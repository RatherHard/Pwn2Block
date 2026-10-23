import { describe, expect, it } from 'vitest';
import {
  CANVAS_MAX_COLLECTION_ITEMS,
  CANVAS_MAX_INT_BITS,
  CANVAS_MAX_TEXT_CHARS,
  CANVAS_MAX_VALUE_DEPTH,
} from '../limits';
import { decodeKey, decodeScalarValue, decodeValue, encodeKey, encodeValue } from './value-codec';
import {
  boolValue,
  byteValue,
  checkValue,
  codePointLength,
  dictLookup,
  dictValue,
  doubleValue,
  formatDouble,
  intBitLength,
  intKey,
  intValue,
  listValue,
  sameValue,
  stringKey,
  stringValue,
  valueSummary,
  valueTypeName,
  type DictEntry,
  type Value,
} from './value';

/**
 * 值模型与编码（需求 §2.1、§8）。
 *
 * 断言一律用精确值：字典要保留顺序、整数键 `1` 与文本键 `"1"` 必须互不相等、
 * 编码往返必须无损。这些是后续所有运算与转换的地基，含糊断言没有意义。
 */

function listOf(...items: Value[]): Value {
  return listValue(items);
}

describe('值构造', () => {
  it('字节串构造时复制，外部再改原数组不影响值', () => {
    const source = new Uint8Array([0x41, 0x42]);
    const value = byteValue(source);
    source[0] = 0x00;
    expect(value.bytes).toEqual(new Uint8Array([0x41, 0x42]));
  });

  it('列表构造时复制，外部再改原数组不影响值', () => {
    const items: Value[] = [intValue(1n)];
    const value = listValue(items);
    items.push(intValue(2n));
    expect(value.items).toHaveLength(1);
  });
});

describe('字典：键、顺序与查找', () => {
  const entries: DictEntry[] = [
    { key: intKey(1n), value: stringValue('整数键') },
    { key: stringKey('1'), value: stringValue('文本键') },
  ];

  it('整数键 1 与文本键 "1" 是两个键，顺序保留', () => {
    const dict = dictValue(entries);
    expect(dict.ok).toBe(true);
    if (!dict.ok) return;
    expect(dict.value.entries).toHaveLength(2);
    const byInt = dictLookup(dict.value, intKey(1n));
    const byText = dictLookup(dict.value, stringKey('1'));
    expect(byInt).toEqual({ ok: true, value: stringValue('整数键') });
    expect(byText).toEqual({ ok: true, value: stringValue('文本键') });
  });

  it('重复键报错，不静默覆盖', () => {
    const dict = dictValue([...entries, { key: intKey(1n), value: boolValue(true) }]);
    expect(dict.ok).toBe(false);
    if (dict.ok) return;
    expect(dict.message).toContain('重复');
  });

  it('缺失键报错，文案带上键值', () => {
    const dict = dictValue(entries);
    expect(dict.ok).toBe(true);
    if (!dict.ok) return;
    const missing = dictLookup(dict.value, stringKey('2'));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.message).toContain('"2"');
  });
});

describe('相等', () => {
  it('字节串逐字节比较', () => {
    expect(sameValue(byteValue(new Uint8Array([1, 2])), byteValue(new Uint8Array([1, 2])))).toBe(true);
    expect(sameValue(byteValue(new Uint8Array([1, 2])), byteValue(new Uint8Array([1, 3])))).toBe(false);
  });

  it('嵌套列表与字典按结构比较，键的种类参与比较', () => {
    const left = listOf(intValue(1n), listOf(stringValue('a')));
    const right = listOf(intValue(1n), listOf(stringValue('a')));
    expect(sameValue(left, right)).toBe(true);

    const dictInt = dictValue([{ key: intKey(1n), value: boolValue(true) }]);
    const dictText = dictValue([{ key: stringKey('1'), value: boolValue(true) }]);
    expect(dictInt.ok && dictText.ok && sameValue(dictInt.value, dictText.value)).toBe(false);
  });
});

describe('容量检查', () => {
  it('整数位数超过上限时报错', () => {
    const tooBig = intValue(1n << BigInt(CANVAS_MAX_INT_BITS));
    expect(checkValue(tooBig)).toContain('超过上限');
  });

  it('整数上限之内可以通过', () => {
    expect(checkValue(intValue((1n << BigInt(CANVAS_MAX_INT_BITS)) - 1n))).toBeUndefined();
  });

  it('浮点数只能是有限值', () => {
    expect(checkValue(doubleValue(Number.POSITIVE_INFINITY))).toContain('有限值');
    expect(checkValue(doubleValue(Number.NaN))).toContain('有限值');
  });

  it('列表元素数有上限', () => {
    const items = Array.from({ length: CANVAS_MAX_COLLECTION_ITEMS + 1 }, () => intValue(0n));
    expect(checkValue(listValue(items))).toContain('超过上限');
  });

  it('嵌套深度有上限', () => {
    let value: Value = intValue(1n);
    for (let depth = 0; depth < CANVAS_MAX_VALUE_DEPTH + 1; depth += 1) {
      value = listValue([value]);
    }
    expect(checkValue(value)).toContain('嵌套');
  });

  it('文本按码点计长度', () => {
    const tooLong = stringValue('a'.repeat(CANVAS_MAX_TEXT_CHARS + 1));
    expect(checkValue(tooLong)).toContain('码点');
  });
});

