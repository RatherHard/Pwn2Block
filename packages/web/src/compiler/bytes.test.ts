import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '@pwn2block/shared';
import {
  ByteBuildError,
  DEFAULT_WORD_BYTES,
  MAX_BYTE_LENGTH,
  MAX_INT_WIDTH,
  MIN_INT_WIDTH,
  addr,
  concat,
  int,
  padding,
  raw,
  string,
  wordBytes,
} from './bytes';

/** 字节断言一律用"每个字节都写出来"的形式：小端序是本题考点，模糊断言等于没测。 */
const toArray = (bytes: Uint8Array): number[] => Array.from(bytes);

/** 取错误码；没抛错或抛错类型不对时返回可读文案，方便定位。 */
function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ByteBuildError) return `${error.name}:${error.code}`;
    return `非 ByteBuildError：${String(error)}`;
  }
  return '没有抛错';
}

describe('字节原语：padding', () => {
  it('重复 n 个相同字节', () => {
    expect(toArray(padding(0x41, 3))).toEqual([0x41, 0x41, 0x41]);
    expect(toArray(padding(0x00, 2))).toEqual([0x00, 0x00]);
    expect(toArray(padding(0xff, 1))).toEqual([0xff]);
  });

  it('次数为 0 时是空字节串', () => {
    expect(toArray(padding(0x41, 0))).toEqual([]);
    expect(padding(0x41, 0)).toHaveLength(0);
  });

  it('字节必须是 0x00..0xff 的整数', () => {
    expect(errorCodeOf(() => padding(256, 1))).toBe('ByteBuildError:invalid_byte');
    expect(errorCodeOf(() => padding(-1, 1))).toBe('ByteBuildError:invalid_byte');
    expect(errorCodeOf(() => padding(1.5, 1))).toBe('ByteBuildError:invalid_byte');
    expect(errorCodeOf(() => padding(Number.NaN, 1))).toBe('ByteBuildError:invalid_byte');
  });

  it('次数必须是非负整数', () => {
    expect(errorCodeOf(() => padding(0x41, -1))).toBe('ByteBuildError:invalid_length');
    expect(errorCodeOf(() => padding(0x41, 1.5))).toBe('ByteBuildError:invalid_length');
    expect(errorCodeOf(() => padding(0x41, Number.POSITIVE_INFINITY))).toBe(
      'ByteBuildError:invalid_length',
    );
  });
});

describe('字节原语：单个构造的长度上限', () => {
  it('恰好等于上限时通过，超过一个字节就报错', () => {
    expect(padding(0x41, MAX_BYTE_LENGTH)).toHaveLength(MAX_BYTE_LENGTH);
    expect(errorCodeOf(() => padding(0x41, MAX_BYTE_LENGTH + 1))).toBe(
      'ByteBuildError:length_out_of_range',
    );
  });

  it('天文数字的次数给出结构化错误，而不是 Uint8Array 的 RangeError', () => {
    // 学习者可以在数字输入框里填任意整数：1e10 个字节既分配不出来，也发不出去。
    expect(errorCodeOf(() => padding(0x41, 10_000_000_000))).toBe(
      'ByteBuildError:length_out_of_range',
    );
    expect(errorCodeOf(() => padding(0x41, Number.MAX_SAFE_INTEGER))).toBe(
      'ByteBuildError:length_out_of_range',
    );
  });

  it('string / raw / concat 同样受上限约束', () => {
    expect(errorCodeOf(() => string('a'.repeat(MAX_BYTE_LENGTH + 1)))).toBe(
      'ByteBuildError:length_out_of_range',
    );
    // UTF-8 按**编码后的字节数**算：一个汉字 3 字节。
    expect(errorCodeOf(() => string('中'.repeat(MAX_BYTE_LENGTH / 3 + 1)))).toBe(
      'ByteBuildError:length_out_of_range',
    );
    expect(errorCodeOf(() => raw('41'.repeat(MAX_BYTE_LENGTH + 1)))).toBe(
      'ByteBuildError:length_out_of_range',
    );
    expect(errorCodeOf(() => concat(padding(0x41, MAX_BYTE_LENGTH), padding(0x42, 1)))).toBe(
      'ByteBuildError:length_out_of_range',
    );
  });

  it('上限是"请求体上限的一半"：hex 编码后正好放得进请求体（04 §6）', () => {
    expect(MAX_BYTE_LENGTH).toBe(MAX_BODY_BYTES / 2);
  });
});

describe('字节原语：string（UTF-8）', () => {
  it('ASCII 字符串一字符一字节', () => {
    expect(toArray(string('AB'))).toEqual([0x41, 0x42]);
  });

  it('非 ASCII 按 UTF-8 编码，不是 Latin-1', () => {
    expect(toArray(string('中'))).toEqual([0xe4, 0xb8, 0xad]);
    expect(toArray(string('é'))).toEqual([0xc3, 0xa9]);
    expect(toArray(string('\u0000'))).toEqual([0x00]);
  });

  it('空串是空字节串', () => {
    expect(toArray(string(''))).toEqual([]);
  });
});

