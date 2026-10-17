import { describe, expect, it } from 'vitest';
import { valueRegion, vmaRegion } from '../src/viewmodel/region';
import { makeReader, makeProjection, makeVma } from './helpers';

describe('值区域着色（pwndbg 风格）', () => {
  const projection = makeProjection({
    vmas: [
      makeVma({ id: 'text', kind: 'code', start: '0x400000', perm: 'rx', hex: '00' }),
      makeVma({ id: 'stack', kind: 'stack', start: '0x7fffe000', size: '0x2000', hex: '00' }),
      makeVma({ id: 'global', kind: 'global', start: '0x600000', hex: '00' }),
      makeVma({ id: 'heap', kind: 'heap', start: '0x700000', hex: '00' }),
      makeVma({ id: 'custom', kind: 'custom', start: '0x800000', hex: '00' }),
      makeVma({ id: 'key', kind: 'key', start: '0x900000', hidden: true }),
    ],
  });
  const reader = makeReader(projection);

  it('代码区域 → code', () => {
    expect(valueRegion(reader, 0x400000n)).toBe('code');
  });

  it('栈区域 → stack', () => {
    expect(valueRegion(reader, 0x7fffe000n)).toBe('stack');
  });

  it('global / heap / custom → data', () => {
    expect(valueRegion(reader, 0x600000n)).toBe('data');
    expect(valueRegion(reader, 0x700000n)).toBe('data');
    expect(valueRegion(reader, 0x800000n)).toBe('data');
  });

  it('隐藏 VMA → hidden（即使 kind 是 key，也在 kind 判断之前先看 hidden）', () => {
    expect(valueRegion(reader, 0x900000n)).toBe('hidden');
  });

  it('不在任何 VMA → unmapped', () => {
    expect(valueRegion(reader, 0x10n)).toBe('unmapped');
  });

  it('vmaRegion 直接按 VMA 布局分类：隐藏优先，其次按种类', () => {
    expect(vmaRegion({ hidden: false, kind: 'code' })).toBe('code');
    expect(vmaRegion({ hidden: false, kind: 'stack' })).toBe('stack');
    expect(vmaRegion({ hidden: false, kind: 'heap' })).toBe('data');
    expect(vmaRegion({ hidden: true, kind: 'code' })).toBe('hidden');
  });
});
