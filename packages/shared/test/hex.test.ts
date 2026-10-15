import { describe, expect, it } from 'vitest';
import {
  HexBytesSchema,
  HexSchema,
  asciiToBytes,
  bigIntToBytesLE,
  bytesToBigIntLE,
  bytesToHex,
  containsBytes,
  containsBytesIgnoringAsciiCase,
  formatHex,
  formatWord,
  hexToBytes,
  maskValue,
  parseHex,
} from '@pwn2block/shared';

describe('hex 基础工具', () => {
  it('掩蔽按位宽回绕，负数按二补数处理', () => {
    expect(maskValue(0x1_0000_0000n, 32)).toBe(0n);
    expect(maskValue(-1n, 32)).toBe(0xffff_ffffn);
    expect(maskValue(-1n, 64)).toBe(0xffff_ffff_ffff_ffffn);
    expect(maskValue(0x4142n, 64)).toBe(0x4142n);
  });

  it('formatHex 输出小写 0x 形式，formatWord 输出定宽无前缀', () => {
    expect(formatHex(0x7ffff000n)).toBe('0x7ffff000');
    expect(formatHex(-1n)).toBe('0xffffffffffffffff');
    expect(formatWord(0x4142n, 64)).toBe('0000000000004142');
    expect(formatWord(0x4142n, 32)).toBe('00004142');
  });

  it('parseHex 只接受 0x 前缀', () => {
    expect(parseHex('0x400002')).toBe(0x400002n);
    expect(() => parseHex('400002')).toThrow();
  });

  it('字节串往返转换保持精确', () => {
    const bytes = hexToBytes('c9c30f0e');
    expect([...bytes]).toEqual([0xc9, 0xc3, 0x0f, 0x0e]);
    expect(bytesToHex(bytes)).toBe('c9c30f0e');
    expect(hexToBytes('')).toHaveLength(0);
  });

  it('小端整数与字节序列互转', () => {
    expect(bytesToBigIntLE(hexToBytes('40ffff7f00000000'))).toBe(0x7fffff40n);
    expect(bytesToBigIntLE(hexToBytes('0200400000000000'))).toBe(0x400002n);
    expect(bytesToHex(bigIntToBytesLE(0x400002n, 8))).toBe('0200400000000000');
  });

  it('子序列查找支持忽略 ASCII 大小写', () => {
    const haystack = asciiToBytes('the secret FLAG{AbC} end');
    expect(containsBytes(haystack, asciiToBytes('FLAG{AbC}'))).toBe(true);
    expect(containsBytes(haystack, asciiToBytes('flag{abc}'))).toBe(false);
    expect(containsBytesIgnoringAsciiCase(haystack, asciiToBytes('flag{abc}'))).toBe(true);
    expect(containsBytesIgnoringAsciiCase(haystack, asciiToBytes('nope'))).toBe(false);
  });
});

describe('hex Schema', () => {
  it('地址统一规范化为小写', () => {
    expect(HexSchema.parse('0x7FFFFF00')).toBe('0x7fffff00');
  });

  it('拒绝空、无前缀与非法字符', () => {
    for (const bad of ['', '0x', '7fffff00', '0xzz', '0x 10']) {
      expect(HexSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('字节串必须是偶数个十六进制字符', () => {
    expect(HexBytesSchema.parse('C9C3')).toBe('c9c3');
    expect(HexBytesSchema.safeParse('c9c').success).toBe(false);
    expect(HexBytesSchema.safeParse('0xc9').success).toBe(false);
  });
});
