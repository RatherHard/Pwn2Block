import { PAGE_SIZE } from '@pwn2block/shared';
import type { MemoryState } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';
import { createMemory } from './index';
import { bytesOf, patch, vma } from './test-helpers';

const read = (mem: MemoryState, addr: bigint, len: number): number[] =>
  bytesOf(createMemory.read(mem, addr, len));

/**
 * text：`rx`，0x1000–0x1fff，初值 `c9 c3` 在 0x1ffc；
 * stack：`rw`，0x2000–0x3fff（两页），初值 `01..08` 在 0x2ffc 起（正好跨页）。
 * 0x4000 起未映射。
 */
function makeFixture(): MemoryState {
  return createMemory.create(
    [
      vma('text', 0x1000n, 0x1000, 'rx', { init: [patch(0x1ffcn, [0xc9, 0xc3])] }),
      vma('stack', 0x2000n, 0x2000, 'rw', { init: [patch(0x2ffcn, [1, 2, 3, 4, 5, 6, 7, 8])] }),
    ],
    64,
  );
}

describe('createMemory 基本形状', () => {
  it('页大小就是 4KB', () => {
    expect(createMemory.pageSize).toBe(0x1000);
    expect(createMemory.pageSize).toBe(PAGE_SIZE);
  });

  it('init 补丁写入初值，未覆盖的部分为 0', () => {
    const mem = createMemory.create(
      [vma('text', 0x400000n, 0x1000, 'rx', { init: [patch(0x400002n, [0x0f, 0x0e])] })],
      64,
    );
    expect([...(createMemory.readVma(mem, 'text') ?? [])].slice(0, 6)).toEqual([0, 0, 0x0f, 0x0e, 0, 0]);
    expect(createMemory.readVma(mem, 'text')?.length).toBe(0x1000);
  });

  it('同一 VMA 内多个补丁按声明顺序生效，后者覆盖前者', () => {
    const mem = createMemory.create(
      [vma('buf', 0x1000n, 0x1000, 'rw', { init: [patch(0x1000n, [1, 2, 3, 4]), patch(0x1002n, [9, 9])] })],
      64,
    );
    expect(read(mem, 0x1000n, 4)).toEqual([1, 2, 9, 9]);
  });

  it('非法布局在 create 入口显式抛错', () => {
    expect(() =>
      createMemory.create([vma('a', 0x1000n, 0x2000, 'rw'), vma('b', 0x2000n, 0x1000, 'rw')], 64),
    ).toThrow(/重叠/);
  });

  it('readVma 返回整块内容，未知 id 返回 undefined', () => {
    const mem = makeFixture();
    const stack = createMemory.readVma(mem, 'stack');
    expect(stack?.length).toBe(0x2000);
    expect([...(stack ?? [])].slice(0xffc, 0x1004)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(createMemory.readVma(mem, 'nope')).toBeUndefined();
  });

  it('外来内存状态显式抛错，不会被当成空内存静默读取', () => {
    const foreign: MemoryState = { kind: 'cow-memory' };
    expect(() => createMemory.read(foreign, 0x1000n, 1)).toThrow(/非法的内存状态/);
    expect(() => createMemory.write(foreign, 0x1000n, Uint8Array.from([1]))).toThrow(/非法的内存状态/);
    expect(() => createMemory.readVma(foreign, 'text')).toThrow(/非法的内存状态/);
  });
});

describe('隐藏 VMA 在内存层不做任何特殊处理', () => {
  it('隐藏区照常可读、可写、可整块读出（拒绝属于动作层与投影层）', () => {
    const mem = createMemory.create(
      [vma('secret', 0x800000n, 0x1000, 'rw', { hidden: true, init: [patch(0x800000n, [0xde, 0xad])] })],
      64,
    );
    expect(createMemory.check(mem, 0x800000n, 2, 'r')).toEqual({ ok: true });
    expect(read(mem, 0x800000n, 2)).toEqual([0xde, 0xad]);
    expect(createMemory.write(mem, 0x800000n, Uint8Array.from([0x11, 0x22]))).toEqual({
      ok: true,
      bytes: Uint8Array.from([0x11, 0x22]),
    });
    expect([...(createMemory.readVma(mem, 'secret') ?? [])].slice(0, 2)).toEqual([0x11, 0x22]);
  });
});

describe('check：权限与映射', () => {
  it('读需 r、写需 w、取指需 x', () => {
    const mem = makeFixture();
    expect(createMemory.check(mem, 0x1000n, 4, 'r')).toEqual({ ok: true });
    expect(createMemory.check(mem, 0x1000n, 4, 'x')).toEqual({ ok: true });
    expect(createMemory.check(mem, 0x2000n, 4, 'r')).toEqual({ ok: true });
    expect(createMemory.check(mem, 0x2000n, 4, 'w')).toEqual({ ok: true });
    expect(createMemory.check(mem, 0x2ffcn, 2, 'x')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x2ffcn,
      len: 2,
    });
  });

  it('已映射但权限不足报 permission，并带 addr / len', () => {
    const mem = makeFixture();
    expect(createMemory.check(mem, 0x1000n, 4, 'w')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x1000n,
      len: 4,
    });
    expect(createMemory.check(mem, 0x2ffcn, 4, 'x')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x2ffcn,
      len: 4,
    });
  });

  it('未映射报 unmapped，并带 addr / len', () => {
    const mem = makeFixture();
    expect(createMemory.check(mem, 0x4000n, 4, 'r')).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x4000n,
      len: 4,
    });
    expect(createMemory.check(mem, 0x3fffn, 4, 'r')).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x3fffn,
      len: 4,
    });
  });
});

