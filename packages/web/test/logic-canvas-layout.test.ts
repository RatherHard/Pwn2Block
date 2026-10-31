import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { connectLogic, detachLogicData, layoutLogicDataComponents, logicBox, moveLogicNodes, nearestLogicSnap,
  LOGIC_RELATION_GAP, LOGIC_RELATION_WIDTH, removeLogic } from '../src/canvas/logic-editor';
import { logicEdgeGeometry } from '../src/components/logic-canvas-view';
import { makeCanvasSave, parseCanvasSave } from '../src/canvas/save';

const value = (id: string, x: number, y = 200): canvas.LogicNode => ({
  id, kind: 'constant', value: { type: 'int', text: '2' }, x, y,
});
const graph = (nodes: canvas.LogicNode[], edges: canvas.LogicEdge[] = []): canvas.LogicGraph => ({
  version: 1, nodes: [{ id: 'start', kind: 'start', x: 100, y: 50 }, ...nodes], edges,
});
const edge = (id: string, from: string, to: string): canvas.LogicEdge => ({ id, kind: 'data', from, to, op: '+' });
function expectFixed(g: canvas.LogicGraph, left: string, right: string, edgeId: string) {
  const a = logicBox(g, left), b = logicBox(g, right);
  const relation = logicEdgeGeometry(g, g.edges.find((e) => e.id === edgeId)!);
  expect(b.y + b.height / 2).toBe(a.y + a.height / 2);
  expect(relation.x - LOGIC_RELATION_WIDTH / 2 - a.x - a.width).toBe(LOGIC_RELATION_GAP);
  expect(b.x - relation.x - LOGIC_RELATION_WIDTH / 2).toBe(LOGIC_RELATION_GAP);
}
describe('unbounded coordinates and fixed data rows', () => {
  it('moves nodes and flow points across the origin and persists distant negative coordinates', () => {
    const g = graph([{ id: 'b', kind: 'branch', x: 400, y: 50 }], [
      { id: 'flow', kind: 'flow', from: 'start', to: 'b', outlet: 'next', points: [{ x: 300, y: 88 }] },
    ]);
    const moved = moveLogicNodes(g, ['start', 'b'], -200000, -300000);
    expect(moved.nodes[0]).toMatchObject({ x: -199900, y: -299950 });
    expect(moved.edges[0]).toMatchObject({ points: [{ x: -199700, y: -299912 }] });
    expect(canvas.LogicGraphSchema.safeParse(moved).success).toBe(true);
    const save = makeCanvasSave('test', { ...canvas.newLogicDocument(), logic: moved });
    expect(parseCanvasSave(JSON.parse(JSON.stringify(save)))).toMatchObject({ ok: true, save: { document: { logic: moved } } });
  });
  it('positions a manually connected row, then appends another row without stretching earlier gaps', () => {
    const initial = graph([value('a', 100), value('b', 1000, 600), value('c', -900, 700), value('d', 1600)]);
    const first = connectLogic(initial, edge('ab', 'a', 'b'));
    const second = connectLogic(first, edge('cd', 'c', 'd'));
    const joined = connectLogic(second, edge('bc', 'b', 'c'));
    expectFixed(joined, 'a', 'b', 'ab');
    expectFixed(joined, 'b', 'c', 'bc');
    expectFixed(joined, 'c', 'd', 'cd');
    expect(joined.nodes.find((n) => n.id === 'a')).toEqual(initial.nodes.find((n) => n.id === 'a'));
    expect(initial.edges).toHaveLength(0);
  });
  it('aligns assignment to the left of its value and permits extension to the right', () => {
    const initial = graph([{ id: 'v', kind: 'variable', name: 'x', x: 0, y: 0 }, value('a', 400), value('b', 900)]);
    const assigned = connectLogic(initial, { id: 'assign', kind: 'data', from: 'a', to: 'v', op: 'assign' });
    const extended = connectLogic(assigned, edge('ab', 'a', 'b'));
    expectFixed(extended, 'v', 'a', 'assign');
    expectFixed(extended, 'a', 'b', 'ab');
  });
  it('moves an envelope with all its members and attachment to align its actual boundary', () => {
    const initial = graph([value('a', -600), value('member', 100, 500),
      { id: 'env', kind: 'envelope', category: 'data', title: 'data', members: ['member'], x: 100, y: 500 },
      { id: 'convert', kind: 'convert', input: 'env', target: 'int', value: { type: 'int', text: '0' }, width: '8', endian: 'little', signed: false, x: 100, y: 500 },
    ]);
    const connected = connectLogic(initial, edge('ae', 'a', 'env'));
    expectFixed(connected, 'a', 'env', 'ae');
    expect(logicBox(connected, 'env').x).toBeLessThan(0);
    const member = connected.nodes.find((n) => n.id === 'member')!;
    const attachment = connected.nodes.find((n) => n.id === 'convert')!;
    expect(attachment.x).toBe(member.x);
    expect(attachment.y).toBe(member.y);
  });
  it('pre-detaches only data edges crossing a moving selection and can reconnect the detached node', () => {
    const initial = graph([value('a', 0), value('b', 268), value('c', 536), value('d', 800, 500)], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]);
    const detached = detachLogicData(initial, ['b']);
    expect(detached.edges).toEqual([]);
    expect(initial.edges).toHaveLength(2);
    const moving = moveLogicNodes(detached, ['b'], 264, 300);
    const snap = nearestLogicSnap(moving, 'b', []);
    expect(snap?.target).toBe('d');
    expectFixed(snap!.graph, 'b', 'd', snap!.edge!.id);
    expect(detachLogicData(initial, ['a', 'b']).edges).toEqual([initial.edges[0]]);
    const withRef = { ...initial, edges: [...initial.edges, { id: 'ref', kind: 'reference' as const, from: 'b', to: 'start', port: 'count' }] };
    expect(detachLogicData(withRef, ['b']).edges).toEqual([withRef.edges[2]]);
  });
  it('refuses a second node on an occupied side instead of overlapping a fixed row', () => {
    const initial = connectLogic(graph([value('a', 0), value('b', 300), value('c', 600)]), edge('ab', 'a', 'b'));
    expect(() => connectLogic(initial, edge('ac', 'a', 'c'))).toThrow(/空闲端点/);
  });
  it('rebuilds every remaining data row after one connection splits the structure', () => {
    const initial = graph(
      [value('a', -800, 40), value('b', 120, 700), value('c', 900, 180), value('d', 1800, 900)],
      [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')],
    );
    const next = removeLogic(initial, ['bc']);
    expectFixed(next, 'a', 'b', 'ab');
    expectFixed(next, 'c', 'd', 'cd');
  });
  it('rebuilds a data row when its operator changes the connection direction', () => {
    const initial = graph(
      [{ id: 'v', kind: 'variable', name: 'x', x: 1000, y: 500 }, value('a', 0, 0)],
      [{ id: 'assign', kind: 'data', from: 'a', to: 'v', op: '+' }],
    );
    const next = layoutLogicDataComponents(
      { ...initial, edges: [{ id: 'assign', kind: 'data', from: 'a', to: 'v', op: 'assign' }] },
      'v',
    );
    expectFixed(next, 'v', 'a', 'assign');
  });
});
