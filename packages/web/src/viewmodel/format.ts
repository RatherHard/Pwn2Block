/**
 * 地址与字节的格式化（05 §2）。纯函数：不依赖 DOM，node 环境下可直接测试。
 *
 * 约定：地址在视图里一律按 `archBits` 定宽显示，便于列对齐；附注与提示里用紧凑形式。
 */
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

export function maskToBits(value: bigint, archBits: number): bigint {
  const bits = BigInt(archBits);
  const mask = (1n << bits) - 1n;
  return value & mask;
}

/** `0x0000000000400000`：定宽地址（按 archBits 决定十六进制位数）。 */
export function formatAddr(value: bigint, archBits: number): string {
  const digits = Math.ceil(archBits / 4);
  return `0x${maskToBits(value, archBits).toString(16).padStart(digits, '0')}`;
}

/** `0x400000`：去掉前导零的紧凑地址，用于附注、链与提示。 */
export function formatAddrShort(value: bigint): string {
  return `0x${maskToBits(value, 64).toString(16)}`;
}

/** `0x1000`（数值前缀 + 十六进制），用于大小与偏移。 */
export function formatSize(value: bigint): string {
  return formatAddrShort(value);
}

/** 两位十六进制字节，例如 `0f`。 */
export function formatByte(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0');
}

/** `c9c30f0e` → `c9 c3 0f 0e`；非偶数长或非法字符原样返回，交给调用方处理。 */
export function formatHexSpaced(hex: string): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(hex.slice(i, i + 2));
  return out.join(' ');
}

/** 取第 `index` 个字节；越界或非法 hex 返回 undefined。 */
export function hexByteAt(hex: string, index: number): number | undefined {
  if (index < 0) return undefined;
  const pair = hex.slice(index * 2, index * 2 + 2);
  if (pair.length !== 2 || !/^[0-9a-f]{2}$/.test(pair)) return undefined;
  return Number.parseInt(pair, 16);
}

export function isPrintableAscii(byte: number): boolean {
  return byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX;
}

/**
 * 字节 → ASCII 展示文本：不可打印记 `.`，遇 `0x00` 视为字符串结束（pwndbg 风格）。
 */
export function asciiOfBytes(bytes: Uint8Array, max = 16): string {
  let out = '';
  const limit = Math.min(bytes.length, max);
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    out += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.';
  }
  return out;
}

export function asciiOfHex(hex: string, max = 16): string {
  const bytes = new Uint8Array(Math.max(0, Math.floor(hex.length / 2)));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = hexByteAt(hex, i) ?? 0;
  return asciiOfBytes(bytes, max);
}

/**
 * 至少有一个真正可打印字符时才返回文本，否则返回 undefined（视图不显示空 ASCII 列）。
 * `.` 只是不可打印字节的占位符，本身不算“可打印”。
 */
export function printableAsciiOfBytes(bytes: Uint8Array, max = 16): string | undefined {
  const limit = Math.min(bytes.length, max);
  let out = '';
  let hasPrintable = false;
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    if (isPrintableAscii(byte)) {
      hasPrintable = true;
      out += String.fromCharCode(byte);
    } else {
      out += '.';
    }
  }
  return hasPrintable ? out : undefined;
}

/** hex dump 用的 ASCII 列：每个字节都占一位，不可打印记 `.`（不把 NUL 当结束）。 */
export function dumpAsciiOfBytes(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.';
  return out;
}

export function printableAsciiOfHex(hex: string, max = 16): string | undefined {
  const bytes = new Uint8Array(Math.max(0, Math.floor(hex.length / 2)));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = hexByteAt(hex, i) ?? 0;
  return printableAsciiOfBytes(bytes, max);
}

/** `0x7fffe000 – 0x80000000`：VMA 范围（左闭右开）。 */
export function formatRange(start: bigint, size: bigint, archBits: number): string {
  return `${formatAddr(start, archBits)} – ${formatAddr(start + size, archBits)}`;
}

export function formatDecimal(value: bigint): string {
  return value.toString(10);
}

/**
 * 地址跳转输入框（05 §2.2）：接受 `0x…` 或十进制整数，其余返回 undefined。
 * 解析失败不抛异常，调用方给出提示文案。
 */
export function parseAddrInput(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^[0-9]+$/.test(trimmed)) return BigInt(trimmed);
  return undefined;
}

/** 地址按 `rowBytes` 向下对齐（视图窗口起点）。 */
export function alignDown(addr: bigint, rowBytes: number): bigint {
  const step = BigInt(rowBytes);
  return addr - (((addr % step) + step) % step);
}
