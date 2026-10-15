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

/**
 * G 的内存实现入口（G01：VMA、位宽、端序、权限、COW）。
 *
 * **这是 B 与 G 之间唯一的缝**：B 只用 `createMemory()` 返回的 `MemoryApi`，
 * 不碰内存内部表示。G 可以在本目录内自由组织实现，但必须保留这个导出名。
 *
 * D1 状态：桩，调用即抛错。G 实现后删掉这里的 throw。
 */
export const createMemory: MemoryApi = {
  pageSize: 0x1000,

  create(_vmas: readonly VmaInit[], _archBits: ArchBits): MemoryState {
    throw new Error('内存尚未实现：G01（D1–D2），见 docs/08-Agent并行开发日程.md §4');
  },
  check(_mem: MemoryState, _addr: bigint, _len: number, _need: PermChar): MemCheck {
    throw new Error('内存尚未实现：G01（D1–D2）');
  },
  read(_mem: MemoryState, _addr: bigint, _len: number): MemResult {
    throw new Error('内存尚未实现：G01（D1–D2）');
  },
  write(_mem: MemoryState, _addr: bigint, _bytes: Uint8Array): MemResult {
    throw new Error('内存尚未实现：G01（D1–D2）');
  },
  copy(_mem: MemoryState, _src: bigint, _dst: bigint, _len: number): MemResult {
    throw new Error('内存尚未实现：G01（D1–D2）');
  },
  readVma(_mem: MemoryState, _vmaId: VmaId): Uint8Array | undefined {
    throw new Error('内存尚未实现：G01（D1–D2）');
  },
  snapshot(_mem: MemoryState): MemorySnapshot {
    throw new Error('内存快照尚未实现：G02（D2–D3）');
  },
  restore(_snapshot: MemorySnapshot): MemoryState {
    throw new Error('内存快照尚未实现：G02（D2–D3）');
  },
};
