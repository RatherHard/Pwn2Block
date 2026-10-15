import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUMP_ROWS,
  HIDDEN_TAG,
  buildHexDump,
  buildVmaList,
  clampDumpOffset,
  dumpByteLength,
  dumpMaxOffset,
  hiddenNotice,
} from '../src/viewmodel/memory';
import { SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { hexOf, makeProjection, makeVma } from './helpers';

describe('自由视图 VMA 列表（05 §2.5）', () => {
  const rows = buildVmaList(SAMPLE_PROJECTION_START, 64);

  it('列出全部 VMA 的布局', () => {
    expect(rows.map((row) => row.id)).toEqual(['text', 'stack', 'key']);
    const stack = rows[1];
    expect(stack?.range).toBe('0x000000007fffe000 – 0x0000000080000000');
    expect(stack?.perm).toBe('rw');
    expect(stack?.sizeText).toBe('0x2000');
    expect(stack?.hasContent).toBe(true);
  });

  it('隐藏 VMA：有布局、没有内容，标「隐藏」', () => {
    const key = rows[2];
    expect(key?.hidden).toBe(true);
    expect(key?.hasContent).toBe(false);
    expect(HIDDEN_TAG).toBe('隐藏');
    expect(hiddenNotice(key!)).toContain('内容未随投影下发');
  });

  it('类别名称用于界面（中文）', () => {
    expect(rows[0]?.kindName).toBe('代码');
    expect(rows[1]?.kindName).toBe('栈');
    expect(rows[2]?.kindName).toBe('关键区');
  });
});

describe('hex dump（05 §2.5）', () => {
  const projection = makeProjection({
    vmas: [
      makeVma({
        id: 'data',
        start: '0x100000',
        size: '0x1000',
        hex: hexOf(0x1000, { 0: '68656c6c6f', 0x10: '41424344' }),
      }),
    ],
  });
  const hex = projection.vmas[0]?.hex;

  it('隐藏 VMA 没有内容可 dump', () => {
    expect(buildHexDump(undefined)).toEqual([]);
    expect(dumpByteLength(undefined)).toBe(0);
  });

  it('按窗口生成 16 行 × 16 字节', () => {
    const dump = buildHexDump(hex, { baseAddr: 0x100000n, rows: 2, rowBytes: 16 });
    expect(dump).toHaveLength(2);
    expect(dump[0]?.address).toBe('0x0000000000100000');
    expect(dump[0]?.hex.startsWith('68 65 6c 6c 6f 00')).toBe(true);
    expect(dump[0]?.ascii).toBe('hello...........');
    expect(dump[1]?.address).toBe('0x0000000000100010');
    expect(dump[1]?.ascii.startsWith('ABCD')).toBe(true);
  });

  it('翻页偏移按行宽对齐并夹在合法范围内', () => {
    const byteLength = dumpByteLength(hex);
    expect(byteLength).toBe(0x1000);
    expect(clampDumpOffset(byteLength, 0x10)).toBe(0x10);
    expect(clampDumpOffset(byteLength, 0x11)).toBe(0x10);
    expect(clampDumpOffset(byteLength, -5)).toBe(0);
    expect(dumpMaxOffset(byteLength, DEFAULT_DUMP_ROWS, 16)).toBe(0x1000 - DEFAULT_DUMP_ROWS * 16);
    expect(clampDumpOffset(byteLength, 0xffff)).toBe(0x1000 - DEFAULT_DUMP_ROWS * 16);
    const dump = buildHexDump(hex, { baseAddr: 0x100000n, byteOffset: 0x10, rows: 1, rowBytes: 16 });
    expect(dump[0]?.offset).toBe(0x10);
    expect(dump[0]?.address).toBe('0x0000000000100010');
  });
});
