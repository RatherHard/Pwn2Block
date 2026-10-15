import type { MemoryState } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';
import { pageIndexOf } from './cow';
import { createMemory } from './index';
import type { CowMemorySnapshot, CowMemoryState } from './index';
import { bytesOf, patch, vma } from './test-helpers';

const readBytes = (mem: MemoryState, addr: bigint, len: number): number[] =>
  bytesOf(createMemory.read(mem, addr, len));

/** buf：`rw`，0x1000–0x2fff（两页），初值 `01 02 03 04` 在 0x1000。 */
function makeMem(): MemoryState {
  return createMemory.create(
    [vma('buf', 0x1000n, 0x2000, 'rw', { init: [patch(0x1000n, [1, 2, 3, 4])] })],
    64,
  );
}

describe('内存快照与 COW 恢复（02 §7）', () => {
  it('snapshot → 写入 → restore 回到快照时的字节', () => {
    const mem = makeMem();
    const snap = createMemory.snapshot(mem);
    createMemory.write(mem, 0x1000n, Uint8Array.from([9, 9, 9, 9]));
    expect(readBytes(mem, 0x1000n, 4)).toEqual([9, 9, 9, 9]);

    const restored = createMemory.restore(snap);
    expect(readBytes(restored, 0x1000n, 4)).toEqual([1, 2, 3, 4]);
    // 恢复是派生新状态，不回滚原句柄
    expect(readBytes(mem, 0x1000n, 4)).toEqual([9, 9, 9, 9]);
  });

  it('快照之后发生的写入不会污染快照', () => {
    const mem = makeMem();
    const snap = createMemory.snapshot(mem);
    createMemory.write(mem, 0x1ffcn, Uint8Array.from([7, 7, 7, 7]));
    const restored = createMemory.restore(snap);
    expect(readBytes(restored, 0x1000n, 4)).toEqual([1, 2, 3, 4]);
    expect(readBytes(restored, 0x2000n, 4)).toEqual([0, 0, 0, 0]);
  });

  it('多级快照各自回到自己的时刻', () => {
    const mem = makeMem();
    const s0 = createMemory.snapshot(mem);
    createMemory.write(mem, 0x1000n, Uint8Array.from([0xaa]));
    const s1 = createMemory.snapshot(mem);
    createMemory.write(mem, 0x1000n, Uint8Array.from([0xbb]));

    expect(readBytes(createMemory.restore(s0), 0x1000n, 4)).toEqual([1, 2, 3, 4]);
    expect(readBytes(createMemory.restore(s1), 0x1000n, 4)).toEqual([0xaa, 2, 3, 4]);
    expect(readBytes(createMemory.restore(createMemory.snapshot(mem)), 0x1000n, 4)).toEqual([
      0xbb, 2, 3, 4,
    ]);
  });

  it('快照是 O(1) 共享：不改页表，只抓住当前页表引用', () => {
    const mem = makeMem();
    createMemory.write(mem, 0x1ffcn, Uint8Array.from([7, 7, 7, 7]));
    const snap = createMemory.snapshot(mem) as CowMemorySnapshot;
    expect(snap.pages).toBe((mem as CowMemoryState).pages);
  });

  it('restore 之后的写入只复制被触及的页，快照页保持原样', () => {
    const mem = makeMem();
    createMemory.write(mem, 0x1ffcn, Uint8Array.from([7, 7, 7, 7]));
    const snap = createMemory.snapshot(mem) as CowMemorySnapshot;
    const restored = createMemory.restore(snap) as CowMemoryState;
    expect(restored.pages).toBe(snap.pages);

    createMemory.write(restored, 0x1000n, Uint8Array.from([0x55]));
    const writtenPage = pageIndexOf(0x1000n);
    const untouchedPage = pageIndexOf(0x2000n);
    expect(restored.pages.get(writtenPage)).not.toBe(snap.pages.get(writtenPage));
    expect(restored.pages.get(untouchedPage)).toBe(snap.pages.get(untouchedPage));
    expect([...(snap.pages.get(writtenPage) ?? [])].slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(readBytes(restored, 0x1000n, 4)).toEqual([0x55, 2, 3, 4]);
  });

  it('恢复非法快照显式抛错', () => {
    expect(() => createMemory.restore({ kind: 'cow-memory-snapshot' })).toThrow(/非法的内存快照/);
  });
});
