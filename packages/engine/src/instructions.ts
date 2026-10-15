import { bigIntToBytesLE, bytesToBigIntLE } from '@pwn2block/shared';
import type { VmError, VmState } from '@pwn2block/shared';
import { addValues, cmpValues, logicValues, shiftValues, subValues } from './alu';
import type { DecodedInstruction, DecodedOperand } from './decode';
import type { EngineEnv } from './env';
import { dispatchSyscall, syscallNumber } from './syscall';
import {
  maskTo,
  readRegister,
  withFlags,
  writeRegister,
  writeRegisters,
} from './state';
import { invalidInstructionError, memFaultError } from './vm-errors';

/**
 * 单条指令的执行（02 §4.1）。
 *
 * 约定：
 * - **不可变**：返回新状态；出错时 `state` 必须是传入的原状态（不做部分生效）。
 * - **只经 `MemoryApi`**：取数、写回、压栈、出栈全部走 `env.memory`，
 *   不看内存的内部表示，也不在引擎里区分隐藏区（隐藏对程序指令透明，02 §3）。
 * - 编码表里语义不明的操作数组合回 `invalid_instruction` 并带机器可读 detail，
 *   而不是抛异常或猜一个结果。
 */

export interface ExecResult {
  readonly state: VmState;
  readonly error?: VmError;
  /** 本次指令让程序退出时的退出码。 */
  readonly exit?: bigint;
}

type WordRead = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly error: VmError };

function invalid(state: VmState, ins: DecodedInstruction, detail: string): ExecResult {
  return { state, error: invalidInstructionError(ins.addr, detail) };
}

function readWord(env: EngineEnv, state: VmState, addr: bigint): WordRead {
  const result = env.memory.read(state.memory, addr, env.wordBytes);
  if (!result.ok) return { ok: false, error: memFaultError(result, `读取 ${env.wordBytes} 字节`) };
  return { ok: true, value: bytesToBigIntLE(result.bytes) };
}

function writeWord(
  env: EngineEnv,
  state: VmState,
  addr: bigint,
  value: bigint,
): { readonly ok: true } | { readonly ok: false; readonly error: VmError } {
  const bytes = bigIntToBytesLE(maskTo(value, env.mask), env.wordBytes);
  const result = env.memory.write(state.memory, addr, bytes);
  if (!result.ok) return { ok: false, error: memFaultError(result, `写入 ${env.wordBytes} 字节`) };
  return { ok: true };
}

/** `mem:R+disp` 的有效地址：寄存器 + 位移，按 2^archBits 回绕（02 §4）。 */
function effectiveAddress(env: EngineEnv, state: VmState, operand: DecodedOperand): bigint {
  const base = operand.kind === 'mem' ? readRegister(state, operand.base) : 0n;
  const disp = operand.kind === 'mem' ? operand.disp : 0n;
  return maskTo(base + disp, env.mask);
}

/** 读一个操作数的值。`mem` 需要访存，可能报 `memory_fault`。 */
function readOperand(
  env: EngineEnv,
  state: VmState,
  operand: DecodedOperand,
): { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly error: VmError } {
  switch (operand.kind) {
    case 'reg':
      return { ok: true, value: readRegister(state, operand.name) };
    case 'imm':
      return { ok: true, value: operand.value };
    case 'const':
      return { ok: true, value: BigInt(operand.nr) };
    case 'mem': {
      const read = readWord(env, state, effectiveAddress(env, state, operand));
      return read.ok ? { ok: true, value: read.value } : { ok: false, error: read.error };
    }
  }
}

function execMov(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const dst = ins.operands[0];
  const src = ins.operands[1];
  if (dst === undefined || src === undefined) return invalid(state, ins, 'mov 需要两个操作数');

  if (dst.kind === 'reg') {
    const value = readOperand(env, state, src);
    if (!value.ok) return { state, error: value.error };
    return { state: writeRegister(state, dst.name, value.value, env.mask) };
  }
  if (dst.kind === 'mem' && src.kind === 'reg') {
    const written = writeWord(env, state, effectiveAddress(env, state, dst), readRegister(state, src.name));
    return written.ok ? { state } : { state, error: written.error };
  }
  return invalid(state, ins, 'mov 只支持 R,I / R,R / R,M / M,R 四种形态（02 §4.1）');
}

function execPush(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const operand = ins.operands[0];
  if (operand === undefined) return invalid(state, ins, 'push 需要一个操作数');
  if (operand.kind === 'mem' || operand.kind === 'const') {
    return invalid(state, ins, 'push 只支持 R / I 形态（02 §4.1）');
  }

  const value = readOperand(env, state, operand);
  if (!value.ok) return { state, error: value.error };
  const sp = readRegister(state, env.roles.sp);
  const nextSp = maskTo(sp - BigInt(env.wordBytes), env.mask);
  const written = writeWord(env, state, nextSp, value.value);
  if (!written.ok) return { state, error: written.error };
  return { state: writeRegister(state, env.roles.sp, nextSp, env.mask) };
}

