import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { createLogicEdge, detachLogicData, logicBox, nearestLogicSnap, removeLogic } from '../src/canvas/logic-editor';

const fixture = (): canvas.LogicGraph => ({ version: 1, nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 },
  { id: 'a', kind: 'constant', x: 200, y: 200, value: { type: 'int', text: '2' } },
  { id: 'env', kind: 'envelope', category: 'data', title: '保留名称', members: ['a'], x: 0, y: 0 },
  { id: 'convert', kind: 'convert', input: 'env', target: 'bytes', value: { type: 'int', text: '0' },
    width: '8', endian: 'little', signed: false, x: 800, y: 500 },
], edges: [] });

describe('空包络的保留与重新使用', () => {
  it('移除最后成员保留包络、名称、附件和可见原点；显式删除包络才清理附件', () => {
    const original = fixture(), box = logicBox(original, 'env');
    for (const next of [removeLogic(original, ['a']), detachLogicData(original, ['a'])]) {
      expect(next.nodes.find((node) => node.id === 'env')).toMatchObject({ members: [], title: '保留名称', x: box.x, y: box.y });
      expect(next.nodes.find((node) => node.id === 'convert')).toEqual(original.nodes[3]);
      expect(logicBox(next, 'env')).toMatchObject({ x: box.x, y: box.y });
      expect(canvas.validateLogicGraph(next)).toEqual([]);
    }
    expect(removeLogic(original, ['env']).nodes.map((node) => node.id)).toEqual(['start']);
    expect(original.nodes[2]).toMatchObject({ members: ['a'], x: 0, y: 0 });
  });
  it('完整数据段可拖入空包络，保留内部关系并锚定空框位置', () => {
    const original = fixture();
    const graph: canvas.LogicGraph = { ...original, nodes: original.nodes.map((node) => node.id === 'env'
      ? { ...node, kind: 'envelope', category: 'data', title: '保留名称', members: [], x: 100, y: 100 } : node),
    edges: [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '*' }] };
    graph.nodes.push({ id: 'b', kind: 'constant', value: { type: 'int', text: '3' }, x: 468, y: 200 });
    const snap = nearestLogicSnap(graph, 'a', [], { movingIds: ['a', 'b'], pointer: { x: 200, y: 210 } });
    expect(snap?.kind).toBe('enclose');
    expect(snap?.graph.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a', 'b'] });
    expect(snap?.graph.edges).toEqual(graph.edges);
    expect(logicBox(snap!.graph, 'env')).toMatchObject({ x: 100, y: 100 });
    expect(canvas.validateLogicGraph(snap!.graph)).toEqual([]);
    expect(nearestLogicSnap(graph, 'a', [], { movingIds: ['a', 'b'], pointer: { x: 200, y: 110 } })?.kind).not.toBe('enclose');
  });
  it('独立类型转换不能建立数据或引用连接，仍可附着数据包络', () => {
    const original = fixture();
    const graph = detachLogicData(original, ['convert']);
    const conversion = graph.nodes.find((node) => node.id === 'convert')!, value = graph.nodes[1]!;
    expect(createLogicEdge(graph, conversion, value, [])).toBeUndefined();
    expect(createLogicEdge(graph, value, conversion, [])).toBeUndefined();
    const invalid: canvas.LogicGraph = { ...graph, edges: [{ id: 'bad', kind: 'data', from: 'a', to: 'convert', op: '+' }] };
    expect(canvas.validateLogicGraph(invalid)).toContainEqual(expect.objectContaining({ nodeId: 'bad', message: expect.stringContaining('独立类型转换') }));
    const method: canvas.LogicNode = { id: 'method', kind: 'method', method: 'emit', x: 0, y: 0 };
    expect(createLogicEdge(graph, conversion, method, [{ id: 'emit', label: 'emit', actionCount: 1, params: [{ name: 'n', type: 'int' }] }])).toBeUndefined();
    const snap = nearestLogicSnap(graph, 'convert', []);
    expect(snap?.attachment).toBe('convert');
    expect(snap?.graph.nodes.find((node) => node.id === 'convert')).toMatchObject({ input: 'env' });
  });
  it('循环附件携带次数引用拖出后可回附原宿主，引用不丢失', () => {
    const original: canvas.LogicGraph = { version: 1, nodes: [fixture().nodes[0]!, fixture().nodes[1]!,
      { id: 'method', kind: 'method', method: 'emit', x: 200, y: 400 },
      { id: 'env', kind: 'envelope', category: 'flow', members: ['method'], title: 'env', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', body: 'env', count: '2', x: 900, y: 600 }],
    edges: [{ id: 'count', kind: 'reference', from: 'a', to: 'loop', port: 'count' }] };
    const box = logicBox(original, 'loop');
    const detached = detachLogicData(original, ['loop']);
    const snap = nearestLogicSnap(detached, 'loop', [], { original, pointer: { x: box.x + 20, y: box.y + 10 } });
    expect(snap?.attachment).toBe('loop');
    expect(snap?.graph.edges).toEqual(original.edges);
    expect(canvas.validateLogicGraph(snap!.graph)).toEqual([]);
  });
  it('附着循环可从两端建立次数引用，流程连接仍通过宿主', () => {
    const graph: canvas.LogicGraph = { version: 1, nodes: [fixture().nodes[0]!, fixture().nodes[1]!,
      { id: 'method', kind: 'method', method: 'emit', x: 200, y: 400 },
      { id: 'env', kind: 'envelope', category: 'flow', members: ['method'], title: 'env', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', body: 'env', count: '2', x: 900, y: 600 }], edges: [] };
    const value = graph.nodes[1]!, loop = graph.nodes[4]!;
    for (const [a, b] of [[value, loop], [loop, value]]) {
      const edge = createLogicEdge(graph, a!, b!, []);
      expect(edge).toMatchObject({ kind: 'reference', from: 'a', to: 'loop', port: 'count' });
      expect(canvas.validateLogicGraph({ ...graph, edges: [edge!] })).toEqual([]);
    }
    expect(createLogicEdge(graph, graph.nodes[0]!, loop, [])).toBeUndefined();
    expect(createLogicEdge(graph, graph.nodes[0]!, graph.nodes[3]!, [])).toMatchObject({ kind: 'flow', to: 'env' });
  });
  it('空流程包络接纳完整连通段，拒绝多个孤立段和不同类别', () => {
    const graph: canvas.LogicGraph = { version: 1, nodes: [fixture().nodes[0]!, fixture().nodes[1]!,
      { id: 'm1', kind: 'method', method: 'emit', x: 500, y: 300 },
      { id: 'm2', kind: 'method', method: 'emit', x: 800, y: 300 },
      { id: 'env', kind: 'envelope', category: 'flow', members: [], title: 'env', x: 100, y: 100 }],
    edges: [{ id: 'flow', kind: 'flow', from: 'm1', to: 'm2', outlet: 'next' }] };
    const options = { movingIds: ['m1', 'm2'], pointer: { x: 200, y: 200 } };
    const snap = nearestLogicSnap(graph, 'm1', [], options);
    expect(snap?.kind).toBe('enclose');
    expect(snap?.graph.edges).toEqual(graph.edges);
    expect(snap?.graph.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['m1', 'm2'] });
    expect(nearestLogicSnap({ ...graph, edges: [] }, 'm1', [], options)?.kind).not.toBe('enclose');
    expect(nearestLogicSnap(graph, 'a', [], { pointer: options.pointer })?.kind).not.toBe('enclose');
  });
  it('拖动整数到循环附件可吸附次数引用，类型不符时不吸附', () => {
    const graph: canvas.LogicGraph = { version: 1, nodes: [fixture().nodes[0]!,
      { id: 'method', kind: 'method', method: 'emit', x: 400, y: 400 },
      { id: 'env', kind: 'envelope', category: 'flow', members: ['method'], title: 'env', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', body: 'env', count: '2', x: 900, y: 600 }], edges: [] };
    const badge = logicBox(graph, 'loop');
    const pointer = { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 };
    graph.nodes.push({ ...fixture().nodes[1]!, x: pointer.x - 90, y: pointer.y - 38 });
    const snap = nearestLogicSnap(graph, 'a', [], { pointer });
    expect(snap?.edge).toMatchObject({ kind: 'reference', from: 'a', to: 'loop', port: 'count' });
    expect(canvas.validateLogicGraph(snap!.graph)).toEqual([]);
    const invalid: canvas.LogicGraph = { ...graph, nodes: graph.nodes.map((node) => node.id === 'a'
      ? { id: 'a', kind: 'constant', x: node.x, y: node.y, value: { type: 'string', text: 'abc' } } : node) };
    expect(nearestLogicSnap(invalid, 'a', [], { pointer })).toBeUndefined();
  });
  it('旧存档中指向转换附件的引用在解除后保留并明确标错', () => {
    const original = fixture();
    original.nodes.push({ id: 'method', kind: 'method', method: 'emit', x: 900, y: 200 });
    original.edges.push({ id: 'legacy', kind: 'reference', from: 'convert', to: 'method', port: 'n' });
    const next = detachLogicData(original, ['convert']);
    expect(next.edges).toEqual(original.edges);
    expect(canvas.validateLogicGraph(next)).toContainEqual(expect.objectContaining({ nodeId: 'legacy', message: expect.stringContaining('独立类型转换') }));
    expect(original.nodes[3]).toHaveProperty('input', 'env');
  });
});
