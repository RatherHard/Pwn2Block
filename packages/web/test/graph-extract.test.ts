import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import { createEditor } from '../src/graph/editor';
import { extractModule } from '../src/graph/extract';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 提取为模块（06 §7；07 §P5）。
 *
 * 关心三件事：提取后动作不变、外部输入/输出被正确改写成调用节点的端口、拒绝时给原因。
 * 这是纯编辑命令，所以不挂组件。
 */

function editorOf(nodes: Parameters<typeof workflow>[0]['nodes'], edges: Parameters<typeof workflow>[0]['edges'], main: readonly string[]) {
  return createEditor(workflow({ nodes, edges, main }));
}

async function actionsOf(document: Parameters<typeof createEditor>[0]) {
  const outcome = await compileGraph({ document, context: WORKFLOW_CONTEXT, documentRevision: 1 });
  if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('; '));
  return outcome.artifact.actions;
}

function intOf(id: string, value: number) {
  return wfNode(id, NODE.arith, { op: 'ADD', a: 0, b: value });
}

describe('提取为模块', () => {
  it('把外部输入与唯一输出改写成调用端口，动作保持不变', async () => {
    const state = editorOf(
      [intOf('n', 41), wfNode('inc', NODE.arith, { op: 'ADD', b: 1 }), wfNode('push', NODE.push)],
      [wfEdge('n', 'inc', 'a'), wfEdge('inc', 'push', 'value')],
      ['n', 'inc', 'push'],
    );
    const before = await actionsOf(state.document);
    const result = extractModule(state, ['inc']);
    if (!result.ok) throw new Error(result.message);
    expect(result.moduleId).toBe('mod1');
    expect(result.state.document.modules?.[0]?.kind).toBe('data');
    expect(result.state.document.modules?.[0]?.inputs).toEqual([{ name: 'a', type: 'int' }]);
    expect(result.state.document.main).toContain('extracted1');
    expect(await actionsOf(result.state.document)).toEqual(before);
    expect(before).toEqual([{ type: 'push', value: '0x2a' }]);
  });

  it('选中的纯数据节点没有输入时也能提取', async () => {
    const state = editorOf(
      [wfNode('five', NODE.arith, { op: 'ADD', a: 0, b: 5 }), wfNode('push', NODE.push)],
      [wfEdge('five', 'push', 'value')],
      ['five', 'push'],
    );
    const result = extractModule(state, ['five']);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.document.modules?.[0]?.inputs).toEqual([]);
    expect(await actionsOf(result.state.document)).toEqual([{ type: 'push', value: '0x5' }]);
  });

  it('拒绝不连续的选区并说明原因', () => {
    const state = editorOf(
      [wfNode('hex', NODE.hex, { hex: '41' }), wfNode('run', NODE.run), intOf('n', 1)],
      [wfEdge('hex', 'run', 'maxSteps')],
      ['hex', 'run', 'n'],
    );
    const result = extractModule(state, ['hex', 'n']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('不连续');
  });

  it('拒绝有多个外部消费者的选区', () => {
    const state = editorOf(
      [wfNode('hex', NODE.hex, { hex: '41' }), wfNode('push', NODE.push), wfNode('feed', NODE.feed)],
      [wfEdge('hex', 'push', 'value'), wfEdge('hex', 'feed', 'data')],
      ['hex', 'push', 'feed'],
    );
    const result = extractModule(state, ['hex']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('多个外部消费者');
  });

  it('含动作的选区提取为流程模块（没有结果也可以）', async () => {
    const state = editorOf(
      [intOf('n', 5), wfNode('push', NODE.push)],
      [wfEdge('n', 'push', 'value')],
      ['n', 'push'],
    );
    const before = await actionsOf(state.document);
    const result = extractModule(state, ['push']);
    if (!result.ok) throw new Error(result.message);
    const module = result.state.document.modules?.[0];
    expect(module?.kind).toBe('flow');
    expect(module?.output).toBeUndefined();
    expect(module?.inputs).toEqual([{ name: 'value', type: 'int' }]);
    expect(await actionsOf(result.state.document)).toEqual(before);
    const call = result.state.document.nodes.find((node) => node.id === result.state.document.main[1]);
    expect(call?.kind).toBe(NODE.moduleCall);
    expect(call?.params.hasOutput).toBe('no');
  });

  it('流程模块可以带一个结果，并接到原来的消费者', async () => {
    const state = editorOf(
      [
        intOf('n', 41),
        wfNode('inc', NODE.arith, { op: 'ADD', b: 1 }),
        wfNode('push', NODE.push),
        wfNode('copy', NODE.arith, { op: 'ADD', b: 0 }),
      ],
      [wfEdge('n', 'inc', 'a'), wfEdge('inc', 'push', 'value'), wfEdge('inc', 'copy', 'a')],
      ['n', 'inc', 'push', 'copy'],
    );
    const before = await actionsOf(state.document);
    const result = extractModule(state, ['inc', 'push']);
    if (!result.ok) throw new Error(result.message);
    const module = result.state.document.modules?.[0];
    expect(module?.kind).toBe('flow');
    expect(module?.output).toEqual({ name: 'out', type: 'int' });
    expect(await actionsOf(result.state.document)).toEqual(before);
    const call = result.state.document.nodes.find((node) => node.kind === NODE.moduleCall);
    expect(call?.params.hasOutput).toBe('yes');
    expect(call?.params.outputType).toBe('int');
  });

  it('容器没选全时拒绝', () => {
    const state = editorOf(
      [
        wfNode('if', NODE.if, {}, { then: ['hex'], else: [] }),
        wfNode('hex', NODE.hex, { hex: '41' }),
        wfNode('push', NODE.push),
      ],
      [wfEdge('hex', 'push', 'value')],
      ['if'],
    );
    const result = extractModule(state, ['if']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('控制结构没选全');
  });
});
