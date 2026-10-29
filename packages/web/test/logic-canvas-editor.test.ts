import { describe, it, expect } from 'vitest';
import { canvas } from '@pwn2block/shared';
import {
  createLogicEdge,
  nearestLogicSnap,
  wrapLogic,
  moveLogicNodes,
  unwrapLogic,
  removeLogic,
} from '../src/canvas/logic-editor';
const constant = (id: string, x: number, y = 200): canvas.LogicNode => ({
  id,
  kind: 'constant',
  value: { type: 'int', text: '2' },
  x,
  y,
});
const graph = (nodes: canvas.LogicNode[], edges: canvas.LogicEdge[] = []): canvas.LogicGraph => ({
  version: 1,
  nodes: [{ id: 'start', kind: 'start', x: 80, y: 20 }, ...nodes],
  edges,
});
describe('逻辑画布编辑：最近吸附与包络', () => {
  it('只选最近一个合法目标，远离后没有候选', () => {
    const g = graph([constant('a', 100), constant('b', 310), constant('c', 550)]);
    const snap = nearestLogicSnap(g, 'b', []);
    expect(snap?.target).toBe('a');
    expect(snap?.edge).toMatchObject({ kind: 'data', from: 'a', to: 'b' });
    expect(g.edges).toHaveLength(0);
    expect(snap?.graph.edges).toHaveLength(1);
    expect(nearestLogicSnap(moveLogicNodes(g, ['b'], 0, 300), 'b', [])).toBeUndefined();
  });
  it('吸附包络内部成员后，节点成为同类包络成员', () => {
    const g = graph([
      constant('a', 200),
      constant('b', 300),
      { id: 'g', kind: 'envelope', category: 'data', members: ['a'], title: 'g', x: 0, y: 0 },
    ]);
    const snap = nearestLogicSnap(g, 'b', []);
    expect(snap?.graph.nodes.find((n) => n.id === 'g')).toMatchObject({ members: ['a', 'b'] });
    expect(canvas.validateLogicGraph(snap!.graph)).toEqual([]);
  });
  it('引用可以跨包络，且不会把异类节点收入包络', () => {
    const g = graph([
      { id: 'condition', kind: 'constant', value: { type: 'bool', text: 'true' }, x: 200, y: 200 },
      { id: 'branch', kind: 'branch', x: 420, y: 200 },
      { id: 'g', kind: 'envelope', category: 'flow', members: ['branch'], title: 'g', x: 0, y: 0 },
    ]);
    const snap = nearestLogicSnap(g, 'condition', []);
    expect(snap?.edge).toMatchObject({ kind: 'reference' });
    expect(snap?.graph.nodes.find((n) => n.id === 'g')).toMatchObject({ members: ['branch'] });
  });
  it('bool/int 引用只吸附类型合适的流程输入', () => {
    const g = graph([constant('n', 200), { id: 'branch', kind: 'branch', x: 420, y: 200 }]);
    expect(nearestLogicSnap(g, 'n', [])).toBeUndefined();
  });
  it('包络整体移动保留成员、连接与括号语义，可解除并删除连接', () => {
    const g = graph(
      [constant('a', 100), constant('b', 348)],
      [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }],
    );
    const wrapped = wrapLogic(g, ['a', 'b']);
    const envelope = wrapped.nodes.find((n) => n.kind === 'envelope')!;
    const moved = moveLogicNodes(wrapped, [envelope.id], 50, 70);
    expect(moved.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 150, y: 270 });
    expect(moved.edges).toEqual(g.edges);
    expect(canvas.previewLogicGraph(moved).get(envelope.id)).toEqual({ kind: 'int', value: 4n });
    expect(unwrapLogic(moved, envelope.id).nodes).toHaveLength(3);
    expect(removeLogic(moved, ['ab']).edges).toHaveLength(0);
    expect(removeLogic(g, ['start']).nodes.some((n) => n.kind === 'start')).toBe(true);
  });
  it('循环和转换拖近合适包络可附着，不产生假关系边', () => {
    const g = graph([
      { id: 'm', kind: 'method', method: 'm', x: 200, y: 200 },
      { id: 'g', kind: 'envelope', category: 'flow', members: ['m'], title: 'g', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', count: '2', x: 420, y: 200 },
    ]);
    const snap = nearestLogicSnap(g, 'loop', []);
    expect(snap?.attachment).toBe('loop');
    expect(snap?.graph.nodes.find((n) => n.id === 'loop')).toMatchObject({ body: 'g' });
  });
});

