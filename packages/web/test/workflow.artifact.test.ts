import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { createWorkflowTracker } from '../src/workflow/artifact';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 异步产物状态机（07 §P1）：计算中 / 成功 / 失败 / 过期 / 取消，以及**迟到结果不能覆盖当前状态**。
 *
 * 这些是并发相关的行为，必须用真实 Promise 时序断言，而不是只测同步分支。
 */

function payloadGraph(hex = '41414141'): ReturnType<typeof workflow> {
  return workflow({
    nodes: [wfNode('hex', NODE.hex, { hex }), wfNode('feed', NODE.feed)],
    edges: [wfEdge('hex', 'feed', 'data')],
    main: ['feed'],
  });
}

describe('产物状态机：基本流转', () => {
  it('从未编译时门禁关闭，并说明原因', () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));
    expect(tracker.state.status).toBe('idle');
    const gate = tracker.gate();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('编译');
  });

  it('编译成功后才放行，产物带当前修订号', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));
    const artifact = await tracker.compile();
    expect(artifact?.actions).toEqual([{ type: 'feed', hex: '41414141' }]);
    expect(tracker.state.status).toBe('ready');
    expect(tracker.gate()).toEqual({ ok: true });
    expect(tracker.state.artifact?.documentRevision).toBe(tracker.state.documentRevision);
  });

  it('语义编辑让产物过期，但保留产物以便对照', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));
    await tracker.compile();
    tracker.noteSemanticEdit();
    expect(tracker.state.status).toBe('stale');
    expect(tracker.state.artifact).toBeDefined();
    expect(tracker.gate().ok).toBe(false);
    expect(tracker.gate().reason).toContain('重新编译');
  });

  it('只改布局不会让产物过期（07 §P1：语义与布局分开记）', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));
    await tracker.compile();
    tracker.noteLayoutEdit();
    expect(tracker.state.status).toBe('ready');
    expect(tracker.gate().ok).toBe(true);
    expect(tracker.state.layoutRevision).toBe(1);
    expect(tracker.state.documentRevision).toBe(0);
  });

  it('编译失败时清空产物，门禁关闭', async () => {
    const broken = workflow({
      nodes: [wfNode('hex', NODE.hex, { hex: '41414141' }), wfNode('feed', NODE.feed)],
      main: ['feed'],
    });
    const tracker = createWorkflowTracker(() => ({ document: broken, context: WORKFLOW_CONTEXT }));
    const artifact = await tracker.compile();
    expect(artifact).toBeUndefined();
    expect(tracker.state.status).toBe('failed');
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.gate().ok).toBe(false);
    expect(tracker.state.issues.map((issue) => issue.code)).toContain('missing_input');
  });

  it('切题时清空并让在途请求失效', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));
    await tracker.compile();
    tracker.clear();
    expect(tracker.state.status).toBe('idle');
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.state.issues).toEqual([]);
  });
});

describe('产物状态机：竞态', () => {
  it('编译途中改图：旧请求的结果被丢弃，不会变成 ready', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));

    const pending = tracker.compile();
    expect(tracker.state.status).toBe('compiling');
    expect(tracker.gate().ok).toBe(false);

    // 用户在这期间改了图：在途请求必须失效。
    tracker.noteSemanticEdit();
    const artifact = await pending;

    expect(artifact).toBeUndefined();
    expect(tracker.state.status).not.toBe('ready');
    expect(tracker.gate().ok).toBe(false);
  });

  it('取消正在进行的编译：状态是 cancelled，且没有产物', async () => {
    const tracker = createWorkflowTracker(() => ({ document: payloadGraph(), context: WORKFLOW_CONTEXT }));

    const pending = tracker.compile();
    tracker.cancel();
    expect(tracker.state.status).toBe('cancelled');
    expect(await pending).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.gate().ok).toBe(false);
  });

  it('连续两次编译：先发起的请求即使后返回也不能覆盖后发起的结果', async () => {
    let current = payloadGraph('41414141');
    const tracker = createWorkflowTracker(() => ({ document: current, context: WORKFLOW_CONTEXT }));

    const pendingFirst = tracker.compile();
    // 第二次编译前图改成了另一份字节：两次请求的产物不同，才能断言谁生效。
    current = payloadGraph('42424242');
    const pendingSecond = tracker.compile();

    expect(await pendingSecond).toBeDefined();
    expect(await pendingFirst).toBeUndefined();
    expect(tracker.state.status).toBe('ready');
    expect(tracker.state.artifact?.actions[0]).toEqual({ type: 'feed', hex: '42424242' });
  });
});
