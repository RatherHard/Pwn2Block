import { describe, expect, it } from 'vitest';
import type { canvas } from '@pwn2block/shared';
import { createLogicEdge, nearestLogicSnap } from '../src/canvas/logic-editor';

const value = (id: string, x: number, y: number): canvas.LogicNode => ({
  id, kind: 'constant', value: { type: 'int', text: '2' }, x, y,
});
const base: canvas.LogicGraph = { version: 1, nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 },
  value('old', 100, 400), value('moving', 300, 200), value('new', 510, 200),
], edges: [] };
const attached: canvas.LogicGraph = { version: 1, edges: [], nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 }, value('member', 200, 200), value('moving', 300, 100),
  { id: 'z-env', kind: 'envelope', category: 'data', members: ['member'], title: 'data', x: 200, y: 200 },
  { id: 'a-convert', kind: 'convert', input: 'z-env', value: { type: 'int', text: '0' }, target: 'int',
    width: '8', endian: 'little', signed: false, x: 900, y: 900 },
] };
describe('connected and attached nodes must not snap as new independent objects', () => {
  it.each(['incoming', 'outgoing'] as const)('does not auto-connect a node with an %s edge', (direction) => {
    const graph: canvas.LogicGraph = { ...base, edges: [{ id: 'existing', kind: 'data', op: '+',
      from: direction === 'incoming' ? 'old' : 'moving', to: direction === 'incoming' ? 'moving' : 'old' }] };
    expect(nearestLogicSnap(graph, 'moving', [])).toBeUndefined();
  });
  it('still allows a fresh node to snap to a connected target', () => {
    const graph: canvas.LogicGraph = { ...base, edges: [{ id: 'existing', kind: 'data', op: '+', from: 'old', to: 'moving' }] };
    expect(nearestLogicSnap(graph, 'new', [])?.target).toBe('moving');
  });
  it('offers the envelope once, without its invisible attachment as a competing target', () => {
    expect(nearestLogicSnap(attached, 'moving', [])?.target).toBe('z-env');
    expect(nearestLogicSnap(attached, 'a-convert', [])).toBeUndefined();
  });
  it('does not create manual connections using an invisible attachment endpoint', () => {
    const hidden = attached.nodes.find((n) => n.id === 'a-convert')!;
    const moving = attached.nodes.find((n) => n.id === 'moving')!;
    expect(createLogicEdge(attached, hidden, moving, [])).toBeUndefined();
    expect(createLogicEdge(attached, moving, hidden, [])).toBeUndefined();
  });
  it('does not resnap an envelope connected through its hidden attachment', () => {
    const graph: canvas.LogicGraph = { ...attached, edges: [{ id: 'old', kind: 'data', op: '+', from: 'a-convert', to: 'moving' }] };
    expect(nearestLogicSnap(graph, 'z-env', [])).toBeUndefined();
  });
});

function nestedEnvelope(): canvas.LogicGraph {
  return { version: 1, nodes: [
    { id: 'start', kind: 'start', x: 0, y: 0 },
    value('left', 200, 300), value('right', 448, 300),
    { id: 'inner', kind: 'envelope', category: 'data', title: 'inner', members: ['left', 'right'], x: 0, y: 0 },
    { id: 'outer', kind: 'envelope', category: 'data', title: 'outer', members: ['inner'], x: 0, y: 0 },
    { id: 'method', kind: 'method', method: 'emit', x: 708, y: 300 },
  ], edges: [{ id: 'sum', kind: 'data', op: '+', from: 'left', to: 'right' }] };
}
const methods: readonly canvas.CanvasMethodDecl[] = [
  { id: 'emit', label: 'emit', params: [{ name: 'n', type: 'int' }], actionCount: 1 },
];
describe('nested envelopes are independent snap endpoints', () => {
  it('references the outer envelope result despite connections between its descendants', () => {
    const graph = nestedEnvelope();
    const snap = nearestLogicSnap(graph, 'outer', methods);
    expect(snap?.edge).toMatchObject({ kind: 'reference', from: 'outer', to: 'method', port: 'n' });
    expect(snap?.graph.edges).toContainEqual(graph.edges[0]);
    expect(graph.edges).toHaveLength(1);
  });
  it.each(['outer', 'right'])('does not resnap when %s already has an external connection', (from) => {
    const graph = nestedEnvelope();
    graph.edges = [...graph.edges, { id: 'existing', kind: 'reference', from, to: 'method', port: 'n' }];
    expect(nearestLogicSnap(graph, 'outer', methods)).toBeUndefined();
  });
});

it('includes internal attachment edges in a nested envelope without blocking its reference', () => {
  const g = nestedEnvelope();
  g.nodes = [...g.nodes, {
    id: 'convert', kind: 'convert', input: 'inner', value: { type: 'int', text: '0' },
    target: 'int', width: '8', endian: 'little', signed: false, x: 0, y: 0,
  }, value('tail', 0, 0)];
  g.nodes = g.nodes.map((n) => n.id === 'outer' && n.kind === 'envelope'
    ? { ...n, members: ['inner', 'tail'] } : n);
  g.edges = [...g.edges, { id: 'internal', kind: 'data', from: 'convert', to: 'tail', op: '+' }];
  expect(nearestLogicSnap(g, 'outer', methods)?.edge).toMatchObject({ kind: 'reference', from: 'outer', to: 'method' });
});
