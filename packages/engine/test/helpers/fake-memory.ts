import { bytesToBigIntLE, bytesToHex, hasPerm, hexToBytes } from '@pwn2block/shared';
import type {
  ArchBits,
  MemCheck,
  MemFault,
  MemResult,
  MemoryApi,
  MemorySnapshot,
  MemoryState,
  Perm,
  PermChar,
  VmaId,
  VmaInit,
} from '@pwn2block/shared';

/**
 * 测试用的内存替身（**只存在于测试**，不参与引擎实现）。
 *
 * 为什么需要它：B 的执行循环、动作分发与历史编排用 `MemoryApi` 作为唯一缝隙，
 * 用替身就能在 G 的内存实现之外独立断言精确的寄存器 / 内存值。
 * 语义与冻结契约一致：地址按位宽掩蔽、读需 r、写需 w、整段校验后再生效、
 * 快照是深拷贝、不做隐藏检查（隐藏只由动作层判定）。
 */

interface FakeRegion {
  readonly id: VmaId;
  readonly start: bigint;
  readonly end: bigint;
  readonly perm: Perm;
  readonly hidden: boolean;
}

interface FakeMemoryState extends MemoryState {
  readonly kind: 'cow-memory';
  readonly archBits: ArchBits;
  readonly mask: bigint;
  readonly regions: readonly FakeRegion[];
  readonly pages: Map<VmaId, Uint8Array>;
}

interface FakeSnapshot extends MemorySnapshot {
  readonly kind: 'cow-memory-snapshot';
  readonly state: FakeMemoryState;
}

/** 一次访问落在单个 VMA 内的片段（与真实内存 `src/memory/vma.ts` 的 `AccessSegment` 同形）。 */
interface FakeSegment {
  readonly region: FakeRegion;
  readonly start: bigint;
  readonly end: bigint;
}

type FakePlan =
  | { readonly ok: true; readonly addr: bigint; readonly segments: readonly FakeSegment[] }
  | MemFault;

function fault(reason: MemFault['reason'], addr: bigint, len: number): MemFault {
  return { ok: false, reason, addr, len };
}

/** 第一个 `end > addr` 的区域；返回的区域可能整体在 `addr` 之后（即落在空洞里）。 */
function regionAtOrAfter(state: FakeMemoryState, addr: bigint): FakeRegion | undefined {
  let found: FakeRegion | undefined;
  for (const region of state.regions) {
    if (region.end > addr && (found === undefined || region.start < found.start)) found = region;
  }
  return found;
}

function asFake(mem: MemoryState): FakeMemoryState {
  const candidate = mem as FakeMemoryState;
  if (candidate.kind !== 'cow-memory' || candidate.pages === undefined) {
    throw new Error('测试内存替身：状态不是 create() 产生的');
  }
  return candidate;
}

/**
 * 整段校验：`[addr, addr + len)` 的每一字节都要落在带 `need` 权限的 VMA 里，
 * 成功时按地址顺序切成片段（可跨相邻的多个 VMA）。
 *
 * 与真实实现 `src/memory/vma.ts` 的 `planAccess` 逐条对齐：
 * - `len === 0` 不触碰字节、**不做地址与权限判定**，直接放行（09 §7 第 8 条）；
 * - 区间越过地址空间末尾整体 `unmapped`；
 * - 空洞 → `unmapped`，命中但权限不足 → `permission`；
 * - 隐藏与地址区间无关：内存层永不因 `hidden` 拒绝（02 §3）。
 *
 * 早先的替身只接受「整段落在同一个 VMA 内」，于是跨相邻 VMA 的访问（例如取指跨过
 * 代码区末尾、栈顶写到相邻区）会在这里被误判成 `unmapped`，与真实实现不一致。
 */
function planAccess(
  state: FakeMemoryState,
  rawAddr: bigint,
  len: number,
  need: PermChar,
): FakePlan {
  const addr = rawAddr & state.mask;
  if (!Number.isSafeInteger(len) || len < 0) return fault('unmapped', addr, len);
  if (len === 0) return { ok: true, addr, segments: [] };
  const end = addr + BigInt(len);
  if (end > state.mask + 1n) return fault('unmapped', addr, len);

  const segments: FakeSegment[] = [];
  let pos = addr;
  while (pos < end) {
    const region = regionAtOrAfter(state, pos);
    if (region === undefined || region.start > pos) return fault('unmapped', addr, len);
    if (!hasPerm(region.perm, need)) return fault('permission', addr, len);
    const segEnd = region.end < end ? region.end : end;
    segments.push({ region, start: pos, end: segEnd });
    pos = segEnd;
  }
  return { ok: true, addr, segments };
}

function readSlice(state: FakeMemoryState, region: FakeRegion, addr: bigint, len: number): Uint8Array {
  const page = state.pages.get(region.id) ?? new Uint8Array(0);
  const offset = Number(addr - region.start);
  return page.slice(offset, offset + len);
}

/** 命中已校验过的片段：把各片段拼成长度为 `len` 的缓冲（`base` 为整段起始地址）。 */
function gatherSegments(
  state: FakeMemoryState,
  segments: readonly FakeSegment[],
  base: bigint,
  len: number,
): Uint8Array {
  const out = new Uint8Array(len);
  for (const segment of segments) {
    const width = Number(segment.end - segment.start);
    out.set(readSlice(state, segment.region, segment.start, width), Number(segment.start - base));
  }
  return out;
}

