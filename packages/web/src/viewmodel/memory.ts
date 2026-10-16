/**
 * 自由视图行投影（05 §2.5）。纯函数。
 *
 * 全部 VMA 的布局都公开（含隐藏区）：隐藏的标「隐藏」，**只显示布局、不显示内容**；
 * 非隐藏 VMA 可以按窗口做 hex dump。视图里没有“任意地址读取”，只有投影里已有的字节。
 */
import type { Projection, VmaKind, VmaView } from '@pwn2block/shared';
import { parseHex } from '@pwn2block/shared';
import {
  dumpAsciiOfBytes,
  formatAddr,
  formatRange,
  formatSize,
  hexByteAt,
} from './format';

export const VMA_KIND_NAMES: Readonly<Record<VmaKind, string>> = {
  code: '代码',
  global: '全局',
  stack: '栈',
  heap: '堆',
  key: '关键区',
  custom: '自定义',
};

export const HIDDEN_TAG = '隐藏';

export interface VmaListRow {
  readonly id: string;
  readonly kind: VmaKind;
  readonly kindName: string;
  readonly label?: string;
  readonly start: bigint;
  readonly size: bigint;
  readonly range: string;
  readonly perm: string;
  readonly hidden: boolean;
  /** 隐藏 VMA 没有内容，只能浏览布局（01 §6 第 2 条）。 */
  readonly hasContent: boolean;
  readonly sizeText: string;
  /** `formatAddr(start)`：定宽起始地址，便于列对齐。 */
  readonly startText: string;
  /** `formatAddr(start + size)`：定宽结束地址（左闭右开）。 */
  readonly endText: string;
}

export function buildVmaList(projection: Projection, archBits: number): readonly VmaListRow[] {
  return projection.vmas.map((vma: VmaView) => {
    const start = parseHex(vma.start);
    const size = parseHex(vma.size);
    return {
      id: vma.id,
      kind: vma.kind,
      kindName: VMA_KIND_NAMES[vma.kind],
      label: vma.label,
      start,
      size,
      range: formatRange(start, size, archBits),
      perm: vma.perm,
      hidden: vma.hidden,
      hasContent: vma.hex !== undefined,
      sizeText: formatSize(size),
      startText: formatAddr(start, archBits),
      endText: formatAddr(start + size, archBits),
    };
  });
}

/** 隐藏 VMA 的说明文案：不解释内容，只说明为什么没有内容。 */
export function hiddenNotice(vma: Pick<VmaListRow, 'id' | 'start' | 'size'>): string {
  return `VMA「${vma.id}」是隐藏区域：布局（起始地址、大小、权限）公开，内容未随投影下发。`;
}

export interface HexDumpRow {
  readonly offset: number;
  readonly addr: bigint;
  readonly address: string;
  readonly hex: string;
  readonly ascii: string;
}

export interface HexDumpOptions {
  readonly baseAddr?: bigint;
  readonly byteOffset?: number;
  readonly rows?: number;
  readonly rowBytes?: number;
}

export const DEFAULT_DUMP_ROWS = 16;
export const DEFAULT_DUMP_ROW_BYTES = 16;

export function dumpByteLength(hex: string | undefined): number {
  return hex === undefined ? 0 : Math.floor(hex.length / 2);
}

export function dumpMaxOffset(byteLength: number, rows: number, rowBytes: number): number {
  const span = rows * rowBytes;
  return Math.max(0, Math.floor(Math.max(0, byteLength - 1) / span) * span);
}

export function clampDumpOffset(
  byteLength: number,
  offset: number,
  rows = DEFAULT_DUMP_ROWS,
  rowBytes = DEFAULT_DUMP_ROW_BYTES,
): number {
  const aligned = Math.floor(Math.max(0, offset) / rowBytes) * rowBytes;
  const max = dumpMaxOffset(byteLength, rows, rowBytes);
  return aligned > max ? max : aligned;
}

/**
 * 生成 hex dump 窗口。隐藏 VMA（`hex === undefined`）返回空数组：
 * 视图据此显示“只有布局”。
 */
export function buildHexDump(hex: string | undefined, options: HexDumpOptions = {}): readonly HexDumpRow[] {
  if (hex === undefined) return [];
  const rows = options.rows ?? DEFAULT_DUMP_ROWS;
  const rowBytes = options.rowBytes ?? DEFAULT_DUMP_ROW_BYTES;
  const base = options.baseAddr ?? 0n;
  const start = clampDumpOffset(dumpByteLength(hex), options.byteOffset ?? 0, rows, rowBytes);

  const out: HexDumpRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = start + row * rowBytes;
    const bytes = readChunk(hex, offset, rowBytes);
    if (bytes.length === 0 && offset > 0) break;
    const addr = base + BigInt(offset);
    const hexText = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    out.push({
      offset,
      addr,
      address: formatAddr(addr, 64),
      hex: hexText.padEnd(rowBytes * 3 - 1, ' '),
      ascii: dumpAsciiOfBytes(bytes),
    });
  }
  return out;
}

function readChunk(hex: string, offset: number, rowBytes: number): Uint8Array {
  const length = Math.max(0, Math.min(rowBytes, dumpByteLength(hex) - offset));
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = hexByteAt(hex, offset + i) ?? 0;
  return bytes;
}
