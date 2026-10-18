import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PYTHON_EVAL_MEMORY_MB,
  PYTHON_EVAL_TIMEOUT_MS,
  PYTHON_MAX_CONCURRENT,
  PYTHON_MAX_INT_DIGITS,
  PYTHON_MAX_OUTPUT_BYTES,
  PYTHON_QUEUE_LIMIT,
  PythonEvalRequestSchema,
  PythonRunnerResultSchema,
  outputTypeMismatch,
} from '@pwn2block/shared';
import type {
  EncodedValue,
  PythonBackend,
  PythonCapability,
  PythonEvalErrorCode,
  PythonEvalJob,
  PythonEvalRequest,
  PythonEvalResult,
  PythonRunnerResult,
} from '@pwn2block/shared';

/**
 * Python 求值入口（06 §6、07 §P6）。
 *
 * 这一层只做「服务端该做的事」：选后端、限额、排队、超时、取消、协议校验。真正的 Python
 * 语义在 `packages/python-runner/runner.py`，隔离强度由 `docker` 与 `process` 后端的差别决定。
 *
 * 三条不可妥协的约定：
 * - **默认不可用**：没配置 `PWN2BLOCK_PYTHON_BACKEND` 就是 `none`，`evaluate` 直接回
 *   `unavailable`，绝不退化成在宿主进程里直接执行（07 §P6）。
 * - **结果只从协议来**：运行器 stdout 必须是**一行**符合 `PythonRunnerResultSchema` 的 JSON，
 *   `requestId` 对不上就丢弃；类型、大小、请求标识全部在服务端再校验一遍。
 * - **普通子进程不是隔离证据**（07 §2）：`process` 后端的 `capability().isolated` 恒为 false，
 *   只有 `docker` 后端才是 true。
 */

/** 运行器 stdout 上限：协议行本身很小，留 8 倍余量挡住失控的运行器；超了就杀进程。 */
const MAX_RUNNER_STDOUT_BYTES = PYTHON_MAX_OUTPUT_BYTES * 8;
/** 运行器 stderr 只用于诊断，永不出现在响应里；只留最后 8KB。 */
const MAX_RUNNER_STDERR_BYTES = 8 * 1024;

const DEFAULT_IMAGE = 'python:3.12-alpine';
const DEFAULT_DOCKER = 'docker';
const DEFAULT_EXECUTABLE = 'python3';
const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('../../python-runner/runner.py', import.meta.url));

const DOCKER_CPUS = '0.5';
const DOCKER_PIDS_LIMIT = '64';
/** 容器里的 nobody：`--read-only` 之外再降权，任务之间不共享可写状态（07 §P6）。 */
const DOCKER_USER = '65534:65534';

const MESSAGES = {
  unavailable: 'Python 求值不可用',
  queueFull: 'Python 求值队列已满，请稍后再试',
  cancelled: 'Python 求值已取消',
  closed: '服务已关闭，Python 求值不可用',
  badOutput: '运行器输出不符合协议',
} as const;

export interface PythonDiagnostic {
  readonly event: string;
  readonly message: string;
  /** 仅用于服务端日志：可能含路径等内部信息，绝不出现在响应里。 */
  readonly detail?: string;
}

export interface PythonEvaluatorConfig {
  /** 环境变量表，默认 `process.env`；后端与镜像都从这里读。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 覆盖 `PWN2BLOCK_PYTHON_BACKEND`（测试用）。 */
  readonly backend?: PythonBackend;
  /** docker 镜像，默认 `PWN2BLOCK_PYTHON_IMAGE` 或 `python:3.12-alpine`。 */
  readonly image?: string;
  /** docker 命令，默认 `PWN2BLOCK_PYTHON_DOCKER` 或 `docker`。 */
  readonly dockerCommand?: string;
  /** `process` 后端的解释器，默认 `PWN2BLOCK_PYTHON_EXECUTABLE` 或 `python3`。 */
  readonly executable?: string;
  /** 运行器脚本路径，默认本仓库的 `packages/python-runner/runner.py`。 */
  readonly runnerPath?: string;
  /**
   * 完整 argv 覆盖（测试注入桩运行器）。给了它就不再拼 docker / process 的命令行，
   * 但排队、超时、取消、协议校验这些**被测逻辑**仍然照常执行。
   */
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  readonly maxConcurrent?: number;
  readonly queueLimit?: number;
  readonly now?: () => number;
  /** 诊断出口（接 fastify logger）；不接就静默，绝不 console.log。 */
  readonly onDiagnostic?: (diagnostic: PythonDiagnostic) => void;
}

