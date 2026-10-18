import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CapabilitiesResponseSchema,
  PythonEvalResultSchema,
} from '@pwn2block/shared';
import type { PythonEvalRequest } from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import { createPythonEvaluator } from '../src/python';
import type { PythonEvaluator, PythonEvaluatorConfig } from '../src/python';
import { expectApiError } from './support';

/**
 * Python 求值入口（06 §6、07 §P6）的服务端行为。
 *
 * 求值器是**真的**在起子进程：`process` 后端 + 一个 Node 桩运行器（`python-stub-runner.mjs`），
 * 排队、超时、kill、协议解析、类型校验全走被测代码，没有替身。真实 Python 语义由
 * `python-real.test.ts` 覆盖，隔离强度由该文件里的 docker 用例覆盖（缺后端时跳过并如实报告）。
 */

const STUB = fileURLToPath(new URL('./python-stub-runner.js', import.meta.url));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stubEvaluator(
  scenario: string,
  overrides: Partial<PythonEvaluatorConfig> = {},
): PythonEvaluator {
  return createPythonEvaluator({
    env: {},
    backend: 'process',
    command: [process.execPath, STUB, scenario],
    timeoutMs: 2000,
    ...overrides,
  });
}

function request(overrides: Partial<PythonEvalRequest> = {}): PythonEvalRequest {
  return { code: 'result = 1', outputType: 'int', inputs: [], ...overrides };
}

