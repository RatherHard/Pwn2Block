import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { DEFAULT_CONVERSION } from '../src/canvas/catalog';
import { externalRefsOf, unwrapConversion, wrapInConversion } from '../src/canvas/editor';
import type { CanvasEdit, WrapConversionResult } from '../src/canvas/editor';
import { ENVELOPE_PADDING, GROUP_PADDING, inflateRect, rectOfNode, unionRects } from '../src/canvas/view-model-geometry';
import type { Rect } from '../src/canvas/view-model-types';

/**
 * 「包络为转换 / 解除转换」的验收测试（需求 §4.1、§6.3，验收表 AT-14）。
 *
 * 每条规则都钉在文档形状上，不看界面：
 * - **外部引用扫描**：数据输入（方法参数、赋值右值、变量绑定、关系/附属操作/切片的输入）算引用，
 *   组合成员是结构归属不算，未接线不算；
 * - **包络为转换**：单成员改接它自己的消费者，多成员先 `createGroup` 成组再包；
 *   外部引用内部中间结果时拒绝、文档不变、`message` 点名；
 * - **解除转换**：删转换节点、消费者改接 `input`（未接线就断开）、组合与成员原样，
 *   `layout` 只清转换自己那一格；
 * - **一次调用一个新文档**：撤销一步就能回到原样。
 */

// ---------------------------------------------------------------------------
// 文档与断言小工具
// ---------------------------------------------------------------------------

function docOf(
  nodes: readonly canvas.CanvasNode[],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes, layout };
}

function intNode(id: string): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'int', value: '1' } };
}

function byteNode(id: string): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'byte', hex: '41' } };
}

function relationNode(id: string, left: string, right: string): canvas.CanvasNode {
  return { kind: 'relation', id, op: 'int.add', left, right };
}

function unaryNode(id: string, operand: string): canvas.CanvasNode {
  return { kind: 'unary', id, op: 'length', operand };
}

function methodNode(id: string, args: Readonly<Record<string, string>>): canvas.CanvasNode {
  return { kind: 'method', id, block: 'emit', args };
}

function assignNode(id: string, target: string, value: string): canvas.CanvasNode {
  return { kind: 'assign', id, target, value };
}

function declNode(id: string, binding: canvas.VariableBinding): canvas.CanvasNode {
  return { kind: 'var-decl', id, name: id, type: 'int', binding };
}

function groupNode(id: string, rows: readonly (readonly string[])[]): canvas.CanvasNode {
  return { kind: 'group', id, mode: 'list', rows };
}

function convertNode(id: string, input: string): canvas.CanvasNode {
  return { kind: 'convert', id, spec: DEFAULT_CONVERSION, input };
}

function dictNode(id: string, entries: readonly { readonly key: canvas.EncodedDictKey; readonly value: string }[]): canvas.CanvasNode {
  return { kind: 'dict', id, entries };
}

function nodeIn(document: canvas.CanvasDocument, id: string): canvas.CanvasNode {
  const node = canvas.nodeMapOf(document).get(id);
  if (node === undefined) throw new Error(`文档里缺少节点「${id}」`);
  return node;
}

/** 包络成功的结果：没有 message，文档真的换了。 */
function ensured(result: WrapConversionResult): canvas.CanvasDocument {
  if (result.message !== undefined) throw new Error(`预期包络成功，却被拒绝：${result.message}`);
  return result.edit.document;
}

/** 被拒绝的结果：文档原样不动，并且有话说。 */
function refusalOf(result: WrapConversionResult, before: canvas.CanvasDocument): string {
  expect(result.edit.document).toBe(before);
  if (result.message === undefined) throw new Error('拒绝时没有给出原因');
  expect(result.edit.issues.map((issue) => issue.message)).toEqual([result.message]);
  return result.message;
}

/** 被拒绝的编辑：文档原样不动。 */
function refusedEdit(edit: CanvasEdit, before: canvas.CanvasDocument): string {
  expect(edit.document).toBe(before);
  const message = edit.issues[0]?.message;
  if (message === undefined) throw new Error('拒绝时没有给出原因');
  return message;
}

/** 文档里唯一那个转换节点（没有或多于一个都显式失败）。 */
function convertIn(document: canvas.CanvasDocument): canvas.ConvertNode {
  const converts = document.nodes.filter((node) => node.kind === 'convert');
  const only = converts[0];
  if (only === undefined || only.kind !== 'convert' || converts.length !== 1) throw new Error('文档里不是恰好一个转换节点');
  return only;
}

