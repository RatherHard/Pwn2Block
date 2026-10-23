import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_BYTES, CANVAS_MAX_TEXT_CHARS } from '../limits';
import { applyConversion } from './convert';
import type { ConversionSpec } from './operators';
import { byteValue, doubleValue, intValue, listValue, stringValue, type Value } from './value';

/**
 * 转换节点求值的行为契约（需求 §4.2）。
 *
 * 断言一律写精确值：转换是数据语义的内核，模糊断言会让「悄悄截断」「静默替换成 U+FFFD」
 * 这类错误蒙混过关。每个转换种类都覆盖正常与失败两条路径，AT-12 / AT-13 的验收点单独标注。
 */

/** 取出成功结果；失败时抛出带原因的异常，省得每条断言都写一遍 `if (!result.ok)`。 */
function succeed(input: Value, spec: ConversionSpec): Value {
  const result = applyConversion(input, spec);
  if (!result.ok) throw new Error(`本该成功却失败：${result.message}`);
  return result.value;
}

/** 取出失败文案；成功时直接抛出，让「静默接受坏输入」变成测试失败。 */
function failure(input: Value, spec: ConversionSpec): string {
  const result = applyConversion(input, spec);
  if (result.ok) throw new Error('本该失败却成功了');
  return result.message;
}

function bytesOf(...values: number[]): Value {
  return byteValue(Uint8Array.from(values));
}

/** 无符号两字节大端：最常见的宽度/端序组合，单独命名省去重复参数。 */
const BE2: ConversionSpec = { kind: 'int-to-bytes', width: 2, endian: 'big', signed: false };

describe('转换的前提', () => {
  it('字典一律不能转换，先取出值再转换', () => {
    const emptyDict: Value = { kind: 'dict', entries: [] };
    expect(failure(emptyDict, BE2)).toBe('字典不参与类型转换：先把要用的值取出来再转换');
    expect(failure(emptyDict, { kind: 'text-to-bytes', encoding: 'utf-8' })).toBe(
      '字典不参与类型转换：先把要用的值取出来再转换',
    );
  });

  it('类型不匹配时说清需要什么、收到什么', () => {
    expect(failure(stringValue('1'), BE2)).toBe('「整数转字节串」需要整数，收到文本');
    expect(failure(intValue(1n), { kind: 'text-to-double' })).toBe('「文本转浮点数」需要文本，收到整数');
    expect(failure(intValue(1n), { kind: 'double-to-text' })).toBe('「浮点数转文本」需要浮点数，收到整数');
    expect(failure(bytesOf(0x41), { kind: 'list-to-text' })).toBe('「文本列表转文本」需要列表，收到字节串');
  });
});

