import { describe, expect, it } from 'vitest';
import { ALPHABETS, NODE, bytesToHex, cyclicFind } from '@pwn2block/shared';
import type { PythonEvalRequest } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import { createHttpPython } from '../src/workflow/python-evaluator';
import type { PythonEvalResult } from '../src/workflow/types';
import { WORKFLOW_CONTEXT, fakePython, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * Python 节点与定位序列（06 §6；07 §P7 验证项）。
 *
 * 断言三件事：请求带的是**显式命名输入**（值编码与类型都对）、未选中的路径不发请求、
 * 循环里每轮按当前输入重新求值；另外验证内置定位序列工具与 Python 侧同一组语义。
 */

async function compile(
  document: ReturnType<typeof workflow>,
  context: ReturnType<typeof fakePython>['context'],
  signal?: AbortSignal,
) {
  return compileGraph({ document, context, documentRevision: 1, ...(signal === undefined ? {} : { signal }) });
}

function actionsOf(outcome: Awaited<ReturnType<typeof compileGraph>>) {
  if (!outcome.ok) throw new Error(`编译失败：${outcome.issues.map((issue) => issue.message).join('; ')}`);
  return outcome.artifact.actions;
}

function issueCodes(outcome: Awaited<ReturnType<typeof compileGraph>>): readonly string[] {
  return outcome.ok ? [] : outcome.issues.map((issue) => issue.code);
}

const BYTES = { kind: 'bytes' as const, hex: '4142' };

describe('Python 节点', () => {
  it('把命名输入编码后发给求值器，结果参与动作生成', async () => {
    const python = fakePython(() => ({ ok: true, value: BYTES }));
    const document = workflow({
      nodes: [
        wfNode('hex', NODE.hex, { hex: '4142' }),
        wfNode('py', NODE.python, { code: 'result = a', outputType: 'bytes', inputs: ['a:bytes'] }),
        wfNode('write', NODE.write, { addr: 0x400000 }),
      ],
      edges: [wfEdge('hex', 'py', 'a'), wfEdge('py', 'write', 'data')],
      main: ['write'],
    });
    expect(actionsOf(await compile(document, python.context))).toEqual([
      { type: 'write_bytes', addr: '0x400000', hex: '4142' },
    ]);
    expect(python.calls).toHaveLength(1);
    const request = python.calls[0] as PythonEvalRequest;
    expect(request.outputType).toBe('bytes');
    expect(request.inputs).toEqual([{ name: 'a', type: 'bytes', value: { kind: 'bytes', hex: '4142' } }]);
  });

  it('没有求值器时明确报不可用，不会退回本地执行', async () => {
    const document = workflow({
      nodes: [wfNode('py', NODE.python, { code: 'result = 1', outputType: 'int' }), wfNode('run', NODE.run)],
      main: ['run'],
      edges: [wfEdge('py', 'run', 'maxSteps')],
    });
    expect(issueCodes(await compile(document, WORKFLOW_CONTEXT))).toContain('python_unavailable');
  });

  it('未选中的分支不发起求值请求', async () => {
    const python = fakePython(() => ({ ok: true, value: BYTES }));
    const document = workflow({
      nodes: [
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 2 }),
        wfNode('py', NODE.python, { code: 'result = a', outputType: 'bytes', inputs: ['a:bytes'] }),
        wfNode('hex', NODE.hex, { hex: '4142' }),
        wfNode('write', NODE.write, { addr: 0x400000 }),
        wfNode('if', NODE.if, {}, { then: ['write'], else: [] }),
      ],
      edges: [
        wfEdge('hex', 'py', 'a'),
        wfEdge('py', 'write', 'data'),
        wfEdge('cmp', 'if', 'cond'),
      ],
      main: ['if'],
    });
    expect(actionsOf(await compile(document, python.context))).toEqual([]);
    expect(python.calls).toHaveLength(0);
  });

  it('循环里每轮按当前输入重新求值', async () => {
    const python = fakePython((request) => ({ ok: true, value: request.inputs[0]?.value ?? { kind: 'int', value: '0' } }));
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 2 }, { body: ['idx', 'py', 'push'] }),
        wfNode('idx', NODE.index),
        wfNode('py', NODE.python, { code: 'result = a', outputType: 'int', inputs: ['a:int'] }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('idx', 'py', 'a'), wfEdge('py', 'push', 'value')],
      main: ['rep'],
    });
    expect(actionsOf(await compile(document, python.context))).toEqual([
      { type: 'push', value: '0x0' },
      { type: 'push', value: '0x1' },
    ]);
    expect(python.calls.map((request) => request.inputs[0]?.value)).toEqual([
      { kind: 'int', value: '0' },
      { kind: 'int', value: '1' },
    ]);
  });

  it('Python 报错带行号，定位到节点', async () => {
    const python = fakePython(() => ({
      ok: false,
      error: { code: 'runtime', message: 'division by zero', line: 3 },
    }));
    const document = workflow({
      nodes: [wfNode('py', NODE.python, { code: 'x = 1 / 0\nresult = x', outputType: 'int' }), wfNode('run', NODE.run)],
      edges: [wfEdge('py', 'run', 'maxSteps')],
      main: ['run'],
    });
    const outcome = await compile(document, python.context);
    expect(issueCodes(outcome)).toContain('python_failed');
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toContain('第 3 行');
    expect(outcome.issues[0]?.nodeId).toBe('py');
  });

  it('取消信号让整次编译报 cancelled，不发布部分产物', async () => {
    const python = fakePython(() => {
      throw new Error('aborted');
    });
    const controller = new AbortController();
    controller.abort();
    const document = workflow({
      nodes: [wfNode('py', NODE.python, { code: 'result = 1', outputType: 'int' }), wfNode('run', NODE.run)],
      edges: [wfEdge('py', 'run', 'maxSteps')],
      main: ['run'],
    });
    expect(issueCodes(await compile(document, python.context, controller.signal))).toContain('cancelled');
  });
});

