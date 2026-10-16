import type { StepOutcome, StopReason, VmError, VmState } from '@pwn2block/shared';
import type { DecodedInstruction } from './decode';
import { decodeAt, maxInstructionBytes } from './decode';
import type { EngineEnv } from './env';
import { executeInstruction } from './instructions';
import { evaluateVerdict, predicateContext } from './predicates';
import {
  failedState,
  forkState,
  isExited,
  readRegister,
  withExitCode,
  withLastStop,
  withStatus,
  withSteps,
} from './state';
import { invalidIpError, memFaultError, resourceLimitError } from './vm-errors';

/**
 * 执行循环骨架（02 §6）：取指 → 解码 → 执行 → 判题。
 *
 * - 一次 `step` 执行一条指令；`step` 的 `count` 与 `run` 的 `maxSteps` 由动作层限制。
 * - 取指与访存**只经** `MemoryApi`（`check / read / write`），不看内存内部表示。
 * - 异常（`memory_fault` / `invalid_ip` / `invalid_instruction` / `resource_limit`）
 *   让实例进入 `failed`，且**不产生部分副作用**：状态回退到取指前，再叠加状态与错误。
 * - `run` 跑到 `maxSteps` 是正常暂停（`stop: 'limit'`），不是异常；请求超过上限才是 `resource_limit`。
 *
 * 每会话累计步数上限（1 000 000）属于会话，由服务端（C）在会话层统计，不在引擎里。
 */

export interface StepHooks {
  /** 每条指令**取指前**调用：指令层环形缓冲（`step_back`）与录像用它压快照。 */
  readonly beforeInstruction?: (state: VmState, ip: bigint) => void;
  /** 每条指令执行后调用；解码失败时 `instruction` 为 `undefined`。 */
  readonly afterInstruction?: (outcome: StepOutcome, instruction?: DecodedInstruction) => void;
}

function outcomeOf(state: VmState, executed: number, stop: StopReason): StepOutcome {
  return state.error === undefined
    ? { state, executed, stop }
    : { state, executed, stop, error: state.error };
}

/**
 * 取指窗口：从 `ip` 起取一段**可执行**字节。
 *
 * 做法：先确认首字节可执行（否则 `invalid_ip`），再从最长指令长度往下收缩到一段
 * 可执行窗口。这样窗口不会因为跨出 VMA 边界而读失败；窗口不足由解码器报
 * `truncated`，执行层再折算成 `invalid_instruction`。
 */
export function fetchWindow(
  env: EngineEnv,
  state: VmState,
  ip: bigint,
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: VmError } {
  const maskedIp = ip & env.mask;
  const head = env.memory.check(state.memory, maskedIp, 1, 'x');
  if (!head.ok) {
    return {
      ok: false,
      error: invalidIpError(
        maskedIp,
        head.reason === 'unmapped' ? '取指地址未映射' : '取指地址不可执行',
      ),
    };
  }

  let length = maxInstructionBytes(env.wordBytes);
  while (length > 1 && !env.memory.check(state.memory, maskedIp, length, 'x').ok) {
    length -= 1;
  }

  const read = env.memory.read(state.memory, maskedIp, length);
  if (!read.ok) return { ok: false, error: memFaultError(read, '取指') };
  return { ok: true, bytes: read.bytes };
}

/**
 * 判定：`fail` 优先于 `win`（03 §2.1）。
 *
 * - 命中 `fail` → `failed` + `stop: 'exception'`（不是运行期异常，所以不带 `error`）。
 * - 命中 `win` → `satisfied`（调试实例里只表示“当前状态已满足”，不发 flag）。
 * - 程序已退出但不满足任何条件 → `exited`。
 * - 其余情况回到 `ready`：成功条件会随状态变化而重新求值，`satisfied` 不是终态。
 */
function judge(env: EngineEnv, state: VmState, ip: bigint): { state: VmState; stop: StopReason } {
  const verdict = evaluateVerdict(env.win, env.fail, predicateContext(env, state));
  const exited = isExited(state);
  // error 只由 failedState 与 failed 一起写入；stepOnce 对失败态及执行异常提前返回。
  // 回退恢复整份历史状态，因此到达判题的状态没有待清理的 error。

  if (verdict === 'fail') {
    return {
      state: withLastStop(withStatus(state, 'failed'), { reason: 'exception', addr: ip }),
      stop: 'exception',
    };
  }
  if (verdict === 'win') {
    return { state: withStatus(state, 'satisfied'), stop: exited ? 'exit' : 'step' };
  }
  return { state: withStatus(state, exited ? 'exited' : 'ready'), stop: exited ? 'exit' : 'step' };
}

