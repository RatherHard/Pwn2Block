import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { attachLogic } from '../src/canvas/logic-editor';

function fixture(kind: 'convert' | 'loop'): canvas.LogicGraph {
  const node: canvas.LogicNode =
    kind === 'convert'
      ? {
          id: 'attach',
          kind,
          value: { type: 'int', text: '0' },
          target: 'bytes',
          width: '8',
          endian: 'little',
          signed: false,
          x: 500,
          y: 100,
        }
      : { id: 'attach', kind, count: '1', x: 500, y: 100 };
  return {
    version: 1,
    edges: [],
    nodes: [
      { id: 'start', kind: 'start', x: 0, y: 0 },
      kind === 'convert'
        ? { id: 'member', kind: 'constant', value: { type: 'int', text: '2' }, x: 200, y: 100 }
        : { id: 'member', kind: 'method', method: 'm', x: 200, y: 100 },
      {
        id: 'env',
        kind: 'envelope',
        category: kind === 'convert' ? 'data' : 'flow',
        title: '包络',
        members: ['member'],
        x: 200,
        y: 100,
      },
      node,
    ],
  };
}

describe('共享附着操作的结构边界', () => {
  it.each(['convert', 'loop'] as const)('附着和解除不修改原图：%s', (kind) => {
    const graph = fixture(kind),
      original = structuredClone(graph);
    const attached = attachLogic(graph, 'attach', 'env');
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(attached.message);
    expect(canvas.validateLogicGraph(attached.graph)).toEqual([]);
    expect(attached.graph.nodes.find((n) => n.id === 'attach')).toMatchObject(
      kind === 'convert' ? { input: 'env' } : { body: 'env' },
    );
    expect(attachLogic(attached.graph, 'attach')).toEqual({ ok: true, graph });
    expect(graph).toEqual(original);
  });
  it.each(['convert', 'loop'] as const)('拒绝缺失、非包络和包含自身的附着目标：%s', (kind) => {
    const graph = fixture(kind);
    expect(attachLogic(graph, 'attach', 'missing').ok).toBe(false);
    expect(attachLogic(graph, 'attach', 'member').ok).toBe(false);
    const recursive: canvas.LogicGraph = {
      ...graph,
      edges: [kind === 'convert'
        ? { id: 'link', kind: 'data', from: 'member', to: 'attach', op: '+' }
        : { id: 'link', kind: 'flow', from: 'member', to: 'attach', outlet: 'next' }],
      nodes: graph.nodes.map((n) =>
        n.kind === 'envelope' ? { ...n, members: [...n.members, 'attach'] } : n,
      ),
    };
    if (kind === 'loop') expect(canvas.validateLogicGraph(recursive)).toEqual([]);
    else expect(canvas.validateLogicGraph(recursive)).toContainEqual(expect.objectContaining({ nodeId: 'link', message: expect.stringContaining('独立类型转换') }));
    expect(attachLogic(recursive, 'attach', 'env').ok).toBe(false);
  });
  it.each(['convert', 'loop'] as const)('拒绝类别不兼容的包络：%s', (kind) => {
    const graph = fixture(kind === 'convert' ? 'loop' : 'convert');
    const node = fixture(kind).nodes.find((n) => n.id === 'attach')!;
    const mismatched = { ...graph, nodes: graph.nodes.map((n) => (n.id === 'attach' ? node : n)) };
    expect(canvas.validateLogicGraph(mismatched)).toEqual([]);
    expect(attachLogic(mismatched, 'attach', 'env').ok).toBe(false);
  });
  it('拒绝缺失节点以及不支持附着的节点', () => {
    const graph = fixture('convert');
    expect(attachLogic(graph, 'missing', 'env').ok).toBe(false);
    expect(attachLogic(graph, 'member', 'env').ok).toBe(false);
  });
});
