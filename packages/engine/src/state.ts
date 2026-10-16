import type {
  ArchBits,
  Flags,
  InstanceStatus,
  LastStop,
  MemoryApi,
  MemoryState,
  VmError,
  VmState,
} from '@pwn2block/shared';

/**
 * 不可变 VM 状态的读写工具（02 §1、§2、§6）。
 *
 * 约定：
 * - 所有写操作返回**新对象**，绝不原地改。`MemoryState` 是 G 的可变句柄，
 *   因此这里只负责替换句柄字段，`state.memory` 的页表由 G 自己换。
 * - 所有写进寄存器的值都按 `archBits` 掩蔽（02 §1：溢出按 2^archBits 回绕）。
 */

/** 位宽掩码 `2^archBits - 1`。 */
export function archMask(archBits: ArchBits): bigint {
  return (1n << BigInt(archBits)) - 1n;
}

/** 字长 `W = archBits / 8`（02 §1）。 */
export function wordBytesOf(archBits: ArchBits): number {
  return archBits / 8;
}

/** 按位宽掩蔽：负数按二补数回绕。 */
export function maskTo(value: bigint, mask: bigint): bigint {
  return value & mask;
}

/** 读寄存器。未声明的名字返回 0：题目包校验保证编码表与谓词只引用已声明寄存器。 */
export function readRegister(state: VmState, name: string): bigint {
  return state.registers[name] ?? 0n;
}

/** 写单个寄存器，值按位宽掩蔽。 */
export function writeRegister(state: VmState, name: string, value: bigint, mask: bigint): VmState {
  return { ...state, registers: { ...state.registers, [name]: maskTo(value, mask) } };
}

/** 一次写多个寄存器：用于 `ret` / `leave` 这类同时改 ip、sp 的指令，避免中间态。 */
export function writeRegisters(
  state: VmState,
  entries: readonly (readonly [string, bigint])[],
  mask: bigint,
): VmState {
  let registers = state.registers;
  for (const [name, value] of entries) {
    registers = { ...registers, [name]: maskTo(value, mask) };
  }
  return { ...state, registers };
}

export function withFlags(state: VmState, flags: Flags): VmState {
  return { ...state, flags };
}

/** 换入新的内存句柄（`undo` / `step_back` 恢复快照后使用）。 */
export function withMemory(state: VmState, memory: MemoryState): VmState {
  return { ...state, memory };
}

/**
 * 为某个时刻**分叉一份自己的内存句柄**（A 的契约澄清，2025 D1）。
 *
 * `MemoryApi.write / copy` 只回 `MemResult`，所以 `MemoryState` 是**可变句柄**：
 * 写入通过换页表指针生效，页表与页内容本身不可变。直接长期持有同一个句柄，
 * 旧状态就会看到后来的写入。任何“要留住某一时刻”的地方（历史快照、录像帧、
 * 返回给调用方的状态）都必须先 fork：`restore(snapshot(mem))`，O(1)，共享页表。
 */
export function forkState(memory: MemoryApi, state: VmState): VmState {
  return withMemory(state, memory.restore(memory.snapshot(state.memory)));
}

export function withSteps(state: VmState, steps: number): VmState {
  return { ...state, steps };
}

export function withStatus(state: VmState, status: InstanceStatus): VmState {
  return { ...state, status };
}

export function withLastStop(state: VmState, lastStop: LastStop): VmState {
  return { ...state, lastStop };
}

/**
 * 运行期异常：实例进入 `failed`，记录停因与错误（02 §6）。
 *
 * 异常不产生部分副作用——调用方在执行失败时把状态回退到取指前再调用本函数。
 */
export function failedState(state: VmState, error: VmError, addr: bigint): VmState {
  return { ...state, status: 'failed', error, lastStop: { reason: 'exception', addr } };
}

/**
 * 带上退出码（`shared` 的 `VmState.exitCode`，A 已按契约缺口建议补上）。
 *
 * 只有 `status === 'exited'` 时有意义；`satisfied` 与 `failed` 也可能带着它，
 * 因为“程序确实退出了”这个事实不能被状态覆盖（见 `isExited`）。
 */
export function withExitCode(state: VmState, code: bigint, mask: bigint): VmState {
  return { ...state, exitCode: maskTo(code, mask) };
}

/**
 * 程序是否已结束。
 *
 * 用 `lastStop.reason === 'exit'` 而不是只看 `status`：程序正常退出后，如果同时满足
 * 成功条件，调试实例的 `status` 会显示 `satisfied`，但“已退出”这个事实不能被抹掉，
 * 否则 `exited` 谓词会漏判（03 §2.1 的 fail 谓词就依赖它）。
 */
export function isExited(state: VmState): boolean {
  return state.status === 'exited' || state.lastStop?.reason === 'exit';
}

/**
 * 终止态：`failed`，或**程序已退出**（`status` 可能是 `exited`，也可能是 `satisfied`——
 * 退出那一刻同时满足成功条件时就是后者）。两者都拒绝执行类动作，回退类动作仍可用（04 §1.1）。
 *
 * 判据用 `isExited` 而不是 `status === 'exited'`：程序已经结束之后不该再取指执行，
 * 否则下一条字节会以 `invalid_instruction` 把已经判胜的 payload 判成失败。
 */
export function isTerminal(state: VmState): boolean {
  return state.status === 'failed' || isExited(state);
}
