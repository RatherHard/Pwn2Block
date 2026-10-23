import { describe, expect, it } from 'vitest';
import {
  CANVAS_FORMAT,
  CANVAS_VERSION,
  suggestGroupMode,
  type CanvasDocument,
  type CanvasNode,
  type CanvasNodeLayout,
  type GroupMode,
  type GroupNode,
} from '../src/canvas/document';
import { evaluateCanvasDocument, evaluateCanvasNode } from '../src/canvas/evaluate';
import type { EncodedScalarValue } from '../src/canvas/value-codec';
import {
  boolValue,
  byteValue,
  intValue,
  listValue,
  stringValue,
  type Value,
} from '../src/canvas/value';

/**
 * 数据语义的验收场景（需求 §2、§4、§7 的数据部分）。
 *
 * 这里按 AT-01–AT-04、AT-11、AT-12、AT-13 的条目逐条断言最终值，不测中间实现细节：
 * 组合的行列顺序、模式、转换、切片、短路都要给出精确结果。断言精确值而不是「成功即可」，
 * 因为这套语义是后面的流程与变量阶段的地基。
 */

function hexBytes(hex: string): EncodedScalarValue {
  return { kind: 'byte', hex };
}

function intLiteral(value: bigint | number): EncodedScalarValue {
  return { kind: 'int', value: String(value) };
}

function textLiteral(value: string): EncodedScalarValue {
  return { kind: 'string', value };
}

function boolLiteral(value: boolean): EncodedScalarValue {
  return { kind: 'bool', value };
}

function doubleLiteral(value: number): EncodedScalarValue {
  return { kind: 'double', value };
}

function valueNode(id: string, value: EncodedScalarValue): CanvasNode {
  return { kind: 'value', id, value };
}

function groupNode(id: string, mode: GroupMode, rows: readonly (readonly string[])[]): GroupNode {
  return { kind: 'group', id, mode, rows };
}

function docOf(nodes: readonly CanvasNode[], layout: Readonly<Record<string, CanvasNodeLayout>> = {}): CanvasDocument {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout, main: [] };
}

function bytesOf(value: Value | undefined): Uint8Array {
  if (value === undefined || value.kind !== 'byte') throw new Error('期望字节串');
  return value.bytes;
}

function textOf(value: Value | undefined): string {
  if (value === undefined || value.kind !== 'string') throw new Error('期望文本');
  return value.value;
}