it('赋值包络和题目方法能一起组成流程包络', () => {
  const g = graph(
    [
      constant('a', 100),
      { id: 'v', kind: 'variable', name: 'x', x: 348, y: 200 },
      { id: 'm', kind: 'method', method: 'm', x: 600, y: 200 },
    ],
    [{ id: 'av', kind: 'data', from: 'a', to: 'v', op: 'assign' }],
  );
  const first = wrapLogic(g, ['a', 'v']);
  const inner = first.nodes.find((n) => n.kind === 'envelope')!;
  const outer = wrapLogic(first, [inner.id, 'm']);
  expect(outer.nodes.filter((n) => n.kind === 'envelope').at(-1)).toMatchObject({ category: 'flow' });
  expect(canvas.validateLogicGraph(outer)).toEqual([]);
});
it('删除最后一个成员时同时清理空包络和附着节点', () => {
  const g = graph([
    constant('a', 100),
    { id: 'g', kind: 'envelope', category: 'data', members: ['a'], title: 'g', x: 0, y: 0 },
    {
      id: 'c',
      kind: 'convert',
      input: 'g',
      value: { type: 'int', text: '0' },
      target: 'bytes',
      width: '8',
      endian: 'little',
      signed: false,
      x: 400,
      y: 200,
    },
  ]);
  expect(removeLogic(g, ['a']).nodes.map((n) => n.id)).toEqual(['start']);
});

it('内部落点不受包络与成员标识排序影响', () => {
  const g = graph([
    constant('z', 200),
    constant('moving', 300),
    { id: 'a', kind: 'envelope', category: 'data', members: ['z'], title: 'a', x: 0, y: 0 },
  ]);
  const snap = nearestLogicSnap(g, 'moving', []);
  expect(snap?.target).toBe('z');
  expect(snap?.graph.nodes.find((n) => n.id === 'a')).toMatchObject({ members: ['z', 'moving'] });
});

it('赋值包络默认向方法建立数据引用，开始仍能连接其流程入口', () => {
  const g = graph(
    [
      constant('a', 100),
      { id: 'v', kind: 'variable', name: 'x', x: 348, y: 200 },
      { id: 'g', kind: 'envelope', category: 'data', members: ['a', 'v'], title: 'g', x: 0, y: 0 },
      { id: 'm', kind: 'method', method: 'emit', x: 600, y: 200 },
    ],
    [{ id: 'av', kind: 'data', from: 'a', to: 'v', op: 'assign' }],
  );
  const envelope = g.nodes.find((n) => n.id === 'g')!;
  const method = g.nodes.find((n) => n.id === 'm')!;
  const methods = [{ id: 'emit', label: '记录', params: [{ name: 'n', type: 'int' as const }], actionCount: 1 }];
  expect(createLogicEdge(g, envelope, method, methods)).toMatchObject({
    kind: 'reference',
    from: 'g',
    to: 'm',
    port: 'n',
  });
  expect(createLogicEdge(g, g.nodes[0]!, envelope, methods)).toMatchObject({ kind: 'flow', from: 'start', to: 'g' });
});
it('解除数据包络保留结果引用和循环次数，含糊端点明确拒绝', () => {
  const g = graph(
    [
      constant('a', 100),
      { id: 'b', kind: 'constant', x: 348, y: 200, value: { type: 'int', text: '3' } },
      { id: 'g', kind: 'envelope', category: 'data', members: ['a', 'b'], title: 'g', x: 0, y: 0 },
      { id: 'm', kind: 'method', method: 'emit', x: 600, y: 200 },
      { id: 'body', kind: 'envelope', category: 'flow', members: ['m'], title: 'body', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', count: '1', body: 'body', x: 800, y: 200 },
    ],
    [
      { id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' },
      { id: 'count', kind: 'reference', from: 'g', to: 'loop', port: 'count' },
      { id: 'run', kind: 'flow', from: 'start', to: 'body', outlet: 'next' },
    ],
  );
  const methods = [{ id: 'emit', label: '记录', params: [], actionCount: 1 }];
  const before = canvas.generateLogicActions(g, { methods });
  const unwrapped = unwrapLogic(g, 'g');
  expect(unwrapped.edges.find((e) => e.id === 'count')).toMatchObject({ from: 'b' });
  const after = canvas.generateLogicActions(unwrapped, { methods });
  expect(before.ok && before.sequence.actions.length).toBe(5);
  expect(after.ok && after.sequence.actions).toEqual(before.ok && before.sequence.actions);
  expect(() => unwrapLogic({ ...g, edges: g.edges.filter((e) => e.id !== 'ab') }, 'g')).toThrow(/端点/);
});