describe('字节原语：int', () => {
  it('默认小端、默认字长 W = 8 字节', () => {
    expect(toArray(int(1))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(toArray(int(1))).toHaveLength(DEFAULT_WORD_BYTES);
    expect(toArray(int(0x1234))).toEqual([0x34, 0x12, 0, 0, 0, 0, 0, 0]);
  });

  it('大端逐字节反向', () => {
    expect(toArray(int(0x1234, 2, 'big'))).toEqual([0x12, 0x34]);
    expect(toArray(int(0x12345678, 4, 'big'))).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(toArray(int(0x1234, 2, 'little'))).toEqual([0x34, 0x12]);
  });

  it('接受 bigint，也接受安全整数', () => {
    expect(toArray(int(0x1234n, 2))).toEqual([0x34, 0x12]);
    expect(toArray(int(255n, 1))).toEqual([0xff]);
  });

  it('边界宽度 1 与 8 都可用', () => {
    expect(toArray(int(0, MIN_INT_WIDTH))).toEqual([0x00]);
    expect(toArray(int(0xffffffffffffffffn, MAX_INT_WIDTH))).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it('负数显式报错，不回绕成二补数', () => {
    expect(errorCodeOf(() => int(-1))).toBe('ByteBuildError:negative_value');
    expect(errorCodeOf(() => int(-1n, 8))).toBe('ByteBuildError:negative_value');
  });

  it('宽度越界显式报错', () => {
    expect(errorCodeOf(() => int(0, 0))).toBe('ByteBuildError:width_out_of_range');
    expect(errorCodeOf(() => int(0, 9))).toBe('ByteBuildError:width_out_of_range');
    expect(errorCodeOf(() => int(0, 1.5))).toBe('ByteBuildError:width_out_of_range');
    expect(errorCodeOf(() => int(0, Number.NaN))).toBe('ByteBuildError:width_out_of_range');
  });

  it('放不下就报错，不截断', () => {
    expect(errorCodeOf(() => int(0x100, 1))).toBe('ByteBuildError:value_overflow');
    expect(errorCodeOf(() => int(0x10000, 2))).toBe('ByteBuildError:value_overflow');
    // 0x100000000 恰好越过 32 位
    expect(errorCodeOf(() => int(0x1_0000_0000, 4))).toBe('ByteBuildError:value_overflow');
    expect(toArray(int(0xffff_ffff, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('非整数与非法端序显式报错', () => {
    expect(errorCodeOf(() => int(1.5, 8))).toBe('ByteBuildError:invalid_value');
    expect(errorCodeOf(() => int(Number.MAX_SAFE_INTEGER + 1, 8))).toBe(
      'ByteBuildError:invalid_value',
    );
    expect(errorCodeOf(() => int(1, 8, 'middle' as 'little'))).toBe(
      'ByteBuildError:invalid_endian',
    );
  });
});

describe('字节原语：addr', () => {
  it('等于 int(v, W, little)：ret2win 的目标地址逐字节断言', () => {
    expect(toArray(addr(0x400002))).toEqual([0x02, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(toArray(addr(0x7fffff00))).toEqual([0x00, 0xff, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x00]);
  });

  it('32 位题目传 4 字节字长', () => {
    expect(toArray(addr(0x7fffff00, 4))).toEqual([0x00, 0xff, 0xff, 0x7f]);
  });

  it('负数与放不下的地址同样报错', () => {
    expect(errorCodeOf(() => addr(-0x10))).toBe('ByteBuildError:negative_value');
    // 0x1_0000_0000 需要 5 字节，32 位题目写不下
    expect(errorCodeOf(() => addr(0x1_0000_0000, 4))).toBe('ByteBuildError:value_overflow');
  });
});

describe('字节原语：raw', () => {
  it('解析 hex 字节对，允许空串', () => {
    expect(toArray(raw('c9c3'))).toEqual([0xc9, 0xc3]);
    expect(toArray(raw('C9C3'))).toEqual([0xc9, 0xc3]);
    expect(toArray(raw(''))).toEqual([]);
  });

  it('奇数字符、非 hex、带 0x 前缀都显式报错', () => {
    expect(errorCodeOf(() => raw('c9c'))).toBe('ByteBuildError:invalid_hex');
    expect(errorCodeOf(() => raw('zz'))).toBe('ByteBuildError:invalid_hex');
    expect(errorCodeOf(() => raw('0xc9'))).toBe('ByteBuildError:invalid_hex');
    expect(errorCodeOf(() => raw('c 9'))).toBe('ByteBuildError:invalid_hex');
  });
});

describe('字节原语：concat', () => {
  it('按参数顺序拼接', () => {
    expect(toArray(concat(raw('aa'), padding(0x00, 2), raw('bb')))).toEqual([
      0xaa, 0x00, 0x00, 0xbb,
    ]);
    expect(toArray(concat(padding(0x41, 16), padding(0x42, 8), addr(0x400002)))).toHaveLength(32);
  });

  it('没有参数时是空字节串', () => {
    expect(toArray(concat())).toEqual([]);
  });

  it('不改动入参，返回新数组', () => {
    const first = raw('aa');
    const second = raw('bb');
    const joined = concat(first, second);
    expect(joined).not.toBe(first);
    joined[0] = 0x00;
    expect(toArray(first)).toEqual([0xaa]);
    expect(toArray(second)).toEqual([0xbb]);
  });

  it('片段必须是 Uint8Array', () => {
    expect(errorCodeOf(() => concat([0x41] as unknown as Uint8Array))).toBe(
      'ByteBuildError:invalid_value',
    );
  });
});

describe('字节原语：位宽换算', () => {
  it('archBits 换算成字长字节', () => {
    expect(wordBytes(32)).toBe(4);
    expect(wordBytes(64)).toBe(8);
    expect(wordBytes(64)).toBe(DEFAULT_WORD_BYTES);
  });
});