describe('read / write', () => {
  it('跨 VMA 的读按 VMA 拼接出精确字节序列', () => {
    const mem = makeFixture();
    expect(read(mem, 0x1ff8n, 16)).toEqual([0, 0, 0, 0, 0xc9, 0xc3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('跨页的读拼出精确字节序列', () => {
    const mem = makeFixture();
    expect(read(mem, 0x2ff8n, 16)).toEqual([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
  });

  it('零长度读成功且无字节，未映射地址也一样', () => {
    expect(createMemory.read(makeFixture(), 0x4000n, 0)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it('写后能读回精确字节，且不影响相邻页与相邻 VMA', () => {
    const mem = makeFixture();
    expect(createMemory.write(mem, 0x2ffcn, Uint8Array.from([0x90, 0x90]))).toEqual({
      ok: true,
      bytes: Uint8Array.from([0x90, 0x90]),
    });
    expect(read(mem, 0x2ffcn, 4)).toEqual([0x90, 0x90, 3, 4]);
    expect(read(mem, 0x3000n, 4)).toEqual([5, 6, 7, 8]);
    expect(read(mem, 0x1ffcn, 2)).toEqual([0xc9, 0xc3]);
  });

  it('跨页写：两页都得到精确字节', () => {
    const mem = makeFixture();
    expect(createMemory.write(mem, 0x2ffcn, Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))).toEqual({
      ok: true,
      bytes: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
    });
    expect(read(mem, 0x2ff8n, 16)).toEqual([0, 0, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 0, 0, 0, 0]);
  });

  it('跨 VMA 写：任何一字节越权就整体失败且无副作用', () => {
    const mem = createMemory.create(
      [
        vma('wr', 0x1000n, 0x1000, 'rw', { init: [patch(0x1ffcn, [1, 2, 3, 4])] }),
        vma('ro', 0x2000n, 0x1000, 'r', { init: [patch(0x2000n, [5, 6, 7, 8])] }),
      ],
      64,
    );
    // 前 4 字节可写、后 4 字节只读：整段必须先校验，因此前半页也不能被改
    expect(createMemory.write(mem, 0x1ffcn, Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x1ffcn,
      len: 8,
    });
    expect(read(mem, 0x1ffcn, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('尾部越过 VMA 末端整体失败且无副作用', () => {
    const mem = makeFixture();
    expect(createMemory.write(mem, 0x3fffn, Uint8Array.from([7, 7]))).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x3fffn,
      len: 2,
    });
    expect(read(mem, 0x3ffcn, 4)).toEqual([0, 0, 0, 0]);
  });

  it('零长度写成功且不改动任何字节', () => {
    const mem = makeFixture();
    expect(createMemory.write(mem, 0x4000n, new Uint8Array(0))).toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
    expect(read(mem, 0x1ffcn, 4)).toEqual([0xc9, 0xc3, 0, 0]);
  });

  it('返回的字节与入参数组都不与内存共享', () => {
    const mem = makeFixture();
    const input = Uint8Array.from([0xaa, 0xbb]);
    const written = createMemory.write(mem, 0x2000n, input);
    input[0] = 0xff;
    expect(read(mem, 0x2000n, 2)).toEqual([0xaa, 0xbb]);
    if (written.ok) written.bytes[1] = 0xff;
    expect(read(mem, 0x2000n, 2)).toEqual([0xaa, 0xbb]);
    const out = createMemory.read(mem, 0x2000n, 2);
    if (out.ok) out.bytes[0] = 0xff;
    expect(read(mem, 0x2000n, 2)).toEqual([0xaa, 0xbb]);
  });

  it('32 位下地址掩蔽回绕后生效', () => {
    const mem = createMemory.create([vma('buf', 0x1000n, 0x1000, 'rw')], 32);
    expect(createMemory.write(mem, 0x1_0000_1000n, Uint8Array.from([7]))).toEqual({
      ok: true,
      bytes: Uint8Array.from([7]),
    });
    expect(read(mem, 0x1000n, 1)).toEqual([7]);
  });

  it('32 位下越过地址空间末尾整体报 unmapped', () => {
    const mem = createMemory.create([vma('top', 0xfffff000n, 0x1000, 'rw')], 32);
    expect(createMemory.write(mem, 0xfffffffen, Uint8Array.from([1, 2, 3, 4]))).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0xfffffffen,
      len: 4,
    });
    expect(read(mem, 0xfffffffen, 2)).toEqual([0, 0]);
  });
});

describe('copy：原子拷贝', () => {
  it('跨 VMA 拷贝精确字节，源可以只读', () => {
    const mem = makeFixture();
    expect(createMemory.copy(mem, 0x1ffcn, 0x2000n, 4)).toEqual({
      ok: true,
      bytes: Uint8Array.from([0xc9, 0xc3, 0, 0]),
    });
    expect(read(mem, 0x2000n, 6)).toEqual([0xc9, 0xc3, 0, 0, 0, 0]);
    expect(read(mem, 0x1ffcn, 2)).toEqual([0xc9, 0xc3]);
  });

  it('源与目标重叠时按 memmove 语义（先整段读出再写）', () => {
    const mem = createMemory.create(
      [vma('buf', 0x1000n, 0x1000, 'rw', { init: [patch(0x1000n, [1, 2, 3, 4, 5, 6, 7, 8])] })],
      64,
    );
    expect(createMemory.copy(mem, 0x1000n, 0x1002n, 6)).toEqual({
      ok: true,
      bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    });
    expect(read(mem, 0x1000n, 8)).toEqual([1, 2, 1, 2, 3, 4, 5, 6]);
  });

  it('目标是只读区：整体失败且无副作用', () => {
    const mem = makeFixture();
    expect(createMemory.copy(mem, 0x2000n, 0x1000n, 4)).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x1000n,
      len: 4,
    });
    expect(read(mem, 0x1ffcn, 4)).toEqual([0xc9, 0xc3, 0, 0]);
  });

  it('源未映射：整体失败且无副作用', () => {
    const mem = makeFixture();
    expect(createMemory.copy(mem, 0x4000n, 0x2000n, 4)).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x4000n,
      len: 4,
    });
    expect(read(mem, 0x2000n, 4)).toEqual([0, 0, 0, 0]);
  });

  it('目标跨 VMA 且后半越权：前半也不能被改', () => {
    const mem = createMemory.create(
      [
        vma('src', 0x1000n, 0x1000, 'r', { init: [patch(0x1000n, [1, 1, 1, 1, 1, 1, 1, 1])] }),
        vma('wr', 0x2000n, 0x1000, 'rw', { init: [patch(0x2ffcn, [2, 2, 2, 2])] }),
        vma('ro', 0x3000n, 0x1000, 'r', { init: [patch(0x3000n, [3, 3, 3, 3])] }),
      ],
      64,
    );
    expect(createMemory.copy(mem, 0x1000n, 0x2ffcn, 8)).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x2ffcn,
      len: 8,
    });
    expect(read(mem, 0x2ffcn, 8)).toEqual([2, 2, 2, 2, 3, 3, 3, 3]);
    expect(read(mem, 0x1000n, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('零长度拷贝成功且无副作用', () => {
    const mem = makeFixture();
    expect(createMemory.copy(mem, 0x4000n, 0x4000n, 0)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });
});
