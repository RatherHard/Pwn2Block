import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { detachLogicData, logicBox, logicDragIds, moveLogicNodes, nearestLogicSnap, normalizeLogicEnvelopes,
  placeLogicOutsideEnvelopes, removeLogic, unwrapLogic, wrapLogic } from '../src/canvas/logic-editor';

const value = (id: string, x: number): canvas.LogicNode =>
  ({ id, kind: 'constant', x, y: 200, value: { type: 'int', text: '2' } });
const data = (id: string, from: string, to: string, op: canvas.LogicOperator = '+'): canvas.LogicEdge =>
  ({ id, kind: 'data', from, to, op });
const row = (): canvas.LogicGraph => ({ version: 1, nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 },
  value('a', 100), value('b', 368), value('c', 636), value('d', 904),
], edges: [data('ab', 'a', 'b'), data('bc', 'b', 'c', '*'), data('cd', 'c', 'd')] });

describe('数据尾段插拔', () => {
  it('流程包络内拖方法仍移动原包络，保留成员和流程连接', () => {
    const graph: canvas.LogicGraph = { version: 1, nodes: [row().nodes[0]!,
      { id: 'a', kind: 'branch', x: 100, y: 200 }, { id: 'b', kind: 'branch', x: 400, y: 200 },
      { id: 'flow', kind: 'envelope', category: 'flow', members: ['a', 'b'], title: 'flow', x: 0, y: 0 }],
    edges: [{ id: 'ab', kind: 'flow', from: 'a', to: 'b', outlet: 'then' }] };
    const ids = logicDragIds(graph, ['b']);
    expect(ids).toEqual(['flow']);
    const next = moveLogicNodes(detachLogicData(graph, ids), ids, 100, 100);
    expect(next.edges).toEqual(graph.edges);
    expect(next.nodes.find((node) => node.id === 'flow')).toMatchObject({ members: ['a', 'b'] });
    expect(canvas.validateLogicGraph(next)).toEqual([]);
  });
  it('从 C 拔起 C + D，只断开左侧乘法关系并保留 A + B', () => {
    const original = row();
    const ids = logicDragIds(original, ['c']);
    const moved = moveLogicNodes(detachLogicData(original, ids), ids, 0, 120);
    expect(moved.edges).toEqual([original.edges[0], original.edges[2]]);
    expect(moved.nodes.find((node) => node.id === 'a')).toEqual(original.nodes[1]);
    expect(moved.nodes.find((node) => node.id === 'b')).toEqual(original.nodes[2]);
    expect(moved.nodes.find((node) => node.id === 'c')).toMatchObject({ x: 636, y: 320 });
    expect(moved.nodes.find((node) => node.id === 'd')).toMatchObject({ x: 904, y: 320 });
    expect(original.edges).toHaveLength(3);
    expect(canvas.validateLogicGraph(moved)).toEqual([]);
  });

  it('删除包络内部连接后，右段完整移到所有祖先框外，左段和引用保留', () => {
    const original = row();
    original.nodes.push(
      { id: 'inner', kind: 'envelope', category: 'data', members: ['a', 'b', 'c', 'd'], title: 'inner', x: 0, y: 0 },
      { id: 'outer', kind: 'envelope', category: 'data', members: ['inner'], title: 'outer', x: 0, y: 0 },
      { id: 'method', kind: 'method', method: 'emit', x: 1400, y: 500 },
    );
    original.edges.push({ id: 'ref', kind: 'reference', from: 'inner', to: 'method', port: 'n' });
    const next = removeLogic(original, ['bc']);
    expect(next.nodes.find((node) => node.id === 'inner')).toMatchObject({ members: ['a', 'b'] });
    expect(next.nodes.find((node) => node.id === 'outer')).toMatchObject({ members: ['inner'] });
    expect(canvas.logicOwner(next, 'c')).toBeUndefined();
    expect(canvas.logicOwner(next, 'd')).toBeUndefined();
    expect(next.edges.map((edge) => edge.id)).toEqual(['ab', 'cd', 'ref']);
    const outer = logicBox(next, 'outer');
    expect(logicBox(next, 'c').x).toBeGreaterThanOrEqual(outer.x + outer.width + 32);
    expect(next.nodes.find((node) => node.id === 'd')!.x - next.nodes.find((node) => node.id === 'c')!.x).toBe(268);
    expect(next.nodes.find((node) => node.id === 'a')).toEqual(original.nodes[1]);
    expect(canvas.validateLogicGraph(next)).toEqual([]);
  });

  it('包络自动覆盖当前完整结构，拒绝不相连的成员，旧坏包络可诊断且不被改写', () => {
    const original = row();
    const wrapped = wrapLogic(original, ['b']);
    expect(wrapped.nodes.find((node) => node.kind === 'envelope')).toMatchObject({ members: ['a', 'b', 'c', 'd'] });
    const disconnected = { ...original, edges: [original.edges[0]!, original.edges[2]!] };
    expect(() => wrapLogic(disconnected, ['a', 'c'])).toThrow(/整体/);
    const invalid: canvas.LogicGraph = { ...disconnected, nodes: [...disconnected.nodes,
      { id: 'env', kind: 'envelope', category: 'data', members: ['a', 'b', 'c', 'd'], title: 'env', x: 0, y: 0 }] };
    expect(canvas.validateLogicGraph(invalid)).toContainEqual(expect.objectContaining({ nodeId: 'env', message: expect.stringContaining('整体') }));
    expect(invalid.nodes.at(-1)).toMatchObject({ members: ['a', 'b', 'c', 'd'] });
  });

  it('整段插入乘法关系时左边界保留乘法，右边界新增加法且右段完整让位', () => {
    const original: canvas.LogicGraph = { ...row(), nodes: [...row().nodes, value('x', 280), value('y', 548)],
      edges: [data('ab', 'a', 'b', '*'), data('bc', 'b', 'c'), data('cd', 'c', 'd'), data('xy', 'x', 'y')] };
    const snap = nearestLogicSnap(original, 'x', [], { movingIds: ['x', 'y'], pointer: { x: 324, y: 238 } });
    expect(snap?.kind).toBe('insert');
    expect(snap?.graph.edges).toContainEqual(expect.objectContaining({ from: 'a', to: 'x', op: '*' }));
    expect(snap?.graph.edges).toContainEqual(expect.objectContaining({ from: 'x', to: 'y', op: '+' }));
    expect(snap?.graph.edges).toContainEqual(expect.objectContaining({ from: 'y', to: 'b', op: '+' }));
    expect(snap?.graph.edges).toContainEqual(original.edges[1]);
    expect(snap?.graph.edges).toContainEqual(original.edges[2]);
    expect(snap?.graph.nodes.find((node) => node.id === 'a')).toEqual(original.nodes[1]);
    expect(snap?.graph.nodes.find((node) => node.id === 'b')).toMatchObject({ x: 904, y: 200 });
    expect(canvas.previewLogicGraph(snap!.graph).get('d')).toEqual({ kind: 'int', value: 12n });
    expect(original.edges).toHaveLength(4);
  });

  it('赋值位置插入保留变量在左，接回原断口恢复乘法而非默认加法', () => {
    const original = row();
    original.nodes[1] = { id: 'a', kind: 'variable', name: 'v', x: 100, y: 200 };
    original.edges[0] = data('ab', 'b', 'a', 'assign');
    original.nodes.push(value('x', 280));
    const inserted = nearestLogicSnap(original, 'x', [], { pointer: { x: 324, y: 238 } });
    expect(inserted?.graph.edges).toContainEqual(expect.objectContaining({ from: 'x', to: 'a', op: 'assign' }));
    expect(inserted?.graph.edges).toContainEqual(expect.objectContaining({ from: 'x', to: 'b', op: '+' }));
    expect(canvas.previewLogicGraph(inserted!.graph).get('a')).toEqual({ kind: 'int', value: 8n });
    const initial = row();
    const detached = detachLogicData(initial, ['c', 'd']);
    const rejoined = nearestLogicSnap(detached, 'c', [], { movingIds: ['c', 'd'], original: initial });
    expect(rejoined?.edge).toEqual(initial.edges[1]);
  });

  it('缩放下用屏幕距离吸附，当前候选在 36px 内保留，远离即退出', () => {
    for (const scale of [0.25, 1, 3]) {
      const base: canvas.LogicGraph = { ...row(), nodes: [row().nodes[0]!, value('a', 100), value('x', 368 + 20 / scale)], edges: [] };
      const snap = nearestLogicSnap(base, 'x', [], { scale });
      expect(snap?.kind).toBe('connect');
      const at30 = moveLogicNodes(base, ['x'], 10 / scale, 0);
      expect(nearestLogicSnap(at30, 'x', [], { scale })).toBeUndefined();
      expect(nearestLogicSnap(at30, 'x', [], { scale, previous: snap })?.key).toBe(snap?.key);
      expect(nearestLogicSnap(moveLogicNodes(at30, ['x'], 7 / scale, 0), 'x', [], { scale, previous: snap })).toBeUndefined();
    }
  });
  it('缩小视图时附近未命中的关系框不抢占更近的空闲端点', () => {
    const graph: canvas.LogicGraph = { version: 1, nodes: [row().nodes[0]!, value('a', 100), value('b', 368),
      value('c', 78), value('x', 346)], edges: [data('ab', 'a', 'b')] };
    const snap = nearestLogicSnap(graph, 'x', [], { scale: 0.25, pointer: { x: 436, y: 238 } });
    expect(snap?.kind).toBe('connect');
    expect(snap?.edge).toMatchObject({ from: 'c', to: 'x' });
  });

  it('整个尾段接入包络内部，引用保留且不把引用目标拖进包络', () => {
    const graph: canvas.LogicGraph = { ...row(), nodes: [row().nodes[0]!, value('a', 100), value('x', 190), value('y', 458),
      { id: 'env', kind: 'envelope', category: 'data', members: ['a'], title: 'env', x: 0, y: 0 },
      { id: 'method', kind: 'method', method: 'emit', x: 1400, y: 500 }],
    edges: [data('xy', 'x', 'y'), { id: 'ref', kind: 'reference', from: 'y', to: 'method', port: 'n' }] };
    const snap = nearestLogicSnap(graph, 'x', [], { movingIds: ['x', 'y'], pointer: { x: 280, y: 238 } });
    expect(snap?.graph.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a', 'x', 'y'] });
    expect(snap?.graph.edges).toContainEqual(graph.edges[1]);
    expect(snap?.graph.nodes.find((node) => node.id === 'method')).toEqual(graph.nodes.at(-1));
    expect(canvas.validateLogicGraph(snap!.graph)).toEqual([]);
  });

  it('类型不兼容的插入没有候选，也不会删除目标关系', () => {
    const graph = row();
    graph.nodes.push({ ...value('x', 280), kind: 'constant', value: { type: 'string', text: 'abc' } });
    expect(nearestLogicSnap(graph, 'x', [], { pointer: { x: 324, y: 238 } })).toBeUndefined();
    expect(graph.edges).toHaveLength(3);
  });

  it('Alt 取出中间节点后左段留框，右段退出且没有自动补桥', () => {
    const original = row();
    original.nodes.push({ id: 'env', kind: 'envelope', category: 'data', members: ['a', 'b', 'c', 'd'], title: 'env', x: 0, y: 0 });
    const ids = logicDragIds(original, ['b'], true);
    const next = placeLogicOutsideEnvelopes(original, detachLogicData(original, ids), ids);
    expect(next.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a'] });
    expect(next.edges).toEqual([original.edges[2]]);
    expect(canvas.logicOwner(next, 'b')).toBeUndefined();
    expect(canvas.logicOwner(next, 'c')).toBeUndefined();
    expect(canvas.validateLogicGraph(next)).toEqual([]);
  });

  it('旧多结构包络仅在显式整理时移出右段，保留数据与内部连接', () => {
    const original = row();
    original.edges = [original.edges[0]!, original.edges[2]!];
    original.nodes.push({ id: 'env', kind: 'envelope', category: 'data', members: ['a', 'b', 'c', 'd'], title: 'env', x: 0, y: 0 });
    const repaired = normalizeLogicEnvelopes(original, original, [], 'env');
    expect(repaired.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a', 'b'] });
    expect(repaired.edges).toEqual(original.edges);
    expect(repaired.nodes).toHaveLength(original.nodes.length);
    expect(canvas.validateLogicGraph(repaired)).toEqual([]);
  });
  it('整理只影响选中的旧坏包络，并按画面左段保留而非成员数组次序', () => {
    const original = row();
    original.edges = [];
    original.nodes.push(
      { id: 'env', kind: 'envelope', category: 'data', members: ['b', 'a'], title: 'env', x: 0, y: 0 },
      { id: 'other', kind: 'envelope', category: 'data', members: ['d', 'c'], title: 'other', x: 0, y: 0 });
    const repaired = normalizeLogicEnvelopes(original, original, [], 'env');
    expect(repaired.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a'] });
    expect(repaired.nodes.find((node) => node.id === 'other')).toEqual(original.nodes.at(-1));
  });
  it('解除嵌套包络保留单一结构，旧坏子包络的多段不能留在父包络', () => {
    const original = row();
    original.edges = [];
    original.nodes.push(
      { id: 'inner', kind: 'envelope', category: 'data', members: ['a', 'b'], title: 'inner', x: 0, y: 0 },
      { id: 'outer', kind: 'envelope', category: 'data', members: ['inner'], title: 'outer', x: 0, y: 0 });
    const next = unwrapLogic(original, 'inner');
    expect(next.nodes.find((node) => node.id === 'outer')).toMatchObject({ members: ['a'] });
    expect(canvas.logicOwner(next, 'b')).toBeUndefined();
    expect(canvas.validateLogicGraph(next)).toEqual([]);
  });
});
