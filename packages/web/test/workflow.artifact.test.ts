import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import type { PythonEvalRequest } from '@pwn2block/shared';
import { createWorkflowTracker } from '../src/workflow/artifact';
import type { PythonEvalResult, WorkflowContext } from '../src/workflow/types';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 异步产物状态机（07 §P1）：计算中 / 成功 / 失败 / 过期 / 取消，以及**迟到结果不能覆盖当前状态**。
 *
 * 这些是并发相关的行为，必须用真实 Promise 时序断言，而不是只测同步分支。
 */

interface Deferred {
  readonly promise: Promise<PythonEvalResult>;
  resolve(result: PythonEvalResult): void;
}

function deferred(): Deferred {
  let resolve!: (result: PythonEvalResult) => void;
  const promise = new Promise<PythonEvalResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function payloadGraph(): ReturnType<typeof workflow> {
  return workflow({
    nodes: [wfNode('hex', NODE.hex, { hex: '41414141' }), wfNode('feed', NODE.feed)],
    edges: [wfEdge('hex', 'feed', 'data')],
    main: ['feed'],
  });
}

function pythonGraph(): ReturnType<typeof workflow> {
  return workflow({
    nodes: [wfNode('py', NODE.python, { code: 'result = b"A"', outputType: 'bytes', inputs: [] })],
    main: ['py'],
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
    const gate = deferred();
    const context: WorkflowContext = {
      ...WORKFLOW_CONTEXT,
      python: { evaluate: () => gate.promise },
    };
    const tracker = createWorkflowTracker(() => ({ document: pythonGraph(), context }));

    const pending = tracker.compile();
    expect(tracker.state.status).toBe('compiling');
    expect(tracker.gate().ok).toBe(false);

    // 用户在这期间改了图：在途请求必须失效。
    tracker.noteSemanticEdit();
    gate.resolve({ ok: true, value: { kind: 'bytes', hex: '41' } });
    const artifact = await pending;

    expect(artifact).toBeUndefined();
    expect(tracker.state.status).not.toBe('ready');
    expect(tracker.gate().ok).toBe(false);
  });

  it('取消正在进行的编译：状态是 cancelled，且没有产物', async () => {
    const gate = deferred();
    const context: WorkflowContext = { ...WORKFLOW_CONTEXT, python: { evaluate: () => gate.promise } };
    const tracker = createWorkflowTracker(() => ({ document: pythonGraph(), context }));

    const pending = tracker.compile();
    tracker.cancel();
    expect(tracker.state.status).toBe('cancelled');
    gate.resolve({ ok: true, value: { kind: 'bytes', hex: '41' } });
    expect(await pending).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.gate().ok).toBe(false);
  });

  it('连续两次编译：先发起的请求即使后返回也不能覆盖后发起的结果', async () => {
    const first = deferred();
    const second = deferred();
    const requests: PythonEvalRequest[] = [];
    const context: WorkflowContext = {
      ...WORKFLOW_CONTEXT,
      python: {
        evaluate: (request) => {
          requests.push(request);
          return requests.length === 1 ? first.promise : second.promise;
        },
      },
    };
    const tracker = createWorkflowTracker(() => ({ document: pythonGraph(), context }));

    const pendingFirst = tracker.compile();
    const pendingSecond = tracker.compile();
    expect(requests).toHaveLength(2);

    second.resolve({ ok: true, value: { kind: 'bytes', hex: '42' } });
    expect(await pendingSecond).toBeDefined();
    first.resolve({ ok: true, value: { kind: 'bytes', hex: '41' } });
    expect(await pendingFirst).toBeUndefined();
    expect(tracker.state.status).toBe('ready');
    expect(tracker.state.artifact?.previews[0]?.hex).toBe('42');
  });
});
