import type { ErrorCode, MemFault, VmError } from '@pwn2block/shared';

/**
 * 引擎内部的结构化错误构造（02 §6、04 §2）。
 *
 * `VmError` 只有 `{code, addr?, detail?}`，文案由服务端用模板生成；
 * `detail` 必须是机器可读、且**永不含隐藏内容**的说明（只允许出现地址、长度、寄存器名、opcode）。
 */

export function memFaultError(fault: MemFault, detail: string): VmError {
  const reason = fault.reason === 'unmapped' ? '未映射' : '权限不足';
  return { code: 'memory_fault', addr: fault.addr, detail: `${detail}：${reason}，长度 ${fault.len}` };
}

export function invalidInstructionError(addr: bigint, detail: string): VmError {
  return { code: 'invalid_instruction', addr, detail };
}

export function invalidIpError(addr: bigint, detail: string): VmError {
  return { code: 'invalid_ip', addr, detail };
}

export function resourceLimitError(detail: string): VmError {
  return { code: 'resource_limit', detail };
}

export function rejectError(code: ErrorCode, detail?: string, addr?: bigint): VmError {
  return {
    code,
    ...(addr === undefined ? {} : { addr }),
    ...(detail === undefined ? {} : { detail }),
  };
}
