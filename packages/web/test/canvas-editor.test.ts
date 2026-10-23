import { describe, expect, it } from 'vitest';
import type { AuthorBlock } from '@pwn2block/shared';
import { CANVAS_MAX_VAR_NAME_CHARS, canvas } from '@pwn2block/shared';
import {
  addExistingNode,
  addNode,
  connect,
  createReference,
  createVariable,
  disconnect,
  moveLayout,
  newNodeId,
  removeNodes,
  renameVariable,
  setBinding,
  setConversion,
  setDictEntries,
  setGroupMode,
  setMethodBlock,
  setRelationOp,
  setUnaryOp,
  setValue,
} from '../src/canvas/editor';
import type { CanvasEdit } from '../src/canvas/editor';

/**
 * 编辑命令（节点 / 内容 / 变量 / 接线 / 删除 / 坐标）的验收测试。
 *
 * 断言口径：
 * - 每条命令都断言**具体节点 id 与问题码**，不比较中文文案；
 * - 命令成功后再跑一次 `validateCanvasDocument`，除「还没接线」（`unconnected`，编辑期的正常状态）
 *   以外不允许新增 error；
 * - 输入文档一律只读：命令返回新对象，旧文档与旧节点不被改动。
 */

const AT = { x: 12, y: 34 } as const;

// 局部构造器：只写测试关心的字段，坐标默认空表。

function docOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[] = [],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
): canvas.CanvasDocument {
  return { format: canvas.CANVAS_FORMAT, version: canvas.CANVAS_VERSION, nodes, layout, main };
}

function lit(id: string, value: canvas.EncodedScalarValue): canvas.CanvasNode {
  return { kind: 'value', id, value };
}

function intLit(id: string, value: number): canvas.CanvasNode {
  return lit(id, { kind: 'int', value: String(value) });
}

function textLit(id: string, value: string): canvas.CanvasNode {
  return lit(id, { kind: 'string', value });
}

function relation(id: string, op: canvas.BinaryOperator, left: string, right: string): canvas.CanvasNode {
  return { kind: 'relation', id, op, left, right };
}

function unary(id: string, op: canvas.UnaryOperator, operand: string): canvas.CanvasNode {
  return { kind: 'unary', id, op, operand };
}

function convert(id: string, spec: canvas.ConversionSpec, input: string): canvas.CanvasNode {
  return { kind: 'convert', id, spec, input };
}

function dictNode(
  id: string,
  entries: readonly { readonly key: canvas.EncodedDictKey; readonly value: string }[],
): canvas.CanvasNode {
  return { kind: 'dict', id, entries };
}

function groupNode(
  id: string,
  mode: canvas.GroupMode,
  rows: readonly (readonly string[])[],
): canvas.CanvasNode {
  return { kind: 'group', id, mode, rows };
}

function declNode(
  id: string,
  name: string,
  type: canvas.ValueKind,
  binding: canvas.VariableBinding = { mode: 'none' },
): canvas.CanvasNode {
  return { kind: 'var-decl', id, name, type, binding };
}

function refNode(id: string, decl: string): canvas.CanvasNode {
  return { kind: 'var-ref', id, decl };
}

function startNode(id = 'start'): canvas.CanvasNode {
  return { kind: 'start', id };
}

function methodNode(id: string, block: string, args: Readonly<Record<string, string>>): canvas.CanvasNode {
  return { kind: 'method', id, block, args };
}

function nodeIn(document: canvas.CanvasDocument, id: string): canvas.CanvasNode {
  const node = canvas.nodeMapOf(document).get(id);
  if (node === undefined) throw new Error(`文档里缺少节点「${id}」`);
  return node;
}

function codesOf(edit: CanvasEdit): readonly string[] {
  return edit.issues.map((issue) => issue.code);
}