/** `pop R`：`r = [sp]; sp += W`。 */
function execPop(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const dst = ins.operands[0];
  if (dst === undefined || dst.kind !== 'reg') return invalid(state, ins, 'pop 需要一个寄存器操作数');

  const sp = readRegister(state, env.roles.sp);
  const read = readWord(env, state, sp);
  if (!read.ok) return { state, error: read.error };
  const nextSp = maskTo(sp + BigInt(env.wordBytes), env.mask);
  return {
    state: writeRegisters(
      state,
      [
        [dst.name, read.value],
        [env.roles.sp, nextSp],
      ],
      env.mask,
    ),
  };
}

/** `ret`：`ip = pop`，允许无配对 `call`（ROP）。 */
function execRet(env: EngineEnv, state: VmState): ExecResult {
  const sp = readRegister(state, env.roles.sp);
  const read = readWord(env, state, sp);
  if (!read.ok) return { state, error: read.error };
  const nextSp = maskTo(sp + BigInt(env.wordBytes), env.mask);
  return {
    state: writeRegisters(
      state,
      [
        [env.roles.ip, read.value],
        [env.roles.sp, nextSp],
      ],
      env.mask,
    ),
  };
}

/** `leave`：`sp = bp; pop bp`。 */
function execLeave(env: EngineEnv, state: VmState): ExecResult {
  const bp = readRegister(state, env.roles.bp);
  const read = readWord(env, state, bp);
  if (!read.ok) return { state, error: read.error };
  const nextSp = maskTo(bp + BigInt(env.wordBytes), env.mask);
  return {
    state: writeRegisters(
      state,
      [
        [env.roles.sp, nextSp],
        [env.roles.bp, read.value],
      ],
      env.mask,
    ),
  };
}

function execArith(
  env: EngineEnv,
  state: VmState,
  ins: DecodedInstruction,
  op: 'add' | 'sub' | 'cmp',
): ExecResult {
  const dst = ins.operands[0];
  const src = ins.operands[1];
  if (dst === undefined || dst.kind !== 'reg' || src === undefined) {
    return invalid(state, ins, `${op} 的形态必须是 R,R / R,I / R,M（02 §4.1）`);
  }

  const a = readRegister(state, dst.name);
  const b = readOperand(env, state, src);
  if (!b.ok) return { state, error: b.error };

  const result =
    op === 'add'
      ? addValues(a, b.value, env.mask, env.archBits)
      : op === 'sub'
        ? subValues(a, b.value, env.mask, env.archBits)
        : cmpValues(a, b.value, env.mask, env.archBits);

  let next = withFlags(state, result.flags);
  if (result.writeBack) next = writeRegister(next, dst.name, result.value, env.mask);
  return { state: next };
}

function execLogic(
  env: EngineEnv,
  state: VmState,
  ins: DecodedInstruction,
  op: 'and' | 'or' | 'xor',
): ExecResult {
  const dst = ins.operands[0];
  const src = ins.operands[1];
  if (dst === undefined || dst.kind !== 'reg' || src === undefined) {
    return invalid(state, ins, `${op} 的形态必须是 R,R / R,I（02 §4.1）`);
  }

  const a = readRegister(state, dst.name);
  const b = readOperand(env, state, src);
  if (!b.ok) return { state, error: b.error };

  const raw = op === 'and' ? a & b.value : op === 'or' ? a | b.value : a ^ b.value;
  const result = logicValues(raw, env.mask, env.archBits, state.flags);
  return { state: writeRegister(withFlags(state, result.flags), dst.name, result.value, env.mask) };
}

function execShift(
  env: EngineEnv,
  state: VmState,
  ins: DecodedInstruction,
  direction: 'left' | 'right',
): ExecResult {
  const dst = ins.operands[0];
  const src = ins.operands[1];
  if (dst === undefined || dst.kind !== 'reg' || src === undefined) {
    return invalid(state, ins, `${ins.op} 的形态必须是 R,R / R,I（02 §4.1）`);
  }

  const a = readRegister(state, dst.name);
  const b = readOperand(env, state, src);
  if (!b.ok) return { state, error: b.error };

  const result = shiftValues(a, b.value, direction, env.mask, env.archBits, state.flags);
  return { state: writeRegister(withFlags(state, result.flags), dst.name, result.value, env.mask) };
}

