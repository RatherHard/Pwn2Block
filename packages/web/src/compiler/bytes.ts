import { MAX_BYTE_CONSTRUCTION_BYTES, type ArchBits } from '@pwn2block/shared';

/**
 * 字节构造原语（05 §3.1）。
 *
 * 这一层是**纯函数**：不 import Blockly、不读页面状态、不改入参，同样的输入永远得到同样的字节。
 * 编译器负责把 `ByteBuildError` 转成带积木 id 的编译错误，所以这里对非法输入一律显式抛错，
 * **绝不静默截断或回绕**：学习者写的宽度不合法时，报错比悄悄写错字节有用得多。
 *
 * 教学核心是小端序：`int` / `addr` 默认 little-endian，断言精确到每个字节
 * （例如 `addr(0x400002)` 是 `02 00 40 00 00 00 00 00`）。
 */

/** 端序。默认 `little`，因为 payload 的目标是 x86 风格的小端机器（05 §3.1）。 */
export type Endian = 'little' | 'big';

export type ByteErrorCode =
  | 'invalid_value'
  | 'invalid_byte'
  | 'invalid_length'
  | 'invalid_hex'
  | 'negative_value'
  | 'width_out_of_range'
  | 'value_overflow'
  | 'invalid_endian'
  | 'length_out_of_range';

/** 字节构造原语的结构化错误：`code` 便于测试精确断言，`message` 是给学习者看的中文文案。 */
export class ByteBuildError extends Error {
  readonly code: ByteErrorCode;

  constructor(code: ByteErrorCode, message: string) {
    super(message);
    this.name = 'ByteBuildError';
    this.code = code;
  }
}

/** 位宽的上下界（以字节计）：1 字节到 64 位（02 §1 只支持 32/64 位机器）。 */
export const MIN_INT_WIDTH = 1;
export const MAX_INT_WIDTH = 8;

/** 默认字长：64 位机器一个寄存器 8 字节。32 位题目由编译器传 `wordBytes(archBits)`。 */
export const DEFAULT_WORD_BYTES = 8;

/**
 * 单个字节构造允许的最大字节数：**请求体上限的一半**（04 §6，常量在 shared 的 `limits.ts`）。
 *
 * 为什么必须有这个上限：`padding(byte, n)` 的 n 直接来自学习者的数字输入框，构造出的字节还要
 * hex 编码（长度翻倍）后进请求体。没有上限时两件事都会发生，而且都不是"学习者写错了"：
 * - n 大到几 GB：`Uint8Array` 真的去分配，页面直接卡死（实测 1e10 字节要 3 秒并占住 10GB 虚拟内存）；
 * - n 更大（例如 `Number.MAX_SAFE_INTEGER`）：`RangeError: Array buffer allocation failed`
 *   会**逃出** `compileProgram`，编译器就违反了「要么给动作、要么给带 blockId 的错误」的契约。
 *
 * 数值本身不在这里定义：它是全局资源上限，与 `MAX_BODY_BYTES` 同源，必须只有一份（07 §2）。
 */
export const MAX_BYTE_LENGTH = MAX_BYTE_CONSTRUCTION_BYTES;

/** 分配前的长度检查：超出上限就抛结构化错误，让编译器转成带 blockId 的编译错误。 */
function assertLength(length: number, what: string): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ByteBuildError('invalid_length', `${what}必须是非负整数，收到 ${String(length)}`);
  }
  if (length > MAX_BYTE_LENGTH) {
    throw new ByteBuildError(
      'length_out_of_range',
      `${what}超过单个字节构造的上限 ${MAX_BYTE_LENGTH} 字节（请求体上限的一半，04 §6）`,
    );
  }
}

/** 题目位宽 → 字长（字节）。 */
export function wordBytes(archBits: ArchBits): number {
  return archBits / 8;
}

/** 偶数个十六进制字符，无 `0x` 前缀（与 shared 的 `HexBytesSchema` 同一口径）。 */
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;

