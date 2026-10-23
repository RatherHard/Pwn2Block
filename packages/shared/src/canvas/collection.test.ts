import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../hex';
import { CANVAS_MAX_BYTES, CANVAS_MAX_COLLECTION_ITEMS, CANVAS_MAX_TEXT_CHARS } from '../limits';
import { indexOf, lengthOf, lookupOf, repeatOf } from './collection';
import type { CanvasResult } from './result';
import {
  byteValue,
  dictValue,
  doubleValue,
  hexOf,
  intKey,
  intValue,
  listValue,
  stringKey,
  stringValue,
  type Value,
} from './value';

/**
 * 集合操作的契约测试（需求 §2.3、§7）。
 *
 * 断言一律精确到值本身或完整中文文案：这些语义同时被求值、校验与界面文案读取，
 * 「大致对得上」的模糊断言会让改动悄悄溜过去。
 */

/** 字典：整数键 `1` 与文本键 `"1"` 各存一个不同的值。 */
function sampleDict(): Value {
  return unwrap(
    dictValue([
      { key: intKey(1n), value: stringValue('整数键') },
      { key: stringKey('1'), value: stringValue('文本键') },
    ]),
  );
}

function unwrap<T>(result: CanvasResult<T>): T {
  if (!result.ok) throw new Error(`期待成功，实际失败：${result.message}`);
  return result.value;
}

function messageOf(result: CanvasResult<Value>): string {
  if (result.ok) throw new Error('期待失败，实际成功');
  return result.message;
}

function intOf(result: CanvasResult<Value>): bigint {
  const value = unwrap(result);
  if (value.kind !== 'int') throw new Error(`期待整数，收到${value.kind}`);
  return value.value;
}

function byteHexOf(result: CanvasResult<Value>): string {
  const value = unwrap(result);
  if (value.kind !== 'byte') throw new Error(`期待字节串，收到${value.kind}`);
  return hexOf(value.bytes);
}

function textOf(result: CanvasResult<Value>): string {
  const value = unwrap(result);
  if (value.kind !== 'string') throw new Error(`期待文本，收到${value.kind}`);
  return value.value;
}

function itemsOf(result: CanvasResult<Value>): readonly Value[] {
  const value = unwrap(result);
  if (value.kind !== 'list') throw new Error(`期待列表，收到${value.kind}`);
  return value.items;
}

describe('长度', () => {
  it('文本按码点计数，不按 UTF-16 码元', () => {
    expect(intOf(lengthOf(stringValue('A😀B')))).toBe(3n);
    expect(intOf(lengthOf(stringValue('')))).toBe(0n);
  });

  it('字节串按字节计数', () => {
    expect(intOf(lengthOf(byteValue(hexToBytes('4142'))))).toBe(2n);
  });

  it('列表按元素计数', () => {
    expect(intOf(lengthOf(listValue([intValue(1n), intValue(2n), intValue(3n)])))).toBe(3n);
    expect(intOf(lengthOf(listValue([])))).toBe(0n);
  });

  it('字典没有长度', () => {
    expect(messageOf(lengthOf(sampleDict()))).toBe('「长度」只接受字节串、文本和列表，收到字典');
  });
});

describe('按索引取元素', () => {
  it('文本按码点取，首、中、尾都对', () => {
    const text = stringValue('A😀B');
    expect(textOf(indexOf(text, intValue(0n)))).toBe('A');
    expect(textOf(indexOf(text, intValue(1n)))).toBe('😀');
    expect(textOf(indexOf(text, intValue(2n)))).toBe('B');
  });

  it('负索引表示倒数', () => {
    const text = stringValue('A😀B');
    expect(textOf(indexOf(text, intValue(-1n)))).toBe('B');
    expect(textOf(indexOf(text, intValue(-2n)))).toBe('😀');
    expect(textOf(indexOf(text, intValue(-3n)))).toBe('A');
  });

  it('字节串取出的是单字节字节串', () => {
    const bytes = byteValue(hexToBytes('4142'));
    expect(byteHexOf(indexOf(bytes, intValue(0n)))).toBe('41');
    expect(byteHexOf(indexOf(bytes, intValue(-1n)))).toBe('42');
  });

  it('列表取出的元素保留原类型', () => {
    const list = listValue([intValue(1n), stringValue('x'), listValue([intValue(9n)])]);
    expect(unwrap(indexOf(list, intValue(1n)))).toEqual(stringValue('x'));
    expect(unwrap(indexOf(list, intValue(2n)))).toEqual(listValue([intValue(9n)]));
  });

  it('越界明确报错并带上长度', () => {
    const text = stringValue('abc');
    expect(messageOf(indexOf(text, intValue(3n)))).toBe('索引 3 越界（长度 3）');
    expect(messageOf(indexOf(text, intValue(5n)))).toBe('索引 5 越界（长度 3）');
  });

  it('负索引同样会越界', () => {
    expect(messageOf(indexOf(stringValue('abc'), intValue(-4n)))).toBe('索引 -4 越界（长度 3）');
  });

  it('空集合的任何索引都越界', () => {
    expect(messageOf(indexOf(byteValue(new Uint8Array(0)), intValue(0n)))).toBe('索引 0 越界（长度 0）');
    expect(messageOf(indexOf(stringValue(''), intValue(-1n)))).toBe('索引 -1 越界（长度 0）');
    expect(messageOf(indexOf(listValue([]), intValue(0n)))).toBe('索引 0 越界（长度 0）');
  });

  it('索引不是整数时报错', () => {
    expect(messageOf(indexOf(stringValue('abc'), stringValue('1')))).toBe('索引需要整数，收到文本');
    expect(messageOf(indexOf(stringValue('abc'), doubleValue(1)))).toBe('索引需要整数，收到浮点数');
  });

  it('字典不能按索引取元素', () => {
    expect(messageOf(indexOf(sampleDict(), intValue(0n)))).toBe(
      '「按索引取元素」只接受字节串、文本和列表，收到字典',
    );
  });
});