function execJump(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const operand = ins.operands[0];
  if (operand === undefined) return invalid(state, ins, 'jmp 需要一个目标操作数');
  const target = readOperand(env, state, operand);
  if (!target.ok) return { state, error: target.error };
  return { state: writeRegister(state, env.roles.ip, target.value, env.mask) };
}

/** 条件跳转只看 ZF / CF（02 §4.1：je = ZF，jne = !ZF，jb = CF，jae = !CF）。 */
function conditionHolds(op: DecodedInstruction['op'], flags: VmState['flags']): boolean {
  switch (op) {
    case 'je':
      return flags.ZF;
    case 'jne':
      return !flags.ZF;
    case 'jb':
      return flags.CF;
    case 'jae':
      return !flags.CF;
    default:
      return false;
  }
}

function execConditionalJump(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const operand = ins.operands[0];
  if (operand === undefined || operand.kind !== 'imm') {
    return invalid(state, ins, '条件跳转只支持绝对立即数目标（02 §4.1）');
  }
  if (!conditionHolds(ins.op, state.flags)) return { state };
  return { state: writeRegister(state, env.roles.ip, operand.value, env.mask) };
}

/** `call`：`push 下一条地址; ip = 目标`（目标支持 I / R）。 */
function execCall(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const operand = ins.operands[0];
  if (operand === undefined) return invalid(state, ins, 'call 需要一个目标操作数');
  const target = readOperand(env, state, operand);
  if (!target.ok) return { state, error: target.error };

  const sp = readRegister(state, env.roles.sp);
  const nextSp = maskTo(sp - BigInt(env.wordBytes), env.mask);
  const returnAddr = maskTo(ins.addr + BigInt(ins.length), env.mask);
  const written = writeWord(env, state, nextSp, returnAddr);
  if (!written.ok) return { state, error: written.error };
  return {
    state: writeRegisters(
      state,
      [
        [env.roles.sp, nextSp],
        [env.roles.ip, target.value],
      ],
      env.mask,
    ),
  };
}

function execSyscall(env: EngineEnv, state: VmState, ins: DecodedInstruction): ExecResult {
  const operand = ins.operands[0];
  if (operand !== undefined && operand.kind !== 'const') {
    return invalid(state, ins, 'syscall 的操作数只能是 const:N 或不带操作数（02 §5.1）');
  }
  const nr = syscallNumber(env, state, operand?.nr);
  if (nr === undefined) return invalid(state, ins, '无法确定 syscall 调用号');

  const syscall = env.syscalls.get(nr);
  if (syscall === undefined) return invalid(state, ins, `调用号 ${nr} 不在 syscall 表里`);

  const args = env.abi === undefined ? [] : env.abi.args.map((name) => readRegister(state, name));
  const outcome = dispatchSyscall(env, state, syscall, args);
  return outcome.error === undefined ? { state: outcome.state, exit: outcome.exit } : { state, error: outcome.error };
}

/** 执行一条已解码的指令。未覆盖的作用在这里不会出现（`OpName` 是封闭集）。 */
export function executeInstruction(
  env: EngineEnv,
  state: VmState,
  ins: DecodedInstruction,
): ExecResult {
  // 取指阶段 PC 自增：所有指令先把 ip 指向**下一条**，控制转移指令再覆盖它。
  // 这是 x86 的真实语义，也顺带处理了“条件跳转未命中时顺序前进”的情况。
  const advanced = writeRegister(
    state,
    env.roles.ip,
    maskTo(ins.addr + BigInt(ins.length), env.mask),
    env.mask,
  );

  switch (ins.op) {
    case 'nop':
      return { state: advanced };
    case 'mov':
      return execMov(env, advanced, ins);
    case 'push':
      return execPush(env, advanced, ins);
    case 'pop':
      return execPop(env, advanced, ins);
    case 'add':
      return execArith(env, advanced, ins, 'add');
    case 'sub':
      return execArith(env, advanced, ins, 'sub');
    case 'cmp':
      return execArith(env, advanced, ins, 'cmp');
    case 'and':
      return execLogic(env, advanced, ins, 'and');
    case 'or':
      return execLogic(env, advanced, ins, 'or');
    case 'xor':
      return execLogic(env, advanced, ins, 'xor');
    case 'shl':
      return execShift(env, advanced, ins, 'left');
    case 'shr':
      return execShift(env, advanced, ins, 'right');
    case 'jmp':
      return execJump(env, advanced, ins);
    case 'je':
    case 'jne':
    case 'jb':
    case 'jae':
      return execConditionalJump(env, advanced, ins);
    case 'call':
      return execCall(env, advanced, ins);
    case 'ret':
      return execRet(env, advanced);
    case 'leave':
      return execLeave(env, advanced);
    case 'syscall':
      return execSyscall(env, advanced, ins);
  }
}