function rectOf(document: canvas.CanvasDocument, nodeId: string): Rect {
  const rect = rectOfNode(document, nodeId);
  if (rect === undefined) throw new Error(`节点「${nodeId}」没有坐标`);
  return rect;
}

function overlaps(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

// ---------------------------------------------------------------------------
// 外部引用扫描的口径
// ---------------------------------------------------------------------------

/** 一张把所有引用形状都用上的图：值、运算、方法参数、赋值、变量绑定、组合归属。 */
function referenceZoo(): canvas.CanvasDocument {
  return docOf(
    [
      intNode('v1'),
      intNode('v2'),
      relationNode('rel1', 'v1', 'v2'),
      unaryNode('un1', 'rel1'),
      methodNode('m1', { x: 'v1', y: '' }),
      assignNode('as1', 'd1', 'v1'),
      declNode('d1', { mode: 'initial', input: 'v2' }),
      groupNode('g1', [['v2']]),
    ],
    { v1: { x: 40, y: 40 }, v2: { x: 40, y: 200 } },
  );
}

describe('外部引用扫描：哪些算引用、哪些是结构归属', () => {
  it('引用者不在选区里、且引用的是选区内节点才返回，并带上端口名', () => {
    // v1 被关系左值、方法参数 x、赋值右值引用；顺序按文档顺序，不按扫描时的分组。
    expect(externalRefsOf(referenceZoo(), ['v1'])).toEqual([
      { referrerId: 'rel1', refName: 'left' },
      { referrerId: 'm1', refName: 'x' },
      { referrerId: 'as1', refName: 'value' },
    ]);
  });

  it('组合成员是结构归属不是引用，变量绑定的输入是引用', () => {
    // v2 是组合 g1 的成员（不算）、是关系右值（算）、是声明 d1 的初始值（算）。
    expect(externalRefsOf(referenceZoo(), ['v2'])).toEqual([
      { referrerId: 'rel1', refName: 'right' },
      { referrerId: 'd1', refName: 'input' },
    ]);
  });

  it('引用者在选区内时不算外部引用', () => {
    // 选区是 {v1, rel1}：rel1 对 v1 的引用是内部的，un1 对 rel1 的引用才是外部的。
    expect(externalRefsOf(referenceZoo(), ['v1', 'rel1'])).toEqual([
      { referrerId: 'un1', refName: 'operand' },
      { referrerId: 'm1', refName: 'x' },
      { referrerId: 'as1', refName: 'value' },
    ]);
  });

  it('未接线（UNCONNECTED）不是引用，空选区什么都不返回', () => {
    expect(externalRefsOf(referenceZoo(), [])).toEqual([]);
    const document = docOf([intNode('v1'), relationNode('rel1', 'v1', canvas.UNCONNECTED)]);
    expect(document.nodes.length).toBe(2);
    expect(externalRefsOf(document, ['v1'])).toEqual([{ referrerId: 'rel1', refName: 'left' }]);
  });
});

// ---------------------------------------------------------------------------
// 包络为转换
// ---------------------------------------------------------------------------

describe('包络为转换：单成员', () => {
  /** v1 被同一个关系的左右两边同时引用：两条连接都要改接。 */
  function singleDocument(): canvas.CanvasDocument {
    return docOf([intNode('v1'), relationNode('rel1', 'v1', 'v1')], { v1: { x: 40, y: 40 } });
  }

  it('转换节点出现，原引用者改接转换结果，原文档一个字节不改', () => {
    const before = singleDocument();
    const after = ensured(wrapInConversion(before, ['v1'], 'conv1'));

    expect(convertIn(after)).toEqual({ kind: 'convert', id: 'conv1', spec: DEFAULT_CONVERSION, input: 'v1' });
    // 左右两边都改接：一次遍历按端口逐个写，不留一条指向内部节点的旧线。
    expect(nodeIn(after, 'rel1')).toEqual(relationNode('rel1', 'conv1', 'conv1'));
    // 不可变：输入文档仍然是原样。
    expect(nodeIn(before, 'rel1')).toEqual(relationNode('rel1', 'v1', 'v1'));
    expect(before.nodes).toHaveLength(2);
  });

  it('被包住的节点本身不动，转换拿到一个坐标', () => {
    const before = singleDocument();
    const after = ensured(wrapInConversion(before, ['v1'], 'conv1'));
    expect(nodeIn(after, 'v1')).toEqual(intNode('v1'));
    expect(after.layout['conv1']).toBeDefined();
  });

  it('转换节点摆在整体结果右侧，不压在包络线上', () => {
    const before = singleDocument();
    const after = ensured(wrapInConversion(before, ['v1'], 'conv1'));
    const envelope = inflateRect(rectOf(after, 'v1'), ENVELOPE_PADDING);
    expect(overlaps(rectOf(after, 'conv1'), envelope)).toBe(false);
  });

  it('引用整体结果（旧的组合）不拒绝：那正是要改接的一批', () => {
    const before = docOf(
      [intNode('v1'), intNode('v2'), groupNode('g1', [['v1', 'v2']]), relationNode('rel1', 'g1', 'g1')],
      { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } },
    );
    const after = ensured(wrapInConversion(before, ['g1'], 'conv1'));
    expect(convertIn(after).input).toBe('g1');
    expect(nodeIn(after, 'rel1')).toEqual(relationNode('rel1', 'conv1', 'conv1'));
    // 组合与成员原样：包络只加在外层。
    expect(nodeIn(after, 'g1')).toEqual(groupNode('g1', [['v1', 'v2']]));
  });

  it('改接后类型对不上不拒绝，交给校验器标错', () => {
    // 文本转字节串要吃文本，这里塞的是整数；而且关系方框的左边要整数，接到字节串结果上。
    const spec: canvas.ConversionSpec = { kind: 'text-to-bytes', encoding: 'utf-8' };
    const before = docOf([intNode('v1'), relationNode('rel1', 'v1', canvas.UNCONNECTED)]);
    const after = ensured(wrapInConversion(before, ['v1'], 'conv1', spec));

    const mismatches = canvas
      .validateCanvasDocument(after)
      .issues.filter((issue) => issue.code === 'type_mismatch')
      .map((issue) => issue.nodeId);
    // 消费者（关系方框）拿到转换结果后类型不对：命令层照改，校验器负责说清楚。
    expect(mismatches).toContain('rel1');
  });

  it('字典条目的值也算引用：包络后改接、解除后改回', () => {
    const before = docOf([intNode('v1'), dictNode('d1', [{ key: { kind: 'string', value: 'k' }, value: 'v1' }])]);
    const wrapped = ensured(wrapInConversion(before, ['v1'], 'conv1'));
    expect(nodeIn(wrapped, 'd1')).toEqual(
      dictNode('d1', [{ key: { kind: 'string', value: 'k' }, value: 'conv1' }]),
    );
    const after = unwrapConversion(wrapped, 'conv1').document;
    expect(nodeIn(after, 'd1')).toEqual(dictNode('d1', [{ key: { kind: 'string', value: 'k' }, value: 'v1' }]));
  });

  it('字典条目的值指向转换、而转换没有内部结果时，解除后断开成未接线', () => {
    const before = docOf([intNode('v1'), convertNode('c1', canvas.UNCONNECTED), dictNode('d1', [
      { key: { kind: 'int', value: '1' }, value: 'c1' },
    ])]);
    const after = unwrapConversion(before, 'c1').document;
    expect(nodeIn(after, 'd1')).toEqual(
      dictNode('d1', [{ key: { kind: 'int', value: '1' }, value: canvas.UNCONNECTED }]),
    );
  });

  it('重复 id 只算一次，不因此建组合', () => {
    const before = singleDocument();
    const after = ensured(wrapInConversion(before, ['v1', 'v1'], 'conv1'));
    expect(convertIn(after).input).toBe('v1');
    expect(after.nodes.some((node) => node.kind === 'group')).toBe(false);
  });
});

