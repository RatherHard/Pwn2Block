import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PythonEvalResultSchema } from '@pwn2block/shared';
import type { PythonEvalRequest } from '@pwn2block/shared';
import { createPythonEvaluator } from '../src/python';
import type { PythonEvaluator } from '../src/python';

/**
 * 真实解释器与真实隔离后端（07 §P6「验证」）。
 *
 * 这里的用例**不会**被替身代跑：能用 `python3` 就真的起解释器，能连上 docker 就真的起容器。
 * 缺后端时整组 skip，并在报告里如实写「跳过」——跳过不等于通过。
 *
 * 请注意两组的差别：`process` 后端**没有**系统隔离，所以它那一组反过来断言「文件能读到」，
 * 把「我们不拿子进程当隔离证据」这句话钉在测试里。
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function request(overrides: Partial<PythonEvalRequest> = {}): PythonEvalRequest {
  return { code: 'result = 1', outputType: 'int', inputs: [], ...overrides };
}

/** 找一个能用的 Python 3 解释器；找不到返回 undefined（整组跳过）。 */
function findPython(): string | undefined {
  const override = process.env.PWN2BLOCK_TEST_PYTHON;
  const candidates = override === undefined
    ? (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
    : [override];
  for (const candidate of candidates) {
    try {
      const output = execFileSync(
        candidate,
        ['-I', '-S', '-B', '-c', 'import sys; print(sys.version_info[0])'],
        { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (Number.parseInt(output.trim(), 10) >= 3) return candidate;
    } catch {
      // 没装、是商店占位符或不是解释器：换下一个候选。
    }
  }
  return undefined;
}

/** docker 守护进程可用且镜像已在本地（不在测试里拉镜像，避免依赖网络）。 */
function dockerImageReady(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const PYTHON = findPython();
const IMAGE = process.env.PWN2BLOCK_PYTHON_IMAGE ?? 'python:3.12-alpine';
const DOCKER = dockerImageReady(IMAGE);

/**
 * 无限循环用例：确认「墙钟超时 → 杀掉 → 回 timeout」。
 *
 * Windows 在整仓并行测试时偶尔直接创建不出进程（Node 报成 `spawn_failed` → `unavailable`）。
 * 那不是超时语义的问题，所以只在「后端不可用」这种环境失败上重试；连试三次都起不来就明确
 * 报环境错误，绝不悄悄当通过，也不把跳过说成成功。
 */
async function expectTimeout(code: string): Promise<void> {
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const notes: string[] = [];
    const evaluator = createPythonEvaluator({
      env: {},
      backend: 'process',
      executable: PYTHON ?? 'python',
      timeoutMs: 1000,
      onDiagnostic: (note) => notes.push(`${note.event} ${note.detail ?? ''}`.trim()),
    });
    try {
      const started = Date.now();
      const result = await evaluator.evaluate(request({ code }));
      expect(Date.now() - started).toBeLessThan(8000);
      const outcome = result.ok ? 'ok' : result.error.code;
      attempts.push(notes.length === 0 ? outcome : `${outcome}（${notes.join('；')}）`);
      if (outcome !== 'unavailable') {
        expect(outcome, attempts.join(' → ')).toBe('timeout');
        return;
      }
    } finally {
      await evaluator.close();
    }
    await delay(250 * attempt);
  }
  throw new Error(`连续 ${attempts.length} 次都没能启动运行器进程（环境问题）：${attempts.join(' → ')}`);
}

describe.skipIf(PYTHON === undefined)('真实解释器（process 后端，不是隔离证据）', () => {
  let evaluator: PythonEvaluator;
  let workdir = '';

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'pwn2block-py-real-'));
    evaluator = createPythonEvaluator({
      env: {},
      backend: 'process',
      executable: PYTHON ?? 'python',
      timeoutMs: 8000,
    });
  });

  afterAll(async () => {
    await evaluator?.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('大整数往返不丢精度（2**100）', async () => {
    const result = await evaluator.evaluate(request({ code: 'result = 2 ** 100' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: (2n ** 100n).toString() });
  });

  it('输入整数不经 float：400 位十进制加一仍然精确', async () => {
    const digits = '9'.repeat(400);
    const result = await evaluator.evaluate(
      request({
        code: 'result = a + 1',
        inputs: [{ name: 'a', type: 'int', value: { kind: 'int', value: digits } }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: (BigInt(digits) + 1n).toString() });
  });

  it('bytes 与工具函数：p32 / cyclic / cyclic_find 与内置节点同一语义', async () => {
    const packed = await evaluator.evaluate(
      request({ code: 'result = p32(0xdeadbeef) + b"AB"', outputType: 'bytes' }),
    );
    expect(packed.ok).toBe(true);
    if (packed.ok) expect(packed.value).toEqual({ kind: 'bytes', hex: 'efbeadde4142' });

    const cyclic = await evaluator.evaluate(request({ code: 'result = cyclic(16)', outputType: 'text' }));
    expect(cyclic.ok).toBe(true);
    if (cyclic.ok) expect(cyclic.value).toEqual({ kind: 'text', text: 'aaaabaaacaaadaaa' });

    const offset = await evaluator.evaluate(request({ code: 'result = cyclic_find("baaa")' }));
    expect(offset.ok).toBe(true);
    if (offset.ok) expect(offset.value).toEqual({ kind: 'int', value: '4' });

    const missing = await evaluator.evaluate(
      request({
        code: 'result = cyclic_find(b"\\x00\\x01\\x02\\x03") is None',
        outputType: 'bool',
      }),
    );
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toEqual({ kind: 'bool', value: true });
  });

  it('语法错误带用户代码行号', async () => {
    const result = await evaluator.evaluate(request({ code: 'x = 1\ny =\n', outputType: 'int' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('syntax');
      expect(result.error.line).toBe(2);
    }
  });

  it('运行异常带行号，且不回传 traceback、宿主路径或环境', async () => {
    const result = await evaluator.evaluate(
      request({ code: 'a = 1\nb = 2\nraise ValueError("boom")\n' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('runtime');
      expect(result.error.line).toBe(3);
      expect(result.error.message).toContain('boom');
      expect(result.error.message).not.toContain('Traceback');
      expect(result.error.message).not.toContain('runner.py');
    }
  });

  it('没有给 result 赋值 → bad_output；类型不符 → bad_output', async () => {
    const missing = await evaluator.evaluate(request({ code: 'x = 1' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('bad_output');

    const mismatch = await evaluator.evaluate(request({ code: 'result = "text"', outputType: 'int' }));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('bad_output');
  });

  it('用户代码读不到宿主环境变量', async () => {
    const result = await evaluator.evaluate(request({ code: 'import os\nresult = len(os.environ)' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: '0' });
  });

  it('print 与协议输出分离：噪声不进结果，也不影响成功', async () => {
    const result = await evaluator.evaluate(
      request({ code: 'print("noise" * 100)\nresult = 7' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: '7' });
  });

  it('日志超限 → too_large', async () => {
    const result = await evaluator.evaluate(request({ code: 'print("x" * 6000)\nresult = 1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
  });

  it('每次求值都是新命名空间：上一次的全局变量不会漏过来', async () => {
    await evaluator.evaluate(request({ code: 'leak = 1\nresult = 1' }));
    const second = await evaluator.evaluate(
      request({ code: 'result = 1 if "leak" not in globals() else 2' }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toEqual({ kind: 'int', value: '1' });
  });

  it('死循环按墙钟超时并杀掉子进程', async () => {
    await expectTimeout('while True:\n    pass\n');
  });

  it('process 后端**不**限制文件访问——所以它不能被当成隔离（诚实记录）', async () => {
    const secretPath = join(workdir, 'secret.txt');
    writeFileSync(secretPath, 'host-secret-value', 'utf8');
    const code = `result = open(${JSON.stringify(secretPath)}, encoding="utf-8").read()`;
    const result = await evaluator.evaluate(request({ code, outputType: 'text' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'text', text: 'host-secret-value' });
    // 与上一条互为证据：能力查询必须同时自报「没隔离」。
    expect(evaluator.capability().isolated).toBe(false);
  });
});

describe.skipIf(!DOCKER)('docker 后端（真实隔离后端）', () => {
  let evaluator: PythonEvaluator;

  beforeAll(() => {
    evaluator = createPythonEvaluator({
      env: {},
      backend: 'docker',
      image: IMAGE,
      timeoutMs: 20_000,
    });
  });

  afterAll(async () => {
    await evaluator?.close();
  });

  it('能力查询报告 isolated:true', () => {
    expect(evaluator.capability()).toMatchObject({ available: true, backend: 'docker', isolated: true });
  });

  it('容器里能正常求值（大整数）', async () => {
    const result = await evaluator.evaluate(request({ code: 'result = 2 ** 100' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: (2n ** 100n).toString() });
  });

  it('容器里看不到环境变量', async () => {
    const result = await evaluator.evaluate(request({ code: 'import os\nresult = len(os.environ)' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'int', value: '0' });
  });

  it('根文件系统只读：写文件失败', async () => {
    const result = await evaluator.evaluate(
      request({ code: 'open("/pwn2block-write-test", "w").write("x")\nresult = 1' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('runtime');
  });

  it('--network=none：连不出去', async () => {
    const code = [
      'import socket',
      'socket.create_connection(("1.1.1.1", 80), timeout=2)',
      'result = 1',
    ].join('\n');
    const result = await evaluator.evaluate(request({ code }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('runtime');
  });

  it('超时会杀掉容器里的任务', async () => {
    const quick = createPythonEvaluator({
      env: {},
      backend: 'docker',
      image: IMAGE,
      timeoutMs: 1500,
    });
    try {
      const started = Date.now();
      const result = await quick.evaluate(request({ code: 'while True:\n    pass\n' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(20_000);
      await delay(10);
    } finally {
      await quick.close();
    }
  });

  it('结果仍然符合 PythonEvalResult', async () => {
    const result = await evaluator.evaluate(request({ code: 'result = 9' }));
    expect(PythonEvalResultSchema.safeParse(result).success).toBe(true);
  });
});