describe('后端选择与能力查询（07 §P6）', () => {
  it('默认不可用：没有配置就是 none，绝不退化成宿主直接执行', async () => {
    const evaluator = createPythonEvaluator({ env: {} });
    const capability = evaluator.capability();
    expect(capability).toMatchObject({ available: false, backend: 'none', isolated: false });
    expect(capability.reason).toBeTruthy();

    const result = await evaluator.evaluate(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unavailable');
    await evaluator.close();
  });

  it('docker 后端报告已隔离，process 后端不冒充隔离', () => {
    const docker = createPythonEvaluator({ env: { PWN2BLOCK_PYTHON_BACKEND: 'docker' } });
    expect(docker.capability()).toEqual({ available: true, backend: 'docker', isolated: true });

    const processBackend = createPythonEvaluator({
      env: { PWN2BLOCK_PYTHON_BACKEND: 'process' },
    });
    const capability = processBackend.capability();
    expect(capability).toMatchObject({ available: true, backend: 'process', isolated: false });
    // 必须自己说明「这是开发用后端，不是隔离证据」（07 §2）。
    expect(capability.reason).toContain('隔离');
  });

  it('非法后端取值落成不可用并说明原因，而不是猜一个后端', () => {
    const evaluator = createPythonEvaluator({ env: { PWN2BLOCK_PYTHON_BACKEND: 'nsjail' } });
    const capability = evaluator.capability();
    expect(capability.available).toBe(false);
    expect(capability.backend).toBe('none');
    expect(capability.reason).toContain('docker');
  });

  it('运行器启动失败 → 后端标记不可用，后续请求直接回 unavailable', async () => {
    const evaluator = createPythonEvaluator({
      env: {},
      backend: 'process',
      command: ['pwn2block-python-does-not-exist-xyz'],
      timeoutMs: 1000,
    });
    const first = await evaluator.evaluate(request());
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe('unavailable');
    expect(evaluator.capability().available).toBe(false);

    const second = await evaluator.evaluate(request());
    if (!second.ok) expect(second.error.code).toBe('unavailable');
    await evaluator.close();
  });
});

describe('协议与结果校验', () => {
  it('成功：任务经 stdin 送到运行器，结果符合 PythonEvalResult', async () => {
    const evaluator = stubEvaluator('success');
    const result = await evaluator.evaluate(request({ code: 'result = 1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: 'int', value: '10' });
      expect(PythonEvalResultSchema.safeParse(result).success).toBe(true);
    }
    await evaluator.close();
  });

  it('声明的输出类型与实际不符 → bad_output', async () => {
    const evaluator = stubEvaluator('wrong-type');
    const result = await evaluator.evaluate(request({ outputType: 'int' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('bad_output');
      expect(result.error.message).toContain('bytes');
    }
    await evaluator.close();
  });

  it('requestId 对不上视为迟到：丢弃，不把别人的值当成这次结果', async () => {
    const evaluator = stubEvaluator('late');
    const result = await evaluator.evaluate(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('bad_output');
      expect(result.error.message).not.toContain('999');
    }
    await evaluator.close();
  });

  it('坏 JSON / 多行 / 没有输出 / 崩溃 都是 bad_output', async () => {
    for (const scenario of ['bad-json', 'two-lines', 'silent', 'crash']) {
      const evaluator = stubEvaluator(scenario);
      const result = await evaluator.evaluate(request());
      expect(result.ok, scenario).toBe(false);
      if (!result.ok) expect(result.error.code, scenario).toBe('bad_output');
      await evaluator.close();
    }
  });

  it('值本身超限 → too_large（服务端第二道检查）', async () => {
    const evaluator = stubEvaluator('oversize');
    const result = await evaluator.evaluate(request({ outputType: 'bytes' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
    await evaluator.close();
  });

  it('运行器输出洪水 → 杀掉并回 too_large，不会把 200KB 读进内存再判断', async () => {
    const evaluator = stubEvaluator('flood');
    const result = await evaluator.evaluate(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
    await evaluator.close();
  });

  it('运行器报告的节点级错误原样传回（code / message / line）', async () => {
    const evaluator = stubEvaluator('error');
    const result = await evaluator.evaluate(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'runtime',
        message: '桩运行器报告运行错误',
        line: 2,
      });
    }
    expect(PythonEvalResultSchema.safeParse(result).success).toBe(true);
    await evaluator.close();
  });
});

describe('配额、超时与取消', () => {
  it('超时回 timeout 并真的杀掉子进程', async () => {
    const evaluator = stubEvaluator('sleep', { timeoutMs: 120 });
    const started = Date.now();
    const result = await evaluator.evaluate(request());
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
    // 杀掉是异步的，但绝不能把 2s 的默认超时跑满。
    expect(elapsed).toBeLessThan(3000);
    await evaluator.close();
  });

  it('并发已满且排队已满 → quota', async () => {
    const evaluator = stubEvaluator('sleep', { maxConcurrent: 1, queueLimit: 1, timeoutMs: 10_000 });
    const controller = new AbortController();
    const running = evaluator.evaluate(request(), controller.signal);
    const queued = evaluator.evaluate(request(), controller.signal);
    const rejected = await evaluator.evaluate(request());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('quota');

    controller.abort();
    const results = await Promise.all([running, queued]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('cancelled');
    }
    await evaluator.close();
  });

  it('并发上限之内前两个立刻跑，第三个排队（不是立刻 quota）', async () => {
    const evaluator = stubEvaluator('sleep', { maxConcurrent: 2, queueLimit: 4, timeoutMs: 10_000 });
    const controller = new AbortController();
    const first = evaluator.evaluate(request(), controller.signal);
    const second = evaluator.evaluate(request(), controller.signal);
    await delay(50);

    let settled = false;
    const third = evaluator.evaluate(request(), controller.signal).then((result) => {
      settled = true;
      return result;
    });
    await delay(100);
    expect(settled).toBe(false);

    controller.abort();
    const results = await Promise.all([first, second, third]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('cancelled');
    }
    await evaluator.close();
  });

  it('AbortSignal 取消：立刻回 cancelled，不等超时', async () => {
    const evaluator = stubEvaluator('sleep', { timeoutMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = evaluator.evaluate(request(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
    await evaluator.close();
  });

  it('关闭后不再接受求值，close() 自己不会挂住', async () => {
    const evaluator = stubEvaluator('success', { timeoutMs: 1000 });
    const running = evaluator.evaluate(request());
    await evaluator.close();
    const after = await evaluator.evaluate(request());
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('unavailable');
    // 关闭时正在跑的那次不能被吞掉：它要么成功、要么被取消，但一定要 settle。
    const result = await running;
    expect(typeof result.ok).toBe('boolean');
  });
});

describe('HTTP 接口（04 §5 风格）', () => {
  let challengeDir = '';

  beforeAll(() => {
    challengeDir = mkdtempSync(join(tmpdir(), 'pwn2block-python-'));
  });

  afterAll(() => {
    rmSync(challengeDir, { recursive: true, force: true });
  });

  function optionsWith(
    python: PythonEvaluatorConfig,
    overrides: Partial<BuildAppOptions> = {},
  ): BuildAppOptions {
    return { env: {}, challengeDir, serveStatic: false, python, ...overrides };
  }

  async function withApp(
    options: BuildAppOptions,
    run: (app: FastifyInstance) => Promise<void>,
  ): Promise<void> {
    const app = buildApp(options);
    try {
      await run(app);
    } finally {
      await app.close();
    }
  }

  it('GET /api/capabilities 暴露前端要的三件事', async () => {
    await withApp(optionsWith({ backend: 'process' }), async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/capabilities' });
      expect(response.statusCode).toBe(200);
      const parsed = CapabilitiesResponseSchema.parse(response.json());
      expect(parsed.python).toMatchObject({ available: true, backend: 'process', isolated: false });
    });
  });

  it('POST /api/python/eval 成功返回 PythonEvalResult，且不需要会话', async () => {
    await withApp(
      optionsWith({ backend: 'process', command: [process.execPath, STUB, 'success'] }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/python/eval',
          payload: request({ code: 'result = 1' }),
        });
        expect(response.statusCode).toBe(200);
        const parsed = PythonEvalResultSchema.parse(response.json());
        expect(parsed).toMatchObject({ ok: true, value: { kind: 'int', value: '10' } });
        expect(parsed.ok && typeof parsed.durationMs).toBe('number');
        // 协议细节（requestId、stdout 行）不外泄。
        expect(response.json()).not.toHaveProperty('requestId');
        expect(response.json()).not.toHaveProperty('stdout');
      },
    );
  });

  it('求值失败是结果不是 HTTP 错误：仍然 200，带节点级错误码', async () => {
    await withApp(
      optionsWith({ backend: 'process', command: [process.execPath, STUB, 'error'] }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/python/eval',
          payload: request(),
        });
        expect(response.statusCode).toBe(200);
        const parsed = PythonEvalResultSchema.parse(response.json());
        expect(parsed.ok).toBe(false);
      },
    );
  });

  it('后端不可用时回 ok:false + unavailable，绝不尝试执行', async () => {
    await withApp(optionsWith({ backend: 'none' }), async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/python/eval',
        payload: request(),
      });
      expect(response.statusCode).toBe(200);
      const parsed = PythonEvalResultSchema.parse(response.json());
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('unavailable');
    });
  });

  it('请求体不合法走 ApiError 400：多余字段、空代码、未知类型、想提高额度', async () => {
    await withApp(optionsWith({ backend: 'none' }), async (app) => {
      const bodies: Record<string, unknown>[] = [
        { ...request(), extra: 1 },
        { ...request(), code: '' },
        { ...request(), outputType: 'object' },
        { ...request(), timeoutMs: 999_999 },
        { ...request(), inputs: [{ name: 'A', type: 'int', value: { kind: 'int', value: '1' } }] },
      ];
      for (const payload of bodies) {
        const response = await app.inject({ method: 'POST', url: '/api/python/eval', payload });
        expectApiError(response, 'invalid_request');
      }
    });
  });

  it('关闭服务时调用 evaluator.close()', async () => {
    const calls: string[] = [];
    const fake: PythonEvaluator = {
      evaluate: async () => ({ ok: false, error: { code: 'unavailable', message: '替身' } }),
      capability: () => ({ available: false, backend: 'none', isolated: false, reason: '替身' }),
      close: async () => {
        calls.push('close');
      },
    };
    const app = buildApp({ env: {}, challengeDir, serveStatic: false, pythonEvaluator: fake });
    await app.close();
    expect(calls).toEqual(['close']);
  });
});