describe('文本与字节串', () => {
  it('AT-13：UTF-8 编码「A😀」得到 41f09f9880，再解码还原', () => {
    const encoded = succeed(stringValue('A😀'), { kind: 'text-to-bytes', encoding: 'utf-8' });
    expect(encoded).toEqual(bytesOf(0x41, 0xf0, 0x9f, 0x98, 0x80));
    expect(succeed(encoded, { kind: 'bytes-to-text', encoding: 'utf-8' })).toEqual(stringValue('A😀'));
  });

  it('ASCII 编码与解码往返', () => {
    const encoded = succeed(stringValue('Pwn2Block'), { kind: 'text-to-bytes', encoding: 'ascii' });
    expect(encoded).toEqual(bytesOf(0x50, 0x77, 0x6e, 0x32, 0x42, 0x6c, 0x6f, 0x63, 0x6b));
    expect(succeed(encoded, { kind: 'bytes-to-text', encoding: 'ascii' })).toEqual(stringValue('Pwn2Block'));
  });

  it('AT-13：ASCII 编码拒绝非 ASCII 字符，报出字符与码位', () => {
    expect(failure(stringValue('A😀'), { kind: 'text-to-bytes', encoding: 'ascii' })).toBe(
      'ASCII 编码不了字符 "😀"（U+1F600）',
    );
    expect(failure(stringValue('é'), { kind: 'text-to-bytes', encoding: 'ascii' })).toBe(
      'ASCII 编码不了字符 "é"（U+00E9）',
    );
  });

  it('AT-13：UTF-8 编码拒绝孤立代理项，不静默换成 U+FFFD', () => {
    expect(failure(stringValue('a\uD800b'), { kind: 'text-to-bytes', encoding: 'utf-8' })).toBe(
      '文本里的孤立代理项 U+D800 无法用 UTF-8 编码',
    );
    expect(failure(stringValue('\uDC00'), { kind: 'text-to-bytes', encoding: 'utf-8' })).toBe(
      '文本里的孤立代理项 U+DC00 无法用 UTF-8 编码',
    );
  });

  it('AT-13：非法 UTF-8 字节报错，不产出替换字符', () => {
    expect(failure(bytesOf(0xff, 0xfe), { kind: 'bytes-to-text', encoding: 'utf-8' })).toBe(
      '字节串不是合法的 UTF-8：fffe',
    );
    expect(failure(bytesOf(0x41, 0xe4), { kind: 'bytes-to-text', encoding: 'utf-8' })).toBe(
      '字节串不是合法的 UTF-8：41e4',
    );
  });

  it('AT-13：ASCII 解码要求每个字节小于 0x80', () => {
    expect(failure(bytesOf(0x41, 0xe4), { kind: 'bytes-to-text', encoding: 'ascii' })).toBe(
      'ASCII 解码要求每个字节都小于 0x80，第 2 个字节是 0xe4',
    );
  });

  it('编码结果超过字节上限时在分配之前失败', () => {
    const text = 'a'.repeat(CANVAS_MAX_BYTES + 1);
    expect(failure(stringValue(text), { kind: 'text-to-bytes', encoding: 'utf-8' })).toBe(
      `文本编码成 UTF-8 需要 ${CANVAS_MAX_BYTES + 1} 字节，超过上限 ${CANVAS_MAX_BYTES} 字节`,
    );
  });
});

