import {
  MAX_IO_BYTES,
  bigIntToBytesLE,
  bytesToBigIntLE,
  expandBlock,
  hexToBytes,
  isAllowedByChallenge,
  isControlAction,
  isHex,
  parseHex,
  runMaxSteps,
  stepCount,
} from '@pwn2block/shared';
import type {
  Action,
  BlockAction,
  PrimitiveAction,
  VmError,
  VmState,
} from '@pwn2block/shared';
import type { EngineEnv } from './env';
import type { StepHooks } from './execute';
import { runState, stepState } from './execute';
import { createIo } from './io/index';
import { checkActionRange } from './layout';
import { isTerminal, maskTo, readRegister, withMemory, writeRegister } from './state';
import { memFaultError, rejectError } from './vm-errors';

/**
 * 动作分发（04 §2）：写原语与出题人积木。
 *
 * 两类结果要分清：
 * - **拒绝**（`ok: false`）：动作不生效，状态不变，不压快照。写原语的隐藏 / 权限校验
 *   在这里做——内存层不做隐藏检查，否则直接动作会变成读隐藏内容的通道。
 * - **异常**（`ok: true` + 状态进入 `failed`）：动作确实执行了，指令抛错（04 §2 最后一条）。
 *
 * 回退类动作（`undo / step_back / reset`）的历史编排在 `instance.ts`，这里不碰历史。
 */

export type PrimitiveOutcome =
  | { readonly ok: true; readonly state: VmState; readonly error?: VmError }
  | { readonly ok: false; readonly state: VmState; readonly error: VmError };

function rejected(state: VmState, error: VmError): PrimitiveOutcome {
  return { ok: false, state, error };
}

/** 地址字符串 → 整数。Schema 已经校验过，这里只做防御性兜底。 */
function addressOf(raw: string): bigint | undefined {
  return isHex(raw) ? parseHex(raw) : undefined;
}

/** 动作层区间校验：隐藏 → `hidden_address`，未映射 / 越权 → `inaccessible_address`（04 §2）。 */
function checkRange(
  env: EngineEnv,
  addr: bigint,
  len: number,
  need: 'r' | 'w',
): { readonly ok: true } | { readonly ok: false; readonly error: VmError } {
  const verdict = checkActionRange(env.layoutIndex, addr, len, need);
  if (verdict.ok) return { ok: true };
  // 地址与长度都是公开布局，写进 detail 不泄露任何隐藏内容，还能帮学习者定位。
  const detail =
    verdict.code === 'hidden_address'
      ? `区间落在隐藏 VMA 内（长度 ${len}）`
      : `区间未映射或权限不足（需要${need === 'w' ? '写' : '读'}，长度 ${len}）`;
  return { ok: false, error: rejectError(verdict.code, detail, addr & env.mask) };
}

/**
 * 执行类动作的前置筛选：
 * - 回退类始终可用，不受 `allowedActions` 约束（04 §2）；
 * - 其余动作必须在 `allowedActions` 里；
 * - `failed` / `exited` 时执行类动作被拒绝（04 §1.1），回退仍可用。
 */
export function screenAction(env: EngineEnv, state: VmState, action: Action): VmError | undefined {
  if (isControlAction(action)) return undefined;
  if (!isAllowedByChallenge(env.pub, action.type)) {
    return rejectError('action_not_allowed', `动作 ${action.type} 不在本题的 allowedActions 里`);
  }
  if (isTerminal(state)) return rejectError('not_executable');
  return undefined;
}

/**
 * `feed`：往 stdin 缓冲追加字节，累计超过 4KB 拒绝（02 §5.3、04 §2）。
 *
 * 缓冲上限、整段拒绝、`pos` 保持都属于 I/O 层：实现**只**委托给 G02 的
 * `createIo().feed`，动作层不再自留第二份。失败时状态不变（`ok: false` 由调用方处理），
 * 错误码直接用 I/O 层的 `stdin_overflow`。
 */
export function feedStdin(state: VmState, bytes: Uint8Array): PrimitiveOutcome {
  const outcome = createIo().feed(state.stdin, bytes);
  if (!outcome.ok) {
    return rejected(state, rejectError(outcome.code, stdinOverflowDetail(state, bytes)));
  }
  return { ok: true, state: { ...state, stdin: outcome.stdin } };
}

/** `stdin_overflow` 的 detail：只含长度、不含内容（与委托前的文案一致）。 */
function stdinOverflowDetail(state: VmState, bytes: Uint8Array): string {
  return `stdin 累计 ${state.stdin.bytes.length + bytes.length} 字节超过上限 ${MAX_IO_BYTES}`;
}

function writeBytesAction(env: EngineEnv, state: VmState, action: Extract<PrimitiveAction, { type: 'write_bytes' }>): PrimitiveOutcome {
  const addr = addressOf(action.addr);
  if (addr === undefined) return rejected(state, rejectError('invalid_arguments', 'write_bytes 的 addr 非法'));
  const bytes = hexToBytes(action.hex);
  const range = checkRange(env, addr, bytes.length, 'w');
  if (!range.ok) return rejected(state, range.error);
  const written = env.memory.write(state.memory, addr, bytes);
  if (!written.ok) return rejected(state, memFaultError(written, 'write_bytes 失败'));
  return { ok: true, state };
}

