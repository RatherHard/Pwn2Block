import { hexToBytes } from '@pwn2block/shared';
import type { GraphNode, ParamSpec, ParamValue, PortType } from '@pwn2block/shared';
import type { WorkflowValue } from './types';

/**
 * 参数值的解析与检查（06 §3「参数默认在节点内填写，可切换为连接输入」）。
 *
 * 参数是学习者手填的，所以两种用法都要能报出**可定位**的错误：
 * - 校验阶段：`checkParam` 给出「第几个参数、哪里不对」，UI 直接标在表单上；
 * - 编译阶段：`inlineValue` 把内填值转成端口值，越界 / 非法 hex / 负移位这类规则在这里截住。
 *
 * 整数一律走 `bigint` 与十进制字符串，不经 `number`，所以 64 位地址与 Python 回来的大整数
 * 都不损失精度（06 §6）。
 */

const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)$/;
const HEX_RE = /^0[xX][0-9a-fA-F]+$/;
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** 整数位的上限：再大的值参与乘法会迅速吃满内存，这里先按"不可信输入"拒绝。 */
export const MAX_INT_BITS = 1024;

export type Converted =
  | { readonly ok: true; readonly value: WorkflowValue }
  | { readonly ok: false; readonly message: string };

/** 参数检查结果：带参数名，UI 能定位到具体输入框。 */
export interface ParamIssue {
  readonly param: string;
  readonly message: string;
}

/** 十进制或 `0x` 十六进制 → `bigint`。允许 `number`（表单给的就是 number）。 */
export function parseInteger(raw: ParamValue | undefined): Converted {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, message: `整数必须是安全整数，收到 ${raw}` };
    return { ok: true, value: { kind: 'int', value: BigInt(raw) } };
  }
  if (typeof raw !== 'string') return { ok: false, message: `需要一个整数，收到 ${String(raw)}` };
  const text = raw.trim();
  if (DECIMAL_RE.test(text)) return { ok: true, value: { kind: 'int', value: BigInt(text) } };
  if (HEX_RE.test(text)) return { ok: true, value: { kind: 'int', value: BigInt(text) } };
  return { ok: false, message: `不是合法整数：${JSON.stringify(raw)}（十进制或 0x 前缀十六进制）` };
}

/** 检查一个整数参数的取值：类型、位数、上下界。 */
export function checkIntegerParam(param: ParamSpec, raw: ParamValue | undefined): string | undefined {
  const parsed = parseInteger(raw);
  if (!parsed.ok) return parsed.message;
  const value = parsed.value.kind === 'int' ? parsed.value.value : 0n;
  if (value > 0n && value.toString(2).length > MAX_INT_BITS) {
    return `整数超过 ${MAX_INT_BITS} 位，换一种算法或先拆分`;
  }
  if (param.min !== undefined && value < BigInt(param.min)) {
    return `${param.label}不能小于 ${param.min}，收到 ${value}`;
  }
  if (param.max !== undefined && value > BigInt(param.max)) {
    return `${param.label}不能大于 ${param.max}，收到 ${value}`;
  }
  return undefined;
}

/** 检查一个参数值是否符合它的输入形态；返回中文原因或 `undefined`。 */
export function checkParam(param: ParamSpec, raw: ParamValue | undefined): string | undefined {
  switch (param.kind) {
    case 'int':
      return checkIntegerParam(param, raw);
    case 'hex': {
      if (typeof raw !== 'string' || !HEX_BYTES_RE.test(raw.trim())) {
        return `${param.label}需要偶数个十六进制字符（无 0x 前缀）`;
      }
      return undefined;
    }
    case 'select':
    case 'type': {
      const options = param.options?.map((option) => option.value) ?? [];
      if (typeof raw !== 'string' || !options.includes(raw)) {
        return `${param.label}只能是 ${options.join(' / ')}，收到 ${String(raw)}`;
      }
      return undefined;
    }
    case 'text':
    case 'code': {
      if (typeof raw !== 'string') return `${param.label}需要文本`;
      return undefined;
    }
    case 'portList': {
      if (raw === undefined) return undefined;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (typeof entry !== 'string' || !/^[a-z][a-z0-9_]{0,15}:(?:int|bool|bytes|text)$/.test(entry.trim())) {
            return `${param.label}的每项必须是 name:类型，收到 ${String(entry)}`;
          }
        }
        return undefined;
      }
      if (typeof raw === 'string') {
        const entries = raw.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry !== '');
        for (const entry of entries) {
          if (!/^[a-z][a-z0-9_]{0,15}:(?:int|bool|bytes|text)$/.test(entry)) {
            return `${param.label}的每项必须是 name:类型，收到 ${entry}`;
          }
        }
        return undefined;
      }
      return `${param.label}需要一组 name:类型`;
    }
    case 'authorBlock': {
      if (typeof raw !== 'string' || raw === '') return `${param.label}需要选择一个题目积木`;
      return undefined;
    }
  }
}

/** 把内填参数转成端口值。`type` 是它要喂的端口类型。 */
export function inlineValue(raw: ParamValue | undefined, type: PortType): Converted {
  switch (type) {
    case 'int': {
      const parsed = parseInteger(raw);
      if (!parsed.ok) return parsed;
      return parsed;
    }
    case 'bytes': {
      if (typeof raw !== 'string') return { ok: false, message: `需要十六进制字节，收到 ${String(raw)}` };
      const hex = raw.trim();
      if (!HEX_BYTES_RE.test(hex)) {
        return { ok: false, message: `字节参数需要偶数个十六进制字符（无 0x 前缀）：${JSON.stringify(raw)}` };
      }
      return { ok: true, value: { kind: 'bytes', bytes: hexToBytes(hex) } };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: `需要文本，收到 ${String(raw)}` };
      return { ok: true, value: { kind: 'text', text: raw } };
    }
    case 'bool': {
      if (raw === 'true') return { ok: true, value: { kind: 'bool', value: true } };
      if (raw === 'false') return { ok: true, value: { kind: 'bool', value: false } };
      return { ok: false, message: `需要布尔值，收到 ${String(raw)}` };
    }
  }
}

/** 参数表的逐项检查：只报第一个问题就够，表单一次改一处。 */
export function checkParams(node: GraphNode, specs: readonly ParamSpec[]): ParamIssue | undefined {
  for (const spec of specs) {
    const raw = node.params[spec.name];
    const reason = checkParam(spec, raw === undefined ? spec.default : raw);
    if (reason !== undefined) return { param: spec.name, message: reason };
  }
  return undefined;
}