describe('显示', () => {
  it('字节串给长度与开头，空字节串明说为空', () => {
    expect(valueSummary(byteValue(new Uint8Array([0x41, 0x42])))).toBe('2 字节：4142');
    expect(valueSummary(byteValue(new Uint8Array([])))).toBe('0 字节（空）');
  });

  it('64 位以内整数同时给十进制与十六进制', () => {
    expect(valueSummary(intValue(0x1234n))).toBe('4660（0x1234）');
  });

  it('浮点数用最短往返表示，整数不带小数点', () => {
    expect(valueSummary(doubleValue(1.5))).toBe('1.5');
    expect(valueSummary(doubleValue(3))).toBe('3');
    expect(formatDouble(1.5)).toBe('1.5');
  });

  it('文本加引号并截断，布尔用中文', () => {
    expect(valueSummary(stringValue('A😀B'))).toBe('"A😀B"');
    expect(valueSummary(boolValue(true))).toBe('真');
    expect(valueSummary(stringValue('字'.repeat(40)))).toBe(`"${'字'.repeat(32)}…"`);
  });

  it('列表与字典给结构化摘要', () => {
    expect(valueSummary(listOf(intValue(1n), stringValue('a')))).toBe('[1（0x1）, "a"]');
    const dict = dictValue([
      { key: intKey(1n), value: boolValue(true) },
      { key: stringKey('1'), value: boolValue(false) },
    ]);
    expect(dict.ok && valueSummary(dict.value)).toBe('{1: 真, "1": 假}');
  });

  it('类型名是中文', () => {
    expect(valueTypeName(listOf())).toBe('列表');
    expect(valueTypeName(stringValue(''))).toBe('文本');
  });
});

describe('单位换算与长度', () => {
  it('码点长度不按 UTF-16 码元算', () => {
    expect(codePointLength('A😀B')).toBe(3);
    expect('A😀B'.length).toBe(4);
  });

  it('整数位数按绝对值算', () => {
    expect(intBitLength(0n)).toBe(0);
    expect(intBitLength(1n)).toBe(1);
    expect(intBitLength(-8n)).toBe(4);
  });
});

describe('编码往返', () => {
  it('覆盖全部七种值种类，往返后结构相等', () => {
    const dict = dictValue([
      { key: intKey(1n), value: stringValue('整数键') },
      { key: stringKey('1'), value: listOf(boolValue(true), doubleValue(-2.5)) },
    ]);
    expect(dict.ok).toBe(true);
    if (!dict.ok) return;

    const values: Value[] = [
      byteValue(new Uint8Array([0x41, 0x00, 0xff])),
      intValue(-12345678901234567890n),
      doubleValue(-2.5),
      stringValue('A😀B'),
      boolValue(false),
      listOf(intValue(1n), listOf(stringValue('嵌套'))),
      dict.value,
    ];

    for (const value of values) {
      const decoded = decodeValue(encodeValue(value));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(sameValue(decoded.value, value)).toBe(true);
    }
  });

  it('整数用十进制字符串，字节串用无前缀 hex', () => {
    expect(encodeValue(intValue(-42n))).toEqual({ kind: 'int', value: '-42' });
    expect(encodeValue(byteValue(new Uint8Array([0x00, 0xab])))).toEqual({ kind: 'byte', hex: '00ab' });
  });

  it('字典键编码保留种类', () => {
    expect(encodeKey(intKey(1n))).toEqual({ kind: 'int', value: '1' });
    expect(encodeKey(stringKey('1'))).toEqual({ kind: 'string', value: '1' });
    expect(decodeKey({ kind: 'int', value: '1' })).toEqual({ ok: true, value: intKey(1n) });
  });

  it('解码拒绝非法 hex、前导零整数、非有限浮点与重复键', () => {
    expect(decodeValue({ kind: 'byte', hex: 'abc' }).ok).toBe(false);
    expect(decodeValue({ kind: 'int', value: '007' }).ok).toBe(false);
    expect(decodeValue({ kind: 'double', value: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(decodeScalarValue({ kind: 'bool', value: true })).toEqual({ ok: true, value: boolValue(true) });
    expect(
      decodeValue({
        kind: 'dict',
        entries: [
          { key: { kind: 'string', value: 'a' }, value: { kind: 'int', value: '1' } },
          { key: { kind: 'string', value: 'a' }, value: { kind: 'int', value: '2' } },
        ],
      }).ok,
    ).toBe(false);
  });

  it('解码后的值同样受容量上限约束', () => {
    const hugeInt = '9'.repeat(CANVAS_MAX_INT_BITS);
    expect(decodeValue({ kind: 'int', value: hugeInt }).ok).toBe(false);
  });
});
