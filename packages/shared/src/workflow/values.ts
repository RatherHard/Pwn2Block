import { z } from 'zod';
import { bytesToHex, hexToBytes } from '../hex';
import { PYTHON_MAX_INT_DIGITS } from '../limits';
import { PORT_TYPE_LABELS, PORT_TYPES, type PortType } from './types';

/**
 * 值的传输编码（06 §6、07 §P1）。
 *
 * 编译期的值在浏览器里用 `bigint` / `Uint8Array` 表示；跨进程（Python）与存档只走这里的形式：
 * - 整数用**十进制字符串**，不经 `number`，所以 64 位地址与超大整数都不丢精度；
 * - 字节用**无前缀 hex**，与仓库里其他"原始字节"同一口径（`hex.ts`）；
 * - 文本用 JSON 字符串；布尔用 JSON 布尔。
 *
 * 这四种之外没有别的值：不接受任意对象、数组或 null（06 §6）。
 */
export type EncodedValue =
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'bytes'; readonly hex: string }
  | { readonly kind: 'text'; readonly text: string };

/** 整数上限：十进制位数。超过就说明对面在试探，直接拒绝而不是让 bigint 吃满内存。 */
const INT_RE = /^-?(?:0|[1-9][0-9]*)$/;
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;

export const EncodedIntSchema = z
  .string()
  .max(PYTHON_MAX_INT_DIGITS, `整数超过 ${PYTHON_MAX_INT_DIGITS} 位十进制数字`)
  .regex(INT_RE, '整数必须是无前导零的十进制字符串');

export const EncodedValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('int'), value: EncodedIntSchema }),
  z.strictObject({ kind: z.literal('bool'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('bytes'), hex: z.string().regex(HEX_BYTES_RE, '字节必须是无前缀的偶数字节 hex') }),
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
]);

/** 输出类型声明：只能声明四类之一，不接受 'any'（06 §6）。 */
export const OutputTypeSchema = z.enum(PORT_TYPES);

export function encodedValueKind(value: EncodedValue): PortType {
  return value.kind;
}

/** `bigint` → 传输形式。负数保留（比较、减法会产生负数，编码成字节时再报错）。 */
export function encodeInt(value: bigint): EncodedValue {
  return { kind: 'int', value: value.toString(10) };
}

export function encodeBytes(bytes: Uint8Array): EncodedValue {
  return { kind: 'bytes', hex: bytesToHex(bytes) };
}

export function encodeText(text: string): EncodedValue {
  return { kind: 'text', text };
}

export function encodeBool(value: boolean): EncodedValue {
  return { kind: 'bool', value };
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** 传输形式 → `bigint`（无损，不经过 `number`）。 */
export function decodeInt(value: EncodedValue): DecodeResult<bigint> {
  if (value.kind !== 'int') return { ok: false, message: `期望整数，收到${PORT_TYPE_LABELS[value.kind]}` };
  if (!INT_RE.test(value.value)) return { ok: false, message: `整数格式非法：${value.value}` };
  if (value.value.replace('-', '').length > PYTHON_MAX_INT_DIGITS) {
    return { ok: false, message: `整数超过 ${PYTHON_MAX_INT_DIGITS} 位十进制数字` };
  }
  return { ok: true, value: BigInt(value.value) };
}

export function decodeBytes(value: EncodedValue): DecodeResult<Uint8Array> {
  if (value.kind !== 'bytes') return { ok: false, message: `期望字节，收到${PORT_TYPE_LABELS[value.kind]}` };
  if (!HEX_BYTES_RE.test(value.hex)) return { ok: false, message: `字节串格式非法：${value.hex}` };
  return { ok: true, value: hexToBytes(value.hex) };
}

/** 一个值的字节长度：字节就是长度，整数按 8 字节估（只用于摘要提示）。 */
export function encodedValueByteLength(value: EncodedValue): number | undefined {
  if (value.kind === 'bytes') return value.hex.length / 2;
  if (value.kind === 'text') return new TextEncoder().encode(value.text).length;
  return undefined;
}

/** 预览用的一行摘要：整数同时给十进制与十六进制，字节给长度与开头。 */
export function encodedValueSummary(value: EncodedValue): string {
  switch (value.kind) {
    case 'int': {
      const big = BigInt(value.value);
      if (big >= 0n && big < 1n << 64n) return `${value.value}（0x${big.toString(16)}）`;
      return value.value;
    }
    case 'bool':
      return value.value ? '真' : '假';
    case 'bytes': {
      const length = value.hex.length / 2;
      if (length === 0) return '0 字节（空）';
      const head = value.hex.slice(0, 32);
      return `${length} 字节：${head}${length > 16 ? '…' : ''}`;
    }
    case 'text':
      return JSON.stringify(value.text.length > 32 ? `${value.text.slice(0, 32)}…` : value.text);
  }
}