const textEncoder = new TextEncoder();

function toBigInt(value: bigint | number, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new ByteBuildError(
    'invalid_value',
    `${what}必须是安全整数或 bigint，收到 ${String(value)}`,
  );
}

/**
 * `padding(byte, n)`：n 个重复字节。用于 `"A"×16` 这类填充。
 */
export function padding(byte: number, n: number): Uint8Array {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new ByteBuildError(
      'invalid_byte',
      `填充字节必须是 0x00..0xff 之间的整数，收到 ${String(byte)}`,
    );
  }
  assertLength(n, '填充次数');
  return new Uint8Array(n).fill(byte);
}

/**
 * `string(s)`：UTF-8 字节。`"中"` 是 `e4b8ad`，不是 Latin-1。
 */
export function string(s: string): Uint8Array {
  if (typeof s !== 'string') {
    throw new ByteBuildError('invalid_value', `string 需要字符串，收到 ${String(s)}`);
  }
  const bytes = textEncoder.encode(s);
  // 按**编码后的字节数**设限：一个汉字 3 字节，不是 1 字节。
  assertLength(bytes.length, '字符串的字节数');
  return bytes;
}

/**
 * `int(v, width, endian)`：定宽整数。默认宽度 W（8 字节），默认小端。
 *
 * - `width` 以**字节**为单位，范围 1..8。
 * - `v` 必须是非负整数，且能放进 `width` 字节；放不下就报错，不做截断。
 */
export function int(
  value: bigint | number,
  width: number = DEFAULT_WORD_BYTES,
  endian: Endian = 'little',
): Uint8Array {
  const big = toBigInt(value, '整数');
  if (big < 0n) {
    throw new ByteBuildError('negative_value', `整数不能为负：${big.toString()}`);
  }
  if (!Number.isInteger(width) || width < MIN_INT_WIDTH || width > MAX_INT_WIDTH) {
    throw new ByteBuildError(
      'width_out_of_range',
      `宽度必须是 ${MIN_INT_WIDTH}..${MAX_INT_WIDTH} 字节之间的整数，收到 ${String(width)}`,
    );
  }
  if (endian !== 'little' && endian !== 'big') {
    throw new ByteBuildError('invalid_endian', `端序只能是 little 或 big，收到 ${String(endian)}`);
  }
  if (big >= 1n << BigInt(width * 8)) {
    throw new ByteBuildError(
      'value_overflow',
      `数值 0x${big.toString(16)} 放不进 ${width} 字节（最大值 0x${((1n << BigInt(width * 8)) - 1n).toString(16)}）`,
    );
  }

  const out = new Uint8Array(width);
  let rest = big;
  for (let i = 0; i < width; i += 1) {
    // 小端：低位字节在前；大端反过来写。
    const index = endian === 'little' ? i : width - 1 - i;
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * `addr(v)`：等价于 `int(v, W, little)`。单独列出是为了教学——
 * 学习者一眼就知道这是"一个地址按小端写进去"，而不是随便一个整数。
 */
export function addr(value: bigint | number, word: number = DEFAULT_WORD_BYTES): Uint8Array {
  return int(value, word, 'little');
}

/**
 * `raw(hex)`：原始 hex 字节。要求偶数个十六进制字符、不带 `0x` 前缀（空串合法，表示零字节）。
 */
export function raw(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX_BYTES_RE.test(hex)) {
    throw new ByteBuildError(
      'invalid_hex',
      `raw 需要偶数个十六进制字符（无 0x 前缀），收到 ${JSON.stringify(String(hex))}`,
    );
  }
  const length = hex.length / 2;
  assertLength(length, 'raw 的字节数');
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * `concat(...)`：按顺序拼接片段。不修改任何入参，返回新数组。
 */
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new ByteBuildError('invalid_value', 'concat 只接受 Uint8Array 片段');
    }
    total += part.length;
  }
  assertLength(total, '拼接结果');

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
