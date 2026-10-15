import { describe, expect, it } from 'vitest';
import { buildVmaTable, findVmaAtOrAfter, findVmaContaining, planAccess } from './vma';
import { patch, vma } from './test-helpers';

const table64 = buildVmaTable(
  [
    vma('text', 0x400000n, 0x1000, 'rx'),
    vma('stack', 0x7fffe000n, 0x2000, 'rw'),
    vma('key', 0x800000n, 0x1000, 'r', { hidden: true }),
  ],
  64,
);

describe('buildVmaTable', () => {
  it('按 start 升序排列并可按键查出区间', () => {
    expect(table64.ranges.map((r) => r.id)).toEqual(['text', 'key', 'stack']);
    expect(table64.byId.get('stack')?.end).toBe(0x80000000n);
  });

  it('区间为左闭右开，相邻 VMA 不算重叠', () => {
    const table = buildVmaTable(
      [vma('a', 0x1000n, 0x1000, 'rw'), vma('b', 0x2000n, 0x1000, 'rw')],
      64,
    );
    expect(table.ranges[0]?.end).toBe(0x2000n);
    expect(table.ranges[1]?.start).toBe(0x2000n);
  });

  it('id 重复时拒绝建表', () => {
    expect(() => buildVmaTable([vma('a', 0x1000n, 0x1000, 'rw'), vma('a', 0x2000n, 0x1000, 'rw')], 64)).toThrow(
      /id 重复（a）/,
    );
  });

  it('区间重叠时拒绝建表', () => {
    expect(() =>
      buildVmaTable([vma('a', 0x1000n, 0x2000, 'rw'), vma('b', 0x2000n, 0x1000, 'rw')], 64),
    ).toThrow(/a 与 b 地址区间重叠/);
  });

  it('超出位宽地址空间时拒绝建表', () => {
    expect(() => buildVmaTable([vma('a', 0x1_0000_0000n, 0x1000, 'rw')], 32)).toThrow(
      /超出 32 位地址空间/,
    );
  });

  it('大小不是非负安全整数时拒绝建表', () => {
    expect(() => buildVmaTable([vma('a', 0x1000n, -1, 'rw')], 64)).toThrow(/size 必须是非负安全整数/);
    expect(() => buildVmaTable([vma('a', 0x1000n, 0.5, 'rw')], 64)).toThrow(/size 必须是非负安全整数/);
  });

  it('init 补丁越出本 VMA 时拒绝建表', () => {
    expect(() =>
      buildVmaTable([vma('a', 0x1000n, 0x1000, 'rw', { init: [patch(0x1fffn, [1, 2])] })], 64),
    ).toThrow(/init 补丁越出本 VMA/);
  });
});

describe('findVma', () => {
  it('命中区间与落在空洞里都能区分', () => {
    expect(findVmaContaining(table64, 0x400000n)?.id).toBe('text');
    expect(findVmaContaining(table64, 0x401000n)).toBeUndefined();
    expect(findVmaAtOrAfter(table64, 0x500000n)?.id).toBe('key');
    expect(findVmaAtOrAfter(table64, 0x900000n)?.id).toBe('stack');
    expect(findVmaAtOrAfter(table64, 0xf0000000n)).toBeUndefined();
  });
});

describe('planAccess', () => {
  it('单段访问：返回掩蔽后的地址与一段', () => {
    const plan = planAccess(table64, 0x7fffe100n, 8, 'r');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.addr).toBe(0x7fffe100n);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]?.start).toBe(0x7fffe100n);
    expect(plan.segments[0]?.end).toBe(0x7fffe108n);
    expect(plan.segments[0]?.vma.id).toBe('stack');
  });

  it('跨 VMA 访问切成两段，边界精确落在 VMA 末端', () => {
    const table = buildVmaTable(
      [vma('a', 0x1000n, 0x1000, 'rw'), vma('b', 0x2000n, 0x1000, 'rw')],
      64,
    );
    const plan = planAccess(table, 0x1ff8n, 16, 'w');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.segments.map((s) => [s.vma.id, s.start, s.end])).toEqual([
      ['a', 0x1ff8n, 0x2000n],
      ['b', 0x2000n, 0x2008n],
    ]);
  });

  it('落在空洞里报 unmapped，并带请求的 addr / len', () => {
    expect(planAccess(table64, 0x500000n, 4, 'r')).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x500000n,
      len: 4,
    });
  });

  it('跨出 VMA 末端报 unmapped', () => {
    expect(planAccess(table64, 0x7fffffen, 4, 'r')).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x7fffffen,
      len: 4,
    });
  });

  it('权限不足报 permission，并带请求的 addr / len', () => {
    expect(planAccess(table64, 0x400000n, 1, 'w')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x400000n,
      len: 1,
    });
    expect(planAccess(table64, 0x800000n, 1, 'x')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x800000n,
      len: 1,
    });
  });

  it('取指需要 x：text 通过，栈不通过', () => {
    expect(planAccess(table64, 0x400000n, 1, 'x').ok).toBe(true);
    expect(planAccess(table64, 0x7fffe000n, 1, 'x')).toEqual({
      ok: false,
      reason: 'permission',
      addr: 0x7fffe000n,
      len: 1,
    });
  });

  it('按位宽掩蔽地址：32 位下 0x1_0000_1000 落到 0x1000', () => {
    const table32 = buildVmaTable([vma('a', 0x1000n, 0x1000, 'rw')], 32);
    const plan = planAccess(table32, 0x1_0000_1000n, 1, 'r');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.addr).toBe(0x1000n);
    expect(plan.segments[0]?.start).toBe(0x1000n);
  });

  it('越过地址空间末尾整体报 unmapped，不逐字节回绕', () => {
    const table32 = buildVmaTable([vma('top', 0xfffff000n, 0x1000, 'rw')], 32);
    expect(planAccess(table32, 0xfffffffen, 4, 'r')).toEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0xfffffffen,
      len: 4,
    });
    // 恰好读到地址空间末尾则成功
    expect(planAccess(table32, 0xfffffffen, 2, 'r').ok).toBe(true);
  });

  it('len === 0 不触碰任何字节，未映射地址也通过', () => {
    const plan = planAccess(table64, 0xdeadbeefn, 0, 'w');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.segments).toEqual([]);
  });

  it('非法长度显式抛错，不静默当成 0', () => {
    expect(() => planAccess(table64, 0x400000n, -1, 'r')).toThrow(RangeError);
    expect(() => planAccess(table64, 0x400000n, 1.5, 'r')).toThrow(RangeError);
    expect(() => planAccess(table64, 0x400000n, Number.NaN, 'r')).toThrow(RangeError);
  });
});