function errorKeys(document: canvas.CanvasDocument): ReadonlySet<string> {
  const issues = canvas.validateCanvasDocument(document).issues;
  return new Set(issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}|${issue.nodeId}`));
}

/** 命令成功后：除「还没接线」以外不许新增 error。 */
function expectNoNewErrors(before: canvas.CanvasDocument, after: canvas.CanvasDocument): void {
  const known = errorKeys(before);
  const added = [...errorKeys(after)].filter((key) => !known.has(key) && !key.startsWith('unconnected|'));
  expect(added).toEqual([]);
}

function expectSchemaOk(document: canvas.CanvasDocument): void {
  const parsed = canvas.CanvasDocumentSchema.safeParse(document);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
}

const EMIT_V: AuthorBlock = {
  id: 'emit',
  label: 'emit(v)',
  params: [{ name: 'v', type: 'int' }],
  expand: [{ type: 'pop' }],
};

const EMIT_VW: AuthorBlock = {
  id: 'emit2',
  label: 'emit(v,w)',
  params: [
    { name: 'v', type: 'int' },
    { name: 'w', type: 'int' },
  ],
  expand: [{ type: 'pop' }],
};

describe('加节点与放置', () => {
  it.each([...canvas.CANVAS_NODE_KINDS])('加 %s 节点：能存档、有坐标、不带问题', (kind) => {
    const result = addNode(canvas.emptyCanvasDocument(), kind, 'fresh', AT);

    expect(result.issues).toEqual([]);
    expect(result.document.nodes).toHaveLength(1);
    expect(result.document.nodes[0].id).toBe('fresh');
    expect(result.document.nodes[0].kind).toBe(kind);
    expect(result.document.layout).toEqual({ fresh: { x: 12, y: 34 } });
    expectSchemaOk(result.document);
  });

  it('重复 id 被拒绝，文档原样返回', () => {
    const document = docOf([intLit('a', 1)]);
    const result = addExistingNode(document, intLit('a', 2), AT);

    expect(codesOf(result)).toEqual(['duplicate_id']);
    expect(result.document).toBe(document);
  });

  it('非法 id 被拒绝', () => {
    const document = docOf([intLit('a', 1)]);
    const result = addNode(document, 'value', 'bad id!', AT);

    expect(codesOf(result)).toEqual(['invalid_id']);
    expect(result.document).toBe(document);
  });

  it('addExistingNode：手写节点进文档并写入坐标', () => {
    const document = docOf([intLit('a', 1)]);
    const result = addExistingNode(document, textLit('t1', 'hi'), { x: -3, y: 8 });

    expect(result.issues).toEqual([]);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['a', 't1']);
    expect(result.document.layout).toEqual({ t1: { x: -3, y: 8 } });
  });
});

describe('字面值与内容', () => {
  it('setValue 换掉字面值，旧文档不被改动', () => {
    const document = docOf([lit('a', { kind: 'int', value: '1' })], [], { a: { x: 1, y: 2 } });
    const result = setValue(document, 'a', { kind: 'string', value: 'flag' });

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'a')).toEqual(lit('a', { kind: 'string', value: 'flag' }));
    expect(result.document.layout).toEqual({ a: { x: 1, y: 2 } });
    expect(nodeIn(document, 'a')).toEqual(lit('a', { kind: 'int', value: '1' }));
    expectNoNewErrors(document, result.document);
  });

  it('setValue 拒绝非法编码（前导零的整数）', () => {
    const document = docOf([intLit('a', 1)]);
    const result = setValue(document, 'a', { kind: 'int', value: '007' });

    expect(codesOf(result)).toEqual(['invalid_value']);
    expect(result.document).toBe(document);
  });

  it('setValue 拒绝非字面值节点', () => {
    const document = docOf([relation('r1', 'int.add', '', '')]);
    const result = setValue(document, 'r1', { kind: 'int', value: '1' });

    expect(codesOf(result)).toEqual(['unknown_kind']);
    expect(result.document).toBe(document);
  });

  it('setValue 拒绝不存在的节点', () => {
    const result = setValue(canvas.emptyCanvasDocument(), 'ghost', { kind: 'int', value: '1' });

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.issues[0].nodeId).toBe('ghost');
  });
});

describe('运算、转换、字典、组合模式与方法', () => {
  it('setRelationOp 换运算保留左右接线', () => {
    const document = docOf([intLit('a', 1), intLit('b', 2), relation('r1', 'int.add', 'a', 'b')]);
    const result = setRelationOp(document, 'r1', 'int.mul');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'r1')).toEqual(relation('r1', 'int.mul', 'a', 'b'));
    expectNoNewErrors(document, result.document);
  });

  it('setRelationOp 拒绝目录里没有的运算', () => {
    const document = docOf([intLit('a', 1), relation('r1', 'int.add', 'a', 'a')]);
    const result = setRelationOp(document, 'r1', 'int.pow');

    expect(codesOf(result)).toEqual(['unknown_kind']);
    expect(result.document).toBe(document);
  });

  it('setRelationOp 拒绝非关系节点', () => {
    const document = docOf([intLit('a', 1)]);
    expect(codesOf(setRelationOp(document, 'a', 'int.add'))).toEqual(['unknown_kind']);
  });

  it('setUnaryOp 换附属操作保留输入接线（类型是否匹配由校验器说）', () => {
    const document = docOf([textLit('t1', 'abc'), unary('u1', 'length', 't1')]);
    const result = setUnaryOp(document, 'u1', 'bool.not');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'u1')).toEqual(unary('u1', 'bool.not', 't1'));
    const codes = canvas.validateCanvasDocument(result.document).issues.map((issue) => issue.code);
    expect(codes).toEqual(['type_mismatch']);
  });

  it('setUnaryOp 拒绝未知的一元运算', () => {
    const document = docOf([textLit('t1', 'abc'), unary('u1', 'length', 't1')]);
    expect(codesOf(setUnaryOp(document, 'u1', 'length2'))).toEqual(['unknown_kind']);
  });

  it('setConversion 换转换保留输入接线', () => {
    const document = docOf([
      textLit('t1', 'abc'),
      convert('c1', { kind: 'text-to-bytes', encoding: 'utf-8' }, 't1'),
    ]);
    const result = setConversion(document, 'c1', { kind: 'text-to-int', base: 10 });

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'c1')).toEqual(convert('c1', { kind: 'text-to-int', base: 10 }, 't1'));
    expectNoNewErrors(document, result.document);
  });

  it('setConversion 拒绝非转换节点', () => {
    const document = docOf([intLit('a', 1)]);
    expect(codesOf(setConversion(document, 'a', { kind: 'text-to-int', base: 10 }))).toEqual(['unknown_kind']);
  });

  it('setDictEntries 按给定顺序重写条目', () => {
    const document = docOf([intLit('a', 1), textLit('t1', 'x'), dictNode('d1', [])]);
    const result = setDictEntries(document, 'd1', [
      { key: { kind: 'int', value: '1' }, value: 'a' },
      { key: { kind: 'string', value: 'k' }, value: 't1' },
    ]);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'd1')).toEqual(
      dictNode('d1', [
        { key: { kind: 'int', value: '1' }, value: 'a' },
        { key: { kind: 'string', value: 'k' }, value: 't1' },
      ]),
    );
    expectNoNewErrors(document, result.document);
  });

  it('setDictEntries 拒绝重复键（整数 1 与文本 "1" 是两个键，不算重复）', () => {
    const document = docOf([intLit('a', 1), dictNode('d1', [])]);
    const result = setDictEntries(document, 'd1', [
      { key: { kind: 'int', value: '1' }, value: 'a' },
      { key: { kind: 'int', value: '1' }, value: 'a' },
    ]);

    expect(codesOf(result)).toEqual(['dict_duplicate_key']);
    expect(result.document).toBe(document);
  });

  it('setDictEntries 拒绝指向不存在节点的条目值', () => {
    const document = docOf([dictNode('d1', [])]);
    const result = setDictEntries(document, 'd1', [{ key: { kind: 'string', value: 'k' }, value: 'ghost' }]);

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.document).toBe(document);
  });

  it('setDictEntries 拒绝坏整数键', () => {
    const document = docOf([intLit('a', 1), dictNode('d1', [])]);
    const result = setDictEntries(document, 'd1', [{ key: { kind: 'int', value: '01' }, value: 'a' }]);

    expect(codesOf(result)).toEqual(['invalid_value']);
  });

  it('setGroupMode 切换模式，成员与行列不动', () => {
    const document = docOf([
      textLit('a', 'x'),
      textLit('b', 'y'),
      groupNode('g1', 'list', [['a', 'b']]),
    ]);
    const result = setGroupMode(document, 'g1', 'merge');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a', 'b']]));
    expectNoNewErrors(document, result.document);
  });

  it('setGroupMode 拒绝非组合节点', () => {
    const document = docOf([intLit('a', 1)]);
    expect(codesOf(setGroupMode(document, 'a', 'merge'))).toEqual(['unknown_kind']);
  });

  it('setMethodBlock 按新声明重建参数表，同名接线保留、未接的填 UNCONNECTED', () => {
    const document = docOf([startNode(), intLit('n1', 1), methodNode('m1', 'emit', { v: 'n1' })], ['start', 'm1']);
    const result = setMethodBlock(document, 'm1', EMIT_VW);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'm1')).toEqual(methodNode('m1', 'emit2', { v: 'n1', w: canvas.UNCONNECTED }));
    expectNoNewErrors(document, result.document);
  });

  it('setMethodBlock 拒绝非方法节点', () => {
    const document = docOf([intLit('a', 1)]);
    expect(codesOf(setMethodBlock(document, 'a', EMIT_V))).toEqual(['unknown_kind']);
  });
});

describe('变量', () => {
  it('createVariable 建出「未初始化」的声明', () => {
    const result = createVariable(canvas.emptyCanvasDocument(), 'd1', ' count ', 'int');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'd1')).toEqual(declNode('d1', 'count', 'int'));
    expectNoNewErrors(canvas.emptyCanvasDocument(), result.document);
  });

  it('createVariable 拒绝空名字', () => {
    const result = createVariable(canvas.emptyCanvasDocument(), 'd1', '   ', 'int');

    expect(codesOf(result)).toEqual(['variable_error']);
    expect(result.document.nodes).toEqual([]);
  });

  it('createVariable 拒绝超长名字', () => {
    const result = createVariable(canvas.emptyCanvasDocument(), 'd1', 'a'.repeat(CANVAS_MAX_VAR_NAME_CHARS + 1), 'int');

    expect(codesOf(result)).toEqual(['variable_error']);
    expect(result.document.nodes).toEqual([]);
  });

  it('createVariable 拒绝重名（去空白后判重）', () => {
    const document = docOf([declNode('d1', 'count', 'int')]);
    const result = createVariable(document, 'd2', ' count ', 'int');

    expect(codesOf(result)).toEqual(['variable_error']);
    expect(result.document).toBe(document);
  });

  it('createVariable 拒绝重复 id', () => {
    const document = docOf([declNode('d1', 'count', 'int')]);
    expect(codesOf(createVariable(document, 'd1', 'other', 'int'))).toEqual(['duplicate_id']);
  });

  it('renameVariable 改名后引用视图仍指向同一份声明', () => {
    const document = docOf([declNode('d1', 'a', 'int'), refNode('r1', 'd1')]);
    const result = renameVariable(document, 'd1', ' total ');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'd1')).toEqual(declNode('d1', 'total', 'int'));
    expect(nodeIn(result.document, 'r1')).toEqual(refNode('r1', 'd1'));
    expectNoNewErrors(document, result.document);
  });

  it('renameVariable 拒绝与别的声明重名', () => {
    const document = docOf([declNode('d1', 'a', 'int'), declNode('d2', 'b', 'int')]);
    const result = renameVariable(document, 'd2', 'a');

    expect(codesOf(result)).toEqual(['variable_error']);
    expect(result.document).toBe(document);
  });

  it('setBinding 设初始值', () => {
    const document = docOf([intLit('n1', 1), declNode('d1', 'a', 'int')]);
    const result = setBinding(document, 'd1', { mode: 'initial', input: 'n1' });

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'd1')).toEqual(declNode('d1', 'a', 'int', { mode: 'initial', input: 'n1' }));
    expectNoNewErrors(document, result.document);
  });

  it('setBinding 允许解绑成 none', () => {
    const document = docOf([intLit('n1', 1), declNode('d1', 'a', 'int', { mode: 'derived', input: 'n1' })]);
    const result = setBinding(document, 'd1', { mode: 'none' });

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'd1')).toEqual(declNode('d1', 'a', 'int'));
    expectNoNewErrors(document, result.document);
  });

  it('setBinding 拒绝指向不存在节点的绑定表达式', () => {
    const document = docOf([declNode('d1', 'a', 'int')]);
    const result = setBinding(document, 'd1', { mode: 'derived', input: 'ghost' });

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.document).toBe(document);
  });

  it('createReference 摆出一个指向声明的新引用视图', () => {
    const document = docOf([declNode('d1', 'a', 'int')]);
    const result = createReference(document, 'd1', 'r1', AT);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'r1')).toEqual(refNode('r1', 'd1'));
    expect(result.document.layout).toEqual({ r1: { x: 12, y: 34 } });
    expectNoNewErrors(document, result.document);
  });

  it('createReference 拒绝指向非声明', () => {
    const document = docOf([intLit('a', 1)]);
    expect(codesOf(createReference(document, 'a', 'r1', AT))).toEqual(['variable_error']);
  });
});

describe('接线', () => {
  it('connect 接上左侧输入', () => {
    const document = docOf([intLit('a', 1), relation('r1', 'int.add', '', '')]);
    const result = connect(document, 'r1', 'left', 'a');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'r1')).toEqual(relation('r1', 'int.add', 'a', ''));
    expectNoNewErrors(document, result.document);
  });

  it('connect 拒绝类型不匹配', () => {
    const document = docOf([textLit('t1', 'x'), relation('r1', 'int.add', '', '')]);
    const result = connect(document, 'r1', 'left', 't1');

    expect(codesOf(result)).toEqual(['type_mismatch']);
    expect(result.issues[0].nodeId).toBe('r1');
    expect(result.document).toBe(document);
  });

  it('connect 拒绝成环', () => {
    const document = docOf([
      intLit('a', 1),
      intLit('b', 2),
      relation('r1', 'int.add', 'a', 'b'),
      relation('r2', 'int.add', 'r1', 'a'),
    ]);
    const result = connect(document, 'r1', 'left', 'r2');

    expect(codesOf(result)).toEqual(['input_cycle']);
    expect(result.document).toBe(document);
  });

  it('connect 拒绝不存在的端口', () => {
    const document = docOf([intLit('a', 1), relation('r1', 'int.add', '', '')]);
    const result = connect(document, 'r1', 'middle', 'a');

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.issues[0].nodeId).toBe('r1');
  });

  it('connect 拒绝不存在的目标节点', () => {
    const document = docOf([intLit('a', 1)]);
    const result = connect(document, 'ghost', 'left', 'a');

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.issues[0].nodeId).toBe('ghost');
  });

  it('connect 拒绝流程节点当来源', () => {
    const document = docOf([startNode(), relation('r1', 'int.add', '', '')]);
    const result = connect(document, 'r1', 'left', 'start');

    expect(codesOf(result)).toEqual(['type_mismatch']);
  });

  it('connect 替换端口上已有的线（一个端口只接一条）', () => {
    const document = docOf([intLit('a', 1), intLit('b', 2), relation('r1', 'int.add', 'a', '')]);
    const result = connect(document, 'r1', 'left', 'b');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'r1')).toEqual(relation('r1', 'int.add', 'b', ''));
  });

  it('disconnect 把必填端口写回 UNCONNECTED，另一侧不动', () => {
    const document = docOf([intLit('a', 1), intLit('b', 2), relation('r1', 'int.add', 'a', 'b')]);
    const result = disconnect(document, 'r1', 'left');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'r1')).toEqual(relation('r1', 'int.add', canvas.UNCONNECTED, 'b'));
    expectNoNewErrors(document, result.document);
  });

  it('disconnect 对本来没接线的端口是无操作', () => {
    const document = docOf([relation('r1', 'int.add', '', '')]);
    expect(disconnect(document, 'r1', 'left').document).toBe(document);
  });

  it('disconnect 拒绝不存在的端口', () => {
    const document = docOf([relation('r1', 'int.add', '', '')]);
    expect(codesOf(disconnect(document, 'r1', 'middle'))).toEqual(['unknown_node']);
  });

  it('connect 拒绝结构端口：字典的值由 setDictEntries 改', () => {
    const document = docOf([
      textLit('a', 'x'),
      textLit('b', 'y'),
      dictNode('d1', [{ key: { kind: 'string', value: 'k' }, value: 'a' }]),
    ]);
    const result = connect(document, 'd1', 'value-0', 'b');

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.document).toBe(document);
  });

  it('disconnect 拒绝结构端口：变量绑定由 setBinding 改', () => {
    const document = docOf([intLit('n1', 1), declNode('d1', 'a', 'int', { mode: 'initial', input: 'n1' })]);
    const result = disconnect(document, 'd1', 'input');

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.document).toBe(document);
  });
});

describe('连带删除', () => {
  it('删 a 会把引用它的 b、c 一起删掉，removed 按删除顺序', () => {
    const document = docOf([
      intLit('a', 1),
      relation('b', 'int.add', 'a', 'a'),
      relation('c', 'int.add', 'b', 'a'),
    ]);
    const result = removeNodes(document, ['a']);

    expect(result.removed).toEqual(['a', 'b', 'c']);
    expect(result.document.nodes).toEqual([]);
    expect(result.document.layout).toEqual({});
  });

  it('删一个成员只让包络收缩，不删整个组合', () => {
    const document = docOf(
      [textLit('a', 'x'), textLit('b', 'y'), groupNode('g1', 'merge', [['a', 'b']])],
      [],
      { g1: { x: 5, y: 5 } },
    );
    const result = removeNodes(document, ['a']);

    expect(result.removed).toEqual(['a']);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['b']]));
    expect(result.document.layout).toEqual({ g1: { x: 5, y: 5 } });
  });

  it('成员被删光的包络一起删掉，removed 里包含组合 id', () => {
    const document = docOf(
      [textLit('a', 'x'), textLit('b', 'y'), groupNode('g1', 'merge', [['a', 'b']])],
      [],
      { g1: { x: 5, y: 5 }, a: { x: 0, y: 0 } },
    );
    const result = removeNodes(document, ['a', 'b']);

    expect(result.removed).toEqual(['a', 'b', 'g1']);
    expect(result.document.nodes).toEqual([]);
    expect(result.document.layout).toEqual({});
  });

  it('从 main 序列里移除已删节点', () => {
    const document = docOf(
      [startNode(), methodNode('m1', 'emit', {}), methodNode('m2', 'emit', {})],
      ['start', 'm1', 'm2'],
    );
    const result = removeNodes(document, ['m1']);

    expect(result.removed).toEqual(['m1']);
    expect(result.document.main).toEqual(['start', 'm2']);
  });

  it('删变量声明会连带删掉指向它的引用视图', () => {
    const document = docOf([declNode('d1', 'count', 'int'), refNode('r1', 'd1')]);

    expect(removeNodes(document, ['d1']).removed).toEqual(['d1', 'r1']);
  });

  it('删不存在的 id：什么都不做，文档原样返回', () => {
    const document = docOf([intLit('a', 1)]);
    const result = removeNodes(document, ['ghost']);

    expect(result.removed).toEqual([]);
    expect(result.document).toBe(document);
  });

  it('删容器会连带删掉它区域里的语句，不留孤儿流程节点', () => {
    const document = docOf(
      [
        startNode(),
        { kind: 'if', id: 'if1', cond: 'b1', then: ['m1'], else: [] },
        { kind: 'value', id: 'b1', value: { kind: 'bool', value: true } },
        methodNode('m1', 'emit', {}),
      ],
      ['start', 'if1'],
    );
    const result = removeNodes(document, ['if1']);

    expect(result.removed).toEqual(['if1', 'm1']);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['start', 'b1']);
  });
});

describe('坐标', () => {
  it('moveLayout 只改坐标：节点、序列、语义都不动', () => {
    const document = docOf([intLit('a', 1)]);
    const moved = moveLayout(document, [{ id: 'a', x: 30, y: 40 }]);

    expect(moved.layout).toEqual({ a: { x: 30, y: 40 } });
    expect(moved.nodes).toBe(document.nodes);
    expect(moved.main).toBe(document.main);
    expectNoNewErrors(document, moved);
  });

  it('moveLayout 忽略文档里没有的 id', () => {
    const document = docOf([intLit('a', 1)], [], { a: { x: 1, y: 1 } });
    expect(moveLayout(document, [{ id: 'ghost', x: 9, y: 9 }])).toBe(document);
  });

  it('newNodeId 跳过已占用的编号', () => {
    const document = docOf([intLit('n1', 1), intLit('n2', 2)]);

    expect(newNodeId(document, 'n')).toBe('n3');
    expect(newNodeId(canvas.emptyCanvasDocument(), 'n')).toBe('n1');
  });
});