describe('整数与字节串', () => {
  it('AT-12：0x1234 两字节小端是 3412，大端是 1234', () => {
    expect(succeed(intValue(0x1234n), { kind: 'int-to-bytes', width: 2, endian: 'little', signed: false })).toEqual(
      bytesOf(0x34, 0x12),
    );
    expect(succeed(intValue(0x1234n), BE2)).toEqual(bytesOf(0x12, 0x34));
    expect(
      succeed(bytesOf(0x34, 0x12), { kind: 'bytes-to-int', width: 2, endian: 'little', signed: false }),
    ).toEqual(intValue(0x1234n));
    expect(succeed(bytesOf(0x12, 0x34), { kind: 'bytes-to-int', width: 2, endian: 'big', signed: false })).toEqual(
      intValue(0x1234n),
    );
  });

  it('AT-12：超出宽度的整数报出宽度与十六进制范围', () => {
    expect(failure(intValue(0x12345n), BE2)).toBe('整数 74565 超出 2 字节无符号范围 0x0..0xffff');
    expect(failure(intValue(-1n), { kind: 'int-to-bytes', width: 1, endian: 'big', signed: false })).toBe(
      '整数 -1 超出 1 字节无符号范围 0x0..0xff',
    );
    expect(failure(intValue(-0x8001n), { kind: 'int-to-bytes', width: 2, endian: 'little', signed: true })).toBe(
      '整数 -32769 超出 2 字节有符号范围 -0x8000..0x7fff',
    );
  });

  it('AT-12：字节串长度与声明宽度不匹配时报错', () => {
    expect(failure(bytesOf(0x01, 0x02, 0x03), { kind: 'bytes-to-int', width: 2, endian: 'big', signed: false })).toBe(
      '字节串长度 3 与声明的 2 字节不匹配',
    );
    expect(failure(bytesOf(0x01), { kind: 'bytes-to-int', width: 8, endian: 'little', signed: false })).toBe(
      '字节串长度 1 与声明的 8 字节不匹配',
    );
  });

  it('有符号按二补码解释，无符号按原值解释', () => {
    expect(succeed(intValue(-2n), { kind: 'int-to-bytes', width: 8, endian: 'little', signed: true })).toEqual(
      bytesOf(0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    );
    expect(succeed(bytesOf(0x80), { kind: 'bytes-to-int', width: 1, endian: 'big', signed: true })).toEqual(
      intValue(-128n),
    );
    expect(succeed(bytesOf(0xff, 0xff), { kind: 'bytes-to-int', width: 2, endian: 'big', signed: true })).toEqual(
      intValue(-1n),
    );
    expect(succeed(bytesOf(0xff, 0xff), { kind: 'bytes-to-int', width: 2, endian: 'big', signed: false })).toEqual(
      intValue(0xffffn),
    );
  });
});

describe('整数与浮点数', () => {
  it('可精确表示的小整数转浮点数成功', () => {
    expect(succeed(intValue(42n), { kind: 'int-to-double' })).toEqual(doubleValue(42));
    expect(succeed(intValue(-42n), { kind: 'int-to-double' })).toEqual(doubleValue(-42));
    expect(succeed(intValue(2n ** 53n), { kind: 'int-to-double' })).toEqual(doubleValue(9007199254740992));
  });

  it('AT-13：大整数不能用 64 位浮点数精确表示时报错', () => {
    expect(failure(intValue(9007199254740993n), { kind: 'int-to-double' })).toBe(
      '整数 9007199254740993 不能用 64 位浮点数精确表示',
    );
    expect(failure(intValue(-(2n ** 53n) - 1n), { kind: 'int-to-double' })).toBe(
      '整数 -9007199254740993 不能用 64 位浮点数精确表示',
    );
  });

  it('AT-13：trunc 向零、floor 向下、ceil 向上（含负数）', () => {
    expect(succeed(doubleValue(3.7), { kind: 'double-to-int', rounding: 'trunc' })).toEqual(intValue(3n));
    expect(succeed(doubleValue(-3.7), { kind: 'double-to-int', rounding: 'trunc' })).toEqual(intValue(-3n));
    expect(succeed(doubleValue(3.2), { kind: 'double-to-int', rounding: 'floor' })).toEqual(intValue(3n));
    expect(succeed(doubleValue(-3.2), { kind: 'double-to-int', rounding: 'floor' })).toEqual(intValue(-4n));
    expect(succeed(doubleValue(3.2), { kind: 'double-to-int', rounding: 'ceil' })).toEqual(intValue(4n));
    expect(succeed(doubleValue(-3.2), { kind: 'double-to-int', rounding: 'ceil' })).toEqual(intValue(-3n));
  });

  it('AT-13：nearest 让 .5 远离零', () => {
    expect(succeed(doubleValue(2.5), { kind: 'double-to-int', rounding: 'nearest' })).toEqual(intValue(3n));
    expect(succeed(doubleValue(-2.5), { kind: 'double-to-int', rounding: 'nearest' })).toEqual(intValue(-3n));
    expect(succeed(doubleValue(3.5), { kind: 'double-to-int', rounding: 'nearest' })).toEqual(intValue(4n));
    expect(succeed(doubleValue(-0.5), { kind: 'double-to-int', rounding: 'nearest' })).toEqual(intValue(-1n));
    expect(succeed(doubleValue(2.4), { kind: 'double-to-int', rounding: 'nearest' })).toEqual(intValue(2n));
  });

  it('AT-13：NaN 与无穷不能转整数', () => {
    expect(failure(doubleValue(Number.NaN), { kind: 'double-to-int', rounding: 'trunc' })).toBe(
      '浮点数 NaN 不是有限值，不能转成整数',
    );
    expect(failure(doubleValue(Number.POSITIVE_INFINITY), { kind: 'double-to-int', rounding: 'floor' })).toBe(
      '浮点数 Infinity 不是有限值，不能转成整数',
    );
    expect(failure(doubleValue(Number.NEGATIVE_INFINITY), { kind: 'double-to-int', rounding: 'nearest' })).toBe(
      '浮点数 -Infinity 不是有限值，不能转成整数',
    );
  });
});

describe('数字与文本', () => {
  it('整数十进制往返，负号与零都保留', () => {
    expect(succeed(intValue(42n), { kind: 'int-to-text', base: 10 })).toEqual(stringValue('42'));
    expect(succeed(intValue(-42n), { kind: 'int-to-text', base: 10 })).toEqual(stringValue('-42'));
    expect(succeed(intValue(0n), { kind: 'int-to-text', base: 10 })).toEqual(stringValue('0'));
    expect(succeed(stringValue('-42'), { kind: 'text-to-int', base: 10 })).toEqual(intValue(-42n));
    expect(succeed(stringValue('9007199254740993'), { kind: 'text-to-int', base: 10 })).toEqual(
      intValue(9007199254740993n),
    );
  });

  it('整数十六进制输出带 0x 前缀，负数写成 -0x1f', () => {
    expect(succeed(intValue(31n), { kind: 'int-to-text', base: 16 })).toEqual(stringValue('0x1f'));
    expect(succeed(intValue(-31n), { kind: 'int-to-text', base: 16 })).toEqual(stringValue('-0x1f'));
    expect(succeed(intValue(0n), { kind: 'int-to-text', base: 16 })).toEqual(stringValue('0x0'));
  });

  it('十六进制解析允许可选 0x/0X 前缀与负号', () => {
    expect(succeed(stringValue('0x1f'), { kind: 'text-to-int', base: 16 })).toEqual(intValue(31n));
    expect(succeed(stringValue('0X1F'), { kind: 'text-to-int', base: 16 })).toEqual(intValue(31n));
    expect(succeed(stringValue('-0x1f'), { kind: 'text-to-int', base: 16 })).toEqual(intValue(-31n));
    expect(succeed(stringValue('1f'), { kind: 'text-to-int', base: 16 })).toEqual(intValue(31n));
  });

  it('十进制拒绝前导零、空白与多余字符', () => {
    for (const text of ['', '007', '1abc', ' 1', '1 ', '+1', '1.0', '- 1']) {
      expect(failure(stringValue(text), { kind: 'text-to-int', base: 10 })).toMatch(/不是合法的十进制整数/);
    }
    expect(failure(stringValue('1abc'), { kind: 'text-to-int', base: 10 })).toBe(
      '文本 "1abc" 不是合法的十进制整数',
    );
  });

  it('十六进制拒绝非法字符与前缀以外的写法', () => {
    for (const text of ['', '0x', '0xzz', '1f ', 'x1f', '0x1g']) {
      expect(failure(stringValue(text), { kind: 'text-to-int', base: 16 })).toMatch(/不是合法的十六进制整数/);
    }
  });

  it('整数文本位数超过上限时报错', () => {
    expect(failure(stringValue('1'.repeat(400)), { kind: 'text-to-int', base: 10 })).toMatch(
      /位数超过整数上限 1024 位/,
    );
    expect(failure(stringValue(`0x${'f'.repeat(300)}`), { kind: 'text-to-int', base: 16 })).toMatch(
      /位数超过整数上限 1024 位/,
    );
  });

  it('整数转文本只接受整数输入', () => {
    expect(failure(stringValue('1'), { kind: 'int-to-text', base: 16 })).toBe('「整数转文本」需要整数，收到文本');
  });

  it('浮点文本用 formatDouble，指数写法可往返', () => {
    expect(succeed(doubleValue(1.5), { kind: 'double-to-text' })).toEqual(stringValue('1.5'));
    expect(succeed(doubleValue(-2), { kind: 'double-to-text' })).toEqual(stringValue('-2'));
    const big = succeed(doubleValue(1e21), { kind: 'double-to-text' });
    expect(big).toEqual(stringValue('1e+21'));
    expect(succeed(big, { kind: 'text-to-double' })).toEqual(doubleValue(1e21));
  });

  it('浮点文本接受整数、小数与指数写法', () => {
    expect(succeed(stringValue('42'), { kind: 'text-to-double' })).toEqual(doubleValue(42));
    expect(succeed(stringValue('0.5'), { kind: 'text-to-double' })).toEqual(doubleValue(0.5));
    expect(succeed(stringValue('-2.5e-3'), { kind: 'text-to-double' })).toEqual(doubleValue(-0.0025));
  });

  it('AT-13：浮点文本拒绝空串、空白、nan、inf、Infinity 与 1abc', () => {
    for (const text of ['', ' 1', '1 ', 'nan', 'NaN', 'inf', '-Infinity', 'Infinity', '1abc', '.5', '1.', '1,5']) {
      expect(failure(stringValue(text), { kind: 'text-to-double' })).toMatch(/不是合法的十进制浮点数/);
    }
  });

  it('超出双精度范围的浮点文本报错', () => {
    expect(failure(stringValue('1e400'), { kind: 'text-to-double' })).toBe('文本 "1e400" 超出 64 位浮点数范围');
  });

  it('NaN 与无穷不能转文本', () => {
    expect(failure(doubleValue(Number.NaN), { kind: 'double-to-text' })).toBe('浮点数 NaN 不是有限值，不能转成文本');
    expect(failure(doubleValue(Number.POSITIVE_INFINITY), { kind: 'double-to-text' })).toBe(
      '浮点数 Infinity 不是有限值，不能转成文本',
    );
  });
});

describe('列表合并', () => {
  it('字节串列表按顺序合并', () => {
    expect(succeed(listValue([bytesOf(0x12, 0x34), bytesOf(0x56)]), { kind: 'list-to-bytes' })).toEqual(
      bytesOf(0x12, 0x34, 0x56),
    );
    expect(succeed(listValue([]), { kind: 'list-to-bytes' })).toEqual(bytesOf());
  });

  it('文本列表按顺序合并，码点不被切断', () => {
    expect(succeed(listValue([stringValue('ab'), stringValue('😀'), stringValue('')]), { kind: 'list-to-text' })).toEqual(
      stringValue('ab😀'),
    );
  });

  it('字节串列表里混进别的类型时指出第几项', () => {
    expect(failure(listValue([bytesOf(0x12), stringValue('x')]), { kind: 'list-to-bytes' })).toBe(
      '第 2 项是文本，字节串列表只能包含字节串；先逐项转换',
    );
  });

  it('文本列表里混进别的类型时指出第几项', () => {
    expect(failure(listValue([stringValue('a'), intValue(1n)]), { kind: 'list-to-text' })).toBe(
      '第 2 项是整数，文本列表只能包含文本；先逐项转换',
    );
  });

  it('合并后超过字节上限时报错，不先拼出结果', () => {
    const full = byteValue(new Uint8Array(CANVAS_MAX_BYTES));
    expect(failure(listValue([full, bytesOf(0x41)]), { kind: 'list-to-bytes' })).toBe(
      `字节串列表合并后 ${CANVAS_MAX_BYTES + 1} 字节，超过上限 ${CANVAS_MAX_BYTES} 字节`,
    );
  });

  it('合并后超过文本上限时报错', () => {
    const long = stringValue('a'.repeat(CANVAS_MAX_TEXT_CHARS));
    expect(failure(listValue([long, stringValue('b')]), { kind: 'list-to-text' })).toBe(
      `文本列表合并后 ${CANVAS_MAX_TEXT_CHARS + 1} 个码点，超过上限 ${CANVAS_MAX_TEXT_CHARS}`,
    );
  });
});