/**
 * 执行恰好一条指令：取指 → 解码 → 执行 → 判题。
 *
 * **入口先 fork 内存句柄**（`forkState`）：`MemoryApi` 的写入是就地换页表，
 * 不 fork 就会把调用方持有的状态一起改掉。fork 是 O(1) 的共享页表操作。
 */
export function stepOnce(env: EngineEnv, state: VmState, hooks?: StepHooks): StepOutcome {
  if (state.status === 'failed') return outcomeOf(state, 0, 'exception');
  // 已退出就是终止态：`satisfied` + `lastStop.reason === 'exit'` 也要停（判胜那一刻程序已经结束）。
  if (isExited(state)) return outcomeOf(state, 0, 'exit');

  const working = forkState(env.memory, state);
  const ip = readRegister(working, env.roles.ip) & env.mask;
  hooks?.beforeInstruction?.(working, ip);

  const fetched = fetchWindow(env, working, ip);
  if (!fetched.ok) {
    const outcome = outcomeOf(failedState(working, fetched.error, ip), 0, 'exception');
    hooks?.afterInstruction?.(outcome);
    return outcome;
  }

  const decoded = decodeAt(fetched.bytes, ip, env.lookup);
  if (!decoded.ok) {
    const error: VmError = {
      code: 'invalid_instruction',
      addr: ip,
      detail: decoded.detail,
    };
    const outcome = outcomeOf(failedState(working, error, ip), 0, 'exception');
    hooks?.afterInstruction?.(outcome);
    return outcome;
  }

  const instruction = decoded.instruction;
  const result = executeInstruction(env, working, instruction);
  if (result.error !== undefined) {
    const outcome = outcomeOf(failedState(working, result.error, ip), 0, 'exception');
    hooks?.afterInstruction?.(outcome, instruction);
    return outcome;
  }

  let next = withSteps(result.state, working.steps + 1);
  if (result.exit !== undefined) {
    next = withLastStop(withExitCode(next, result.exit, env.mask), { reason: 'exit', addr: ip });
  }
  const judged = judge(env, next, ip);
  const outcome = outcomeOf(judged.state, 1, judged.stop);
  hooks?.afterInstruction?.(outcome, instruction);
  return outcome;
}

function limitFailure(env: EngineEnv, state: VmState, detail: string): StepOutcome {
  const error = resourceLimitError(detail);
  const ip = readRegister(state, env.roles.ip) & env.mask;
  return outcomeOf(failedState(state, error, ip), 0, 'exception');
}

/** 执行最多 `count` 条指令；`failed` / `exited` 立即停止。 */
export function stepState(
  env: EngineEnv,
  state: VmState,
  count: number,
  hooks?: StepHooks,
): StepOutcome {
  if (!Number.isSafeInteger(count) || count < 1) {
    return limitFailure(env, state, `step 的 count 非法：${String(count)}`);
  }
  if (count > env.limits.maxStepsPerRun) {
    return limitFailure(env, state, `step 的 count ${count} 超过单次运行上限 ${env.limits.maxStepsPerRun}`);
  }

  let current = state;
  let executed = 0;
  let stop: StopReason = 'step';
  for (let i = 0; i < count; i += 1) {
    const outcome = stepOnce(env, current, hooks);
    current = outcome.state;
    executed += outcome.executed;
    stop = outcome.stop;
    if (stop !== 'step') return outcomeOf(current, executed, stop);
  }
  return outcomeOf(current, executed, stop);
}

/** 连续执行，直到程序退出、异常或达到 `maxSteps`；到达上限停为 `limit`（04 §4）。 */
export function runState(
  env: EngineEnv,
  state: VmState,
  maxSteps: number,
  hooks?: StepHooks,
): StepOutcome {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    return limitFailure(env, state, `run 的 maxSteps 非法：${String(maxSteps)}`);
  }
  if (maxSteps > env.limits.maxStepsPerRun) {
    return limitFailure(
      env,
      state,
      `run 的 maxSteps ${maxSteps} 超过单次运行上限 ${env.limits.maxStepsPerRun}`,
    );
  }

  let current = state;
  let executed = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    const outcome = stepOnce(env, current, hooks);
    current = outcome.state;
    executed += outcome.executed;
    if (outcome.stop !== 'step') return outcomeOf(current, executed, outcome.stop);
  }
  return outcomeOf(current, executed, 'limit');
}
