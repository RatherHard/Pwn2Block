import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_GROUP_ROWS, CANVAS_MAX_NODES, CANVAS_MAX_TEXT_CHARS } from '../limits';
import { CANVAS_FORMAT, CANVAS_VERSION, emptyCanvasDocument, type CanvasDocument } from './document';
import { parseCanvasDocument, type ParseCanvasResult } from './schema';

/**
 * 新版画布存档 Schema 的契约测试（需求 §8）。
 *
 * 断言尽量精确：这些形状同时被界面、求值和存档读写共用，改动必须让测试失败，
 * 而不是被"大概能读"的模糊断言放过。
 */

type Loose = Record<string, unknown>;

function documentOf(nodes: readonly unknown[], patch: Loose = {}): Loose {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main: [], ...patch };
}

/** 一份只包含 `convert` 节点的文档：源节点在 0 号，转换节点在 1 号，报错路径稳定。 */
function convertDocument(spec: unknown): Loose {
  return documentOf([
    { id: 'n_src', kind: 'value', value: { kind: 'string', value: 'x' } },
    { id: 'n_conv', kind: 'convert', spec, input: 'n_src' },
  ]);
}

function parsedOrThrow(raw: unknown): CanvasDocument {
  const result = parseCanvasDocument(raw);
  if (!result.ok) throw new Error(`期望解析成功，实际是 ${result.reason}：${result.message}`);
  return result.document;
}

function failureOf(raw: unknown): Extract<ParseCanvasResult, { readonly ok: false }> {
  const result = parseCanvasDocument(raw);
  if (result.ok) throw new Error('期望解析失败，实际通过了形状校验');
  return result;
}

/** 形状错误必须带上出错路径，否则一份大存档只说"格式不对"等于没说。 */
function expectInvalidAt(raw: unknown, path: string): void {
  const failure = failureOf(raw);
  expect(failure.reason).toBe('invalid');
  expect(failure.message).toContain(`（${path}）`);
}

/** 十种节点各至少一个；`convert` 出现两次，覆盖"三种参数"与"一种参数"两种组合。 */
function fullDocumentNodes(): Loose[] {
  return [
    { id: 'n_str', kind: 'value', value: { kind: 'string', value: 'hello' } },
    { id: 'n_byte', kind: 'value', value: { kind: 'byte', hex: '414243' } },
    { id: 'n_int', kind: 'value', value: { kind: 'int', value: '257' } },
    { id: 'n_double', kind: 'value', value: { kind: 'double', value: 1.5 } },
    { id: 'n_bool', kind: 'value', value: { kind: 'bool', value: true } },
    { id: 'n_group', kind: 'group', mode: 'list', rows: [['n_int', 'n_double'], ['n_bool']] },
    {
      id: 'n_dict',
      kind: 'dict',
      entries: [
        { key: { kind: 'string', value: 'a' }, value: 'n_int' },
        { key: { kind: 'int', value: '1' }, value: 'n_bool' },
      ],
    },
    { id: 'n_relation', kind: 'relation', op: 'int.add', left: 'n_int', right: 'n_int' },
    { id: 'n_unary', kind: 'unary', op: 'length', operand: 'n_str' },
    { id: 'n_index', kind: 'index', target: 'n_group', index: 'n_int' },
    { id: 'n_lookup', kind: 'lookup', target: 'n_dict', key: 'n_str' },
    { id: 'n_slice', kind: 'slice', target: 'n_str', start: 'n_int', end: 'n_int', step: 'n_int' },
    { id: 'n_slice_bare', kind: 'slice', target: 'n_str' },
    { id: 'n_repeat', kind: 'repeat', target: 'n_str', count: 'n_int' },
    {
      id: 'n_conv_bytes',
      kind: 'convert',
      spec: { kind: 'int-to-bytes', width: 2, endian: 'big', signed: false },
      input: 'n_int',
    },
    {
      id: 'n_conv_round',
      kind: 'convert',
      spec: { kind: 'double-to-int', rounding: 'trunc' },
      input: 'n_double',
    },
  ];
}

describe('空画布', () => {
  it('emptyCanvasDocument() 能存档、能恢复', () => {
    const empty = emptyCanvasDocument();
    expect(parsedOrThrow(empty)).toEqual(empty);
  });
});

