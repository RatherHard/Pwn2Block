import { z } from 'zod';

/**
 * 十六进制字符串工具。
 *
 * 仓库里有两类十六进制表示，别混用：
 * - 地址 / 值：带 `0x` 前缀，例如 `"0x7ffff000"`（02 §1）。
 * - 原始字节：不带前缀的十六进制对，例如 `"c9c30f0e"`（VMA init 补丁、虚拟文件内容、填充字节）。
 */

const ADDR_RE = /^0x[0-9a-fA-F]+$/;
const BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** 地址 / 值：`0x` 前缀，解析后统一转小写。 */
export const HexSchema = z
  .string()
  .regex(ADDR_RE, '必须是 0x 前缀的十六进制字符串')
  .transform((v) => v.toLowerCase());

/** 原始字节序列：偶数个十六进制字符，无前缀，解析后统一转小写。允许空串。 */
export const HexBytesSchema = z
  .string()
  .regex(BYTES_RE, '必须是偶数个十六进制字符（无 0x 前缀）')
  .transform((v) => v.toLowerCase());

export type Hex = z.infer<typeof HexSchema>;
export type HexBytes = z.infer<typeof HexBytesSchema>;

export const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

/** 位宽掩码，用于把任意大整数回绕到 `archBits` 域内（负数按二补数处理）。 */
export function maskValue(value: bigint, archBits: number): bigint {
  return value & ((1n << BigInt(archBits)) - 1n);
}

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && ADDR_RE.test(value);
}

export function isHexBytes(value: unknown): value is string {
  return typeof value === 'string' && BYTES_RE.test(value);
}

export function parseHex(value: string): bigint {
  if (!ADDR_RE.test(value)) throw new Error(`非法十六进制字符串：${value}`);
  return BigInt(value.toLowerCase());
}

/** 数值 → `0x…` 字符串（小写、无多余前导零，与文档示例一致）。 */
export function formatHex(value: bigint): Hex {
  const normalized = value < 0n ? maskValue(value, 64) : value;
  return `0x${normalized.toString(16)}`;
}

/** 数值 → 定宽 hex（无前缀），用于内存 dump：64 位字长 16 个字符。 */
export function formatWord(value: bigint, archBits: number): HexBytes {
  const width = archBits / 4;
  return maskValue(value, archBits).toString(16).padStart(width, '0');
}

export function hexToBytes(hex: string): Uint8Array {
  if (!BYTES_RE.test(hex)) throw new Error(`非法字节串：${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): HexBytes {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexByteLength(hex: string): number {
  return hex.length / 2;
}

/** 小端字节序列 → 整数（未掩蔽，调用方按位宽掩蔽）。 */
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }
  return value;
}

/** 整数 → 定长小端字节序列（len 字节，超出部分截断）。 */
export function bigIntToBytesLE(value: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let rest = value < 0n ? maskValue(value, len * 8) : value;
  for (let i = 0; i < len; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function hexToBigIntLE(hex: string): bigint {
  return bytesToBigIntLE(hexToBytes(hex));
}

export function bigIntToHexLE(value: bigint, len: number): HexBytes {
  return bytesToHex(bigIntToBytesLE(value, len));
}

/** 子序列查找（逐字节精确匹配），用于 `mem_contains` / `stdout_contains` 谓词。 */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 忽略 ASCII 大小写的子序列查找。
 * 用于 S05 的 flag 哨兵检查：`FLAG{AbC}` 与 `flag{abc}` 视为同一真值，避免大小写变体绕过加载校验。
 */
export function containsBytesIgnoringAsciiCase(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      const a = haystack[i + j] ?? 0;
      const b = needle[j] ?? 0;
      if (a === b) continue;
      const lower = (x: number) => (x >= 0x41 && x <= 0x5a ? x + 0x20 : x);
      if (lower(a) !== lower(b)) continue outer;
    }
    return true;
  }
  return false;
}

export function asciiToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
