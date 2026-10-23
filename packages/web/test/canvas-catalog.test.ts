import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import {
  CANVAS_CATALOG,
  CANVAS_CATEGORY_LABELS,
  VALUE_KIND_OPTIONS,
  convertLabelOf,
  createMethodNode,
  createNode,
  declLabelOf,
  defaultEncodedValue,
  methodArgZeroValue,
  portValueOf,
  portsOf,
  relationLabelOf,
  specOf,
} from '../src/canvas/catalog';

/**
 * 节点目录的验收（需求 §2.2、§4、§5）。
 *
 * 目录是纯数据，所以只咬三件事：**齐全**（18 种一个不落、`specOf` 拿回同一份对象）、
 * **能存档**（每种默认节点都过 `parseCanvasDocument`）、**与共享语义对得上**（端口就是
 * `inputRefsOf` 那一条，类型来自 operators/conversions，运算名与转换名不另写文案）。
 */

/** 造节点时用的 id：形状合法，也方便断言原样保留。 */
const NODE_ID = 'n1';

/** 一份只装着这些节点的文档，其余字段取空画布。 */
function documentWith(nodes: readonly canvas.CanvasNode[], main: readonly string[] = []): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes, main };
}

/** 解析一份本该合法的文档：失败时把原因带进断言消息，避免只看一个 `false`。 */
function parseOrFail(document: canvas.CanvasDocument): canvas.CanvasDocument {
  const parsed = canvas.parseCanvasDocument(document);
  if (!parsed.ok) throw new Error(`默认节点没能过 schema：${parsed.message}`);
  return parsed.document;
}

/** 已接线的端口取值序列（未接线是 `undefined`，会被滤掉）。 */
function wiredIdsOf(node: canvas.CanvasNode): readonly string[] {
  return portsOf(node)
    .map((port) => portValueOf(node, port.name))
    .filter((id): id is string => id !== undefined);
}

/** 覆盖全部 12 种转换的样例，用来对拍端口类型与中文名，不另抄一份目录。 */
const CONVERSIONS: readonly canvas.ConversionSpec[] = [
  { kind: 'text-to-bytes', encoding: 'utf-8' },
  { kind: 'bytes-to-text', encoding: 'ascii' },
  { kind: 'int-to-bytes', width: 8, endian: 'big', signed: true },
  { kind: 'bytes-to-int', width: 2, endian: 'little', signed: true },
  { kind: 'int-to-double' },
  { kind: 'double-to-int', rounding: 'nearest' },
  { kind: 'int-to-text', base: 16 },
  { kind: 'text-to-int', base: 10 },
  { kind: 'double-to-text' },
  { kind: 'text-to-double' },
  { kind: 'list-to-bytes' },
  { kind: 'list-to-text' },
];

describe('目录：18 种节点齐全', () => {
  it('覆盖全部种类，且长度与 CANVAS_NODE_KINDS 相等', () => {
    expect(CANVAS_CATALOG.length).toBe(canvas.CANVAS_NODE_KINDS.length);
    expect(CANVAS_CATALOG.map((spec) => spec.kind).sort()).toEqual([...canvas.CANVAS_NODE_KINDS].sort());
  });

  it('specOf 对每种都返回目录里的同一个对象', () => {
    for (const spec of CANVAS_CATALOG) expect(specOf(spec.kind)).toBe(spec);
  });

  it('每种都有分类中文名、说明、种类级标签，侧栏字段的 key 都是节点上真有的属性', () => {
    for (const spec of CANVAS_CATALOG) {
      expect(spec.label).toBe(canvas.CANVAS_NODE_KIND_LABELS[spec.kind]);
      expect(CANVAS_CATEGORY_LABELS[spec.category]).not.toBe('');
      expect(spec.description.length).toBeGreaterThan(0);
      const node = createNode(spec.kind, NODE_ID);
      for (const field of spec.fields) expect(Object.hasOwn(node, field.key)).toBe(true);
    }
  });

  it('分类在目录里连续排列（工具箱按顺序切组不会把同一类切成两段）', () => {
    const closed = new Set<string>();
    let current = '';
    for (const spec of CANVAS_CATALOG) {
      if (spec.category === current) continue;
      expect(closed.has(spec.category)).toBe(false);
      if (current !== '') closed.add(current);
      current = spec.category;
    }
  });

  it('目录里的端口名与默认实例的端口名逐个相同', () => {
    for (const spec of CANVAS_CATALOG) {
      const node = createNode(spec.kind, NODE_ID);
      expect(spec.ports.map((port) => port.name)).toEqual(canvas.inputRefsOf(node).map((ref) => ref.name));
    }
  });
});

