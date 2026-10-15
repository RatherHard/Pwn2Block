import { parseHex } from '@pwn2block/shared';
import type { Syscall, VmError, VmState } from '@pwn2block/shared';
import type { EngineEnv } from './env';
import { maskTo, withMemory, writeRegister } from './state';
import { invalidInstructionError, memFaultError } from './vm-errors';

/**
 * syscall 派发（02 §5）。
 *
 * 分工：调用号解析、调用约定（`nr / args / ret` 寄存器）、`custom` 效果与退出都属于执行引擎；
 * **fd / stdin / stdout / 虚拟文件**留给 G 的 `src/io/**`（G02，D2–D3），
 * 经 `SyscallIo` 注入。宿主缺失时显式报错，而不是把 `read` / `write` 当成无事发生，
 * 否则失败会变成静默的错误判题结果。
 *
 * D1 已实现：`exit`、`custom` 的 `set_reg` / `reveal` / `copy` / `exit`。
 * D2 接 G：`read` / `write`（本文件不需要改动，只换注入的实现）。
 */

/** `read` / `write` 的宿主实现（G02 提供）。`ret` 由派发层写回调用约定的 `ret` 寄存器。 */
export interface SyscallIo {
  transfer(
    state: VmState,
    syscall: Syscall,
    args: readonly bigint[],
  ): { readonly state: VmState; readonly ret: bigint } | { readonly error: VmError };
}

export interface SyscallOutcome {
  /** 新的状态。**出错时必须是传入的原状态**（不做部分生效）。 */
  readonly state: VmState;
  readonly error?: VmError;
  /** 本次 syscall 让程序退出时的退出码（`exit` 指令 / `exit` 效果）。 */
  readonly exit?: bigint;
}

/** 计算 syscall 的调用号：`const:N` 形态取常量，无操作数形态取 `nr` 寄存器（02 §5.1）。 */
export function syscallNumber(env: EngineEnv, state: VmState, operand: number | undefined): number | undefined {
  if (operand !== undefined) return operand;
  if (env.abi === undefined) return undefined;
  const value = state.registers[env.abi.nr] ?? 0n;
  return value > 0xffffn ? undefined : Number(value);
}

/** 判题用的退出码：`custom` 的 `exit` 效果默认 0（02 §5.2）。 */
function effectExitCode(code: string | undefined, mask: bigint): bigint {
  return code === undefined ? 0n : maskTo(parseHex(code), mask);
}

/** 派发一条 syscall。调用号未知由调用方（指令执行）报 `invalid_instruction`。 */
export function dispatchSyscall(
  env: EngineEnv,
  state: VmState,
  syscall: Syscall,
  args: readonly bigint[],
): SyscallOutcome {
  if (syscall.kind === 'exit') {
    return { state, exit: args[0] ?? 0n };
  }

  if (syscall.kind === 'read' || syscall.kind === 'write') {
    const io = env.io;
    if (io === undefined) {
      throw new Error(
        `syscall ${syscall.name}（kind=${syscall.kind}）需要 fd 宿主：G02（D2–D3）在 engine/src/io/** ` +
          '落地后由包入口注入 SyscallIo，见 docs/08-Agent并行开发日程.md §2 规则 2',
      );
    }
    const result = io.transfer(state, syscall, args);
    if ('error' in result) return { state, error: result.error };
    if (env.abi === undefined) {
      return { state, error: invalidInstructionError(0n, '缺少 syscallAbi，无法写回返回值') };
    }
    return { state: writeRegister(result.state, env.abi.ret, result.ret, env.mask) };
  }

  return applyEffects(env, state, syscall);
}

/** `custom` 的四件套效果按序执行；任一效果失败则整体不生效（含已执行的 copy）。 */
function applyEffects(
  env: EngineEnv,
  state: VmState,
  syscall: Extract<Syscall, { kind: 'custom' }>,
): SyscallOutcome {
  const memorySnapshot = env.memory.snapshot(state.memory);
  let current = state;
  let exit: bigint | undefined;

  for (const effect of syscall.effects) {
    switch (effect.type) {
      case 'set_reg':
        current = writeRegister(current, effect.reg, parseHex(effect.value), env.mask);
        break;
      case 'reveal':
        if (!current.revealed.includes(effect.vma)) {
          current = { ...current, revealed: [...current.revealed, effect.vma] };
        }
        break;
      case 'copy': {
        const copied = env.memory.copy(
          current.memory,
          parseHex(effect.src),
          parseHex(effect.dst),
          effect.len,
        );
        if (!copied.ok) {
          // 回退已生效的效果：状态回原对象，内存换回快照。
          return {
            state: withMemory(state, env.memory.restore(memorySnapshot)),
            error: memFaultError(copied, `custom ${syscall.name} 的 copy 越权`),
          };
        }
        break;
      }
      case 'exit':
        exit = effectExitCode(effect.code, env.mask);
        break;
    }
    if (exit !== undefined) break;
  }

  return exit === undefined ? { state: current } : { state: current, exit };
}