describe('包络为转换：多成员', () => {
  function pairDocument(): canvas.CanvasDocument {
    return docOf([intNode('v1'), intNode('v2')], { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } });
  }

  it('先按选区顺序成组，再包成转换：组合是整体结果', () => {
    const before = pairDocument();
    const after = ensured(wrapInConversion(before, ['v2', 'v1'], 'conv1'));
    const convert = convertIn(after);
    const group = nodeIn(after, convert.input);
    // 组合的行列顺序就是选区顺序（这里刻意倒着选）。
    expect(group).toEqual({ kind: 'group', id: convert.input, mode: 'list', rows: [['v2', 'v1']] });
    expect(after.nodes).toHaveLength(before.nodes.length + 2);
  });

  it('组合模式用 createGroup 的默认判定：全字节串合并为字节串', () => {
    const before = docOf([byteNode('b1'), byteNode('b2')], { b1: { x: 40, y: 40 }, b2: { x: 240, y: 40 } });
    const after = ensured(wrapInConversion(before, ['b1', 'b2'], 'conv1'));
    expect(nodeIn(after, convertIn(after).input)).toMatchObject({ kind: 'group', mode: 'merge' });
  });

  it('转换节点不压在组合包络上', () => {
    const before = pairDocument();
    const after = ensured(wrapInConversion(before, ['v1', 'v2'], 'conv1'));
    const union = unionRects([rectOf(after, 'v1'), rectOf(after, 'v2')]);
    if (union === undefined) throw new Error('成员没有坐标');
    const envelope = inflateRect(inflateRect(union, GROUP_PADDING), ENVELOPE_PADDING);
    expect(overlaps(rectOf(after, 'conv1'), envelope)).toBe(false);
  });

  it('外部引用内部中间结果时拒绝，文档不变，message 点名引用者与被引用者', () => {
    const before = docOf(
      [intNode('v1'), intNode('v2'), relationNode('rel1', 'v1', 'v2')],
      { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } },
    );
    const message = refusalOf(wrapInConversion(before, ['v1', 'v2'], 'conv1'), before);
    expect(message).toBe('「rel1」还引用着内部的「v1」，先把它改接或删除再包成转换');
    // 文档的节点与坐标都没被改动。
    expect(before.nodes).toHaveLength(3);
    expect(before.layout).toEqual({ v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } });
  });

  it('成员已经属于别的组合时按 createGroup 的判定拒绝', () => {
    const before = docOf(
      [intNode('v1'), intNode('v2'), intNode('v3'), groupNode('g1', [['v1', 'v2']])],
      { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 }, v3: { x: 40, y: 200 } },
    );
    const message = refusalOf(wrapInConversion(before, ['v1', 'v3'], 'conv1'), before);
    expect(message).toContain('已经属于包络「g1」');
  });
});

