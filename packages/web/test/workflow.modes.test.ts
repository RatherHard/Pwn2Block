import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import { createEditor, setPortMode } from '../src/graph/editor';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 参数来源的显式切换（07 §P3）：手填不看连线，接线必须接上，冲突要报出来。
 */

function editorOf(nodes: Parameters<typeof workflow>[0]['nodes'], edges: Parameters<typeof workflow>[0]['edges'], main: readonly string[]) {
  return createEditor(workflow({ nodes, edges, main }));
}

describe('参数来源：手填 / 接线', () => {
  it('选了接线但没有连线时编译失败并指到端口', async () => {
    const state = editorOf([wfNode('push', NODE.push, { valueMode: 'port' })], [], ['push']);
    const outcome = await compileGraph({ document: state.document, context: WORKFLOW_CONTEXT, documentRevision: 1 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.message.includes('选择了接线'))).toBe(true);
  });

  it('手填优先于连线，并提示连线被忽略', async () => {
    const state = editorOf(
      [wfNode('n', NODE.arith, { op: 'ADD', a: 0, b: 1 }), wfNode('push', NODE.push, { value: 0x2a, valueMode: 'inline' })],
      [wfEdge('n', 'push', 'value')],
      ['n', 'push'],
    );
    const outcome = await compileGraph({ document: state.document, context: WORKFLOW_CONTEXT, documentRevision: 1 });
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('; '));
    expect(outcome.artifact.actions).toEqual([{ type: 'push', value: '0x2a' }]);
    expect((outcome.warnings ?? []).some((issue) => issue.code === 'port_mode_conflict')).toBe(true);
  });

  it('切回手填会断开该端口的连线（可撤销）', () => {
    const state = editorOf(
      [wfNode('n', NODE.arith, { op: 'ADD', a: 0, b: 1 }), wfNode('push', NODE.push)],
      [wfEdge('n', 'push', 'value')],
      ['n', 'push'],
    );
    expect(state.document.connections).toHaveLength(1);
    const inline = setPortMode(state, 'push', 'value', 'inline');
    expect(inline.document.connections).toHaveLength(0);
    expect(inline.document.nodes.find((node) => node.id === 'push')?.params.valueMode).toBe('inline');
    const back = setPortMode(inline, 'push', 'value', 'port');
    expect(back.document.nodes.find((node) => node.id === 'push')?.params.valueMode).toBe('port');
  });
});