describe('定位序列工具', () => {
  it('内置「查找序列偏移」与共享工具同语义', async () => {
    const needle = 'baaa';
    const expected = cyclicFind(new TextEncoder().encode(needle), ALPHABETS.lower);
    expect(expected).toBe(4);
    const bytes = new TextEncoder().encode(needle);
    const document = workflow({
      nodes: [
        wfNode('needle', NODE.hex, { hex: bytesToHex(bytes) }),
        wfNode('find', NODE.find, { alphabet: 'lower' }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('needle', 'find', 'needle'), wfEdge('find', 'push', 'value')],
      main: ['push'],
    });
    expect(actionsOf(await compile(document, WORKFLOW_CONTEXT))).toEqual([
      { type: 'push', value: `0x${expected.toString(16)}` },
    ]);
    expect(bytesToHex(bytes)).toBe(bytesToHex(new TextEncoder().encode(needle)));
  });
});

describe('HTTP 求值器', () => {
  it('成功响应先过 Schema 再返回', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ ok: true, value: BYTES }), { status: 200 });
    }) as unknown as typeof fetch;
    const evaluator = createHttpPython({ fetchImpl });
    const result = await evaluator.evaluate({ code: 'result = a', outputType: 'bytes', inputs: [] });
    expect(result).toEqual({ ok: true, value: BYTES });
    expect(calls[0]?.url).toBe('/api/python/eval');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ code: 'result = a', outputType: 'bytes', inputs: [] });
  });

  it('HTTP 错误与坏响应都变成节点级错误码', async () => {
    const quota = createHttpPython({
      fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
    });
    expect(await quota.evaluate({ code: 'result = 1', outputType: 'int', inputs: [] })).toEqual({
      ok: false,
      error: { code: 'quota', message: '求值服务返回 HTTP 429' },
    });
    const bad = createHttpPython({
      fetchImpl: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    });
    const result = await bad.evaluate({ code: 'result = 1', outputType: 'int', inputs: [] });
    expect(result.ok).toBe(false);
  });

  it('网络失败说明「不可用」，不假装成功', async () => {
    const evaluator = createHttpPython({
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    const result: PythonEvalResult = await evaluator.evaluate({ code: 'result = 1', outputType: 'int', inputs: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
  });

  it('取消请求映射为 cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const evaluator = createHttpPython({
      signal: controller.signal,
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as unknown as typeof fetch,
    });
    const result = await evaluator.evaluate({ code: 'result = 1', outputType: 'int', inputs: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cancelled');
  });
});
