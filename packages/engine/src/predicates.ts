import { containsBytes, hexToBytes, parseHex } from '@pwn2block/shared';
import type { MemoryApi, Predicate, PredicateVerdict, VmState, VmaId } from '@pwn2block/shared';
import { isExited } from './state';

/**
 * 判题谓词求值（03 §2.1）。
 *
 * 纯函数：只读传入的上下文，不碰内存实现。执行循环在每条指令结束后求值一次，
 * **失败条件先于成功条件**，因此 `evaluateVerdict` 里 `fail` 优先于 `win`。
 *
 * 读不到的数据一律判 `false`：谓词不能成为探测通道，越权 / 未映射的读取只是“不匹配”。
 */

export interface PredicateContext {
  readonly state: VmState;
  /** 读一段内存（`mem_eq` 用）；越权或未映射时回 `undefined`。 */
  readonly readMemory?: (addr: bigint, len: number) => Uint8Array | undefined;
  /** 整块读一个 VMA（`mem_contains` 用，含隐藏区）；不存在时回 `undefined`。 */
  readonly readVma?: (id: VmaId) => Uint8Array | undefined;
}

function equalsBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** 求值单个谓词。 */
export function evaluatePredicate(predicate: Predicate, ctx: PredicateContext): boolean {
  if ('reg_eq' in predicate) {
    const { reg, value } = predicate.reg_eq;
    return (ctx.state.registers[reg] ?? 0n) === parseHex(value);
  }

  if ('mem_eq' in predicate) {
    const { addr, hex } = predicate.mem_eq;
    if (ctx.readMemory === undefined) return false;
    const bytes = ctx.readMemory(parseHex(addr), hex.length / 2);
    return bytes !== undefined && equalsBytes(bytes, hexToBytes(hex));
  }

  if ('mem_contains' in predicate) {
    const { vma, hex } = predicate.mem_contains;
    if (ctx.readVma === undefined) return false;
    const haystack = ctx.readVma(vma);
    return haystack !== undefined && containsBytes(haystack, hexToBytes(hex));
  }

  if ('stdout_contains' in predicate) {
    return containsBytes(ctx.state.stdout, hexToBytes(predicate.stdout_contains.hex));
  }

  if ('exited' in predicate) {
    // `isExited` 而不是只看 status：正常退出后若同时满足成功条件，status 会显示 satisfied
    if (!isExited(ctx.state)) return false;
    const code = predicate.exited.code;
    if (code === undefined) return true;
    const actual = ctx.state.exitCode;
    return actual !== undefined && actual === parseHex(code);
  }

  if ('all' in predicate) return predicate.all.every((item) => evaluatePredicate(item, ctx));
  if ('any' in predicate) return predicate.any.some((item) => evaluatePredicate(item, ctx));
  return !evaluatePredicate(predicate.not, ctx);
}

/**
 * 判胜 / 判负求值：`fail` 优先于 `win`（03 §2.1）。
 * 两者都不成立时回 `'none'`，表示当前状态还没结论。
 */
export function evaluateVerdict(
  win: Predicate,
  fail: readonly Predicate[],
  ctx: PredicateContext,
): PredicateVerdict {
  for (const predicate of fail) {
    if (evaluatePredicate(predicate, ctx)) return 'fail';
  }
  return evaluatePredicate(win, ctx) ? 'win' : 'none';
}

/** 只需要内存接口就能组出谓词上下文，便于执行循环与包入口复用（避免 import 环）。 */
export interface PredicateEnv {
  readonly memory: MemoryApi;
}

/** 用真实内存构造谓词上下文：读失败（越权 / 未映射）一律判 `false`。 */
export function predicateContext(env: PredicateEnv, state: VmState): PredicateContext {
  return {
    state,
    readMemory: (addr, len) => {
      const result = env.memory.read(state.memory, addr, len);
      return result.ok ? result.bytes : undefined;
    },
    readVma: (id) => env.memory.readVma(state.memory, id),
  };
}