/**
 * 命中已校验过的片段：把 `bytes` 按片段摊进各页（写时复制）。校验已经全部通过，
 * 所以这里不会再失败——「整段先校验再生效」由此保证。
 */
function scatterSegments(
  state: FakeMemoryState,
  segments: readonly FakeSegment[],
  base: bigint,
  bytes: Uint8Array,
): void {
  for (const segment of segments) {
    const from = Number(segment.start - base);
    const to = Number(segment.end - base);
    writeSlice(state, segment.region, segment.start, bytes.subarray(from, to));
  }
}

/**
 * 写一段：**写时复制**——换一个属于本状态的新页数组，旧页数组与共享它的快照 / 其它
 * fork 保持不可变。这与 G 的 `MemoryApi` 语义一致（句柄可变、页内容不可变），
 * 否则“历史不共享内存”这类测试会因为替身自身的行为而失真。
 */
function writeSlice(state: FakeMemoryState, region: FakeRegion, addr: bigint, bytes: Uint8Array): void {
  const page = state.pages.get(region.id);
  if (page === undefined) throw new Error(`测试内存替身：缺少 ${region.id} 的页`);
  const next = page.slice();
  next.set(bytes, Number(addr - region.start));
  state.pages.set(region.id, next);
}

export function createFakeMemory(): MemoryApi {
  return {
    pageSize: 0x1000,

    create(vmas: readonly VmaInit[], archBits: ArchBits): MemoryState {
      const mask = (1n << BigInt(archBits)) - 1n;
      const pages = new Map<VmaId, Uint8Array>();
      const regions: FakeRegion[] = vmas.map((vma) => {
        const page = new Uint8Array(vma.size);
        for (const patch of vma.init) page.set(patch.bytes, Number(patch.at - vma.start));
        pages.set(vma.id, page);
        return {
          id: vma.id,
          start: vma.start,
          end: vma.start + BigInt(vma.size),
          perm: vma.perm,
          hidden: vma.hidden,
        };
      });
      const created: FakeMemoryState = { kind: 'cow-memory', archBits, mask, regions, pages };
      return created;
    },

    check(mem: MemoryState, addr: bigint, len: number, need: PermChar): MemCheck {
      const plan = planAccess(asFake(mem), addr, len, need);
      return plan.ok ? { ok: true } : plan;
    },

    read(mem: MemoryState, addr: bigint, len: number): MemResult {
      const state = asFake(mem);
      const plan = planAccess(state, addr, len, 'r');
      if (!plan.ok) return plan;
      return { ok: true, bytes: gatherSegments(state, plan.segments, plan.addr, len) };
    },

    write(mem: MemoryState, addr: bigint, bytes: Uint8Array): MemResult {
      const state = asFake(mem);
      // 先整段校验，全部通过再落笔：任何一字节越权都无副作用。
      const plan = planAccess(state, addr, bytes.length, 'w');
      if (!plan.ok) return plan;
      scatterSegments(state, plan.segments, plan.addr, bytes);
      return { ok: true, bytes: bytes.slice() };
    },

    copy(mem: MemoryState, src: bigint, dst: bigint, len: number): MemResult {
      const state = asFake(mem);
      // 顺序与真实实现一致：先校验读端，再校验写端；任一处失败都无副作用。
      const from = planAccess(state, src, len, 'r');
      if (!from.ok) return from;
      const to = planAccess(state, dst, len, 'w');
      if (!to.ok) return to;
      // 先整段读出再写回：重叠时等价于 memmove。
      const data = gatherSegments(state, from.segments, from.addr, len);
      scatterSegments(state, to.segments, to.addr, data);
      return { ok: true, bytes: data };
    },

    readVma(mem: MemoryState, vmaId: VmaId): Uint8Array | undefined {
      const page = asFake(mem).pages.get(vmaId);
      return page === undefined ? undefined : page.slice();
    },

    snapshot(mem: MemoryState): MemorySnapshot {
      const state = asFake(mem);
      const pages = new Map<VmaId, Uint8Array>();
      for (const [id, page] of state.pages) pages.set(id, page.slice());
      const snapshot: FakeSnapshot = { kind: 'cow-memory-snapshot', state: { ...state, pages } };
      return snapshot;
    },

    restore(snapshot: MemorySnapshot): MemoryState {
      const snap = snapshot as FakeSnapshot;
      if (snap.kind !== 'cow-memory-snapshot') throw new Error('测试内存替身：快照不合法');
      const restored: FakeMemoryState = { ...snap.state, pages: new Map(snap.state.pages) };
      return restored;
    },
  };
}

/** 便捷读数：测试里断言内存内容时用。 */
export function memoryWord(mem: MemoryApi, state: MemoryState, addr: bigint, len = 8): bigint {
  const result = mem.read(state, addr, len);
  if (!result.ok) throw new Error(`测试内存替身：读取 ${addr.toString(16)} 失败`);
  return bytesToBigIntLE(result.bytes);
}

/** 便捷读字节：回 hex 字符串，便于精确断言。 */
export function memoryHex(mem: MemoryApi, state: MemoryState, addr: bigint, len: number): string {
  const result = mem.read(state, addr, len);
  if (!result.ok) throw new Error(`测试内存替身：读取 ${addr.toString(16)} 失败`);
  return bytesToHex(result.bytes);
}

/** 便捷写法：`hex('0102')` → 两个字节。 */
export function hex(value: string): Uint8Array {
  return hexToBytes(value);
}
