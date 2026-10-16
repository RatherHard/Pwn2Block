import { describe, expect, it } from 'vitest';
import { searchVisibleBytes } from '../src/viewmodel/search';
import { makeProjection, makeVma } from './helpers';

const projection = makeProjection({ vmas: [
  makeVma({ id: 'later', start: '0x2000', size: '0x4', hex: '41422041' }),
  makeVma({ id: 'first', start: '0x1000', size: '0x5', hex: '1414414220' }),
  makeVma({ id: 'hidden', start: '0x0', size: '0x10', hidden: true }),
] });

describe('可见投影字节搜索', () => {
  it('hex 忽略空白和大小写，仅匹配完整字节，选择最小地址', () => {
    expect(searchVisibleBytes(projection, '41 42', 'hex')).toEqual({ kind: 'found', addr: 0x1002n });
    expect(searchVisibleBytes(projection, '14 14', 'hex')).toEqual({ kind: 'found', addr: 0x1000n });
    expect(searchVisibleBytes(projection, '42\n20', 'hex')).toEqual({ kind: 'found', addr: 0x1003n });
    expect(searchVisibleBytes(projection, 'FF', 'hex')).toEqual({ kind: 'missing' });
  });
  it('ASCII 保留空格，hex 不将半字节匹配当作命中', () => {
    expect(searchVisibleBytes(projection, 'AB ', 'ascii')).toEqual({ kind: 'found', addr: 0x1002n });
    expect(searchVisibleBytes(projection, ' ', 'ascii')).toEqual({ kind: 'found', addr: 0x1004n });
    expect(searchVisibleBytes(projection, '41 41', 'hex')).toEqual({ kind: 'missing' });
  });
  it.each(['', ' ', '4', '4g', '0x41'])('hex 拒绝不完整或非法输入 %j', (text) => {
    expect(searchVisibleBytes(projection, text, 'hex').kind).toBe('invalid');
  });
  it.each(['', '中文', 'é'])('ASCII 拒绝空输入或非 ASCII %j', (text) => {
    expect(searchVisibleBytes(projection, text, 'ascii').kind).toBe('invalid');
  });
  it('隐藏区域和 VMA 之间的间隙不能匹配，也不跨 VMA 拼接内容', () => {
    const separated = makeProjection({ vmas: [
      makeVma({ id: 'a', start: '0x1000', size: '0x1', hex: '41' }),
      makeVma({ id: 'b', start: '0x1001', size: '0x1', hex: '42' }),
      makeVma({ id: 'secret', start: '0x1002', size: '0x2', hidden: true }),
    ] });
    expect(searchVisibleBytes(separated, '4142', 'hex').kind).toBe('missing');
    expect(searchVisibleBytes(separated, '00', 'hex').kind).toBe('missing');
    // 即使未经边界校验的数据带上内容，搜索仍必须尊重 hidden。
    const hidden = { ...separated, vmas: separated.vmas.map((vma) => ({ ...vma, hidden: true })) };
    expect(searchVisibleBytes(hidden, '41', 'hex').kind).toBe('missing');
  });
});