describe('包络为转换：拒绝条件', () => {
  function zoo(): canvas.CanvasDocument {
    return docOf(
      [
        intNode('v1'),
        { kind: 'start', id: 'start' },
        methodNode('m1', {}),
        declNode('d1', { mode: 'none' }),
        convertNode('c1', 'v1'),
      ],
      { v1: { x: 40, y: 40 } },
    );
  }

  it('空选区被拒绝', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, []), before)).toBe('先选中要包成转换的数据节点');
  });

  it('流程节点被拒绝：没有数据结果', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['m1']), before)).toBe('「m1」是「方法」，没有数据结果，不能包成转换');
  });

  it('开始节点被拒绝', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['v1', 'start']), before)).toBe(
      '「start」是「开始」，没有数据结果，不能包成转换',
    );
  });

  it('变量声明被拒绝：它不是数据节点', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['d1']), before)).toBe(
      '「d1」是「变量声明」，没有数据结果，不能包成转换',
    );
  });

  it('选区里已经有转换时拒绝：转换不能包住自己', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['v1', 'c1']), before)).toBe(
      '选区里已经有转换「c1」，转换不能包住自己，先解除它再包',
    );
  });

  it('不存在的 id 被拒绝', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['ghost']), before)).toBe('选中的「ghost」不在文档里');
  });

  it('转换 id 已经存在时拒绝，不覆盖别人的节点', () => {
    const before = zoo();
    expect(refusalOf(wrapInConversion(before, ['v1'], 'c1'), before)).toBe('节点 id「c1」已经存在，换一个再包');
  });
});

// ---------------------------------------------------------------------------
// 解除转换
// ---------------------------------------------------------------------------

