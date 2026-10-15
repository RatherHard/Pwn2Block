import { PAGE_SIZE } from '@pwn2block/shared';
import type {
  ArchBits,
  MemCheck,
  MemResult,
  MemoryApi,
  MemorySnapshot,
  MemoryState,
  PermChar,
  VmaId,
  VmaInit,
} from '@pwn2block/shared';
import type { PageTable } from './cow';
import { pageIndexOf, pageOffsetIn, readRange, writeRange } from './cow';
import type { AccessSegment, VmaTable } from './vma';
import { buildVmaTable, planAccess } from './vma';

/**
 * G 的内存实现（G01，02 §3、§5.2、§7）。
 *
 * **这是 B 与 G 之间唯一的缝**：B 只用 `createMemory()` 返回的 `MemoryApi`，
 * 不碰内存内部表示。本目录内可以自由拆分实现，但必须保留 `createMemory` 这个导出名。
 *
 * 语义边界：
 * - 地址按 `archBits` 掩蔽回绕；`len === 0` 不触碰字节，永远通过。
 * - 读需 `r`、写需 `w`、取指需 `x`；未映射 → `unmapped`，权限不足 → `permission`。
 * - **整段先校验再生效**：`write` / `copy` 任何一字节越权就整体失败且无副作用（02 §5.2）。
 * - **不做隐藏检查**：隐藏 VMA 对内存层就是普通 VMA，程序指令照常读写（02 §3）。
 *   隐藏只影响投影，拒绝直接动作是 B 的动作层与 C 的投影层的职责。
 * - 内存层不读时间、不用随机数，结果只由输入状态决定（02 §7）。
 *
 * 关于状态形状（供 D2 集成时与 B 对齐）：
 * 冻结契约里 `write` / `copy` 只回 `MemResult`，没有地方承载“新状态”，
 * 因此 `MemoryState` 在本实现里是一个**可变句柄**：句柄上只有一个可变的页表指针，
 * 写入时整体换入新页表。页表与页内容本身严格不可变，所以快照是 O(1) 共享、
 * `snapshot` 之后发生的任何写入都不会污染已取出的快照。
 *
 * 由此得到一条使用纪律：**要留住“某一时刻的内存”，必须 fork 一份句柄**，
 * 而不是把句柄直接存进历史/录像：
 *
 * ```ts
 * const fork = memory.restore(memory.snapshot(state.memory)); // O(1)：共享当前页表
 * ```
 *
 * 此后对原句柄或 fork 的写入都只会产生新页表，fork 的内存内容保持不变。
 * B 的录像帧、C 的逐动作投影与 undo 历史都应该存 fork。
 */

/** 内存状态句柄。除 `pages` 指针外全部只读；`pages` 只被 `write` / `copy` 整体替换。 */
export interface CowMemoryState extends MemoryState {
  readonly kind: 'cow-memory';
  readonly table: VmaTable;
  pages: PageTable;
}

/** 内存快照：与创建它的状态共享同一份不可变页表（02 §7 的“脏页 + 页表”）。 */
export interface CowMemorySnapshot extends MemorySnapshot {
  readonly kind: 'cow-memory-snapshot';
  readonly table: VmaTable;
  readonly pages: PageTable;
}

function asCowMemory(mem: MemoryState): CowMemoryState {
  const candidate = mem as CowMemoryState;
  if (candidate.kind !== 'cow-memory' || candidate.table === undefined || candidate.pages === undefined) {
    throw new Error('非法的内存状态：只能使用 createMemory().create() 产生的状态');
  }
  return candidate;
}

function asCowSnapshot(snapshot: MemorySnapshot): CowMemorySnapshot {
  const candidate = snapshot as CowMemorySnapshot;
  if (
    candidate.kind !== 'cow-memory-snapshot' ||
    candidate.table === undefined ||
    candidate.pages === undefined
  ) {
    throw new Error('非法的内存快照：只能恢复 createMemory().snapshot() 产生的快照');
  }
  return candidate;
}

/** 命中已校验过的分段：按段读出并拼进长度为 `len` 的新数组（`base` 为整段起始地址）。 */
function gatherSegments(
  pages: PageTable,
  segments: readonly AccessSegment[],
  base: bigint,
  len: number,
): Uint8Array {
  const out = new Uint8Array(len);
  for (const segment of segments) {
    const bytes = readRange(pages, segment.start, Number(segment.end - segment.start));
    out.set(bytes, Number(segment.start - base));
  }
  return out;
}

