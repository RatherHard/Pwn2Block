import { z } from 'zod';
import { formatHex } from './hex';

/**
 * 异常码与拒绝原因。
 *
 * 两类要分清（04 §2、§6）：
 * - **运行期异常**（`VmErrorCode`）：指令执行出错，实例进入 `failed`。调试实例可以回退，判题实例即判负。
 * - **拒绝**（`RejectReason`）：写原语校验不通过，动作本身不执行，状态不变、不压快照。
 */
export const ERROR_CODES = [
  'memory_fault',
  'invalid_ip',
  'invalid_instruction',
  'resource_limit',
  'hidden_address',
  'inaccessible_address',
  'action_not_allowed',
  'unknown_action',
  'not_executable',
  'empty_history',
  'stdin_overflow',
  'reads_state',
  'invalid_arguments',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export type VmErrorCode = Extract<
  ErrorCode,
  'memory_fault' | 'invalid_ip' | 'invalid_instruction' | 'resource_limit'
>;

export type RejectReason = Exclude<ErrorCode, VmErrorCode>;

export const INSTANCE_STATUSES = ['ready', 'satisfied', 'failed', 'exited'] as const;
export const InstanceStatusSchema = z.enum(INSTANCE_STATUSES);
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const STOP_REASONS = ['step', 'exit', 'exception', 'limit'] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = (typeof STOP_REASONS)[number];

export const VERDICTS = ['won', 'failed', 'rejected', 'incomplete'] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = (typeof VERDICTS)[number];

/** 引擎内部的结构化错误：不带文案，文案由服务端用模板生成（02 §6）。 */
export interface VmError {
  readonly code: ErrorCode;
  readonly addr?: bigint;
  /** 机器可读的补充信息，例如越权寄存器名、未命中的 opcode。不得含隐藏内容。 */
  readonly detail?: string;
}

/** 投影里的错误：文案 + 题目自定义 note（04 §4）。 */
export interface ErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  readonly note?: string;
}

export interface LastStop {
  readonly reason: StopReason;
  readonly addr?: bigint;
}

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  memory_fault: '访问了未映射或权限不足的地址',
  invalid_ip: '指令指针落在不可执行或未映射的地址',
  invalid_instruction: '无法解码的指令或未声明的调用号',
  resource_limit: '超出了步数或输出上限',
  hidden_address: '目标落在隐藏区域，直接动作不能读写隐藏内容',
  inaccessible_address: '目标未映射或权限不足',
  action_not_allowed: '该动作不在本题的允许动作集里',
  unknown_action: '未知动作',
  not_executable: '实例已结束或已失败，执行类动作被拒绝',
  empty_history: '没有可回退的历史',
  stdin_overflow: 'stdin 缓冲超过 4KB',
  reads_state: 'payload 不能包含读取当前状态的构造',
  invalid_arguments: '动作参数不合法',
};

/** 错误码 → 默认中文文案；出题人可用 `errorNotes` 覆盖 note，但不改这里的 message。 */
export function describeError(code: ErrorCode, addr?: bigint): string {
  const base = DEFAULT_MESSAGES[code];
  return addr === undefined ? base : `${base}（地址 ${formatHex(addr)}）`;
}

/** 判断错误码是否属于运行期异常。 */
export function isVmErrorCode(code: ErrorCode): code is VmErrorCode {
  return (
    code === 'memory_fault' ||
    code === 'invalid_ip' ||
    code === 'invalid_instruction' ||
    code === 'resource_limit'
  );
}

/** 判断错误码是否属于动作拒绝。 */
export function isRejectReason(code: ErrorCode): code is RejectReason {
  return !isVmErrorCode(code);
}
