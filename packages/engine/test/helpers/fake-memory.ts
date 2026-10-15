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

type Located = { readonly ok: true; readonly addr: bigint; readonly region: FakeRegion } | MemFault;

function fault(reason: MemFault['reason'], addr: bigint, len: number): MemFault {
  return { ok: false, reason, addr, len };
}

function asFake(mem: MemoryState): FakeMemoryState {
  const candidate = mem as FakeMemoryState;
  if (candidate.kind !== 'cow-memory' || candidate.pages === undefined) {
    throw new Error('测试内存替身：状态不是 create() 产生的');
  }
  return candidate;
}

function locate(state: FakeMemoryState, rawAddr: bigint, len: number, need: PermChar): Located {
  const addr = rawAddr & state.mask;
  if (!Number.isSafeInteger(len) || len < 0) return fault('unmapped', addr, len);
  if (len === 0) return { ok: true, addr, region: state.regions[0] as FakeRegion };
  const end = addr + BigInt(len);
  if (end > state.mask + 1n) return fault('unmapped', addr, len);

  for (const region of state.regions) {
    if (region.start <= addr && end <= region.end) {
      if (!hasPerm(region.perm, need)) return fault('permission', addr, len);
      return { ok: true, addr, region };
    }
  }
  return fault('unmapped', addr, len);
}

function readSlice(state: FakeMemoryState, region: FakeRegion, addr: bigint, len: number): Uint8Array {
  const page = state.pages.get(region.id) ?? new Uint8Array(0);
  const offset = Number(addr - region.start);
  return page.slice(offset, offset + len);
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
      const located = locate(asFake(mem), addr, len, need);
      return located.ok ? { ok: true } : located;
    },

    read(mem: MemoryState, addr: bigint, len: number): MemResult {
      const state = asFake(mem);
      const located = locate(state, addr, len, 'r');
      if (!located.ok) return located;
      return { ok: true, bytes: readSlice(state, located.region, located.addr, len) };
    },

    write(mem: MemoryState, addr: bigint, bytes: Uint8Array): MemResult {
      const state = asFake(mem);
      const located = locate(state, addr, bytes.length, 'w');
      if (!located.ok) return located;
      writeSlice(state, located.region, located.addr, bytes);
      return { ok: true, bytes: bytes.slice() };
    },

    copy(mem: MemoryState, src: bigint, dst: bigint, len: number): MemResult {
      const state = asFake(mem);
      const from = locate(state, src, len, 'r');
      if (!from.ok) return from;
      const to = locate(state, dst, len, 'w');
      if (!to.ok) return to;
      const data = readSlice(state, from.region, from.addr, len);
      writeSlice(state, to.region, to.addr, data);
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