/** 命中已校验过的分段：把 `bytes` 按段摊进新页表，返回新页表。 */
function scatterSegments(
  pages: PageTable,
  segments: readonly AccessSegment[],
  base: bigint,
  bytes: Uint8Array,
): PageTable {
  let next = pages;
  for (const segment of segments) {
    const from = Number(segment.start - base);
    const to = Number(segment.end - base);
    next = writeRange(next, segment.start, bytes.subarray(from, to));
  }
  return next;
}

/** 按声明顺序应用 `init` 补丁：同一 VMA 内后一个补丁覆盖前一个。 */
function applyInitPatches(vmas: readonly VmaInit[]): PageTable {
  let pages: PageTable = new Map<bigint, Uint8Array>();
  for (const vma of vmas) {
    for (const patch of vma.init) {
      pages = writeRange(pages, patch.at, patch.bytes);
    }
  }
  return pages;
}

/** 整块读出某个 VMA 的内容：未落页的部分为 0。 */
function readVmaBytes(state: CowMemoryState, id: VmaId): Uint8Array | undefined {
  const vma = state.table.byId.get(id);
  if (vma === undefined) return undefined;
  const out = new Uint8Array(vma.size);
  let off = 0;
  while (off < vma.size) {
    const addr = vma.start + BigInt(off);
    const inPage = pageOffsetIn(addr);
    const chunk = Math.min(PAGE_SIZE - inPage, vma.size - off);
    const page = state.pages.get(pageIndexOf(addr));
    if (page !== undefined) out.set(page.subarray(inPage, inPage + chunk), off);
    off += chunk;
  }
  return out;
}

export const createMemory: MemoryApi = {
  pageSize: PAGE_SIZE,

  create(vmas: readonly VmaInit[], archBits: ArchBits): MemoryState {
    const table = buildVmaTable(vmas, archBits);
    const state: CowMemoryState = { kind: 'cow-memory', table, pages: applyInitPatches(vmas) };
    return state;
  },

  check(mem: MemoryState, addr: bigint, len: number, need: PermChar): MemCheck {
    const plan = planAccess(asCowMemory(mem).table, addr, len, need);
    return plan.ok ? { ok: true } : plan;
  },

  read(mem: MemoryState, addr: bigint, len: number): MemResult {
    const state = asCowMemory(mem);
    const plan = planAccess(state.table, addr, len, 'r');
    if (!plan.ok) return plan;
    return { ok: true, bytes: gatherSegments(state.pages, plan.segments, plan.addr, len) };
  },

  write(mem: MemoryState, addr: bigint, bytes: Uint8Array): MemResult {
    const state = asCowMemory(mem);
    // 先整段校验，全部通过才换页表：任何一字节越权都无副作用。
    const plan = planAccess(state.table, addr, bytes.length, 'w');
    if (!plan.ok) return plan;
    state.pages = scatterSegments(state.pages, plan.segments, plan.addr, bytes);
    return { ok: true, bytes: bytes.slice() };
  },

  copy(mem: MemoryState, src: bigint, dst: bigint, len: number): MemResult {
    const state = asCowMemory(mem);
    // 顺序：先校验读端（src），再校验写端（dst）；任一处失败都无副作用。
    const srcPlan = planAccess(state.table, src, len, 'r');
    if (!srcPlan.ok) return srcPlan;
    const dstPlan = planAccess(state.table, dst, len, 'w');
    if (!dstPlan.ok) return dstPlan;
    // 先把 src 整段读出，再写 dst：重叠时等价于 memmove，而不是逐字节复制。
    const data = gatherSegments(state.pages, srcPlan.segments, srcPlan.addr, len);
    state.pages = scatterSegments(state.pages, dstPlan.segments, dstPlan.addr, data);
    return { ok: true, bytes: data };
  },

  readVma(mem: MemoryState, vmaId: VmaId): Uint8Array | undefined {
    // 含隐藏区：可见性由调用方（B/C）负责，内存层不做隐藏判断。
    return readVmaBytes(asCowMemory(mem), vmaId);
  },

  snapshot(mem: MemoryState): MemorySnapshot {
    const state = asCowMemory(mem);
    // O(1)：只抓住当前页表引用；此后写入换的是新页表，快照内容不会被改动。
    const snapshot: CowMemorySnapshot = {
      kind: 'cow-memory-snapshot',
      table: state.table,
      pages: state.pages,
    };
    return snapshot;
  },

  restore(snapshot: MemorySnapshot): MemoryState {
    const snap = asCowSnapshot(snapshot);
    const state: CowMemoryState = { kind: 'cow-memory', table: snap.table, pages: snap.pages };
    return state;
  },
};