describe('解除转换：拆掉包络、留下结构', () => {
  /** 组合 g1 被转换 c1 包住，消费者 rel1 读转换结果。 */
  function wrappedDocument(input: string): canvas.CanvasDocument {
    return docOf(
      [intNode('v1'), intNode('v2'), groupNode('g1', [['v1', 'v2']]), convertNode('c1', input), relationNode('rel1', 'c1', 'c1')],
      { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 }, c1: { x: 480, y: 40 }, rel1: { x: 720, y: 40 } },
    );
  }

  it('删掉转换节点，消费者改接回它的输入', () => {
    const before = wrappedDocument('g1');
    const edit = unwrapConversion(before, 'c1');
    expect(edit.issues).toEqual([]);
    expect(edit.document.nodes.some((node) => node.id === 'c1')).toBe(false);
    expect(nodeIn(edit.document, 'rel1')).toEqual(relationNode('rel1', 'g1', 'g1'));
  });

  it('内部结构原样保留：组合与成员都没动，组合包络还在', () => {
    const before = wrappedDocument('g1');
    const after = unwrapConversion(before, 'c1').document;
    expect(nodeIn(after, 'g1')).toEqual(groupNode('g1', [['v1', 'v2']]));
    expect(nodeIn(after, 'v1')).toEqual(intNode('v1'));
    expect(nodeIn(after, 'v2')).toEqual(intNode('v2'));
    // 组合仍然是 g1，成员仍然归它：包络画得出来。
    expect(canvas.ownerMapOf(after).get('v1')).toBe('g1');
  });

  it('layout 只清转换节点自己那一格', () => {
    const before = wrappedDocument('g1');
    const after = unwrapConversion(before, 'c1').document;
    expect(after.layout['c1']).toBeUndefined();
    expect(after.layout['g1']).toBeUndefined();
    expect(after.layout['v1']).toEqual({ x: 40, y: 40 });
    expect(after.layout['rel1']).toEqual({ x: 720, y: 40 });
  });

  it('输入是未接线时消费者断开，不留悬空引用', () => {
    const before = wrappedDocument(canvas.UNCONNECTED);
    const after = unwrapConversion(before, 'c1').document;
    expect(nodeIn(after, 'rel1')).toEqual(relationNode('rel1', canvas.UNCONNECTED, canvas.UNCONNECTED));
  });

  it('可选端口（切片的起点）断开时整条删掉，不写空串', () => {
    const before = docOf([
      intNode('v1'),
      convertNode('c1', canvas.UNCONNECTED),
      { kind: 'slice', id: 's1', target: 'v1', start: 'c1' },
    ]);
    const after = unwrapConversion(before, 'c1').document;
    expect(nodeIn(after, 's1')).toEqual({ kind: 'slice', id: 's1', target: 'v1' });
  });

  it('非转换节点被拒绝，文档不变', () => {
    const before = wrappedDocument('g1');
    expect(refusedEdit(unwrapConversion(before, 'g1'), before)).toBe(
      '节点「g1」是「组合」，不是转换，没有包络可以解除',
    );
    expect(refusedEdit(unwrapConversion(before, 'ghost'), before)).toBe('节点「ghost」不存在');
  });
});

describe('包络与解除的一次往返', () => {
  it('单成员包上再解除：连接回到原来那个节点，不留下组合', () => {
    const before = docOf(
      [intNode('v1'), relationNode('rel1', 'v1', 'v1')],
      { v1: { x: 40, y: 40 }, rel1: { x: 480, y: 40 } },
    );
    const wrapped = ensured(wrapInConversion(before, ['v1'], 'conv1'));
    const after = unwrapConversion(wrapped, 'conv1').document;

    expect(nodeIn(after, 'rel1')).toEqual(relationNode('rel1', 'v1', 'v1'));
    expect(after.nodes.map((node) => node.id).sort()).toEqual(['rel1', 'v1']);
  });

  it('多成员包上再解除：组合与成员都还在，转换消失', () => {
    // 多成员时整体结果是新建的组合；消费组合的那种形状由上面「解除转换」一组用例覆盖
    // （`convertNode('c1', 'g1')` 与这里包出来的文档是同一形状）。
    const before = docOf([intNode('v1'), intNode('v2')], { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } });
    const wrapped = ensured(wrapInConversion(before, ['v1', 'v2'], 'conv1'));
    const groupId = convertIn(wrapped).input;
    const after = unwrapConversion(wrapped, 'conv1').document;

    expect(after.nodes.some((node) => node.id === 'conv1')).toBe(false);
    expect(nodeIn(after, groupId)).toMatchObject({ kind: 'group', mode: 'list', rows: [['v1', 'v2']] });
    expect(after.nodes.map((node) => node.id).sort()).toEqual([groupId, 'v1', 'v2'].sort());
    expect(nodeIn(after, 'v1')).toEqual(intNode('v1'));
  });
});
