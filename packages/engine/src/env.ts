import {
  MAX_SNAPSHOTS,
  MAX_STEPS_PER_RUN,
  NO_FLAGS,
  STEP_BACK_WINDOW,
  buildEncodingLookup,
  isEncodingSpec,
} from '@pwn2block/shared';
import type {
  ArchBits,
  EncodingItem,
  EncodingLookup,
  MemoryApi,
  Predicate,
  PrivateChallenge,
  PublicChallenge,
  Roles,
  Syscall,
  SyscallAbi,
  VmState,
  VmaInit,
  VmaLayout,
} from '@pwn2block/shared';
import { buildVmaLayout, initialFileOffsets, initialRegisters, toVmaInits } from './initial';
import type { LayoutIndex } from './layout';
import { buildLayoutIndex } from './layout';
import { archMask, wordBytesOf } from './state';
import type { SyscallIo } from './syscall';

/**
 * 引擎运行环境：把一道题的所有固定信息装配成执行循环需要的东西。
 *
 * 一次 `createRuntime` 只装配一次，之后是不可变的：执行循环、动作分发、
 * 历史编排、判题与回放都从这里取参数，保证同一份输入永远得到同一份结果（02 §7）。
 */

/** 资源上限。默认取 `shared/limits.ts`，测试可以注入更小的值（02 §6、04 §3）。 */
export interface EngineLimits {
  readonly maxStepsPerRun: number;
  readonly stepBackWindow: number;
  readonly maxSnapshots: number;
}

export const DEFAULT_LIMITS: EngineLimits = Object.freeze({
  maxStepsPerRun: MAX_STEPS_PER_RUN,
  stepBackWindow: STEP_BACK_WINDOW,
  maxSnapshots: MAX_SNAPSHOTS,
});

export interface EngineEnv {
  readonly challengeId: string;
  readonly archBits: ArchBits;
  readonly wordBytes: number;
  readonly mask: bigint;
  readonly roles: Roles;
  /** 寄存器声明顺序（投影与重置都用它）。 */
  readonly registers: readonly string[];
  readonly lookup: EncodingLookup;
  /** 公开布局，顺序即题目包声明顺序。 */
  readonly layout: readonly VmaLayout[];
  /** 动作层的隐藏 / 权限判定索引。 */
  readonly layoutIndex: LayoutIndex;
  readonly vmas: readonly VmaInit[];
  readonly pub: PublicChallenge;
  readonly priv: PrivateChallenge;
  readonly memory: MemoryApi;
  readonly win: Predicate;
  readonly fail: readonly Predicate[];
  readonly syscalls: ReadonlyMap<number, Syscall>;
  readonly abi?: SyscallAbi;
  readonly limits: EngineLimits;
  /** read / write 的宿主实现：G02 在 `src/io/**` 落地后由包入口注入（08 §2 规则 2）。 */
  readonly io?: SyscallIo;
}

export interface BuildEnvironmentOptions {
  readonly limits?: Partial<EngineLimits>;
  readonly io?: SyscallIo;
  /** preset 展开后的编码表（`RuntimeOptions.encoding`）。 */
  readonly encoding?: readonly EncodingItem[];
  /** 已经建好的查询表，优先于 `encoding`（`RuntimeOptions.lookup`）。 */
  readonly lookup?: EncodingLookup;
}

/**
 * 解析本题的编码表。
 *
 * 三种可用来源，按优先级：调用方给的 `lookup` → 调用方给的展开结果 `encoding` →
 * 题目 `encoding` 本身就是完整数组。都不成立时显式报错：引擎不做文件 IO，无法读
 * `presets/<name>.json` 展开 `{preset, add, remove}`（03 §1）。
 */
function resolveEncoding(
  pub: PublicChallenge,
  options: BuildEnvironmentOptions,
  wordBytes: number,
): EncodingLookup {
  if (options.lookup !== undefined) return options.lookup;
  if (options.encoding !== undefined) return buildEncodingLookup(options.encoding, wordBytes);
  if (!isEncodingSpec(pub.encoding)) return buildEncodingLookup(pub.encoding, wordBytes);

  throw new Error(
    `题目 ${pub.id} 的 encoding 引用了 preset「${pub.encoding.preset}」：引擎不做文件 IO，` +
      '调用方必须先把编码表展开，并通过 options.encoding（或用 options.lookup 直接传查询表）' +
      '交给 createRuntime（03 §1、shared 的 RuntimeOptions）',
  );
}

/**
 * 装配运行环境。
 *
 * **编码表前置条件**：见 `resolveEncoding`。引用 preset 的题目必须由调用方传入展开结果，
 * 否则显式抛错，而不是拿半张表跑出错误结果。
 */
export function buildEnvironment(
  pub: PublicChallenge,
  priv: PrivateChallenge,
  memory: MemoryApi,
  options: BuildEnvironmentOptions = {},
): EngineEnv {
  const archBits = pub.archBits;
  const wordBytes = wordBytesOf(archBits);
  const syscalls = new Map<number, Syscall>();
  for (const syscall of pub.syscalls ?? []) syscalls.set(syscall.nr, syscall);

  return {
    challengeId: pub.id,
    archBits,
    wordBytes,
    mask: archMask(archBits),
    roles: priv.roles,
    registers: priv.registers,
    lookup: resolveEncoding(pub, options, wordBytes),
    layout: buildVmaLayout(priv.vmas),
    layoutIndex: buildLayoutIndex(priv.vmas, archBits),
    vmas: toVmaInits(priv.vmas),
    pub,
    priv,
    memory,
    win: priv.win,
    fail: priv.fail ?? [],
    syscalls,
    abi: pub.syscallAbi,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    io: options.io,
  };
}

/**
 * 题目初始状态（03 §2、04 §4）。
 *
 * 每次调用都重新建一份内存，因此 `initialState()` 可以反复调用而互不影响——
 * 调试实例的 `reset` 与判题实例的「重置到初态」都依赖这一点。
 */
export function createInitialState(env: EngineEnv): VmState {
  return {
    archBits: env.archBits,
    registers: initialRegisters(env.priv, env.mask),
    flags: NO_FLAGS,
    memory: env.memory.create(env.vmas, env.archBits),
    revealed: [],
    stdin: { bytes: new Uint8Array(0), pos: 0 },
    stdout: new Uint8Array(0),
    fileOffsets: initialFileOffsets(env.pub.fds),
    status: 'ready',
    steps: 0,
  };
}
