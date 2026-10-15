import { hasPerm, parseHex } from '@pwn2block/shared';
import type {
  ArchBits,
  ChallengeVma,
  Perm,
  PermChar,
  VmaId,
  VmaKind,
  VmState,
} from '@pwn2block/shared';

/**
 * 题目布局索引：把私有包的 VMA 声明规整成区间表，供**动作层**做隐藏与权限判定。
 *
 * 为什么需要它（02 §3、04 §2）：
 * - 内存层（G）不做隐藏检查，程序指令照常读写隐藏 VMA；
 *   拒绝“直接动作”读写隐藏区是动作层（本文件的 `checkActionRange`）的职责。
 * - 判定只用题目声明的布局（地址、大小、权限、hidden），**不读内存内容**，
 *   因此隐藏区被拒绝时不会泄露任何字节。
 */

export interface VmaRegion {
  readonly id: VmaId;
  readonly kind: VmaKind;
  readonly label?: string;
  readonly start: bigint;
  readonly size: number;
  /** 左闭右开区间上界 `start + size`。 */
  readonly end: bigint;
  readonly perm: Perm;
  readonly hidden: boolean;
}

export interface LayoutIndex {
  readonly archBits: ArchBits;
  readonly mask: bigint;
  /** 按 start 升序，便于二分与区间判定。 */
  readonly regions: readonly VmaRegion[];
  readonly byId: ReadonlyMap<VmaId, VmaRegion>;
}

/** 建立布局索引。区间重叠是题目包错误，直接报错而不是静默取其一。 */
export function buildLayoutIndex(vmas: readonly ChallengeVma[], archBits: ArchBits): LayoutIndex {
  const mask = (1n << BigInt(archBits)) - 1n;
  const byId = new Map<VmaId, VmaRegion>();
  const regions: VmaRegion[] = [];

  for (const vma of vmas) {
    if (byId.has(vma.id)) throw new Error(`VMA 声明非法：id 重复（${vma.id}）`);
    const start = parseHex(vma.start);
    const sizeBig = parseHex(vma.size);
    const size = Number(sizeBig);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`VMA 声明非法：${vma.id}.size 必须是正的安全整数`);
    }
    if (start + sizeBig > mask + 1n) {
      throw new Error(`VMA 声明非法：${vma.id} 超出 ${archBits} 位地址空间`);
    }
    const region: VmaRegion = {
      id: vma.id,
      kind: vma.kind,
      label: vma.label,
      start,
      size,
      end: start + sizeBig,
      perm: vma.perm,
      hidden: vma.hidden,
    };
    byId.set(region.id, region);
    regions.push(region);
  }

  regions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (let i = 1; i < regions.length; i += 1) {
    const prev = regions[i - 1] as VmaRegion;
    const cur = regions[i] as VmaRegion;
    if (cur.start < prev.end) {
      throw new Error(`VMA 声明非法：${prev.id} 与 ${cur.id} 地址区间重叠`);
    }
  }

  return { archBits, mask, regions, byId };
}

/** 包含 `addr` 的区域（地址先按位宽掩蔽）；未映射时 `undefined`。 */
export function regionOf(index: LayoutIndex, addr: bigint): VmaRegion | undefined {
  return regionOfMasked(index, addr & index.mask);
}

function regionOfMasked(index: LayoutIndex, addr: bigint): VmaRegion | undefined {
  const { regions } = index;
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((regions[mid] as VmaRegion).end <= addr) lo = mid + 1;
    else hi = mid;
  }
  const candidate = lo < regions.length ? (regions[lo] as VmaRegion) : undefined;
  return candidate !== undefined && candidate.start <= addr ? candidate : undefined;
}

export function regionById(index: LayoutIndex, id: VmaId): VmaRegion | undefined {
  return index.byId.get(id);
}

/** 内容是否可见：非隐藏区域永远可见，隐藏区域只在 `reveal` 之后可见（02 §3）。 */
export function isRegionVisible(state: VmState, region: VmaRegion): boolean {
  return !region.hidden || state.revealed.includes(region.id);
}

/** 动作层一次区间访问的判定结果。 */
export type RangeVerdict =
  | { readonly ok: true; readonly region: VmaRegion }
  | { readonly ok: false; readonly code: 'hidden_address' | 'inaccessible_address' };

/**
 * 判定“直接动作”能否访问 `[addr, addr + len)`（04 §2）。
 *
 * 规则与错误码：
 * - 区间触及任何隐藏 VMA → `hidden_address`（布局公开，区分原因不泄露内容）。
 * - 区间未映射、跨越空洞或权限不足 → `inaccessible_address`。
 * - 区间必须完整落在**一个**可访问区域里。
 */
export function checkActionRange(
  index: LayoutIndex,
  addr: bigint,
  len: number,
  need: PermChar,
): RangeVerdict {
  if (!Number.isSafeInteger(len) || len < 0) {
    return { ok: false, code: 'inaccessible_address' };
  }

  const start = addr & index.mask;
  const end = start + BigInt(len);

  for (const region of index.regions) {
    if (region.hidden && region.start < end && start < region.end) {
      return { ok: false, code: 'hidden_address' };
    }
  }

  const region = regionOfMasked(index, start);
  if (region === undefined || end > region.end || !hasPerm(region.perm, need)) {
    return { ok: false, code: 'inaccessible_address' };
  }
  return { ok: true, region };
}
