import { PAGE_SIZE } from '@pwn2block/shared';

/**
 * 4KB 分页的写时复制页存储（G01，02 §7）。
 *
 * 不变式（整个内存层都依赖它）：
 * - 页表（`PageTable`）与页内容（`Uint8Array`）**永不原地修改**；
 * - 写入通过 `writeRange` 产生**新的页表**，且只复制本次真正触及的页，
 *   其余页按引用共享，因此“写一个字节只复制那一页”；
 * - 页缺失等价于整页 0（VMA 内未被 `init` / 写入覆盖的部分必须是 0，02 §3）；
 * - 页一经复制就只被新页表引用，可以安全地只改那一页。
 *
 * 页表以页号为键。VMA 起点按 4KB 对齐、大小为 4KB 的倍数（02 §3），
 * 所以正常情况下不存在“一页横跨两个 VMA”的情形，页权限由 `vma.ts` 的分段校验负责。
 */

const PAGE_BYTES = BigInt(PAGE_SIZE);

/** 页号 = `addr / 4KB`。 */
export function pageIndexOf(addr: bigint): bigint {
  return addr / PAGE_BYTES;
}

/** 页起始地址。 */
export function pageStartOf(pageIndex: bigint): bigint {
  return pageIndex * PAGE_BYTES;
}

/** 页内偏移（0..PAGE_SIZE-1）。 */
export function pageOffsetIn(addr: bigint): number {
  return Number(addr % PAGE_BYTES);
}

/** 不可变页表：页号 → 4KB 页内容。缺失的页是整页 0。 */
export type PageTable = ReadonlyMap<bigint, Uint8Array>;

/** 初始空页表；因为它永不被修改，可以直接共享。 */
export const EMPTY_PAGE_TABLE: PageTable = new Map<bigint, Uint8Array>();

/**
 * 读取一段连续区间，返回新数组。
 * 调用方必须已经用 `planAccess` 校验过整段（未落页的部分按 0 读出）。
 */
export function readRange(pages: PageTable, addr: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let pos = addr;
  let off = 0;
  while (off < len) {
    const inPage = pageOffsetIn(pos);
    const chunk = Math.min(PAGE_SIZE - inPage, len - off);
    const page = pages.get(pageIndexOf(pos));
    if (page !== undefined) out.set(page.subarray(inPage, inPage + chunk), off);
    pos += BigInt(chunk);
    off += chunk;
  }
  return out;
}

/**
 * 写入一段连续区间，返回**新页表**；只复制被触及的页。
 * 调用方必须已经用 `planAccess` 校验过整段权限，本函数不再做权限判断。
 */
export function writeRange(pages: PageTable, addr: bigint, bytes: Uint8Array): PageTable {
  if (bytes.length === 0) return pages;
  const next = new Map(pages);
  let pos = addr;
  let off = 0;
  while (off < bytes.length) {
    const index = pageIndexOf(pos);
    const inPage = pageOffsetIn(pos);
    const chunk = Math.min(PAGE_SIZE - inPage, bytes.length - off);
    const existing = next.get(index);
    // 复制而不是原地改：`existing` 可能被历史快照或旧状态共享。
    const page = existing === undefined ? new Uint8Array(PAGE_SIZE) : existing.slice();
    page.set(bytes.subarray(off, off + chunk), inPage);
    next.set(index, page);
    pos += BigInt(chunk);
    off += chunk;
  }
  return next;
}