export interface PythonEvaluator {
  evaluate(request: PythonEvalRequest, signal?: AbortSignal): Promise<PythonEvalResult>;
  capability(): PythonCapability;
  close(): Promise<void>;
}

type SlotDecision = 'granted' | 'quota' | 'cancelled';

interface Waiter {
  readonly grant: () => void;
  readonly drop: () => void;
}

/** 一次子进程运行的结局。`exited` 之外都不需要解析 stdout。 */
interface ChildRun {
  readonly kind: 'exited' | 'timeout' | 'cancelled' | 'overflow' | 'spawn_failed';
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly detail?: string;
}

interface RunOptions {
  readonly job: PythonEvalJob;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function failure(code: PythonEvalErrorCode, message: string): PythonEvalResult {
  return { ok: false, error: { code, message } };
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Python 求值配置 ${name} 必须是正整数，收到 ${String(value)}`);
  }
  return value;
}

/** 环境变量或显式配置 → 后端名。非法取值一律落成 `none`，并给出原因（不抛错，服务要能起来）。 */
function resolveBackend(
  env: Readonly<Record<string, string | undefined>>,
  override?: PythonBackend,
): { backend: PythonBackend; reason?: string } {
  const raw = override ?? env.PWN2BLOCK_PYTHON_BACKEND ?? 'none';
  if (raw === 'none') {
    return {
      backend: 'none',
      reason: '未配置 Python 求值后端（PWN2BLOCK_PYTHON_BACKEND），Python 节点不可用',
    };
  }
  if (raw === 'docker') return { backend: 'docker' };
  if (raw === 'process') {
    return {
      backend: 'process',
      reason: '已启用开发用子进程后端：它不提供系统隔离，不能作为隔离证据（07 §2）',
    };
  }
  return {
    backend: 'none',
    reason: `PWN2BLOCK_PYTHON_BACKEND 取值不合法，只支持 docker / process / none`,
  };
}

/** 容器名：requestId 是服务端生成的 hex，只含安全字符；带上它才能按名字 kill。 */
function containerName(requestId: string): string {
  return `pwn2block-python-${requestId}`;
}

/** 值的大小与整数位数检查：运行器自己也会拦，这里是服务端的第二道。 */
function valueProblem(value: EncodedValue): string | undefined {
  if (value.kind === 'int') {
    if (value.value.replace('-', '').length > PYTHON_MAX_INT_DIGITS) {
      return `整数输出超过 ${PYTHON_MAX_INT_DIGITS} 位十进制数字`;
    }
    return undefined;
  }
  if (value.kind === 'bytes') {
    const length = value.hex.length / 2;
    return length > PYTHON_MAX_OUTPUT_BYTES ? `字节输出超过 ${PYTHON_MAX_OUTPUT_BYTES} 字节` : undefined;
  }
  if (value.kind === 'text') {
    const length = Buffer.byteLength(value.text, 'utf8');
    return length > PYTHON_MAX_OUTPUT_BYTES ? `文本输出超过 ${PYTHON_MAX_OUTPUT_BYTES} 字节` : undefined;
  }
  return undefined;
}

type LineParse =
  | { readonly ok: true; readonly result: PythonRunnerResult }
  | { readonly ok: false; readonly message: string };

/** stdout → 协议结果。**只接受一行**：多行说明用户输出混进来了，整次求值按失败处理。 */
function parseRunnerLine(stdout: string): LineParse {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, message: '运行器没有返回结果' };
  if (lines.length > 1) return { ok: false, message: '运行器输出不止一行' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(lines[0] as string);
  } catch {
    return { ok: false, message: '运行器输出不是合法 JSON' };
  }
  const parsed = PythonRunnerResultSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, message: MESSAGES.badOutput };
  return { ok: true, result: parsed.data };
}

/** 有上限的字节缓冲：溢出后停止累积并标记，避免恶意输出吃满内存。 */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private readonly limit: number;
  private size = 0;
  private full = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 返回 false 表示已溢出（调用方据此判定 too_large）。 */
  push(chunk: Buffer): boolean {
    if (this.full) return false;
    if (this.size + chunk.length > this.limit) {
      this.full = true;
      this.chunks.length = 0;
      return false;
    }
    this.size += chunk.length;
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

class PythonEvaluatorImpl implements PythonEvaluator {
  private readonly backend: PythonBackend;
  private readonly baseCapability: PythonCapability;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly image: string;
  private readonly dockerCommand: string;
  private readonly executable: string;
  private readonly runnerPath: string;
  private readonly command: readonly string[] | undefined;
  private readonly timeoutMs: number;
  private readonly memoryMb: number;
  private readonly maxConcurrent: number;
  private readonly queueLimit: number;
  private readonly now: () => number;
  private readonly onDiagnostic: ((diagnostic: PythonDiagnostic) => void) | undefined;

  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly children = new Set<ChildProcess>();
  private readonly containers = new Set<string>();
  private closed = false;
  private unavailableReason: string | undefined;

  constructor(config: PythonEvaluatorConfig) {
    this.env = config.env ?? process.env;
    const resolved = resolveBackend(this.env, config.backend);
    this.backend = resolved.backend;
    this.image = config.image ?? this.env.PWN2BLOCK_PYTHON_IMAGE ?? DEFAULT_IMAGE;
    this.dockerCommand = config.dockerCommand ?? this.env.PWN2BLOCK_PYTHON_DOCKER ?? DEFAULT_DOCKER;
    this.executable = config.executable ?? this.env.PWN2BLOCK_PYTHON_EXECUTABLE ?? DEFAULT_EXECUTABLE;
    this.runnerPath = config.runnerPath ?? DEFAULT_RUNNER_PATH;
    this.command = config.command;
    this.timeoutMs = positive(config.timeoutMs ?? PYTHON_EVAL_TIMEOUT_MS, 'timeoutMs');
    this.memoryMb = positive(config.memoryMb ?? PYTHON_EVAL_MEMORY_MB, 'memoryMb');
    this.maxConcurrent = positive(config.maxConcurrent ?? PYTHON_MAX_CONCURRENT, 'maxConcurrent');
    this.queueLimit = positive(config.queueLimit ?? PYTHON_QUEUE_LIMIT, 'queueLimit');
    this.now = config.now ?? Date.now;
    this.onDiagnostic = config.onDiagnostic;
    this.baseCapability = {
      available: resolved.backend !== 'none',
      backend: resolved.backend,
      // 只有容器后端才算「有隔离」；普通子进程永远不是证据（07 §2）。
      isolated: resolved.backend === 'docker',
      ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
    };
  }

  capability(): PythonCapability {
    if (this.closed) {
      return { available: false, backend: this.backend, isolated: false, reason: MESSAGES.closed };
    }
    if (this.unavailableReason !== undefined) {
      return {
        available: false,
        backend: this.backend,
        isolated: false,
        reason: this.unavailableReason,
      };
    }
    return this.baseCapability;
  }

  async evaluate(request: PythonEvalRequest, signal?: AbortSignal): Promise<PythonEvalResult> {
    const capability = this.capability();
    if (!capability.available) return failure('unavailable', capability.reason ?? MESSAGES.unavailable);

    // 路由已经用 Schema 校验过，这里再校验一次：这个入口自身也必须是封闭的（不可信输入）。
    const parsed = PythonEvalRequestSchema.safeParse(request);
    if (!parsed.success) return failure('invalid_request', 'Python 求值请求不符合协议');

    const slot = await this.reserve(signal);
    if (slot !== 'granted') {
      return slot === 'quota' ? failure('quota', MESSAGES.queueFull) : failure('cancelled', MESSAGES.cancelled);
    }
    try {
      if (signal?.aborted === true) return failure('cancelled', MESSAGES.cancelled);
      return await this.dispatch(parsed.data, signal);
    } catch (error) {
      // 临时目录建不出来、spawn 抛错之类的内部故障：如实回报不可用，别漏成 500。
      this.diagnostic('python_internal_error', 'Python 求值内部错误', String(error));
      return failure('unavailable', 'Python 求值运行环境不可用');
    } finally {
      this.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.drop();
    for (const child of [...this.children]) terminate(child);
    this.children.clear();
    for (const name of this.containers) this.killContainer(name);
    this.containers.clear();
  }

  /** 跑一次任务：分配 requestId、拼命令行、执行、解释结果。 */
  private async dispatch(request: PythonEvalRequest, signal?: AbortSignal): Promise<PythonEvalResult> {
    const job: PythonEvalJob = { ...request, requestId: randomBytes(16).toString('hex') };
    const startedAt = this.now();
    const argv = this.argvFor(job);
    const name = this.backend === 'docker' && this.command === undefined ? containerName(job.requestId) : undefined;
    if (name !== undefined) this.containers.add(name);
    const cwd = this.backend === 'process' && this.command === undefined ? await this.makeWorkdir() : undefined;
    try {
      const run = await this.runChild(argv, {
        job,
        ...(cwd === undefined ? {} : { cwd }),
        ...(this.backend === 'process' ? { env: this.processEnv() } : {}),
        timeoutMs: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      return this.interpret(run, job, startedAt, name);
    } finally {
      if (name !== undefined) this.containers.delete(name);
      if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
    }
  }

  /** 子进程结局 → 协议结果。这里不做重试：一次任务一次尝试，失败就如实回报。 */
  private interpret(run: ChildRun, job: PythonEvalJob, startedAt: number, name?: string): PythonEvalResult {
    if (run.kind === 'timeout') {
      this.diagnostic('python_timeout', 'Python 求值超时，已终止', run.detail);
      if (name !== undefined) this.killContainer(name);
      return failure('timeout', `Python 求值超过 ${this.timeoutMs} 毫秒，已终止`);
    }
    if (run.kind === 'cancelled') {
      if (name !== undefined) this.killContainer(name);
      return failure('cancelled', MESSAGES.cancelled);
    }
    if (run.kind === 'overflow') {
      this.diagnostic('python_stdout_overflow', '运行器输出超过上限，已终止');
      if (name !== undefined) this.killContainer(name);
      return failure('too_large', '运行器输出超过上限');
    }
    if (run.kind === 'spawn_failed') {
      // 命令不存在或没权限：把整个后端标成不可用，别再让每个节点各撞一次。
      this.markUnavailable('Python 运行器启动失败，请检查 Python 后端配置');
      this.diagnostic('python_spawn_failed', 'Python 运行器启动失败', run.detail);
      return failure('unavailable', 'Python 运行器启动失败，请检查 Python 后端配置');
    }
    if (run.stderr.length > 0) {
      // stderr 只进日志：它可能含运行器内部路径，绝不回给客户端。
      this.diagnostic('python_runner_stderr', '运行器写入了 stderr', run.stderr.slice(-1000));
    }

    const parsed = parseRunnerLine(run.stdout);
    if (!parsed.ok) {
      this.diagnostic('python_bad_output', parsed.message, `exit=${String(run.code)}`);
      return failure('bad_output', parsed.message);
    }
    return this.interpretResult(parsed.result, job, run, startedAt);
  }

  private interpretResult(
    result: PythonRunnerResult,
    job: PythonEvalJob,
    run: ChildRun,
    startedAt: number,
  ): PythonEvalResult {
    if (result.requestId !== job.requestId) {
      // 迟到结果（或串台的运行器）：丢弃，绝不把别人的值当成本次结果（07 §P1）。
      this.diagnostic('python_late_result', '运行器返回的任务标识不匹配，已丢弃');
      return failure('bad_output', '运行器返回的结果与本次任务不匹配，已丢弃');
    }
    if (!result.ok) {
      if (result.error === undefined) return failure('bad_output', '运行器报告失败但没有给出原因');
      return { ok: false, error: result.error };
    }
    if (result.error !== undefined) return failure('bad_output', '运行器同时返回了结果和错误');
    if (result.value === undefined) return failure('bad_output', '运行器报告成功但没有返回值');

    const value = result.value;
    if (value.kind !== job.outputType) {
      return failure('bad_output', outputTypeMismatch(job.outputType, value.kind));
    }
    const problem = valueProblem(value);
    if (problem !== undefined) return failure('too_large', problem);
    if (run.code !== 0) {
      // 协议行有效但退出码非 0：运行器在收尾时出了状况，值仍然可信，记一笔诊断就好。
      this.diagnostic('python_nonzero_exit', '运行器非零退出但返回了结果', `exit=${String(run.code)}`);
    }
    return { ok: true, value, durationMs: Math.max(0, this.now() - startedAt) };
  }

  /** 拼命令行。docker 的隔离参数是这一层唯一的安全声明，改动要同步 README。 */
  private argvFor(job: PythonEvalJob): readonly string[] {
    if (this.command !== undefined) return this.command;
    if (this.backend === 'docker') {
      return [
        this.dockerCommand,
        'run',
        '--rm',
        '-i',
        '--network=none',
        `--memory=${this.memoryMb}m`,
        `--cpus=${DOCKER_CPUS}`,
        `--pids-limit=${DOCKER_PIDS_LIMIT}`,
        '--read-only',
        '--user',
        DOCKER_USER,
        '--name',
        containerName(job.requestId),
        '-v',
        `${this.runnerPath}:/runner.py:ro`,
        this.image,
        'python',
        '-I',
        '-S',
        '-B',
        '/runner.py',
      ];
    }
    return [this.executable, '-I', '-S', '-B', this.runnerPath];
  }

  /**
   * `process` 后端的环境：只留最小 PATH/LANG（Windows 另加 SYSTEMROOT，否则部分标准库调用会失败）。
   * 运行器自己还会清空 `os.environ`，两道一起挡宿主凭据。
   *
   * PATH 可以取自宿主进程：它不是凭据，而是「怎么找到解释器」的搜索路径；`config.env` 只用于
   * 读 `PWN2BLOCK_*` 配置，不该被当成一整套环境（否则测试传 `env: {}` 就找不到 python3 了）。
   */
  private processEnv(): NodeJS.ProcessEnv {
    const systemRoot = this.env.SYSTEMROOT ?? process.env.SYSTEMROOT;
    const env: NodeJS.ProcessEnv = {
      PATH: this.env.PATH ?? process.env.PATH ?? '',
      LANG: this.env.LANG ?? process.env.LANG ?? 'C.UTF-8',
    };
    if (process.platform === 'win32' && systemRoot !== undefined) env.SYSTEMROOT = systemRoot;
    return env;
  }

  /** 每次求值一个新目录：任务之间不共享可写状态，结束后整目录删掉（07 §P6）。 */
  private async makeWorkdir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'pwn2block-python-'));
  }

  /** 起子进程、喂任务、收结果；超时/取消/kill 与输出上限都在这里收口。 */
  private runChild(argv: readonly string[], options: RunOptions): Promise<ChildRun> {
    const spawned = this.spawnChild(argv, options);
    if ('failure' in spawned) return Promise.resolve(spawned.failure);
    this.children.add(spawned.child);
    return this.awaitChild(spawned.child, options);
  }

  /** 只负责 spawn：同步抛错（参数非法）与异步 error 事件都在调用方归一成 spawn_failed。 */
  private spawnChild(
    argv: readonly string[],
    options: RunOptions,
  ): { readonly child: ChildProcess } | { readonly failure: ChildRun } {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX 上新进程组：超时/取消时能连它自己的子进程一起杀。
        detached: process.platform !== 'win32',
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      return { child };
    } catch (error) {
      return {
        failure: { kind: 'spawn_failed', code: null, stdout: '', stderr: '', detail: String(error) },
      };
    }
  }

  /** 等这次运行结束：收集有上限的输出，处理超时、取消与提前退出。 */
  private awaitChild(child: ChildProcess, options: RunOptions): Promise<ChildRun> {
    const stdout = new BoundedBuffer(MAX_RUNNER_STDOUT_BYTES);
    const stderr = new BoundedBuffer(MAX_RUNNER_STDERR_BYTES);
    return new Promise((resolveRun) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined = undefined;

      const finish = (run: ChildRun): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.children.delete(child);
        resolveRun(run);
      };
      const stop = (kind: 'timeout' | 'cancelled' | 'overflow'): void => {
        if (settled) return;
        terminate(child);
        finish({ kind, code: null, stdout: stdout.text(), stderr: stderr.text() });
      };
      const onAbort = (): void => stop('cancelled');

      child.stdout?.on('data', (chunk: Buffer) => {
        // 输出上限是 hard limit：超过就不再读，直接杀掉并报 too_large。
        if (!stdout.push(chunk)) stop('overflow');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      // 对端提前退出时写入会 EPIPE；结果由退出码与 stdout 判定，不在这里抛。
      child.stdin?.on('error', () => undefined);
      child.on('error', (error: Error) => {
        finish({ kind: 'spawn_failed', code: null, stdout: '', stderr: '', detail: error.message });
      });
      child.on('close', (code: number | null) => {
        finish({ kind: 'exited', code, stdout: stdout.text(), stderr: stderr.text() });
      });

      timer = setTimeout(() => stop('timeout'), options.timeoutMs);
      timer.unref();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        child.stdin?.end(`${JSON.stringify(options.job)}\n`);
      } catch {
        stop('cancelled');
      }
    });
  }

  /** 占一个并发位：满了排队，排队也满了报 quota，排队期间取消直接返回 cancelled。 */
  private reserve(signal?: AbortSignal): SlotDecision | Promise<SlotDecision> {
    if (this.closed) return 'cancelled';
    if (signal?.aborted === true) return 'cancelled';
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return 'granted';
    }
    if (this.waiters.length >= this.queueLimit) return 'quota';
    return this.queueForSlot(signal);
  }

  private queueForSlot(signal?: AbortSignal): Promise<'granted' | 'cancelled'> {
    return new Promise((resolveWaiter) => {
      const entry: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolveWaiter('granted');
        },
        drop: () => resolveWaiter('cancelled'),
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        entry.drop();
      };
      this.waiters.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.maxConcurrent) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      this.active += 1;
      waiter.grant();
    }
  }

  /**
   * kill 掉按名字对应的容器。
   *
   * 为什么需要它：杀掉 `docker run` 这个**客户端**不会停掉容器（容器在 daemon 侧跑），
   * `--rm` 只在容器自己退出后才摘掉它。超时/取消后按名字补一枪，别留下跑满 CPU 的任务。
   */
  private killContainer(name: string): void {
    if (this.backend !== 'docker' || this.command !== undefined) return;
    try {
      const child = spawn(this.dockerCommand, ['kill', name], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // 容器可能已经不在了：这里没有可做的补救动作。
    }
  }

  private markUnavailable(reason: string): void {
    if (this.unavailableReason !== undefined) return;
    this.unavailableReason = reason;
  }

  private diagnostic(event: string, message: string, detail?: string): void {
    this.onDiagnostic?.({
      event,
      message,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

/** 结束一个子进程及其整棵树。Windows 上 `child.kill()` 只杀直接子进程，要用 taskkill /T。 */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => undefined);
      killer.unref();
    } catch {
      // 进程可能已经退出。
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // 同上。
    }
    return;
  }
  try {
    // detached 让它自成一个进程组，负号 kill 才能覆盖它的子进程。
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已消失。
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 同上。
  }
}

export function createPythonEvaluator(config: PythonEvaluatorConfig = {}): PythonEvaluator {
  return new PythonEvaluatorImpl(config);
}