describe('合法文档', () => {
  it('接受包含全部十种节点与两种转换参数的文档', () => {
    const raw = documentOf(fullDocumentNodes(), {
      layout: { n_str: { x: 10, y: -20 } },
      main: ['n_repeat'],
    });
    const document = parsedOrThrow(raw);
    expect(document.nodes).toHaveLength(16);
    expect(new Set(document.nodes.map((node) => node.kind)).size).toBe(10);
    expect(document.layout).toEqual({ n_str: { x: 10, y: -20 } });
    expect(document.main).toEqual(['n_repeat']);
    expect(document.nodes.find((node) => node.id === 'n_conv_bytes')).toMatchObject({
      kind: 'convert',
      spec: { kind: 'int-to-bytes', width: 2, endian: 'big', signed: false },
    });
  });

  it('slice 省略三个边界是合法的（省略即默认）', () => {
    const document = parsedOrThrow(documentOf([{ id: 'n_slice', kind: 'slice', target: 'n_str' }]));
    const node = document.nodes[0];
    expect(node).toMatchObject({ kind: 'slice', target: 'n_str' });
    expect(node !== undefined && 'start' in node).toBe(false);
    expect(node !== undefined && 'end' in node).toBe(false);
    expect(node !== undefined && 'step' in node).toBe(false);
  });

  it('缺省 layout 与 main 时补成空集合，不当成坏存档', () => {
    const document = parsedOrThrow({ format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes: [] });
    expect(document.layout).toEqual({});
    expect(document.main).toEqual([]);
  });

  it('引用字段只查 id 形状：目标不存在也不算存档坏', () => {
    const document = parsedOrThrow(
      documentOf([{ id: 'n_relation', kind: 'relation', op: 'int.mul', left: 'ghost_a', right: 'ghost_b' }]),
    );
    expect(document.nodes).toHaveLength(1);
  });

  it('layout 允许已删除节点的残留条目', () => {
    const document = parsedOrThrow(
      documentOf([{ id: 'n_bool', kind: 'value', value: { kind: 'bool', value: false } }], {
        layout: { deleted_node: { x: 0, y: 0 } },
      }),
    );
    expect(document.layout).toEqual({ deleted_node: { x: 0, y: 0 } });
  });
});

describe('格式与版本', () => {
  it('旧版画布存档（pwn2block.workflow）明确判为不兼容', () => {
    const failure = failureOf({
      format: 'pwn2block.workflow',
      version: 1,
      nodes: [],
      connections: [],
      main: [],
      layout: {},
    });
    expect(failure.reason).toBe('legacy');
    expect(failure.message).toContain('pwn2block.workflow');
    expect(failure.message).toContain('不兼容');
  });

  it('版本 1 → version，文案里两个版本号都在', () => {
    const failure = failureOf(documentOf([], { version: 1 }));
    expect(failure.reason).toBe('version');
    expect(failure.message).toContain('1');
    expect(failure.message).toContain(String(CANVAS_VERSION));
  });

  it('未知 format → format', () => {
    const failure = failureOf(documentOf([], { format: 'pwn2block.whatever' }));
    expect(failure.reason).toBe('format');
    expect(failure.message).toContain('pwn2block.whatever');
  });
});

describe('形状错误', () => {
  it('缺少 nodes → invalid，路径指向 nodes', () => {
    expectInvalidAt({ format: CANVAS_FORMAT, version: CANVAS_VERSION, layout: {}, main: [] }, 'nodes');
  });

  it('节点上多出未知字段 → invalid，严格对象直接拒绝', () => {
    expectInvalidAt(
      documentOf([{ id: 'n_bool', kind: 'value', value: { kind: 'bool', value: true }, mystery: 1 }]),
      'nodes.0',
    );
  });

  it('文档根上多出未知字段 → invalid', () => {
    const failure = failureOf(documentOf([], { mystery: 1 }));
    expect(failure.reason).toBe('invalid');
  });

  it('节点 kind 非法 → invalid，路径指向 kind', () => {
    expectInvalidAt(documentOf([{ id: 'n_x', kind: 'widget' }]), 'nodes.0.kind');
  });

  it('节点 id 非法 → invalid，路径指向 id', () => {
    expectInvalidAt(
      documentOf([{ id: 'bad id!', kind: 'value', value: { kind: 'bool', value: true } }]),
      'nodes.0.id',
    );
  });

  it('组合的 rows 超过上限 → invalid，路径指向 rows', () => {
    const rows = Array.from({ length: CANVAS_MAX_GROUP_ROWS + 1 }, () => ['n_x']);
    expectInvalidAt(documentOf([{ id: 'n_group', kind: 'group', mode: 'list', rows }]), 'nodes.0.rows');
  });

  it('节点数超过上限 → invalid', () => {
    const nodes = Array.from({ length: CANVAS_MAX_NODES + 1 }, (_item, index) => ({
      id: `n_${index}`,
      kind: 'value',
      value: { kind: 'bool', value: true },
    }));
    expectInvalidAt(documentOf(nodes), 'nodes');
  });

  it('整数带前导零 → invalid，路径指向字面值', () => {
    expectInvalidAt(
      documentOf([{ id: 'n_int', kind: 'value', value: { kind: 'int', value: '007' } }]),
      'nodes.0.value.value',
    );
  });

  it('浮点数非有限 → invalid，路径指向字面值', () => {
    expectInvalidAt(
      documentOf([{ id: 'n_double', kind: 'value', value: { kind: 'double', value: Number.POSITIVE_INFINITY } }]),
      'nodes.0.value.value',
    );
    expectInvalidAt(
      documentOf([{ id: 'n_double', kind: 'value', value: { kind: 'double', value: Number.NaN } }]),
      'nodes.0.value.value',
    );
  });

  it('字节串 hex 奇数长度 → invalid', () => {
    expectInvalidAt(
      documentOf([{ id: 'n_byte', kind: 'value', value: { kind: 'byte', hex: 'abc' } }]),
      'nodes.0.value.hex',
    );
  });

  it('文本超过 UTF-16 码元上限 → invalid', () => {
    const value = { kind: 'string', value: 'a'.repeat(CANVAS_MAX_TEXT_CHARS * 2 + 1) };
    expectInvalidAt(documentOf([{ id: 'n_str', kind: 'value', value }]), 'nodes.0.value.value');
  });

  it('值节点里塞列表 → invalid（列表只能由组合产生）', () => {
    expectInvalidAt(
      documentOf([{ id: 'n_list', kind: 'value', value: { kind: 'list', items: [] } }]),
      'nodes.0.value.kind',
    );
  });
});