describe('字典按键取值', () => {
  it('整数键 1 与文本键 "1" 各自命中不同值', () => {
    const dict = sampleDict();
    expect(textOf(lookupOf(dict, intValue(1n)))).toBe('整数键');
    expect(textOf(lookupOf(dict, stringValue('1')))).toBe('文本键');
  });

  it('缺失键报错', () => {
    expect(messageOf(lookupOf(sampleDict(), intValue(2n)))).toBe('字典里没有键 2');
    expect(messageOf(lookupOf(sampleDict(), stringValue('2')))).toBe('字典里没有键 "2"');
  });

  it('键只能是整数或文本', () => {
    expect(messageOf(lookupOf(sampleDict(), doubleValue(1.5)))).toBe('字典键只能是整数或文本，收到浮点数');
  });

  it('目标不是字典时报错', () => {
    expect(messageOf(lookupOf(listValue([]), intValue(0n)))).toBe('「按键取值」需要字典，收到列表');
  });
});

describe('重复', () => {
  it('字节串按字节重复', () => {
    expect(byteHexOf(repeatOf(byteValue(hexToBytes('41')), intValue(3n)))).toBe('414141');
    expect(byteHexOf(repeatOf(byteValue(hexToBytes('4142')), intValue(2n)))).toBe('41424142');
  });

  it('列表按元素重复且保留元素', () => {
    const list = listValue([intValue(1n), stringValue('x')]);
    const repeated = unwrap(repeatOf(list, intValue(2n)));
    expect(repeated.kind).toBe('list');
    expect(repeated).toEqual(listValue([intValue(1n), stringValue('x'), intValue(1n), stringValue('x')]));
  });

  it('文本按码点重复', () => {
    expect(textOf(repeatOf(stringValue('ab'), intValue(2n)))).toBe('abab');
    expect(textOf(repeatOf(stringValue('A😀'), intValue(2n)))).toBe('A😀A😀');
  });

  it('0 次得到空结果并保持类型', () => {
    expect(byteHexOf(repeatOf(byteValue(hexToBytes('41')), intValue(0n)))).toBe('');
    expect(textOf(repeatOf(stringValue('ab'), intValue(0n)))).toBe('');
    expect(itemsOf(repeatOf(listValue([intValue(1n)]), intValue(0n)))).toEqual([]);
  });

  it('次数必须是非负整数', () => {
    expect(messageOf(repeatOf(stringValue('ab'), intValue(-1n)))).toBe('重复次数不能为负，收到 -1');
    expect(messageOf(repeatOf(stringValue('ab'), stringValue('2')))).toBe('重复次数需要整数，收到文本');
  });

  it('先算结果规模再分配：字节串超限直接报错', () => {
    const big = byteValue(new Uint8Array(1_000_000));
    expect(messageOf(repeatOf(big, intValue(1000n)))).toBe(
      `重复后字节串长度 1000000000 超过上限 ${CANVAS_MAX_BYTES}`,
    );
  });

  it('先算结果规模再分配：文本超限直接报错', () => {
    expect(messageOf(repeatOf(stringValue('ab'), intValue(1_000_000_000n)))).toBe(
      `重复后文本 2000000000 个码点，超过上限 ${CANVAS_MAX_TEXT_CHARS}`,
    );
  });

  it('先算结果规模再分配：列表超限直接报错', () => {
    const many = listValue(Array.from({ length: CANVAS_MAX_COLLECTION_ITEMS }, () => intValue(1n)));
    expect(messageOf(repeatOf(many, intValue(2n)))).toBe(
      `重复后列表元素数 ${CANVAS_MAX_COLLECTION_ITEMS * 2} 超过上限 ${CANVAS_MAX_COLLECTION_ITEMS}`,
    );
  });

  it('字典不能重复', () => {
    expect(messageOf(repeatOf(sampleDict(), intValue(2n)))).toBe(
      '「重复」只接受字节串、文本和列表，收到字典',
    );
  });

  it('空集合重复任意多次仍是空，不按次数分配', () => {
    expect(byteHexOf(repeatOf(byteValue(new Uint8Array(0)), intValue(10n ** 18n)))).toBe('');
    expect(textOf(repeatOf(stringValue(''), intValue(10n ** 18n)))).toBe('');
  });
});
