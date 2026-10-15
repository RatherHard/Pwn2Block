import { describe, expect, it } from 'vitest';
import {
  alignDown,
  asciiOfBytes,
  dumpAsciiOfBytes,
  formatAddr,
  formatAddrShort,
  formatByte,
  formatDecimal,
  formatHexSpaced,
  formatRange,
  hexByteAt,
  isPrintableAscii,
  maskToBits,
  parseAddrInput,
  printableAsciiOfHex,
} from '../src/viewmodel/format';

describe('地址格式化（05 §2）', () => {
  it('按 archBits 定宽显示，便于列对齐', () => {
    expect(formatAddr(0x400000n, 64)).toBe('0x0000000000400000');
    expect(formatAddr(0x400000n, 32)).toBe('0x00400000');
    expect(formatAddr(0n, 64)).toBe('0x0000000000000000');
  });

  it('紧凑形式去掉前导零', () => {
    expect(formatAddrShort(0x7fffff00n)).toBe('0x7fffff00');
    expect(formatAddrShort(0n)).toBe('0x0');
  });

  it('超出位宽或负数按二补数掩蔽', () => {
    expect(maskToBits(-1n, 8)).toBe(255n);
    expect(maskToBits(0x1_0000n, 16)).toBe(0n);
    expect(formatAddr(-1n, 8)).toBe('0xff');
  });

  it('范围是左闭右开', () => {
    expect(formatRange(0x7fffe000n, 0x2000n, 64)).toBe('0x000000007fffe000 – 0x0000000080000000');
  });

  it('十进制用于寄存器视图的辅助列', () => {
    expect(formatDecimal(99n)).toBe('99');
  });
});

describe('字节格式化', () => {
  it('两位十六进制', () => {
    expect(formatByte(0x0f)).toBe('0f');
    expect(formatByte(0xc9)).toBe('c9');
  });

  it('机器码按字节分组', () => {
    expect(formatHexSpaced('c9c30f0e')).toBe('c9 c3 0f 0e');
    expect(formatHexSpaced('')).toBe('');
  });

  it('hexByteAt 越界与非法输入返回 undefined', () => {
    expect(hexByteAt('c9c30f0e', 1)).toBe(0xc3);
    expect(hexByteAt('c9c30f0e', 4)).toBeUndefined();
    expect(hexByteAt('c9c30f0e', -1)).toBeUndefined();
    expect(hexByteAt('zz', 0)).toBeUndefined();
  });
});

describe('ASCII 展示（05 §2.2）', () => {
  it('不可打印记点，NUL 结束字符串', () => {
    expect(asciiOfBytes(new Uint8Array([0x41, 0x42, 0x00, 0x43]))).toBe('AB');
    expect(asciiOfBytes(new Uint8Array([0x41, 0x01]))).toBe('A.');
  });

  it('hex dump 的 ASCII 列每个字节占一位，不把 NUL 当结束', () => {
    expect(dumpAsciiOfBytes(new Uint8Array([0x41, 0x00, 0x42]))).toBe('A.B');
  });

  it('可打印判断覆盖边界', () => {
    expect(isPrintableAscii(0x20)).toBe(true);
    expect(isPrintableAscii(0x7e)).toBe(true);
    expect(isPrintableAscii(0x7f)).toBe(false);
    expect(isPrintableAscii(0x00)).toBe(false);
  });

  it('只有真正含可打印字符时才返回文本', () => {
    expect(printableAsciiOfHex('41414141')).toBe('AAAA');
    expect(printableAsciiOfHex('00000000')).toBeUndefined();
    expect(printableAsciiOfHex('0102')).toBeUndefined();
  });
});

describe('地址跳转输入（05 §2.2）', () => {
  it('接受 0x 前缀与十进制，其余返回 undefined', () => {
    expect(parseAddrInput('0x7fffff00')).toBe(0x7fffff00n);
    expect(parseAddrInput('  0X400000 ')).toBe(0x400000n);
    expect(parseAddrInput('255')).toBe(255n);
    expect(parseAddrInput('')).toBeUndefined();
    expect(parseAddrInput('7f')).toBeUndefined();
    expect(parseAddrInput('0xzz')).toBeUndefined();
  });

  it('对齐按行宽向下取整', () => {
    expect(alignDown(0x7fffff05n, 8)).toBe(0x7fffff00n);
    expect(alignDown(0x7fffff00n, 8)).toBe(0x7fffff00n);
  });
});