/** 12 种转换各一份合法参数。 */
const VALID_SPECS: readonly (readonly [string, Loose])[] = [
  ['文本转字节串', { kind: 'text-to-bytes', encoding: 'utf-8' }],
  ['字节串转文本', { kind: 'bytes-to-text', encoding: 'ascii' }],
  ['整数转字节串', { kind: 'int-to-bytes', width: 8, endian: 'little', signed: true }],
  ['字节串转整数', { kind: 'bytes-to-int', width: 1, endian: 'big', signed: false }],
  ['整数转浮点数', { kind: 'int-to-double' }],
  ['浮点数转整数', { kind: 'double-to-int', rounding: 'nearest' }],
  ['整数转文本', { kind: 'int-to-text', base: 16 }],
  ['文本转整数', { kind: 'text-to-int', base: 10 }],
  ['浮点数转文本', { kind: 'double-to-text' }],
  ['文本转浮点数', { kind: 'text-to-double' }],
  ['列表转字节串', { kind: 'list-to-bytes' }],
  ['列表转文本', { kind: 'list-to-text' }],
];

/** 同 12 种转换各一份非法参数：参数缺失、越界或多写。 */
const INVALID_SPECS: readonly (readonly [string, Loose])[] = [
  ['文本转字节串的编码', { kind: 'text-to-bytes', encoding: 'latin-1' }],
  ['字节串转文本的编码', { kind: 'bytes-to-text', encoding: 'utf-16' }],
  ['整数转字节串的宽度', { kind: 'int-to-bytes', width: 3, endian: 'big', signed: true }],
  ['字节串转整数的端序', { kind: 'bytes-to-int', width: 4, endian: 'middle', signed: false }],
  ['整数转浮点数不该带宽度', { kind: 'int-to-double', width: 4 }],
  ['浮点数转整数的舍入', { kind: 'double-to-int', rounding: 'half' }],
  ['整数转文本的进制', { kind: 'int-to-text', base: 2 }],
  ['文本转整数的进制', { kind: 'text-to-int', base: 8 }],
  ['浮点数转文本不该带进制', { kind: 'double-to-text', base: 10 }],
  ['文本转浮点数不该带编码', { kind: 'text-to-double', encoding: 'ascii' }],
  ['列表转字节串不该带宽度', { kind: 'list-to-bytes', width: 1 }],
  ['列表转文本不该带进制', { kind: 'list-to-text', base: 10 }],
];

describe('转换规格', () => {
  it('12 种转换规格都被覆盖', () => {
    expect(new Set(VALID_SPECS.map(([, spec]) => spec.kind)).size).toBe(12);
    expect(new Set(INVALID_SPECS.map(([, spec]) => spec.kind)).size).toBe(12);
  });

  it.each(VALID_SPECS)('%s 的参数合法', (_label, spec) => {
    expect(parsedOrThrow(convertDocument(spec)).nodes).toHaveLength(2);
  });

  it.each(INVALID_SPECS)('%s 非法 → invalid，路径指向 spec', (_label, spec) => {
    const failure = failureOf(convertDocument(spec));
    expect(failure.reason).toBe('invalid');
    expect(failure.message).toContain('nodes.1.spec');
  });
});
