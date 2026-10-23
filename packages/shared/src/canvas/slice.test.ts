import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../hex';
import type { CanvasResult } from './result';
import { sliceOf } from './slice';
import {
  byteValue,
  dictValue,
  doubleValue,
  hexOf,
  intKey,
  intValue,
  listValue,
  stringValue,
  type Value,
} from './value';

/**
 * 切片的契约测试（需求 §2.3、AT-11）。
 *
 * 重点是三件容易做错的事：文本必须按码点切（`"A😀B"[1:2]` 只能是完整的 `"😀"`）、
 * 负步长的默认端点（「越过开头」而不是第 0 个元素）、以及超长边界不能被 `Number()` 丢精度。
 */

function unwrap(result: CanvasResult<Value>): Value {
  if (!result.ok) throw new Error(`期待成功，实际失败：${result.message}`);
  return result.value;
}

function messageOf(result: CanvasResult<Value>): string {
  if (result.ok) throw new Error('期待失败，实际成功');
  return result.message;
}

function textOf(result: CanvasResult<Value>): string {
  const value = unwrap(result);
  if (value.kind !== 'string') throw new Error(`期待文本，收到${value.kind}`);
  return value.value;
}

function byteHexOf(result: CanvasResult<Value>): string {
  const value = unwrap(result);
  if (value.kind !== 'byte') throw new Error(`期待字节串，收到${value.kind}`);
  return hexOf(value.bytes);
}

function itemsOf(result: CanvasResult<Value>): readonly Value[] {
  const value = unwrap(result);
  if (value.kind !== 'list') throw new Error(`期待列表，收到${value.kind}`);
  return value.items;
}

describe('切片：文本按 Unicode 码点', () => {
  it('[1:2] 取到完整的表情符号，而不是半个代理对', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), { start: intValue(1n), end: intValue(2n) }))).toBe('😀');
  });

  it('[::-1] 反转', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), { step: intValue(-1n) }))).toBe('B😀A');
  });

  it('[0:99] 把终点裁剪到长度', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), { start: intValue(0n), end: intValue(99n) }))).toBe('A😀B');
  });

  it('[-2:] 取后两个码点', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), { start: intValue(-2n) }))).toBe('😀B');
  });

  it('[::2] 隔一个取一个', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), { step: intValue(2n) }))).toBe('AB');
  });

  it('[1:1] 空结果合法，类型仍是文本', () => {
    const sliced = unwrap(sliceOf(stringValue('A😀B'), { start: intValue(1n), end: intValue(1n) }));
    expect(sliced).toEqual(stringValue(''));
    expect(sliced.kind).toBe('string');
  });

  it('缺省边界就是整份文本', () => {
    expect(textOf(sliceOf(stringValue('A😀B'), {}))).toBe('A😀B');
  });

  it('负步长带边界：abcdef[4:1:-1]', () => {
    const sliced = sliceOf(stringValue('abcdef'), {
      start: intValue(4n),
      end: intValue(1n),
      step: intValue(-1n),
    });
    expect(textOf(sliced)).toBe('edc');
  });

  it('负索引与负步长配合：abcdef[-1:-3:-1]', () => {
    const sliced = sliceOf(stringValue('abcdef'), {
      start: intValue(-1n),
      end: intValue(-3n),
      step: intValue(-1n),
    });
    expect(textOf(sliced)).toBe('fe');
  });
});

describe('切片：字节串按字节', () => {
  it('[1:3] 取中间两个字节，结果仍是字节串', () => {
    const sliced = sliceOf(byteValue(hexToBytes('41424344')), { start: intValue(1n), end: intValue(3n) });
    expect(byteHexOf(sliced)).toBe('4243');
    expect(unwrap(sliced).kind).toBe('byte');
  });

  it('[::-1] 按字节反转', () => {
    expect(byteHexOf(sliceOf(byteValue(hexToBytes('414243')), { step: intValue(-1n) }))).toBe('434241');
  });

  it('[1:1] 空字节串合法', () => {
    const sliced = unwrap(sliceOf(byteValue(hexToBytes('4142')), { start: intValue(1n), end: intValue(1n) }));
    expect(sliced).toEqual(byteValue(new Uint8Array(0)));
    expect(sliced.kind).toBe('byte');
  });
});

describe('切片：列表按元素', () => {
  it('[1:3] 切后类型仍是列表，元素原样保留', () => {
    const list = listValue([intValue(1n), stringValue('x'), intValue(3n)]);
    const sliced = sliceOf(list, { start: intValue(1n), end: intValue(3n) });
    expect(unwrap(sliced).kind).toBe('list');
    expect(unwrap(sliced)).toEqual(listValue([stringValue('x'), intValue(3n)]));
  });

  it('[::-1] 反转元素顺序', () => {
    const list = listValue([intValue(1n), intValue(2n), intValue(3n)]);
    expect(itemsOf(sliceOf(list, { step: intValue(-1n) }))).toEqual([intValue(3n), intValue(2n), intValue(1n)]);
  });

  it('空结果仍是列表', () => {
    const list = listValue([intValue(1n), intValue(2n)]);
    const sliced = unwrap(sliceOf(list, { start: intValue(1n), end: intValue(1n) }));
    expect(sliced.kind).toBe('list');
    expect(sliced).toEqual(listValue([]));
  });
});

describe('切片：边界与错误', () => {
  it('步长为 0 报错', () => {
    expect(messageOf(sliceOf(stringValue('abc'), { step: intValue(0n) }))).toBe('切片步长不能为 0');
  });

  it('字典不支持切片', () => {
    const dict = unwrap(
      dictValue([{ key: intKey(1n), value: stringValue('整数键') }]),
    );
    expect(messageOf(sliceOf(dict, {}))).toBe('「切片」只接受字节串、文本和列表，收到字典');
  });

  it('三个边界都必须是整数', () => {
    expect(messageOf(sliceOf(stringValue('abc'), { start: stringValue('1') }))).toBe('切片起点需要整数，收到文本');
    expect(messageOf(sliceOf(stringValue('abc'), { end: doubleValue(1) }))).toBe('切片终点需要整数，收到浮点数');
    expect(messageOf(sliceOf(stringValue('abc'), { step: stringValue('x') }))).toBe('切片步长需要整数，收到文本');
  });

  it('超长边界折成 ±Infinity 后走同一套裁剪', () => {
    const huge = intValue(10n ** 30n);
    const minusHuge = intValue(-(10n ** 30n));
    expect(textOf(sliceOf(stringValue('abc'), { start: huge }))).toBe('');
    expect(textOf(sliceOf(stringValue('abc'), { end: huge }))).toBe('abc');
    expect(textOf(sliceOf(stringValue('abc'), { start: minusHuge }))).toBe('abc');
    expect(textOf(sliceOf(stringValue('abc'), { step: huge }))).toBe('a');
    expect(textOf(sliceOf(stringValue('abc'), { step: minusHuge }))).toBe('c');
  });

  it('空目标的切片是空结果', () => {
    expect(unwrap(sliceOf(stringValue(''), {}))).toEqual(stringValue(''));
    expect(unwrap(sliceOf(listValue([]), { step: intValue(-1n) }))).toEqual(listValue([]));
    expect(unwrap(sliceOf(byteValue(new Uint8Array(0)), { start: intValue(2n) }))).toEqual(
      byteValue(new Uint8Array(0)),
    );
  });
});
