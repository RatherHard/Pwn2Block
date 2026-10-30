import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { createLogicEdge, logicBox, moveLogicNodes, nearestLogicSnap } from '../src/canvas/logic-editor';
import { logicEdgeGeometry, logicPointInsertionIndex } from '../src/components/logic-canvas-view';
import { makeCanvasSave, parseCanvasSave } from '../src/canvas/save';

const flow: canvas.LogicGraph = { version: 1, nodes: [
  { id: 'start', kind: 'start', x: 100, y: 100 },
  { id: 'branch', kind: 'branch', x: 700, y: 100 },
], edges: [{ id: 'edge', kind: 'flow', from: 'start', to: 'branch', outlet: 'next' }] };

describe('flow routing and leftward assignment', () => {
  it('defaults to a straight arrow and interpolates movable route points', () => {
    const edge = flow.edges[0]!;
    expect(logicEdgeGeometry(flow, edge).paths).toEqual(['M 293 138 L 687 138']);
    if (edge.kind !== 'flow') throw new Error('flow fixture');
    const bent = { ...edge, points: [{ x: 450, y: 260 }, { x: 600, y: 300 }] };
    expect(logicEdgeGeometry(flow, bent).paths[0]).toContain('450 260 C');
    expect(logicPointInsertionIndex(flow, bent, { x: 340, y: 180 })).toBe(0);
    expect(logicPointInsertionIndex(flow, bent, { x: 660, y: 200 })).toBe(2);
    expect(logicEdgeGeometry(flow, { ...bent, points: [] }).paths).toEqual(logicEdgeGeometry(flow, edge).paths);
  });
  it('persists points through the document save format and accepts older documents', () => {
    const graph = { ...flow, edges: flow.edges.map((e) => ({ ...e, points: [{ x: 450, y: 260 }] })) };
    const saved = makeCanvasSave('test', { ...canvas.newLogicDocument(), logic: graph });
    expect(parseCanvasSave(JSON.parse(JSON.stringify(saved)))).toMatchObject({ ok: true, save: { document: { logic: graph } } });
    expect(canvas.LogicGraphSchema.safeParse(flow).success).toBe(true);
    expect(canvas.LogicGraphSchema.safeParse({ ...graph, edges: [{ ...graph.edges[0], points: [{ x: Infinity, y: 2 }] }] }).success).toBe(false);
  });
  it('moves route points with a group, while moving one endpoint preserves the route', () => {
    const graph = { ...flow, edges: flow.edges.map((e) => ({ ...e, points: [{ x: 450, y: 260 }] })) };
    expect(moveLogicNodes(graph, ['start', 'branch'], 30, 40).edges[0]).toMatchObject({ points: [{ x: 480, y: 300 }] });
    expect(moveLogicNodes(graph, ['branch'], 30, 40).edges[0]).toEqual(graph.edges[0]);
  });
  it('assigns the right value into the left variable during snapping and explicit connection', () => {
    const variable: canvas.LogicNode = { id: 'v', kind: 'variable', name: 'x', x: 100, y: 300 };
    const value: canvas.LogicNode = { id: 'value', kind: 'constant', value: { type: 'int', text: '42' }, x: 330, y: 300 };
    const graph: canvas.LogicGraph = { ...flow, nodes: [...flow.nodes, variable, value] };
    expect(createLogicEdge(graph, variable, value, [])).toMatchObject({ from: 'value', to: 'v', op: 'assign' });
    const snap = nearestLogicSnap(graph, 'value', []);
    expect(snap?.edge).toMatchObject({ from: 'value', to: 'v', op: 'assign' });
    expect(canvas.previewLogicGraph(snap!.graph).get('v')).toMatchObject({ kind: 'int', value: 42n });
  });
  it('anchors attached-node connections in the envelope header and follows envelope movement', () => {
    const graph: canvas.LogicGraph = { version: 1, edges: [], nodes: [
      { id: 'm', kind: 'branch', x: 400, y: 300 },
      { id: 'env', kind: 'envelope', category: 'flow', members: ['m'], title: 'flow', x: 400, y: 300 },
      { id: 'loop', kind: 'loop', count: '2', body: 'env', x: 900, y: 700 },
    ] };
    const header = logicBox(graph, 'loop'), envelope = logicBox(graph, 'env');
    expect(header.y).toBeGreaterThan(envelope.y);
    expect(header.y + header.height).toBeLessThan(300);
    expect(header.x).toBe(envelope.x + 8);
    expect(logicBox(moveLogicNodes(graph, ['env'], 40, 60), 'loop')).toMatchObject({ x: header.x + 40, y: header.y + 60 });
  });
});