describe('AT-01 吸附组合：行列顺序与折行', () => {
  const nodes: CanvasNode[] = [
    valueNode('a', hexBytes('41')),
    valueNode('b', hexBytes('42')),
    valueNode('c', hexBytes('43')),
  ];

  it('第一行 41、第二行 42 与 43，按先行后列合并为 414243', () => {
    const document = docOf([...nodes, groupNode('g', 'merge', [['a'], ['b', 'c']])]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(bytesOf(outcome.values.get('g'))).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
  });

  it('整组移动（只改布局）不改变结果', () => {
    const before = docOf([...nodes, groupNode('g', 'merge', [['a'], ['b', 'c']])]);
    const after = docOf([...nodes, groupNode('g', 'merge', [['a'], ['b', 'c']])], {
      g: { x: 320, y: 480 },
      a: { x: 0, y: 0 },
    });
    expect(evaluateCanvasDocument(after).values.get('g')).toEqual(
      evaluateCanvasDocument(before).values.get('g'),
    );
  });

  it('组内重排按成员顺序改变结果', () => {
    const document = docOf([...nodes, groupNode('g', 'merge', [['c'], ['a', 'b']])]);
    expect(bytesOf(evaluateCanvasDocument(document).values.get('g'))).toEqual(
      new Uint8Array([0x43, 0x41, 0x42]),
    );
  });

  it('折行不插入换行或分隔符：两行与一行结果相同', () => {
    const wrapped = docOf([...nodes, groupNode('g', 'merge', [['a', 'b'], ['c']])]);
    const flat = docOf([...nodes, groupNode('g', 'merge', [['a', 'b', 'c']])]);
    expect(bytesOf(evaluateCanvasDocument(wrapped).values.get('g'))).toEqual(
      bytesOf(evaluateCanvasDocument(flat).values.get('g')),
    );
  });

  it('全文本合并为文本', () => {
    const document = docOf([
      valueNode('a', textLiteral('AB')),
      valueNode('b', textLiteral('CD')),
      groupNode('g', 'merge', [['a'], ['b']]),
    ]);
    expect(textOf(evaluateCanvasDocument(document).values.get('g'))).toBe('ABCD');
  });
});

describe('AT-02 组合模式', () => {
  it('把全字节串组合切换成列表，保留各成员', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('b', hexBytes('42')),
      groupNode('g', 'list', [['a'], ['b']]),
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(outcome.values.get('g')).toEqual(
      listValue([byteValue(new Uint8Array([0x41])), byteValue(new Uint8Array([0x42]))]),
    );
  });

  it('向既有字节串合并组拖入文本：明确报错，不自动切换模式', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('b', textLiteral('B')),
      groupNode('g', 'merge', [['a'], ['b']]),
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    const issue = outcome.issues.find((candidate) => candidate.code === 'group_mode_conflict');
    expect(issue?.nodeId).toBe('g');
    expect(issue?.message).toContain('合并为串要求成员类型一致');
    expect(issue?.message).toContain('第 2 项是文本');
  });

  it('默认模式：全字节串或全文本合并，其余组成列表', () => {
    expect(suggestGroupMode(['byte', 'byte'])).toBe('merge');
    expect(suggestGroupMode(['string', 'string'])).toBe('merge');
    expect(suggestGroupMode(['byte', 'string'])).toBe('list');
    expect(suggestGroupMode(['int', 'int'])).toBe('list');
    expect(suggestGroupMode([])).toBe('list');
  });
});

describe('AT-03 混合列表与嵌套列表', () => {
  it('列表保留类型与层级，嵌套列表不自动展开', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      valueNode('s', textLiteral('文本')),
      valueNode('b', hexBytes('41')),
      groupNode('inner', 'list', [['n'], ['s']]),
      groupNode('outer', 'list', [['inner'], ['b']]),
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(outcome.values.get('outer')).toEqual(
      listValue([listValue([intValue(1n), stringValue('文本')]), byteValue(new Uint8Array([0x41]))]),
    );
  });

  it('整体转字节串前必须逐项处理：混合列表不能直接合并', () => {
    const document = docOf([
      valueNode('b', hexBytes('41')),
      valueNode('s', textLiteral('B')),
      groupNode('g', 'list', [['b'], ['s']]),
      { kind: 'convert', id: 'conv', spec: { kind: 'list-to-bytes' }, input: 'g' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.message).toContain('第 2 项是文本');
  });

  it('全字节串列表可以整体合并为字节串', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('b', hexBytes('42')),
      groupNode('g', 'list', [['a', 'b']]),
      { kind: 'convert', id: 'conv', spec: { kind: 'list-to-bytes' }, input: 'g' },
    ]);
    expect(bytesOf(evaluateCanvasDocument(document).values.get('conv'))).toEqual(
      new Uint8Array([0x41, 0x42]),
    );
  });
});