describe('默认节点：能过 parseCanvasDocument', () => {
  it.each(canvas.CANVAS_NODE_KINDS)('%s 的默认节点通过形状校验，id 与 kind 原样保留', (kind) => {
    const node = createNode(kind, NODE_ID);
    expect(node.id).toBe(NODE_ID);
    expect(node.kind).toBe(kind);
    const parsed = parseOrFail(documentWith([node]));
    expect(parsed.nodes.map((item) => item.id)).toEqual([NODE_ID]);
    expect(parsed.nodes.map((item) => item.kind)).toEqual([kind]);
  });

  it('字面值默认整数 0；切换种类用最小载荷，不背上一类的值', () => {
    const node = createNode('value', NODE_ID);
    expect(node).toEqual({ id: NODE_ID, kind: 'value', value: { kind: 'int', value: '0' } });
    for (const kind of canvas.SCALAR_VALUE_KINDS) {
      const encoded = defaultEncodedValue(kind);
      expect(encoded.kind).toBe(kind);
      expect(canvas.decodeScalarValue(encoded).ok).toBe(true);
    }
    expect(defaultEncodedValue('int')).toEqual({ kind: 'int', value: '0' });
  });

  it('列表与字典不是字面值：显式抛错，不静默退回整数 0', () => {
    expect(() => defaultEncodedValue('list')).toThrow();
    expect(() => defaultEncodedValue('dict')).toThrow();
  });

  it('VALUE_KIND_OPTIONS 只列标量，中文名复用共享标签', () => {
    expect(VALUE_KIND_OPTIONS.map((option) => option.value)).toEqual([...canvas.SCALAR_VALUE_KINDS]);
    for (const option of VALUE_KIND_OPTIONS) expect(option.label).toBe(canvas.VALUE_KIND_LABELS[option.value]);
  });

  it('新组合默认是空的：schema 收，语义校验报 group_empty（编辑期预期状态）', () => {
    const node = createNode('group', NODE_ID);
    if (node.kind !== 'group') throw new Error('createNode 造的不是组合节点');
    expect(node.rows).toEqual([]);
    const validation = canvas.validateCanvasDocument(parseOrFail(documentWith([node])));
    expect(validation.issues.some((issue) => issue.code === 'group_empty')).toBe(true);
  });

  it('未接线的默认关系节点：问题全是 unconnected，端口取值全是 undefined', () => {
    const node = createNode('relation', 'r1');
    expect(canvas.inputIdsOf(node)).toEqual([]);
    for (const port of portsOf(node)) expect(portValueOf(node, port.name)).toBeUndefined();

    const validation = canvas.validateCanvasDocument(parseOrFail(documentWith([node])));
    expect(validation.ok).toBe(false);
    expect([...new Set(validation.issues.map((issue) => issue.code))]).toEqual(['unconnected']);
    expect(validation.issues.every((issue) => issue.nodeId === 'r1')).toBe(true);
  });
});

