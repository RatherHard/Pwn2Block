import { z } from 'zod';
import { PORT_TYPES, type PortType } from './types';
import { EncodedValueSchema, type EncodedValue } from './values';
import { PYTHON_MAX_CODE_CHARS, PYTHON_MAX_INPUTS, PYTHON_MAX_INT_DIGITS } from '../limits';

/**
 * Python 求值协议（06 §6、07 §P1 / §P6）。
 *
 * 数据只走显式的命名输入与一个声明类型的输出，**不传任意 Python 对象**（06 §6）：
 * - 浏览器 → 服务端：`code` + `outputType` + 命名输入（不带请求标识、额度、句柄）；
 * - 服务端 → 运行器：上面的内容再加服务端分配的 `requestId` 与额度；
 * - 运行器 → 服务端：类型化结果，或带行号的错误。
 *
 * 整数一律十进制字符串（`EncodedValue`），不经 `number`，所以大整数不丢精度。
 */

/** 输入名：Python 里的变量名，所以限成标识符。 */
export const PYTHON_INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,15}$/;

export const PythonInputSchema = z.strictObject({
  name: z.string().regex(PYTHON_INPUT_NAME_RE, '输入名必须是合法的小写标识符'),
  type: z.enum(PORT_TYPES),
  value: EncodedValueSchema,
});

/** 客户端能提交的部分：代码、输出类型、输入。额度与标识都由服务端补。 */
export const PythonEvalRequestSchema = z.strictObject({
  code: z.string().min(1).max(PYTHON_MAX_CODE_CHARS),
  outputType: z.enum(PORT_TYPES),
  inputs: z.array(PythonInputSchema).max(PYTHON_MAX_INPUTS).default([]),
});

export type PythonEvalRequest = z.infer<typeof PythonEvalRequestSchema>;

/** 服务端派给运行器的任务：请求本身 + 服务端生成的标识。 */
export interface PythonEvalJob extends PythonEvalRequest {
  readonly requestId: string;
}

export const PYTHON_EVAL_ERROR_CODES = [
  'invalid_request',
  'unavailable',
  'timeout',
  'cancelled',
  'quota',
  'too_large',
  'syntax',
  'runtime',
  'bad_output',
] as const;
export type PythonEvalErrorCode = (typeof PYTHON_EVAL_ERROR_CODES)[number];

export const PythonEvalErrorSchema = z.strictObject({
  code: z.enum(PYTHON_EVAL_ERROR_CODES),
  message: z.string().max(2000),
  /** 用户代码里的行号（1 起）；定位不到时为 undefined。 */
  line: z.number().int().min(1).max(PYTHON_MAX_CODE_CHARS).optional(),
});

export type PythonEvalError = z.infer<typeof PythonEvalErrorSchema>;

export type PythonEvalOutcome =
  | {
      readonly ok: true;
      readonly value: EncodedValue;
      /** 服务端统计的耗时，用于诊断；不进编译产物。 */
      readonly durationMs: number;
    }
  | { readonly ok: false; readonly error: PythonEvalError };

/** 运行器写回服务端的一行 JSON。`requestId` 必须与任务一致，否则结果视为迟到。 */
export interface PythonRunnerResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: EncodedValue;
  readonly error?: PythonEvalError;
}

export const PythonRunnerResultSchema = z.strictObject({
  requestId: z.string().min(1).max(64),
  ok: z.boolean(),
  value: EncodedValueSchema.optional(),
  error: PythonEvalErrorSchema.optional(),
});

/** 输出的类型与声明不符时用它生成统一文案。 */
export function outputTypeMismatch(expected: PortType, actual: EncodedValue['kind']): string {
  return `Python 输出类型是 ${actual}，但节点声明的是 ${expected}`;
}

/** 整数位数上限：与传输编码一致，避免运行器把天文数字的整数塞回来。 */
export const PYTHON_INT_DIGIT_LIMIT = PYTHON_MAX_INT_DIGITS;
