import { describe, expect, it } from 'vitest';
import {
  CANVAS_FORMAT,
  CANVAS_VERSION,
  emptyCanvasDocument,
  inputIdsOf,
  suggestGroupMode,
  type CanvasDocument,
  type CanvasNode,
} from '../src/canvas/document';
import { parseCanvasDocument } from '../src/canvas/schema';
import { staticTypeOf, validateCanvasDocument } from '../src/canvas/validate';
import type { EncodedScalarValue } from '../src/canvas/value-codec';

/**
 * 结构与类型校验、存档形状（需求 §4.1、§7、§8）。
 *
 * 校验器和求值器分工：校验器拦「不依赖具体值就一定是错的」问题（未知节点、归属冲突、
 * 数据环、类型不匹配、字典重复键、转换适用性）；除零与越界留给求值阶段，免得编辑中途
 * 满屏红色。这里逐条断言代码与定位，不比较完整文案。
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

function valueNode(id: string, value: EncodedScalarValue): CanvasNode {
  return { kind: 'value', id, value };
}

function docOf(nodes: readonly CanvasNode[], main: readonly string[] = []): CanvasDocument {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main };
}

function codesOf(document: CanvasDocument): readonly string[] {
  return validateCanvasDocument(document).issues.map((issue) => issue.code);
}

describe('结构校验', () => {
  it('重复 id 报 duplicate_id', () => {
    const document = docOf([valueNode('a', intLiteral(1)), valueNode('a', intLiteral(2))]);
    expect(codesOf(document)).toContain('duplicate_id');
  });

  it('引用不存在的节点报 unknown_node，并定位到引用者', () => {
    const document = docOf([
      valueNode('a', intLiteral(1)),
      { kind: 'relation', id: 'sum', op: 'int.add', left: 'a', right: 'missing' },
    ]);
    const issue = validateCanvasDocument(document).issues.find((item) => item.code === 'unknown_node');
    expect(issue?.nodeId).toBe('sum');
  });

  it('节点引用自己报 self_reference', () => {
    const document = docOf([{ kind: 'unary', id: 'loop', op: 'length', operand: 'loop' }]);
    expect(codesOf(document)).toContain('self_reference');
  });

  it('数据引用成环报 input_cycle', () => {
    const document = docOf([
      valueNode('a', intLiteral(1)),
      { kind: 'relation', id: 'r', op: 'int.add', left: 'a', right: 'u' },
      { kind: 'unary', id: 'u', op: 'length', operand: 'r' },
    ]);
    expect(codesOf(document)).toContain('input_cycle');
  });

  it('一个节点被两个组合占有报 ownership_conflict', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      { kind: 'group', id: 'g1', mode: 'merge', rows: [['a']] },
      { kind: 'group', id: 'g2', mode: 'list', rows: [['a']] },
    ]);
    const issue = validateCanvasDocument(document).issues.find((item) => item.code === 'ownership_conflict');
    expect(issue?.nodeId).toBe('a');
  });

  it('空组合报 group_empty', () => {
    const document = docOf([{ kind: 'group', id: 'g', mode: 'merge', rows: [] }]);
    expect(codesOf(document)).toContain('group_empty');
  });

  it('合并组里成员类型不一致报 group_mode_conflict', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('b', textLiteral('B')),
      { kind: 'group', id: 'g', mode: 'merge', rows: [['a', 'b']] },
    ]);
    expect(codesOf(document)).toContain('group_mode_conflict');
  });
});

describe('类型校验', () => {
  it('整数加接到文本上报 type_mismatch，并说明哪一边', () => {
    const document = docOf([
      valueNode('a', intLiteral(1)),
      valueNode('b', textLiteral('x')),
      { kind: 'relation', id: 'sum', op: 'int.add', left: 'a', right: 'b' },
    ]);
    const issue = validateCanvasDocument(document).issues.find((item) => item.code === 'type_mismatch');
    expect(issue?.nodeId).toBe('sum');
    expect(issue?.message).toContain('右边');
  });

  it('字典不参与转换：转换包络接字典报 conversion_unsupported', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      { kind: 'dict', id: 'd', entries: [{ key: { kind: 'int', value: '1' }, value: 'n' }] },
      { kind: 'convert', id: 'conv', spec: { kind: 'int-to-double' }, input: 'd' },
    ]);
    expect(codesOf(document)).toContain('conversion_unsupported');
  });

  it('按键取值只接受字典，按索引取元素只接受集合', () => {
    const lookup = docOf([
      valueNode('n', intLiteral(1)),
      valueNode('key', intLiteral(1)),
      { kind: 'lookup', id: 'got', target: 'n', key: 'key' },
    ]);
    expect(codesOf(lookup)).toContain('type_mismatch');

    const index = docOf([
      valueNode('n', intLiteral(1)),
      valueNode('i', intLiteral(0)),
      { kind: 'index', id: 'got', target: 'n', index: 'i' },
    ]);
    expect(codesOf(index)).toContain('type_mismatch');
  });

  it('切片与重复的边界必须是整数', () => {
    const document = docOf([
      valueNode('text', textLiteral('abc')),
      valueNode('flag', textLiteral('1')),
      { kind: 'slice', id: 'cut', target: 'text', step: 'flag' },
      { kind: 'repeat', id: 'rep', target: 'text', count: 'flag' },
    ]);
    const issues = validateCanvasDocument(document).issues.filter((item) => item.code === 'type_mismatch');
    expect(issues.map((issue) => issue.nodeId).sort()).toEqual(['cut', 'rep']);
  });

  it('字典重复键报 dict_duplicate_key', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      {
        kind: 'dict',
        id: 'd',
        entries: [
          { key: { kind: 'string', value: 'a' }, value: 'n' },
          { key: { kind: 'string', value: 'a' }, value: 'n' },
        ],
      },
    ]);
    expect(codesOf(document)).toContain('dict_duplicate_key');
  });

  it('整数键 1 与文本键 "1" 不是重复键', () => {
    const document = docOf([
      valueNode('n', intLiteral(1)),
      {
        kind: 'dict',
        id: 'd',
        entries: [
          { key: { kind: 'int', value: '1' }, value: 'n' },
          { key: { kind: 'string', value: '1' }, value: 'n' },
        ],
      },
    ]);
    expect(codesOf(document)).not.toContain('dict_duplicate_key');
    expect(validateCanvasDocument(document).ok).toBe(true);
  });

  it('合法的数据图整体通过校验', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('n', intLiteral(2)),
      { kind: 'group', id: 'g', mode: 'merge', rows: [['a', 'a']] },
      { kind: 'relation', id: 'rep', op: 'int.mul', left: 'n', right: 'n' },
      { kind: 'convert', id: 'conv', spec: { kind: 'int-to-bytes', width: 1, endian: 'little', signed: false }, input: 'rep' },
      { kind: 'group', id: 'all', mode: 'list', rows: [['g'], ['conv']] },
    ]);
    expect(validateCanvasDocument(document)).toEqual({ ok: true, issues: [] });
  });
});

describe('静态类型推导', () => {
  const document = docOf([
    valueNode('bytes', hexBytes('41')),
    valueNode('n', intLiteral(1)),
    valueNode('text', textLiteral('abc')),
    { kind: 'group', id: 'merged', mode: 'merge', rows: [['bytes']] },
    { kind: 'group', id: 'list', mode: 'list', rows: [['bytes'], ['text']] },
    { kind: 'index', id: 'fromBytes', target: 'bytes', index: 'n' },
    { kind: 'index', id: 'fromText', target: 'text', index: 'n' },
    { kind: 'index', id: 'fromList', target: 'list', index: 'n' },
    { kind: 'lookup', id: 'anyValue', target: 'list', key: 'text' },
    { kind: 'convert', id: 'toText', spec: { kind: 'bytes-to-text', encoding: 'utf-8' }, input: 'merged' },
  ]);

  it('推导值种类、合并组类型与取出元素的类型', () => {
    expect(staticTypeOf(document, 'bytes')).toBe('byte');
    expect(staticTypeOf(document, 'merged')).toBe('byte');
    expect(staticTypeOf(document, 'list')).toBe('list');
    expect(staticTypeOf(document, 'fromBytes')).toBe('int');
    expect(staticTypeOf(document, 'fromText')).toBe('string');
    expect(staticTypeOf(document, 'fromList')).toBe('any');
    expect(staticTypeOf(document, 'toText')).toBe('string');
  });

  it('字典取出的值是「未知类型」，等求值后再判断', () => {
    const dictDoc = docOf([
      valueNode('n', intLiteral(1)),
      { kind: 'dict', id: 'd', entries: [{ key: { kind: 'int', value: '1' }, value: 'n' }] },
      { kind: 'lookup', id: 'got', target: 'd', key: 'n' },
    ]);
    expect(staticTypeOf(dictDoc, 'got')).toBe('any');
  });

  it('组合的默认模式按成员类型推导', () => {
    expect(suggestGroupMode(['byte'])).toBe('merge');
  });
});

describe('存档形状（§8）', () => {
  it('空画布可以解析，且没有任何节点与连线', () => {
    const parsed = parseCanvasDocument(emptyCanvasDocument());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.nodes).toEqual([]);
    expect(inputIdsOf({ kind: 'value', id: 'x', value: { kind: 'int', value: '1' } })).toEqual([]);
  });

  it('一份包含全部节点种类的文档可以解析', () => {
    const document = docOf([
      valueNode('a', hexBytes('41')),
      valueNode('n', intLiteral(1)),
      valueNode('text', textLiteral('abc')),
      { kind: 'group', id: 'g', mode: 'list', rows: [['a'], ['text']] },
      { kind: 'dict', id: 'd', entries: [{ key: { kind: 'string', value: 'k' }, value: 'n' }] },
      { kind: 'relation', id: 'r', op: 'int.add', left: 'n', right: 'n' },
      { kind: 'unary', id: 'u', op: 'length', operand: 'g' },
      { kind: 'index', id: 'i', target: 'g', index: 'n' },
      { kind: 'lookup', id: 'l', target: 'd', key: 'text' },
      { kind: 'slice', id: 's', target: 'text' },
      { kind: 'repeat', id: 'rep', target: 'text', count: 'n' },
      { kind: 'convert', id: 'c', spec: { kind: 'int-to-bytes', width: 2, endian: 'big', signed: true }, input: 'n' },
    ]);
    const parsed = parseCanvasDocument(JSON.parse(JSON.stringify(document)));
    expect(parsed.ok).toBe(true);
  });

  it('旧版存档明确判为不兼容，而不是「格式不对」', () => {
    const parsed = parseCanvasDocument({ format: 'pwn2block.workflow', version: 1, nodes: [] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('legacy');
    expect(parsed.message).toContain('旧版');
  });

  it('版本不符与未知格式各自有明确原因', () => {
    const version = parseCanvasDocument({ ...emptyCanvasDocument(), version: 1 });
    expect(version.ok).toBe(false);
    if (!version.ok) expect(version.reason).toBe('version');

    const format = parseCanvasDocument({ ...emptyCanvasDocument(), format: 'other' });
    expect(format.ok).toBe(false);
    if (!format.ok) expect(format.reason).toBe('format');
  });

  it('形状问题给出出错路径', () => {
    const parsed = parseCanvasDocument({
      ...emptyCanvasDocument(),
      nodes: [{ id: 'a', kind: 'value', value: { kind: 'int', value: '007' } }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid');
    expect(parsed.message).toContain('nodes.0');
  });

  it('未知字段被拒绝，避免手改存档塞进无意义内容', () => {
    const parsed = parseCanvasDocument({ ...emptyCanvasDocument(), extra: true });
    expect(parsed.ok).toBe(false);
  });

  it('转换参数不在目录里时不通过', () => {
    const parsed = parseCanvasDocument({
      ...emptyCanvasDocument(),
      nodes: [
        { id: 'a', kind: 'value', value: { kind: 'int', value: '1' } },
        { id: 'c', kind: 'convert', spec: { kind: 'int-to-bytes', width: 3, endian: 'big', signed: true }, input: 'a' },
      ],
    });
    expect(parsed.ok).toBe(false);
  });
});