describe('端口与 inputIdsOf 对齐', () => {
  it.each(canvas.CANVAS_NODE_KINDS)('%s 的已接线端口序列等于 inputIdsOf，端口名唯一且可回答', (kind) => {
    const node = createNode(kind, NODE_ID);
    expect(wiredIdsOf(node)).toEqual(canvas.inputIdsOf(node));
    const names = portsOf(node).map((port) => port.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(portValueOf(node, name)).toBeUndefined();
  });

  it('接好线的切片：顺序仍是 target → start → end → step，未接的两段不算引用', () => {
    const slice: canvas.CanvasNode = { kind: 'slice', id: 's1', target: 'a', step: 'c' };
    expect(portsOf(slice).map((port) => port.name)).toEqual(['target', 'start', 'end', 'step']);
    expect(wiredIdsOf(slice)).toEqual(['a', 'c']);
    expect(canvas.inputIdsOf(slice)).toEqual(['a', 'c']);
    expect(portValueOf(slice, 'start')).toBeUndefined();
    expect(portValueOf(slice, 'step')).toBe('c');
    expect(portsOf(slice).map((port) => port.required)).toEqual([true, false, false, false]);
  });

  it('接好线的关系与方法：端口顺序与 inputIdsOf 一致', () => {
    const relation: canvas.CanvasNode = { kind: 'relation', id: 'r1', op: 'bool.and', left: 'x', right: 'y' };
    expect(portsOf(relation).map((port) => port.name)).toEqual(['left', 'right']);
    expect(wiredIdsOf(relation)).toEqual(['x', 'y']);
    expect(canvas.inputIdsOf(relation)).toEqual(['x', 'y']);

    const method: canvas.CanvasNode = { kind: 'method', id: 'm1', block: 'emit', args: { v: 'x', buf: 'y' } };
    expect(portsOf(method).map((port) => port.name)).toEqual(['v', 'buf']);
    expect(wiredIdsOf(method)).toEqual(['x', 'y']);
    expect(canvas.inputIdsOf(method)).toEqual(['x', 'y']);
  });

  it('组合与字典的成员端口按展开顺序编号', () => {
    const group: canvas.CanvasNode = { kind: 'group', id: 'g1', mode: 'list', rows: [['a', 'b'], ['c']] };
    expect(portsOf(group).map((port) => port.name)).toEqual(['member-0', 'member-1', 'member-2']);
    expect(wiredIdsOf(group)).toEqual(['a', 'b', 'c']);

    const dict: canvas.CanvasNode = {
      kind: 'dict',
      id: 'd1',
      entries: [
        { key: { kind: 'int', value: '1' }, value: 'a' },
        { key: { kind: 'string', value: 'k' }, value: 'b' },
      ],
    };
    expect(portsOf(dict).map((port) => port.name)).toEqual(['value-0', 'value-1']);
    expect(wiredIdsOf(dict)).toEqual(['a', 'b']);
  });
});

describe('portValueOf', () => {
  it('接好线返回节点 id，没接线与未知端口返回 undefined', () => {
    const relation: canvas.CanvasNode = {
      kind: 'relation',
      id: 'r1',
      op: 'int.add',
      left: 'a',
      right: canvas.UNCONNECTED,
    };
    expect(portValueOf(relation, 'left')).toBe('a');
    expect(portValueOf(relation, 'right')).toBeUndefined();
    expect(portValueOf(relation, 'nope')).toBeUndefined();
    expect(portValueOf(createNode('relation', 'r2'), 'left')).toBeUndefined();
  });
});

describe('端口类型来自静态语义', () => {
  it('关系的左右类型与结果类型都读 BINARY_OPERATORS 的 spec', () => {
    for (const op of canvas.BINARY_OPERATORS) {
      const spec = canvas.binaryOperatorSpec(op);
      const relation: canvas.CanvasNode = { kind: 'relation', id: 'r1', op, left: 'a', right: 'b' };
      expect(portsOf(relation).map((port) => port.accepts)).toEqual([[spec.left], [spec.right]]);
      expect(canvas.staticTypeOf(documentWith([relation]), 'r1')).toBe(spec.result);
    }
  });

  it('int.add / bool.and 两端类型，int.eq 的结果是布尔', () => {
    const relationOf = (op: canvas.BinaryOperator): canvas.CanvasNode => ({
      kind: 'relation', id: 'r1', op, left: 'a', right: 'b',
    });
    expect(portsOf(relationOf('int.add')).map((port) => port.accepts)).toEqual([['int'], ['int']]);
    expect(portsOf(relationOf('bool.and')).map((port) => port.accepts)).toEqual([['bool'], ['bool']]);
    expect(portsOf(relationOf('int.eq')).map((port) => port.accepts)).toEqual([['int'], ['int']]);
    expect(canvas.binaryOperatorSpec('int.eq').result).toBe(canvas.staticTypeOf(documentWith([relationOf('int.eq')]), 'r1'));
  });

  it('一元运算的接受类型读 UNARY_OPERATORS 的 spec', () => {
    for (const op of canvas.UNARY_OPERATORS) {
      const unary: canvas.CanvasNode = { kind: 'unary', id: 'u1', op, operand: 'a' };
      expect(portsOf(unary).map((port) => port.accepts)).toEqual([canvas.unaryOperatorSpec(op).accepts]);
    }
  });

  it('下标、切片、重复：目标只吃三种序列，索引类端口是整数', () => {
    const index: canvas.CanvasNode = { kind: 'index', id: 'i1', target: 'a', index: 'b' };
    expect(portsOf(index).map((port) => port.accepts)).toEqual([['byte', 'string', 'list'], ['int']]);

    const slice: canvas.CanvasNode = { kind: 'slice', id: 's1', target: 'a', start: 'b', end: 'c', step: 'd' };
    expect(portsOf(slice).map((port) => port.accepts)).toEqual([
      ['byte', 'string', 'list'],
      ['int'],
      ['int'],
      ['int'],
    ]);

    const repeat: canvas.CanvasNode = { kind: 'repeat', id: 'p1', target: 'a', count: 'b' };
    expect(portsOf(repeat).map((port) => port.accepts)).toEqual([['byte', 'string', 'list'], ['int']]);
  });

  it('按键取值的键不限类型；条件是布尔，循环次数是整数', () => {
    const lookup: canvas.CanvasNode = { kind: 'lookup', id: 'l1', target: 'a', key: 'b' };
    expect(portsOf(lookup).map((port) => port.accepts)).toEqual([['dict'], 'any']);
    const branch: canvas.CanvasNode = { kind: 'if', id: 'f1', cond: 'a', then: [], else: [] };
    expect(portsOf(branch).map((port) => port.accepts)).toEqual([['bool']]);
    const loop: canvas.CanvasNode = { kind: 'loop', id: 'w1', count: 'b', body: [] };
    expect(portsOf(loop).map((port) => port.accepts)).toEqual([['int']]);
  });
});

describe('端口类型：转换', () => {
  it('每种转换的输入类型都来自 conversionInputKind', () => {
    expect(CONVERSIONS.map((spec) => spec.kind).sort()).toEqual(Object.keys(canvas.CONVERSION_LABELS).sort());
    for (const spec of CONVERSIONS) {
      const convert: canvas.CanvasNode = { kind: 'convert', id: 'c1', spec, input: 'a' };
      expect(portsOf(convert).map((port) => port.accepts)).toEqual([[canvas.conversionInputKind(spec)]]);
    }
  });

  it('int-to-bytes 要整数，list-to-bytes 要列表', () => {
    const intToBytes: canvas.CanvasNode = {
      kind: 'convert',
      id: 'c1',
      spec: { kind: 'int-to-bytes', width: 4, endian: 'little', signed: false },
      input: 'a',
    };
    expect(portsOf(intToBytes).map((port) => port.accepts)).toEqual([['int']]);
    const listToBytes: canvas.CanvasNode = { kind: 'convert', id: 'c2', spec: { kind: 'list-to-bytes' }, input: 'a' };
    expect(portsOf(listToBytes).map((port) => port.accepts)).toEqual([['list']]);
  });
});

describe('端口类型：变量', () => {
  it('未初始化的声明没有绑定端口，接上初始化后端口类型就是声明类型', () => {
    const none: canvas.CanvasNode = { kind: 'var-decl', id: 'd1', name: 'a', type: 'byte', binding: { mode: 'none' } };
    expect(portsOf(none)).toEqual([]);

    const initial: canvas.CanvasNode = { kind: 'var-decl', id: 'd2', name: 'b', type: 'byte', binding: { mode: 'initial', input: 'x' } };
    expect(portsOf(initial).map((port) => port.name)).toEqual(['input']);
    expect(portsOf(initial).map((port) => port.accepts)).toEqual([['byte']]);
    expect(portValueOf(initial, 'input')).toBe('x');

    const derived: canvas.CanvasNode = { kind: 'var-decl', id: 'd3', name: 'c', type: 'string', binding: { mode: 'derived', input: 'y' } };
    expect(portsOf(derived).map((port) => port.accepts)).toEqual([['string']]);
    expect(portsOf(derived).map((port) => port.label)).not.toEqual(portsOf(initial).map((port) => port.label));
  });

  it('流程赋值的右值按目标声明取类型；拿不到声明时是 any', () => {
    const decl: canvas.CanvasNode = { kind: 'var-decl', id: 'd1', name: 'a', type: 'string', binding: { mode: 'none' } };
    const ref: canvas.CanvasNode = { kind: 'var-ref', id: 'r1', decl: 'd1' };
    const assign: canvas.CanvasNode = { kind: 'assign', id: 'a1', target: 'd1', value: 'x' };
    const document = documentWith([decl, ref, assign]);

    expect(portsOf(assign, document).map((port) => port.accepts)).toEqual([['string']]);
    // 目标写引用视图也一样解析到同一声明。
    const viaRef: canvas.CanvasNode = { kind: 'assign', id: 'a2', target: 'r1', value: 'x' };
    expect(portsOf(viaRef, documentWith([decl, ref, viaRef])).map((port) => port.accepts)).toEqual([['string']]);
    // 没有文档、目标悬空、目标不是变量：都退化成「不限类型」，端口照样画。
    expect(portsOf(assign).map((port) => port.accepts)).toEqual(['any']);
    expect(portsOf({ ...assign, target: 'missing' }, document).map((port) => port.accepts)).toEqual(['any']);
    expect(portsOf({ ...assign, target: 'r1' }, documentWith([ref, assign])).map((port) => port.accepts)).toEqual(['any']);
  });

  it('declLabelOf 解析声明与引用视图，其他节点返回 undefined', () => {
    const decl: canvas.CanvasNode = { kind: 'var-decl', id: 'd1', name: '槽位 a', type: 'int', binding: { mode: 'none' } };
    const ref: canvas.CanvasNode = { kind: 'var-ref', id: 'r1', decl: 'd1' };
    const document = documentWith([decl, ref]);
    expect(declLabelOf(document, 'd1')).toBe('槽位 a');
    expect(declLabelOf(document, 'r1')).toBe('槽位 a');
    expect(declLabelOf(document, 'missing')).toBeUndefined();
  });
});

describe('方法节点', () => {
  /** 题目声明的一个方法：整数参数 `v` 与字节串参数 `buf`。 */
  const EMIT: AuthorBlock = {
    id: 'emit',
    label: 'emit(v, buf)',
    params: [
      { name: 'v', type: 'int' },
      { name: 'buf', type: 'bytes' },
    ],
    expand: [{ type: 'push', value: '$v' }],
  };

  it('createMethodNode 按参数生成 args，每个参数都有同名端口', () => {
    const node = createMethodNode('m1', EMIT);
    if (node.kind !== 'method') throw new Error('createMethodNode 造的不是方法节点');
    expect(node.block).toBe('emit');
    expect(Object.keys(node.args)).toEqual(['v', 'buf']);
    expect(portsOf(node).map((port) => port.name)).toEqual(['v', 'buf']);
    parseOrFail(documentWith([node]));
  });

  it('参数默认未接线：零值字面量得由调用方另造 value 节点接上', () => {
    const node = createMethodNode('m1', EMIT);
    if (node.kind !== 'method') throw new Error('createMethodNode 造的不是方法节点');
    expect(node.args).toEqual({ v: canvas.UNCONNECTED, buf: canvas.UNCONNECTED });
    expect(portValueOf(node, 'v')).toBeUndefined();
    expect(methodArgZeroValue('bytes')).toEqual({ kind: 'byte', hex: '' });
    expect(methodArgZeroValue('int')).toEqual({ kind: 'int', value: '0' });
    expect(methodArgZeroValue('addr')).toEqual({ kind: 'int', value: '0' });
  });

  it('默认方法节点没有方法标识也没有参数，端口为空', () => {
    const node = createNode('method', 'm1');
    if (node.kind !== 'method') throw new Error('createNode 造的不是方法节点');
    expect(node.block).toBe(canvas.UNCONNECTED);
    expect(node.args).toEqual({});
    expect(portsOf(node)).toEqual([]);
    expect(specOf('method').ports).toEqual([]);
  });
});

describe('中文名复用运算与转换目录', () => {
  it('relationLabelOf 与 BINARY_OPERATOR_SPECS 的 label 一致', () => {
    for (const op of canvas.BINARY_OPERATORS) expect(relationLabelOf(op)).toBe(canvas.binaryOperatorSpec(op).label);
  });

  it('未知运算给可读的兜底文案，不抛也不吞', () => {
    expect(relationLabelOf('nope.nope')).toContain('nope.nope');
  });

  it('convertLabelOf 与 CONVERSION_LABELS 一致', () => {
    for (const spec of CONVERSIONS) expect(convertLabelOf(spec)).toBe(canvas.CONVERSION_LABELS[spec.kind]);
  });
});
