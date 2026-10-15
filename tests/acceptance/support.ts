import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { API_ERROR_STATUS, ApiErrorSchema, bytesToHex, formatHex } from '@pwn2block/shared';
import type { ApiErrorCode, EngineRuntime, Projection, VmState } from '@pwn2block/shared';

/**
 * 验收测试的公共设施（owner：F，写入范围 `tests/acceptance/**`）。
 *
 * 这里只放**测试基础设施**，不放任何断言豁免：
 * - 真实对象一律用真实 `@pwn2block/engine` / `@pwn2block/server`，禁 mock（08 §1）。
 * - 题目包写在临时目录里，不落进仓库的 `challenges/`（那是 E 的地盘，且会被 `challenge:check --all` 扫到）。
 * - 本文件不是测试文件（vitest 的 include 只收 `**\/*.test.ts`）。
 */

export interface TempChallengeRoot {
  /** 临时工作目录，测试结束时整棵删掉。 */
  readonly root: string;
  /** 传给 `buildApp({ challengeDir })`：里面每个子目录是一道题。 */
  readonly challengeDir: string;
  /** 传给 `buildApp({ presetDir })`：空目录即可，本题的编码表是完整的数组。 */
  readonly presetDir: string;
}

export interface TempChallengePackage {
  readonly pub: unknown;
  readonly priv: unknown;
}

/**
 * 建临时题目根目录：`<root>/challenges/<id>/{public,private}.json` + 空的 `<root>/presets/`。
 * 键就是目录名，也是公开包声明的 id（`loadChallengeDir` 要求二者一致）。
 */
export function makeChallengeRoot(
  packages: Readonly<Record<string, TempChallengePackage>>,
): TempChallengeRoot {
  const root = mkdtempSync(join(tmpdir(), 'pwn2block-acceptance-'));
  const challengeDir = join(root, 'challenges');
  const presetDir = join(root, 'presets');
  mkdirSync(presetDir, { recursive: true });

  for (const [id, pkg] of Object.entries(packages)) {
    const dir = join(challengeDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'public.json'), JSON.stringify(pkg.pub, null, 2), 'utf8');
    writeFileSync(join(dir, 'private.json'), JSON.stringify(pkg.priv, null, 2), 'utf8');
  }

  return { root, challengeDir, presetDir };
}

export function removeChallengeRoot(target: TempChallengeRoot): void {
  rmSync(target.root, { recursive: true, force: true });
}

export function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

/** 递归收集对象 / 数组里出现过的所有字段名（只看键，不看值）。 */
export function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/**
 * 响应正文不得夹带内部信息（04 §6）：内部堆栈、源码路径、私有包文件名、题目目录的绝对路径。
 * `extra` 用来加题目特有的哨兵真值与隐藏内容。
 */
export function expectNoInternalLeak(body: string, extra: readonly string[] = []): void {
  for (const needle of ['private.json', 'at Object.', 'node_modules', '.ts:', 'ZodError']) {
    expect(body).not.toContain(needle);
  }
  for (const needle of extra) {
    if (needle === '') continue;
    expect(body).not.toContain(needle);
  }
}

/**
 * 「被拒绝的动作状态不变」的比较口径（04 §2、§3）。
 *
 * 逐字段比较整份投影，**只排除 `failures`**：按 04 §3，`failures` 是「被拒绝 + 失败的动作计数」，
 * 用于解锁提示，设计上**单调递增**——一次拒绝本来就该让它 +1，回退也不许减少。
 * 所以它不属于「状态不变」的比较范围；每个用例都单独正面断言它的变化（+1，而不是忽略它）。
 * 其余字段（`status` / `steps` / `registers` / `roles` / `flags` / `vmas` 的 `hidden` 与 `hex` /
 * `disasm` / `stdin` / `stdout` / `lastStop` / `error`）全在比较范围内；以后投影加字段也会自动进入。
 */
export function stateFieldsOf(projection: Projection): string {
  const copy: Record<string, unknown> = { ...projection };
  delete copy.failures;
  return jsonOf(copy);
}

/** 错误响应句柄的最小形状（不 import `fastify` 的类型：根 tsconfig 看不到那个包）。 */
export interface ResponseLike {
  readonly statusCode: number;
  readonly body: string;
  json(): unknown;
}

/** 断言错误响应：HTTP 状态、`ApiErrorSchema` 形状、错误码，且不含内部信息（04 §6）。 */
export function expectApiError(
  response: ResponseLike,
  code: ApiErrorCode,
  extra: readonly string[] = [],
): void {
  expect(response.statusCode).toBe(API_ERROR_STATUS[code]);
  const parsed = ApiErrorSchema.safeParse(response.json());
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.code).toBe(code);
  expectNoInternalLeak(response.body, extra);
}

/**
 * VM 状态的**逐字段指纹**：寄存器、标志位、已 reveal 的 VMA、I/O、文件偏移、停因、
 * 以及每个 VMA 的完整内存字节。
 *
 * 用途：断言“被拒绝的动作不修改状态”（04 §2）——只比较投影是不够的，投影里看不到隐藏 VMA 的字节，
 * 而隐藏区恰恰是最可能被悄悄改掉的地方。`failures` 故意不在指纹里：按 04 §3 它单调递增，
 * 被拒绝的动作**应该**让它 +1，那是设计行为而不是状态变化。
 */
export function stateFingerprint(runtime: EngineRuntime, state: VmState): string {
  const registers: Record<string, string> = {};
  for (const [name, value] of Object.entries(state.registers)) registers[name] = formatHex(value);

  const memory: Record<string, string> = {};
  for (const vma of runtime.privatePkg.vmas) {
    const bytes = runtime.memory.readVma(state.memory, vma.id);
    memory[vma.id] = bytes === undefined ? '<unreadable>' : bytesToHex(bytes);
  }

  return JSON.stringify({
    status: state.status,
    steps: state.steps,
    registers,
    flags: state.flags,
    revealed: state.revealed,
    stdin: { hex: bytesToHex(state.stdin.bytes), pos: state.stdin.pos },
    stdout: bytesToHex(state.stdout),
    fileOffsets: state.fileOffsets,
    lastStop:
      state.lastStop === undefined
        ? null
        : {
            reason: state.lastStop.reason,
            addr: state.lastStop.addr === undefined ? null : formatHex(state.lastStop.addr),
          },
    error:
      state.error === undefined
        ? null
        : {
            code: state.error.code,
            addr: state.error.addr === undefined ? null : formatHex(state.error.addr),
            detail: state.error.detail ?? null,
          },
    memory,
  });
}
