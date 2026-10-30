import { describe, expect, it } from 'vitest';
import type { canvas } from '@pwn2block/shared';
import { copyLogicSelection, parseLogicSelection, pasteLogicSelection, serializeLogicSelection } from '../src/canvas/logic-clipboard';
import { logicBox } from '../src/canvas/logic-editor';
import { logicEdgeGeometry } from '../src/components/logic-canvas-view';

const value = (id: string, x: number, y = 200): canvas.LogicNode => ({
  id, kind: 'constant', value: { type: 'int', text: '2' }, x, y,
});
const graph = (): canvas.LogicGraph => ({ version: 1, nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 }, value('a', 100), value('b', 368), value('outside', 900),
  { id: 'data', kind: 'envelope', category: 'data', title: '表达式', members: ['a', 'b'], x: 100, y: 200 },
  { id: 'convert', kind: 'convert', input: 'data', target: 'int', value: { type: 'int', text: '0' }, width: '8', endian: 'little', signed: false, x: 100, y: 200 },
  { id: 'branch', kind: 'branch', x: 700, y: 200 },
  { id: 'outer', kind: 'envelope', category: 'flow', title: '流程', members: ['data', 'branch'], x: 0, y: 0 },
  { id: 'loop', kind: 'loop', count: '3', body: 'outer', x: 0, y: 0 },
], edges: [
  { id: 'sum', kind: 'data', from: 'a', to: 'b', op: '+' },
  { id: 'ref', kind: 'reference', from: 'data', to: 'branch', port: 'condition' },
  { id: 'flow', kind: 'flow', from: 'branch', to: 'outer', outlet: 'then', points: [{ x: 600, y: 450 }] },
  { id: 'incoming', kind: 'flow', from: 'start', to: 'outer', outlet: 'next' },
  { id: 'external', kind: 'reference', from: 'outside', to: 'branch', port: 'condition' },
] });

describe('logic selection clipboard', () => {
  it('copies nested envelopes, attachments and internal edges, excluding external links and the start node', () => {
    const original = graph();
    const copied = copyLogicSelection(original, ['start', 'outer'])!;
    expect(copied.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'branch', 'convert', 'data', 'loop', 'outer']);
    expect(copied.edges.map((e) => e.id)).toEqual(['sum', 'ref', 'flow']);
    expect(parseLogicSelection(serializeLogicSelection(copied))).toEqual(copied);
    const a = original.nodes.find((n) => n.id === 'a')!;
    if (a.kind === 'constant') a.value.text = 'changed';
    expect(copied.nodes.find((n) => n.id === 'a')).toMatchObject({ value: { text: '2' } });
    expect(copyLogicSelection(original, ['start'])).toBeUndefined();
  });
  it('remaps all relationships and bend points, preserving fixed spacing at negative coordinates', () => {
    const original = graph(), fragment = copyLogicSelection(original, ['outer'])!;
    const before = structuredClone(original);
    const pasted = pasteLogicSelection(original, fragment, { x: -1000, y: -2000 });
    const added = pasted.graph.nodes.slice(original.nodes.length);
    const ids = new Map(fragment.nodes.map((n, i) => [n.id, added[i]!.id]));
    expect(pasted.selected).toEqual([ids.get('outer')]);
    expect(logicBox(pasted.graph, ids.get('outer')!)).toMatchObject({ x: -1000, y: -2000 });
    expect(added.find((n) => n.kind === 'loop')).toMatchObject({ body: ids.get('outer') });
    expect(added.find((n) => n.kind === 'convert')).toMatchObject({ input: ids.get('data') });
    expect(added.find((n) => n.id === ids.get('data'))).toMatchObject({ members: [ids.get('a'), ids.get('b')] });
    expect(logicBox(pasted.graph, ids.get('b')!).x - logicBox(pasted.graph, ids.get('a')!).x).toBe(268);
    const dx = added[0]!.x - fragment.nodes[0]!.x, dy = added[0]!.y - fragment.nodes[0]!.y;
    expect(pasted.graph.edges.slice(original.edges.length)).toEqual(fragment.edges.map((e, i) => ({
      ...e, id: `edge-${i + 1}`, from: ids.get(e.from), to: ids.get(e.to),
      ...(e.kind === 'flow' ? { points: [{ x: 600 + dx, y: 450 + dy }] } : {}),
    })));
    const twice = pasteLogicSelection(pasted.graph, fragment, { x: 500, y: 500 });
    const allIds = [...twice.graph.nodes, ...twice.graph.edges].map((n) => n.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    const a = added[0]!;
    if (a.kind === 'constant') a.value.text = 'changed';
    expect(fragment.nodes[0]).toMatchObject({ value: { text: '2' } });
    expect(original).toEqual(before);
  });
  it('copies a single member or attached modifier independently of its envelope', () => {
    expect(copyLogicSelection(graph(), ['a'])?.nodes.map((n) => n.id)).toEqual(['a']);
    const standalone = copyLogicSelection(graph(), ['convert'])!;
    expect(standalone.nodes[0]).not.toHaveProperty('input');
    const pasted = pasteLogicSelection(graph(), standalone, { x: 10, y: 20 });
    expect(pasted.selected).toHaveLength(1);
    expect(pasted.graph.nodes.at(-1)).toMatchObject({ kind: 'convert', x: 10, y: 20 });
  });
  it('rejects unrelated clipboard text and broken IDs without altering the current graph', () => {
    expect(parseLogicSelection('hello')).toBeUndefined();
    expect(parseLogicSelection(JSON.stringify(graph()))).toBeUndefined();
    const missing = graph();
    missing.nodes = missing.nodes.filter((n) => n.id !== 'a');
    expect(parseLogicSelection(serializeLogicSelection(missing))).toBeUndefined();
    const duplicate = graph();
    duplicate.edges[0]!.id = 'a';
    expect(parseLogicSelection(serializeLogicSelection(duplicate))).toBeUndefined();
    const full: canvas.LogicGraph = { version: 1, nodes: Array.from({ length: 512 }, (_, i) => value(`n${i}`, i)), edges: [] };
    expect(() => pasteLogicSelection(full, copyLogicSelection(graph(), ['a'])!, { x: 0, y: 0 })).toThrow(/容量/);
    expect(full.nodes).toHaveLength(512);
  });
});

it('spaces reference lines six pixels apart perpendicular to horizontal or diagonal connections', () => {
  for (const y of [200, 500]) {
    const g: canvas.LogicGraph = { version: 1, nodes: [value('a', 0), value('b', 500, y)], edges: [] };
    const paths = logicEdgeGeometry(g, { id: 'ref', kind: 'reference', from: 'a', to: 'b', port: 'value' }).paths;
    const starts = paths.map((p) => p.split(' ').slice(1, 3).map(Number));
    expect(Math.hypot(starts[0]![0]! - starts[1]![0]!, starts[0]![1]! - starts[1]![1]!)).toBeCloseTo(6);
    expect(Math.hypot(starts[2]![0]! - starts[0]![0]!, starts[2]![1]! - starts[0]![1]!)).toBeCloseTo(12);
  }
});