describe('AT-04 字典', () => {
  it('整数键 1 与字符串键 "1" 独立且保留插入顺序', () => {
    const document = docOf([
      valueNode('v1', textLiteral('整数键')),
      valueNode('v2', textLiteral('文本键')),
      {
        kind: 'dict',
        id: 'd',
        entries: [
          { key: { kind: 'int', value: '1' }, value: 'v1' },
          { key: { kind: 'string', value: '1' }, value: 'v2' },
        ],
      },
    ]);
    const dict = evaluateCanvasDocument(document).values.get('d');
    expect(dict?.kind).toBe('dict');
    if (dict === undefined || dict.kind !== 'dict') return;
    expect(dict.entries.map((entry) => entry.key)).toEqual([
      { kind: 'int', value: 1n },
      { kind: 'string', value: '1' },
    ]);
    expect(dict.entries.map((entry) => entry.value)).toEqual([
      stringValue('整数键'),
      stringValue('文本键'),
    ]);
  });

  it('按键取出值后可以按自身类型转换', () => {
    const document = docOf([
      valueNode('n', intLiteral(0x1234)),
      {
        kind: 'dict',
        id: 'd',
        entries: [{ key: { kind: 'string', value: 'addr' }, value: 'n' }],
      },
      valueNode('key', textLiteral('addr')),
      { kind: 'lookup', id: 'got', target: 'd', key: 'key' },
      {
        kind: 'convert',
        id: 'conv',
        spec: { kind: 'int-to-bytes', width: 2, endian: 'little', signed: false },
        input: 'got',
      },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(bytesOf(outcome.values.get('conv'))).toEqual(new Uint8Array([0x34, 0x12]));
  });

  it('缺失键报错', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      { kind: 'dict', id: 'd', entries: [{ key: { kind: 'int', value: '1' }, value: 'n' }] },
      valueNode('key', intLiteral(2)),
      { kind: 'lookup', id: 'got', target: 'd', key: 'key' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.message).toContain('没有键');
  });

  it('字典没有转换入口：转换包络接字典直接报错', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      { kind: 'dict', id: 'd', entries: [{ key: { kind: 'int', value: '1' }, value: 'n' }] },
      { kind: 'convert', id: 'conv', spec: { kind: 'int-to-double' }, input: 'd' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.code === 'conversion_unsupported')).toBe(true);
  });
});

