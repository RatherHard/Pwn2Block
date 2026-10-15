/**
 * 投影读取器（05 §2）：把一份 `Projection` 包装成只读的可见内存视图。
 *
 * **隐藏即不下发**（01 §6 第 2 条）：隐藏 VMA 在投影里没有 `hex`，这里也就读不到字节；
 * `locate()` 仍然会命中隐藏 VMA（布局是公开的），供视图显示 `??` 与所属 VMA。
 */
import {
  bytesToBigIntLE,
  hexToBytes,
  parseHex,
  type DisasmEntry,
  type Projection,
  type VmaView,
} from '@pwn2block/shared';
import { printableAsciiOfBytes, formatByte } from './format';

export type ByteState = 'visible' | 'hidden' | 'unmapped';

export interface ByteInfo {
  readonly addr: bigint;
  readonly state: ByteState;
  /** 命中区域时给出 VMA id（隐藏区也给，布局是公开的）。 */
  readonly vmaId?: string;
  /** 仅 `visible` 时存在。 */
  readonly byte?: number;
}

export interface VmaContents {
  readonly vma: VmaView;
  readonly start: bigint;
  readonly size: bigint;
  /** 仅可见 VMA 有内容；隐藏 VMA 为 undefined。 */
  readonly bytes?: Uint8Array;
}

export interface ProjectionReader {
  readonly archBits: number;
  readonly wordBytes: number;
  readonly vmas: readonly VmaContents[];
  /** 命中 VMA（含隐藏区）；未映射返回 undefined。 */
  locate(addr: bigint): VmaContents | undefined;
  byteAt(addr: bigint): ByteInfo;
  /** 单次读取必须完全落在一个可见 VMA 内，否则返回 undefined。 */
  read(addr: bigint, len: number): Uint8Array | undefined;
  readWordLE(addr: bigint): bigint | undefined;
  /** 可见内存里的可打印字符串（最长 `max`，遇 NUL 结束）。 */
  readString(addr: bigint, max?: number): string | undefined;
  disasmAt(addr: bigint): DisasmEntry | undefined;
  /** 该地址所在 VMA 是否可执行。 */
  isExecutable(addr: bigint): boolean;
  isVisible(addr: bigint): boolean;
}

function contentsOf(vma: VmaView): VmaContents {
  return {
    vma,
    start: parseHex(vma.start),
    size: parseHex(vma.size),
    bytes: vma.hex === undefined ? undefined : hexToBytes(vma.hex),
  };
}

export function createProjectionReader(projection: Projection, archBits: number): ProjectionReader {
  const vmas = projection.vmas.map(contentsOf);
  const wordBytes = Math.max(1, Math.floor(archBits / 8));
  const disasmIndex = new Map<bigint, DisasmEntry>();
  for (const entry of projection.disasm) disasmIndex.set(parseHex(entry.addr), entry);

  const locate = (addr: bigint): VmaContents | undefined =>
    vmas.find((item) => addr >= item.start && addr < item.start + item.size);

  const read = (addr: bigint, len: number): Uint8Array | undefined => {
    if (len <= 0) return new Uint8Array(0);
    const found = locate(addr);
    if (!found || found.bytes === undefined) return undefined;
    const offset = addr - found.start;
    // 内容长度以实际下发的字节为准：越界或短于声明的 `size` 都不读，宁可显示 `??`。
    if (offset + BigInt(len) > BigInt(found.bytes.length)) return undefined;
    const start = Number(offset);
    return found.bytes.slice(start, start + len);
  };

  const byteAt = (addr: bigint): ByteInfo => {
    const found = locate(addr);
    if (!found) return { addr, state: 'unmapped' };
    if (found.bytes === undefined) return { addr, state: 'hidden', vmaId: found.vma.id };
    const byte = found.bytes[Number(addr - found.start)];
    return byte === undefined
      ? { addr, state: 'hidden', vmaId: found.vma.id }
      : { addr, state: 'visible', vmaId: found.vma.id, byte };
  };

  const readWordLE = (addr: bigint): bigint | undefined => {
    const bytes = read(addr, wordBytes);
    return bytes === undefined ? undefined : bytesToBigIntLE(bytes);
  };

  return {
    archBits,
    wordBytes,
    vmas,
    locate,
    byteAt,
    read,
    readWordLE,
    readString: (addr, max = 16) => {
      const bytes = read(addr, max);
      if (bytes === undefined) return undefined;
      // 只返回真正含可打印字符的文本，避免把一串 `0x00` 注解成 `"..."`。
      return printableAsciiOfBytes(bytes, max);
    },
    disasmAt: (addr) => disasmIndex.get(addr),
    isExecutable: (addr) => (locate(addr)?.vma.perm.includes('x') ?? false),
    isVisible: (addr) => locate(addr)?.bytes !== undefined,
  };
}

/** 单元格文本：可见给两位 hex，隐藏给 `??`，未映射给空串（05 §2.2）。 */
export function cellText(info: ByteInfo): string {
  if (info.state === 'hidden') return '??';
  if (info.state === 'unmapped') return '';
  return formatByte(info.byte ?? 0);
}

/** 状态说明文案，用于图例与不可见区域的解释。 */
export function byteStateName(state: ByteState): string {
  if (state === 'hidden') return '隐藏';
  if (state === 'unmapped') return '未映射';
  return '可见';
}
