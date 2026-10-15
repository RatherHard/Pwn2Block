import { describe, expect, it } from 'vitest';
import type { ChallengeVma, VmState } from '@pwn2block/shared';
import { NO_FLAGS } from '@pwn2block/shared';
import {
  buildLayoutIndex,
  checkActionRange,
  isRegionVisible,
  regionById,
  regionOf,
} from '../src/layout';
import type { LayoutIndex } from '../src/layout';

const VMAS: ChallengeVma[] = [
  { id: 'code', kind: 'code', start: '0x1000', size: '0x1000', perm: 'rx', hidden: false },
  { id: 'data', kind: 'global', start: '0x2000', size: '0x1000', perm: 'rw', hidden: false },
  { id: 'ro', kind: 'custom', label: '只读', start: '0x3000', size: '0x1000', perm: 'r', hidden: false },
  { id: 'secret', kind: 'key', start: '0x4000', size: '0x1000', perm: 'rw', hidden: true },
];

const index = buildLayoutIndex(VMAS, 64);

function stateOf(revealed: readonly string[] = []): VmState {
  return {
    archBits: 64,
    registers: {},
    flags: NO_FLAGS,
    memory: { kind: 'cow-memory' },
    revealed,
    stdin: { bytes: new Uint8Array(0), pos: 0 },
    stdout: new Uint8Array(0),
    fileOffsets: {},
    status: 'ready',
    steps: 0,
  };
}

describe('buildLayoutIndex / regionOf', () => {
  it('区间左闭右开：start 命中、end 不命中', () => {
    expect(regionOf(index, 0x1000n)?.id).toBe('code');
    expect(regionOf(index, 0x1fffn)?.id).toBe('code');
    expect(regionOf(index, 0x2000n)?.id).toBe('data');
    expect(regionOf(index, 0xfffn)).toBeUndefined();
    expect(regionOf(index, 0x5000n)).toBeUndefined();
  });

  it('regionById 命中与未命中', () => {
    expect(regionById(index, 'secret')?.hidden).toBe(true);
    expect(regionById(index, 'nope')).toBeUndefined();
  });

  it('id 重复时报错', () => {
    const duplicated: ChallengeVma[] = [VMAS[0] as ChallengeVma, VMAS[0] as ChallengeVma];
    expect(() => buildLayoutIndex(duplicated, 64)).toThrow(/id 重复/);
  });

  it('区间重叠时报错', () => {
    const overlapping: ChallengeVma[] = [
      { id: 'a', kind: 'global', start: '0x1000', size: '0x2000', perm: 'rw', hidden: false },
      { id: 'b', kind: 'global', start: '0x2000', size: '0x1000', perm: 'rw', hidden: false },
    ];
    expect(() => buildLayoutIndex(overlapping, 64)).toThrow(/重叠/);
  });

  it('地址按位宽掩蔽后判定（32 位题目的地址回绕）', () => {
    const index32 = buildLayoutIndex(
      [
        { id: 'data', kind: 'global', start: '0x2000', size: '0x1000', perm: 'rw', hidden: false },
      ],
      32,
    );
    expect(regionOf(index32, 0x1_0000_2000n)?.id).toBe('data');
    expect(checkActionRange(index32, 0x1_0000_2000n, 8, 'w').ok).toBe(true);
  });
});

describe('checkActionRange：动作层的隐藏 / 权限判定', () => {
  it('落在非隐藏可写区间 → 通过，并回带区域', () => {
    const verdict = checkActionRange(index, 0x2000n, 16, 'w');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.region.id).toBe('data');
  });

  it('未映射 → inaccessible_address', () => {
    expect(checkActionRange(index, 0x9000n, 8, 'w')).toEqual({
      ok: false,
      code: 'inaccessible_address',
    });
  });

  it('权限不足（只读区写）→ inaccessible_address', () => {
    expect(checkActionRange(index, 0x3000n, 1, 'w')).toEqual({
      ok: false,
      code: 'inaccessible_address',
    });
  });

  it('触及隐藏区 → hidden_address（即使可写）', () => {
    expect(checkActionRange(index, 0x4000n, 8, 'w')).toEqual({ ok: false, code: 'hidden_address' });
    expect(checkActionRange(index, 0x4fffn, 1, 'w')).toEqual({ ok: false, code: 'hidden_address' });
  });

  it('区间部分压到隐藏区也算 hidden_address', () => {
    expect(checkActionRange(index, 0x3ff8n, 16, 'w')).toEqual({ ok: false, code: 'hidden_address' });
  });

  it('跨越两个可见区间（中间没有隐藏）→ inaccessible_address', () => {
    expect(checkActionRange(index, 0x2ff8n, 16, 'w')).toEqual({
      ok: false,
      code: 'inaccessible_address',
    });
  });

  it('长度为 0 时只要求起点在可访问区域内', () => {
    expect(checkActionRange(index, 0x2000n, 0, 'w').ok).toBe(true);
    expect(checkActionRange(index, 0x6000n, 0, 'w').ok).toBe(false);
  });

  it('读判定与写判定分开', () => {
    expect(checkActionRange(index, 0x3000n, 8, 'r').ok).toBe(true);
    expect(checkActionRange(index, 0x1000n, 8, 'w').ok).toBe(false);
    expect(checkActionRange(index, 0x1000n, 8, 'r').ok).toBe(true);
    expect(checkActionRange(index, 0x1000n, 8, 'x').ok).toBe(true);
  });

  it('非法长度 → inaccessible_address', () => {
    expect(checkActionRange(index, 0x2000n, -1, 'w').ok).toBe(false);
    expect(checkActionRange(index, 0x2000n, 1.5, 'w').ok).toBe(false);
  });
});

describe('isRegionVisible', () => {
  it('非隐藏区域永远可见', () => {
    const region = regionById(index as LayoutIndex, 'data');
    expect(region).toBeDefined();
    if (region === undefined) return;
    expect(isRegionVisible(stateOf(), region)).toBe(true);
  });

  it('隐藏区域只在 reveal 之后可见', () => {
    const region = regionById(index, 'secret');
    expect(region).toBeDefined();
    if (region === undefined) return;
    expect(isRegionVisible(stateOf(), region)).toBe(false);
    expect(isRegionVisible(stateOf(['secret']), region)).toBe(true);
  });
});
