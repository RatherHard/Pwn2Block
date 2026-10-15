import { hasPerm } from '@pwn2block/shared';
import type {
  ArchBits,
  MemAccessReason,
  MemFault,
  Perm,
  PermChar,
  VmaId,
  VmaInit,
  VmaKind,
} from '@pwn2block/shared';

/**
 * VMA 布局与访问校验（G01，02 §3）。
 *
 * 本文件只做两件事：
 * 1. 把题目包声明的 `VmaInit` 规整成一张**互不重叠、按 start 升序**的区间表；
 * 2. 把一次 `[addr, addr + len)` 访问切成若干段，并在切片过程中判定越权。
 *
 * **这里不做隐藏检查**：`hidden` 只是“内容不进入投影”（02 §3），程序指令照常读写；
 * 可见性由 B 的动作层与 C 的投影层负责，内存层永不因 `hidden` 拒绝访问。
 */

/** 位宽掩码：`2^archBits - 1`（02 §1）。 */
export function archMask(archBits: ArchBits): bigint {
  return (1n << BigInt(archBits)) - 1n;
}

/** 按位宽把地址掩蔽回绕到域内（02 §1、§4：有效地址按 2^archBits 回绕）。 */
export function maskAddress(addr: bigint, mask: bigint): bigint {
  return addr & mask;
}

/** 一个 VMA 的规整表示：区间为左闭右开 `[start, end)`。 */
export interface VmaRange {
  readonly id: VmaId;
  readonly kind: VmaKind;
  readonly label?: string;
  readonly start: bigint;
  readonly size: number;
  readonly end: bigint;
  readonly perm: Perm;
  readonly hidden: boolean;
}

/** 一张 VMA 区间表。声明顺序对访问语义没有影响，因此内部按 start 升序保存。 */
export interface VmaTable {
  readonly archBits: ArchBits;
  readonly mask: bigint;
  readonly ranges: readonly VmaRange[];
  readonly byId: ReadonlyMap<VmaId, VmaRange>;
}

/** 一次访问落在单个 VMA 内的最大连续片段（用于读、写、校验三方共用）。 */
export interface AccessSegment {
  readonly vma: VmaRange;
  readonly start: bigint;
  readonly end: bigint;
}

/**
 * 一次访问的校验结果。
 *
 * 成功时回带**掩蔽后的起始地址**与分段；失败时是 `MemFault`，
 * 其中 `addr` 是请求的起始地址（已掩蔽）、`len` 是请求长度，便于直接进错误文案（02 §6）。
 */
export type AccessPlan =
  | { readonly ok: true; readonly addr: bigint; readonly segments: readonly AccessSegment[] }
  | MemFault;

export function buildVmaTable(vmas: readonly VmaInit[], archBits: ArchBits): VmaTable {
  const mask = archMask(archBits);
  const byId = new Map<VmaId, VmaRange>();
  const ranges: VmaRange[] = [];
  for (const vma of vmas) {
    if (byId.has(vma.id)) {
      throw new Error(`VMA 布局非法：id 重复（${vma.id}）`);
    }
    const range = toRange(vma, mask, archBits);
    byId.set(vma.id, range);
    ranges.push(range);
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  assertNoOverlap(ranges);
  return { archBits, mask, ranges, byId };
}

function toRange(vma: VmaInit, mask: bigint, archBits: ArchBits): VmaRange {
  if (!Number.isSafeInteger(vma.size) || vma.size < 0) {
    throw new Error(`VMA 布局非法：${vma.id} 的 size 必须是非负安全整数`);
  }
  const end = vma.start + BigInt(vma.size);
  if (vma.start < 0n || end > mask + 1n) {
    throw new Error(`VMA 布局非法：${vma.id} 超出 ${archBits} 位地址空间`);
  }
  assertPatchesInside(vma, end);
  return {
    id: vma.id,
    kind: vma.kind,
    label: vma.label,
    start: vma.start,
    size: vma.size,
    end,
    perm: vma.perm,
    hidden: vma.hidden,
  };
}

/** `init` 补丁不得越出本 VMA（02 §3）；越出即拒绝建表，不静默截断。 */
function assertPatchesInside(vma: VmaInit, end: bigint): void {
  for (const patch of vma.init) {
    const patchEnd = patch.at + BigInt(patch.bytes.length);
    if (patch.at < vma.start || patchEnd > end) {
      throw new Error(
        `VMA 布局非法：${vma.id} 的 init 补丁越出本 VMA（at=${patch.at}，len=${patch.bytes.length}）`,
      );
    }
  }
}

function assertNoOverlap(ranges: readonly VmaRange[]): void {
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1] as VmaRange;
    const cur = ranges[i] as VmaRange;
    if (cur.start < prev.end) {
      throw new Error(`VMA 布局非法：${prev.id} 与 ${cur.id} 地址区间重叠`);
    }
  }
}

/** 第一个 `end > addr` 的区间；返回的区间可能整体在 `addr` 之后（即 `addr` 落在空洞里）。 */
export function findVmaAtOrAfter(table: VmaTable, addr: bigint): VmaRange | undefined {
  const { ranges } = table;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid] as VmaRange).end <= addr) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length ? (ranges[lo] as VmaRange) : undefined;
}

/** 包含 `addr` 的区间；未映射时为 `undefined`。 */
export function findVmaContaining(table: VmaTable, addr: bigint): VmaRange | undefined {
  const range = findVmaAtOrAfter(table, addr);
  return range !== undefined && range.start <= addr ? range : undefined;
}

function fault(reason: MemAccessReason, addr: bigint, len: number): MemFault {
  return { ok: false, reason, addr, len };
}

/**
 * 整段校验：`[addr, addr + len)` 的每一字节都必须落在带 `need` 权限的 VMA 里。
 *
 * 语义要点：
 * - `addr` 先按 `archBits` 掩蔽；区间越过地址空间末尾整体失败（不逐字节回绕，
 *   逐字节回绕会让一段连续缓冲同时落在地址空间两端，无法对应调用方的缓冲语义）。
 * - `len === 0` 不触碰任何字节，永远通过（零长度读写没有任何信息量，也就不构成映射探测）。
 * - 按地址顺序推进，**首个**故障决定 `reason`：空洞 → `unmapped`，命中但权限不足 → `permission`。
 * - 循环次数由相交的 VMA 个数决定（题目包上限 32 个），与 `len` 无关。
 */
export function planAccess(table: VmaTable, rawAddr: bigint, len: number, need: PermChar): AccessPlan {
  if (!Number.isSafeInteger(len) || len < 0) {
    throw new RangeError(`非法访问长度：${String(len)}（必须是非负安全整数）`);
  }
  const addr = maskAddress(rawAddr, table.mask);
  if (len === 0) return { ok: true, addr, segments: [] };
  const end = addr + BigInt(len);
  if (end > table.mask + 1n) return fault('unmapped', addr, len);

  const segments: AccessSegment[] = [];
  let pos = addr;
  while (pos < end) {
    const vma = findVmaAtOrAfter(table, pos);
    if (vma === undefined || vma.start > pos) return fault('unmapped', addr, len);
    if (!hasPerm(vma.perm, need)) return fault('permission', addr, len);
    const segEnd = vma.end < end ? vma.end : end;
    segments.push({ vma, start: pos, end: segEnd });
    pos = segEnd;
  }
  return { ok: true, addr, segments };
}
