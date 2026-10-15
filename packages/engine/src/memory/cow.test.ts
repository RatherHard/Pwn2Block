import { describe, expect, it } from 'vitest';
import { EMPTY_PAGE_TABLE, pageIndexOf, pageOffsetIn, pageStartOf, readRange, writeRange } from './cow';
import type { PageTable } from './cow';

const PAGE = 0x1000;

function pageAt(pages: PageTable, addr: bigint): Uint8Array | undefined {
  return pages.get(pageIndexOf(addr));
}

describe('页号换算', () => {
  it('4KB 分页', () => {
    expect(pageIndexOf(0x7fffeffcn)).toBe(0x7fffen);
    expect(pageStartOf(0x7fffen)).toBe(0x7fffe000n);
    expect(pageOffsetIn(0x7fffeffcn)).toBe(0xffc);
    expect(pageOffsetIn(0x7fffe000n)).toBe(0);
  });
});

describe('readRange', () => {
  it('未落页的部分读出 0', () => {
    expect(readRange(EMPTY_PAGE_TABLE, 0x1000n, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('跨页读取精确字节序列', () => {
    const pages = writeRange(EMPTY_PAGE_TABLE, 0x1ffcn, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect([...readRange(pages, 0x1ff8n, 16)]).toEqual([
      0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0,
    ]);
  });

  it('返回新数组：改动结果不影响页存储', () => {
    const pages = writeRange(EMPTY_PAGE_TABLE, 0x1000n, Uint8Array.from([1, 2]));
    const read = readRange(pages, 0x1000n, 2);
    read[0] = 0xff;
    expect([...readRange(pages, 0x1000n, 2)]).toEqual([1, 2]);
  });
});

describe('writeRange', () => {
  it('只复制被触及的页，其余页保持共享', () => {
    const before = writeRange(EMPTY_PAGE_TABLE, 0x1ffcn, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const touched = pageIndexOf(0x1000n);
    const untouched = pageIndexOf(0x2000n);
    expect(before.has(touched)).toBe(true);
    expect(before.has(untouched)).toBe(true);

    const after = writeRange(before, 0x1000n, Uint8Array.from([0xaa]));
    // 被写的那一页换了新对象，另一页仍是同一个对象
    expect(pageAt(after, 0x1000n)).not.toBe(pageAt(before, 0x1000n));
    expect(pageAt(after, 0x2000n)).toBe(pageAt(before, 0x2000n));
  });

  it('复制页时保留同页其它字节，且不改动旧页', () => {
    const before = writeRange(EMPTY_PAGE_TABLE, 0x1000n, Uint8Array.from([1, 2, 3, 4]));
    const after = writeRange(before, 0x1002n, Uint8Array.from([0xcc]));
    expect([...readRange(after, 0x1000n, 4)]).toEqual([1, 2, 0xcc, 4]);
    expect([...readRange(before, 0x1000n, 4)]).toEqual([1, 2, 3, 4]);
  });

  it('入参数组事后被改动，不影响已写入的页内容', () => {
    const input = Uint8Array.from([1, 2, 3, 4]);
    const pages = writeRange(EMPTY_PAGE_TABLE, 0x1000n, input);
    input[0] = 0xff;
    expect([...readRange(pages, 0x1000n, 4)]).toEqual([1, 2, 3, 4]);
  });

  it('空写入直接返回原页表', () => {
    const pages = writeRange(EMPTY_PAGE_TABLE, 0x1000n, Uint8Array.from([1]));
    expect(writeRange(pages, 0x9000n, new Uint8Array(0))).toBe(pages);
  });

  it('页大小固定 4KB：写入页内最后一个字节不会碰到下一页', () => {
    const pages = writeRange(EMPTY_PAGE_TABLE, 0x1000n + BigInt(PAGE - 1), Uint8Array.from([0x7f]));
    expect(pageAt(pages, 0x1000n)).toBeDefined();
    expect(pageAt(pages, 0x2000n)).toBeUndefined();
    expect([...readRange(pages, 0x1fffn, 2)]).toEqual([0x7f, 0]);
  });
});
