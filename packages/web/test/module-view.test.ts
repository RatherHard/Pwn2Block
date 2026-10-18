import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { createEditor, undo } from '../src/graph/editor';
import { moduleViewDocument, moduleViewState, withModuleBody } from '../src/graph/module-view';
import { wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 模块体编辑（07 §P5）：模块当成独立文档编辑，写回主图时只换节点/连线/序列/布局，
 * 版本与接口不动；撤销作用在主图上。
 */

const MODULE = {
  id: 'inc',
  name: '自增',
  summary: '',
  kind: 'data' as const,
  version: 2,
  inputs: [{ name: 'a', type: 'int' as const }],
  output: { name: 'out', type: 'int' as const },
  nodes: [wfNode('get', NODE.varGet, { name: 'a', type: 'int' }), wfNode('ret', NODE.moduleReturn, { valueType: 'int' })],
  connections: [wfEdge('get', 'ret', 'value')],
  main: ['ret'],
  layout: {},
};

function main() {
  return createEditor(
    workflow({
      nodes: [wfNode('run', NODE.run, { maxSteps: 10 })],
      edges: [],
      main: ['run'],
      modules: [MODULE],
    }),
  );
}

describe('模块体编辑', () => {
  it('模块视图只含模块自己的节点，不带主图节点与模块列表', () => {
    const view = moduleViewDocument(main().document, 'inc');
    expect(view?.nodes.map((node) => node.id)).toEqual(['get', 'ret']);
    expect(view?.modules).toEqual([]);
    expect(moduleViewState(main(), 'inc')?.document.main).toEqual(['ret']);
  });

  it('写回只换节点/连线/序列/布局，版本与接口保持', () => {
    const state = main();
    const body = moduleViewDocument(state.document, 'inc');
    if (body === undefined) throw new Error('缺少模块视图');
    const edited = {
      ...body,
      nodes: [...body.nodes, wfNode('extra', NODE.arith, { op: 'ADD', a: 0, b: 1 })],
      main: ['ret'],
    };
    const result = withModuleBody(state, 'inc', edited);
    if (!result.ok) throw new Error(result.message);
    const module = result.state.document.modules?.[0];
    expect(module?.version).toBe(2);
    expect(module?.inputs).toEqual([{ name: 'a', type: 'int' }]);
    expect(module?.nodes.map((node) => node.id)).toEqual(['get', 'ret', 'extra']);
    expect(result.state.semanticRevision).toBe(state.semanticRevision + 1);
    expect(undo(result.state).document.modules?.[0]?.nodes).toHaveLength(2);
  });

  it('布局编辑不涨语义版本', () => {
    const state = main();
    const body = moduleViewDocument(state.document, 'inc');
    if (body === undefined) throw new Error('缺少模块视图');
    const moved = { ...body, layout: { ...body.layout, get: { x: 300, y: 120 } } };
    const result = withModuleBody(state, 'inc', moved, 'layout');
    if (!result.ok) throw new Error(result.message);
    expect(result.state.semanticRevision).toBe(state.semanticRevision);
    expect(result.state.layoutRevision).toBe(state.layoutRevision + 1);
  });
});
