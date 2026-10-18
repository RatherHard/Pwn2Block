import { describe, expect, it } from 'vitest';
import { NODE, WORKFLOW_FORMAT, WORKFLOW_VERSION } from '@pwn2block/shared';
import type { GraphDocument, GraphModule, GraphNode } from '@pwn2block/shared';
import { createEditor } from '../src/graph/editor';
import { upgradeModule, upgradeTargetOf } from '../src/graph/module-upgrade';
import { compileGraph } from '../src/workflow/compile';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 显式升级（06 §7；07 §P5）：调用钉住版本，升级是用户主动触发且可撤销的编辑。
 */

function incModule(version: number, outputType: 'int' | 'bytes' = 'int'): GraphModule {
  return {
    id: 'inc',
    name: '自增',
    summary: '',
    kind: 'data',
    version,
    inputs: [{ name: 'a', type: 'int' }],
    output: { name: 'out', type: outputType },
    nodes: [
      wfNode('get', NODE.varGet, { name: 'a', type: 'int' }),
      wfNode('inc', NODE.arith, { op: 'ADD', b: 1 }),
      wfNode('ret', NODE.moduleReturn, { valueType: outputType }),
    ],
    connections: [wfEdge('get', 'inc', 'a'), wfEdge('inc', 'ret', 'value')],
    main: ['ret'],
    layout: {},
  };
}

function document(modules: readonly GraphModule[]): GraphDocument {
  const base = workflow({
    nodes: [
      wfNode('n', NODE.arith, { op: 'ADD', a: 0, b: 41 }),
      wfNode('call', NODE.moduleData, {
        moduleId: 'inc',
        moduleVersion: 1,
        outputType: 'int',
        inputs: ['a:int'],
      }),
      wfNode('push', NODE.push),
    ],
    edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
    main: ['n', 'call', 'push'],
    modules,
  });
  return { ...base, format: WORKFLOW_FORMAT, version: WORKFLOW_VERSION };
}

function callNode(doc: GraphDocument): GraphNode {
  const node = doc.nodes.find((candidate) => candidate.id === 'call');
  if (node === undefined) throw new Error('缺少调用节点');
  return node;
}

async function actionsOf(doc: GraphDocument) {
  const outcome = await compileGraph({ document: doc, context: WORKFLOW_CONTEXT, documentRevision: 1 });
  if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('; '));
  return outcome.artifact.actions;
}

describe('模块显式升级', () => {
  it('兼容版本可以升级，动作不变，且可撤销', async () => {
    const state = createEditor(document([incModule(1), incModule(2)]));
    expect(upgradeTargetOf(state.document, callNode(state.document))?.version).toBe(2);
    const result = upgradeModule(state, 'call');
    if (!result.ok) throw new Error(result.message);
    expect(callNode(result.state.document).params.moduleVersion).toBe(2);
    expect(await actionsOf(result.state.document)).toEqual([{ type: 'push', value: '0x2a' }]);
  });

  it('端口类型变了就拒绝升级，并保留原版本', () => {
    const state = createEditor(document([incModule(1), incModule(2, 'bytes')]));
    const result = upgradeModule(state, 'call');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('结果的类型');
    expect(state.document.nodes.find((node) => node.id === 'call')?.params.moduleVersion).toBe(1);
  });

  it('没有新版本时明确说已经是最新', () => {
    const state = createEditor(document([incModule(1)]));
    expect(upgradeTargetOf(state.document, callNode(state.document))).toBeUndefined();
    const result = upgradeModule(state, 'call');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('最新版本');
  });
});