describe('表达式结构与短路（AT-10 的数据部分）', () => {
  const nodes: CanvasNode[] = [
    valueNode('two', intLiteral(2)),
    valueNode('three', intLiteral(3)),
    valueNode('four', intLiteral(4)),
  ];

  it('表达式结构决定顺序：a + (b × c) 与 (a + b) × c 结果不同', () => {
    const nested = docOf([
      ...nodes,
      { kind: 'relation', id: 'mul', op: 'int.mul', left: 'three', right: 'four' },
      { kind: 'relation', id: 'add', op: 'int.add', left: 'two', right: 'mul' },
    ]);
    const flat = docOf([
      ...nodes,
      { kind: 'relation', id: 'add', op: 'int.add', left: 'two', right: 'three' },
      { kind: 'relation', id: 'mul', op: 'int.mul', left: 'add', right: 'four' },
    ]);
    expect(evaluateCanvasDocument(nested).values.get('add')).toEqual(intValue(14n));
    expect(evaluateCanvasDocument(flat).values.get('mul')).toEqual(intValue(20n));
  });

  it('布尔与短路：左侧为假时不求值右侧，除零错误不出现', () => {
    const document = docOf([
      valueNode('zero', intLiteral(0)),
      valueNode('one', intLiteral(1)),
      valueNode('no', boolLiteral(false)),
      { kind: 'relation', id: 'boom', op: 'int.div', left: 'one', right: 'zero' },
      { kind: 'relation', id: 'and', op: 'bool.and', left: 'no', right: 'boom' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(outcome.values.get('and')).toEqual(boolValue(false));
    expect(outcome.values.has('boom')).toBe(false);
    expect(outcome.issues).toHaveLength(0);
  });

  it('布尔或短路：左侧为真时右侧不求值', () => {
    const document = docOf([
      valueNode('zero', intLiteral(0)),
      valueNode('one', intLiteral(1)),
      valueNode('yes', boolLiteral(true)),
      { kind: 'relation', id: 'boom', op: 'int.div', left: 'one', right: 'zero' },
      { kind: 'relation', id: 'or', op: 'bool.or', left: 'yes', right: 'boom' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(true);
    expect(outcome.values.get('or')).toEqual(boolValue(true));
  });

  it('短路不成立时错误照常报出', () => {
    const document = docOf([
      valueNode('zero', intLiteral(0)),
      valueNode('one', intLiteral(1)),
      valueNode('yes', boolLiteral(true)),
      { kind: 'relation', id: 'boom', op: 'int.div', left: 'one', right: 'zero' },
      { kind: 'relation', id: 'and', op: 'bool.and', left: 'yes', right: 'boom' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes('除数'))).toBe(true);
  });

  it('不做隐式转换：整数与浮点混用报错', () => {
    const document = docOf([
      valueNode('int', intLiteral(1)),
      valueNode('double', doubleLiteral(1.5)),
      { kind: 'relation', id: 'add', op: 'double.add', left: 'int', right: 'double' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.message).toContain('浮点加');
    expect(outcome.issues[0]?.message).toContain('整数');
  });
});

describe('集合与切片（AT-11 的集成部分）', () => {
  it('文本按码点切片，结果保持文本', () => {
    const document = docOf([
      valueNode('text', textLiteral('A😀B')),
      valueNode('start', intLiteral(1)),
      valueNode('end', intLiteral(2)),
      { kind: 'slice', id: 'cut', target: 'text', start: 'start', end: 'end' },
    ]);
    expect(textOf(evaluateCanvasDocument(document).values.get('cut'))).toBe('😀');
  });

  it('字节串按字节切片、列表按元素切片，类型各自保持', () => {
    const document = docOf([
      valueNode('bytes', hexBytes('414243')),
      valueNode('one', intLiteral(1)),
      valueNode('item', hexBytes('41')),
      groupNode('list', 'list', [['item'], ['item']]),
      { kind: 'slice', id: 'bySlice', target: 'bytes', start: 'one' },
      { kind: 'slice', id: 'listSlice', target: 'list', end: 'one' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(bytesOf(outcome.values.get('bySlice'))).toEqual(new Uint8Array([0x42, 0x43]));
    expect(outcome.values.get('listSlice')).toEqual(listValue([byteValue(new Uint8Array([0x41]))]));
  });

  it('单元素索引越界报错；负索引从末尾数', () => {
    const document = docOf([
      valueNode('list', textLiteral('ab')),
      valueNode('last', intLiteral(-1)),
      valueNode('over', intLiteral(5)),
      { kind: 'index', id: 'ok', target: 'list', index: 'last' },
      { kind: 'index', id: 'bad', target: 'list', index: 'over' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.values.get('ok')).toEqual(stringValue('b'));
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes('越界'))).toBe(true);
  });

  it('长度按码点数、按字节数、按元素数分别计算', () => {
    const document = docOf([
      valueNode('text', textLiteral('A😀B')),
      valueNode('bytes', hexBytes('4142')),
      valueNode('item', textLiteral('x')),
      groupNode('list', 'list', [['item'], ['text']]),
      { kind: 'unary', id: 'textLen', op: 'length', operand: 'text' },
      { kind: 'unary', id: 'bytesLen', op: 'length', operand: 'bytes' },
      { kind: 'unary', id: 'listLen', op: 'length', operand: 'list' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.values.get('textLen')).toEqual(intValue(3n));
    expect(outcome.values.get('bytesLen')).toEqual(intValue(2n));
    expect(outcome.values.get('listLen')).toEqual(intValue(2n));
  });
});

describe('转换（AT-12、AT-13 的集成部分）', () => {
  it('0x1234 转两字节：小端 3412、大端 1234', () => {
    const document = docOf([
      valueNode('n', intLiteral(0x1234)),
      { kind: 'convert', id: 'le', spec: { kind: 'int-to-bytes', width: 2, endian: 'little', signed: false }, input: 'n' },
      { kind: 'convert', id: 'be', spec: { kind: 'int-to-bytes', width: 2, endian: 'big', signed: false }, input: 'n' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(bytesOf(outcome.values.get('le'))).toEqual(new Uint8Array([0x34, 0x12]));
    expect(bytesOf(outcome.values.get('be'))).toEqual(new Uint8Array([0x12, 0x34]));
  });

  it('文本经 UTF-8 转字节串再转回文本，往返保持', () => {
    const document = docOf([
      valueNode('text', textLiteral('A😀')),
      { kind: 'convert', id: 'bytes', spec: { kind: 'text-to-bytes', encoding: 'utf-8' }, input: 'text' },
      { kind: 'convert', id: 'back', spec: { kind: 'bytes-to-text', encoding: 'utf-8' }, input: 'bytes' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(bytesOf(outcome.values.get('bytes'))).toEqual(new Uint8Array([0x41, 0xf0, 0x9f, 0x98, 0x80]));
    expect(textOf(outcome.values.get('back'))).toBe('A😀');
  });

  it('浮点转整数按显式舍入方式', () => {
    const document = docOf([
      valueNode('d', doubleLiteral(-2.5)),
      { kind: 'convert', id: 'trunc', spec: { kind: 'double-to-int', rounding: 'trunc' }, input: 'd' },
      { kind: 'convert', id: 'floor', spec: { kind: 'double-to-int', rounding: 'floor' }, input: 'd' },
      { kind: 'convert', id: 'ceil', spec: { kind: 'double-to-int', rounding: 'ceil' }, input: 'd' },
      { kind: 'convert', id: 'near', spec: { kind: 'double-to-int', rounding: 'nearest' }, input: 'd' },
    ]);
    const outcome = evaluateCanvasDocument(document);
    expect(outcome.values.get('trunc')).toEqual(intValue(-2n));
    expect(outcome.values.get('floor')).toEqual(intValue(-3n));
    expect(outcome.values.get('ceil')).toEqual(intValue(-2n));
    expect(outcome.values.get('near')).toEqual(intValue(-3n));
  });
});

describe('预览与预算', () => {
  it('单节点预览不需要它是根，也不会因为别处的错误失败', () => {
    const document = docOf([
      valueNode('a', intLiteral(2)),
      valueNode('b', intLiteral(3)),
      { kind: 'relation', id: 'sum', op: 'int.add', left: 'a', right: 'b' },
      valueNode('zero', intLiteral(0)),
      { kind: 'relation', id: 'boom', op: 'int.div', left: 'a', right: 'zero' },
    ]);
    expect(evaluateCanvasDocument(document).ok).toBe(false);
    expect(evaluateCanvasNode(document, 'sum')).toEqual({ ok: true, value: intValue(5n) });
  });

  it('求值步数超过上限时停止并报 limit_exceeded', () => {
    const document = docOf([
      valueNode('a', intLiteral(1)),
      valueNode('b', intLiteral(2)),
      valueNode('c', intLiteral(3)),
      { kind: 'relation', id: 'x', op: 'int.add', left: 'a', right: 'b' },
      { kind: 'relation', id: 'y', op: 'int.add', left: 'x', right: 'c' },
    ]);
    const outcome = evaluateCanvasDocument(document, { maxSteps: 2 });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.code === 'limit_exceeded')).toBe(true);
  });

  it('表达式嵌套超过上限时停止，而不是把调用栈拖死', () => {
    const nodes: CanvasNode[] = [valueNode('n0', intLiteral(7))];
    for (let step = 1; step <= 70; step += 1) {
      nodes.push({
        kind: 'convert',
        id: `n${step}`,
        spec: step % 2 === 1 ? { kind: 'int-to-text', base: 10 } : { kind: 'text-to-int', base: 10 },
        input: `n${step - 1}`,
      });
    }
    const outcome = evaluateCanvasDocument(docOf(nodes));
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes('嵌套'))).toBe(true);
  });
});