/** `push value`：`sp -= W; [sp] = value`，写槽必须非隐藏且可写。 */
function pushAction(env: EngineEnv, state: VmState, action: Extract<PrimitiveAction, { type: 'push' }>): PrimitiveOutcome {
  const value = addressOf(action.value);
  if (value === undefined) return rejected(state, rejectError('invalid_arguments', 'push 的 value 非法'));
  const word = BigInt(env.wordBytes);
  const nextSp = maskTo(readRegister(state, env.roles.sp) - word, env.mask);
  const range = checkRange(env, nextSp, env.wordBytes, 'w');
  if (!range.ok) return rejected(state, range.error);
  const written = env.memory.write(state.memory, nextSp, bigIntToBytesLE(value, env.wordBytes));
  if (!written.ok) return rejected(state, memFaultError(written, 'push 写栈失败'));
  return { ok: true, state: writeRegister(state, env.roles.sp, nextSp, env.mask) };
}

/**
 * `pop`：读栈槽并 `sp += W`（04 §2）。
 *
 * 动作 `pop` 没有目标寄存器，因此这里只做“读栈槽 + 前进栈指针”：读取本身必须
 * 通过隐藏 / 权限校验，否则 `pop` 会成为读隐藏内容的通道。
 */
function popAction(env: EngineEnv, state: VmState): PrimitiveOutcome {
  const sp = readRegister(state, env.roles.sp);
  const range = checkRange(env, sp, env.wordBytes, 'r');
  if (!range.ok) return rejected(state, range.error);
  const read = env.memory.read(state.memory, sp, env.wordBytes);
  if (!read.ok) return rejected(state, memFaultError(read, 'pop 读栈失败'));
  const nextSp = maskTo(sp + BigInt(env.wordBytes), env.mask);
  return { ok: true, state: writeRegister(state, env.roles.sp, nextSp, env.mask) };
}

/** `call addr`：压入**当前 ip** 作为返回地址，然后 `ip = addr`（不执行指令）。 */
function callAction(env: EngineEnv, state: VmState, action: Extract<PrimitiveAction, { type: 'call' }>): PrimitiveOutcome {
  const target = addressOf(action.addr);
  if (target === undefined) return rejected(state, rejectError('invalid_arguments', 'call 的 addr 非法'));
  const sp = readRegister(state, env.roles.sp);
  const nextSp = maskTo(sp - BigInt(env.wordBytes), env.mask);
  const range = checkRange(env, nextSp, env.wordBytes, 'w');
  if (!range.ok) return rejected(state, range.error);
  const returnAddr = readRegister(state, env.roles.ip);
  const written = env.memory.write(state.memory, nextSp, bigIntToBytesLE(returnAddr, env.wordBytes));
  if (!written.ok) return rejected(state, memFaultError(written, 'call 写栈失败'));
  const pushed = writeRegister(state, env.roles.sp, nextSp, env.mask);
  return { ok: true, state: writeRegister(pushed, env.roles.ip, target, env.mask) };
}

/** `ret`：栈顶值出栈送给 ip（允许无配对 call，ROP 用）。 */
function retAction(env: EngineEnv, state: VmState): PrimitiveOutcome {
  const sp = readRegister(state, env.roles.sp);
  const range = checkRange(env, sp, env.wordBytes, 'r');
  if (!range.ok) return rejected(state, range.error);
  const read = env.memory.read(state.memory, sp, env.wordBytes);
  if (!read.ok) return rejected(state, memFaultError(read, 'ret 读栈失败'));
  const nextSp = maskTo(sp + BigInt(env.wordBytes), env.mask);
  const target = bytesToBigIntLE(read.bytes);
  const advanced = writeRegister(state, env.roles.sp, nextSp, env.mask);
  return { ok: true, state: writeRegister(advanced, env.roles.ip, target, env.mask) };
}

/** 单个原子动作（不含回退类）。调用方先用 `screenAction` 筛选。 */
export function applyPrimitive(
  env: EngineEnv,
  state: VmState,
  action: PrimitiveAction,
  hooks?: StepHooks,
): PrimitiveOutcome {  switch (action.type) {
    case 'write_bytes':
      return writeBytesAction(env, state, action);
    case 'push':
      return pushAction(env, state, action);
    case 'pop':
      return popAction(env, state);
    case 'call':
      return callAction(env, state, action);
    case 'ret':
      return retAction(env, state);
    case 'feed':
      return feedStdin(state, hexToBytes(action.hex));
    case 'step': {
      const outcome = stepState(env, state, stepCount(action), hooks);
      return outcome.error === undefined
        ? { ok: true, state: outcome.state }
        : { ok: true, state: outcome.state, error: outcome.error };
    }
    case 'run': {
      const outcome = runState(env, state, runMaxSteps(action), hooks);
      return outcome.error === undefined
        ? { ok: true, state: outcome.state }
        : { ok: true, state: outcome.state, error: outcome.error };
    }
  }
}

/**
 * 出题人积木：服务端展开（`shared/expandBlock`，客户端提交的展开结果一律不采信）。
 *
 * 块内任一步被拒绝时整体回滚到块执行前——这样“被拒绝的动作不修改状态”对提交者
 * 看到的那个动作仍然成立（S03）。回滚用内存快照 + 原状态对象，不需要额外的历史。
 */
export function applyBlock(
  env: EngineEnv,
  state: VmState,
  action: BlockAction,
  hooks?: StepHooks,
): PrimitiveOutcome {
  const expansion = expandBlock(env.pub, action);
  if (!expansion.ok) return rejected(state, rejectError(expansion.code, expansion.detail));

  const guard = env.memory.snapshot(state.memory);
  let current = state;
  for (const inner of expansion.actions) {
    const outcome = applyPrimitive(env, current, inner, hooks);
    if (!outcome.ok) {
      return rejected(withMemory(state, env.memory.restore(guard)), outcome.error);
    }
    current = outcome.state;
    if (isTerminal(current)) break;
  }
  return current.error === undefined
    ? { ok: true, state: current }
    : { ok: true, state: current, error: current.error };
}
