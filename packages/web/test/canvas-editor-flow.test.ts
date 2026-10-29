import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import {
  COL_PITCH,
  ROW_PITCH,
  appendStatement,
  connect,
  createGroup,
  dissolveGroup,
  insertRowAfter,
  insertStatement,
  moveMember,
  moveStatement,
  regionOfId,
  regionRefsOf,
  regionSequenceOf,
  removeNodes,
  removeRow,
  removeStatement,
} from '../src/canvas/editor';
import type { CanvasEdit } from '../src/canvas/editor';

/**
 * 包络（组合）与流程序列的验收测试。
 *
 * 两条边界在这里被反复断言：
 * - 组合的 `rows` 是权威行列：插入行 / 删行 / 移动成员写 `rows`，再把成员坐标按
 *   `ROW_PITCH` / `COL_PITCH` 压紧（组合自身坐标不动）；
 * - 流程用数组表达顺序，一个流程节点只能出现在一条序列里，重复放置在命令层就被拒绝（`flow_error`）。
 */

function docOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[] = [],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
): canvas.CanvasDocument {
  return { format: canvas.CANVAS_FORMAT, version: canvas.CANVAS_VERSION, nodes, layout, main };
}

function intLit(id: string, value: number): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'int', value: String(value) } };
}

function textLit(id: string, value: string): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'string', value } };
}

function byteLit(id: string, hex: string): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'byte', hex } };
}

function boolLit(id: string, value: boolean): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'bool', value } };
}

function groupNode(
  id: string,
  mode: canvas.GroupMode,
  rows: readonly (readonly string[])[],
): canvas.CanvasNode {
  return { kind: 'group', id, mode, rows };
}

function ifNode(
  id: string,
  cond: string,
  then: readonly string[],
  otherwise: readonly string[],
): canvas.CanvasNode {
  return { kind: 'if', id, cond, then, else: otherwise };
}

function loopNode(id: string, count: string, body: readonly string[]): canvas.CanvasNode {
  return { kind: 'loop', id, count, body };
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

function expectNoNewErrors(before: canvas.CanvasDocument, after: canvas.CanvasDocument): void {
  const known = errorKeys(before);
  const added = [...errorKeys(after)].filter((key) => !known.has(key) && !key.startsWith('unconnected|'));
  expect(added).toEqual([]);
}

function expectSchemaOk(document: canvas.CanvasDocument): void {
  const parsed = canvas.CanvasDocumentSchema.safeParse(document);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
}

const MAIN: canvas.FlowRegionRef = { ownerId: '', kind: 'main' };

describe('创建包络', () => {
  it('两个字节串成员默认「合并为串」', () => {
    const document = docOf([byteLit('a', 'ff'), byteLit('b', '00')]);
    const result = createGroup(document, ['a', 'b'], 'g1');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a', 'b']]));
    expectNoNewErrors(document, result.document);
  });

  it('两个整数成员默认「组成列表」', () => {
    const document = docOf([intLit('a', 1), intLit('b', 2)]);
    const result = createGroup(document, ['a', 'b'], 'g1');

    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'list', [['a', 'b']]));
    expectNoNewErrors(document, result.document);
  });

  it('显式指定模式时按指定的来', () => {
    const document = docOf([byteLit('a', 'ff'), byteLit('b', '00')]);

    expect(nodeIn(createGroup(document, ['a', 'b'], 'g1', 'list').document, 'g1')).toEqual(
      groupNode('g1', 'list', [['a', 'b']]),
    );
  });

  it('空包络被拒绝，单个表达式允许包络', () => {
    const document = docOf([intLit('a', 1)]);
    expect(createGroup(document, ['a'], 'single').issues).toEqual([]);
    const result = createGroup(document, [], 'g1');

    expect(codesOf(result)).toEqual(['ownership_conflict']);
    expect(result.issues[0].nodeId).toBe('g1');
    expect(result.document).toBe(document);
  });

  it('成员已经在别的包络里被拒绝', () => {
    const document = docOf(
      [textLit('a', 'x'), textLit('b', 'y'), textLit('c', 'z'), groupNode('g1', 'merge', [['a', 'b']])],
      [],
      { g1: { x: 1, y: 1 } },
    );
    const result = createGroup(document, ['a', 'c'], 'g2');

    expect(codesOf(result)).toEqual(['ownership_conflict']);
    expect(result.issues[0].nodeId).toBe('a');
    expect(result.document).toBe(document);
  });

  it('流程节点不能进包络', () => {
    const document = docOf([startNode(), intLit('a', 1)]);
    const result = createGroup(document, ['start', 'a'], 'g1');

    expect(codesOf(result)).toEqual(['ownership_conflict']);
    expect(result.issues[0].nodeId).toBe('start');
  });

  it('同一成员重复出现被拒绝', () => {
    const document = docOf([intLit('a', 1)]);
    const result = createGroup(document, ['a', 'a'], 'g1');

    expect(codesOf(result)).toEqual(['ownership_conflict']);
    expect(result.issues[0].nodeId).toBe('a');
  });

  it('成员不存在被拒绝', () => {
    const document = docOf([intLit('a', 1)]);
    const result = createGroup(document, ['a', 'ghost'], 'g1');

    expect(codesOf(result)).toEqual(['unknown_node']);
    expect(result.issues[0].nodeId).toBe('ghost');
  });

  it('组合 id 重复被拒绝', () => {
    const document = docOf([intLit('a', 1), intLit('b', 2), groupNode('g1', 'list', [['a', 'b']])]);
    const result = createGroup(document, ['a', 'b'], 'g1');

    expect(codesOf(result)).toEqual(['duplicate_id']);
    expect(result.document).toBe(document);
  });
});

describe('解除包络', () => {
  it('成员回到顶层，组合与坐标一起删掉', () => {
    const document = docOf(
      [textLit('a', 'x'), textLit('b', 'y'), groupNode('g1', 'merge', [['a', 'b']])],
      [],
      { g1: { x: 3, y: 4 } },
    );
    const result = dissolveGroup(document, 'g1');

    expect(result.issues).toEqual([]);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(result.document.layout).toEqual({});
    expect(canvas.ownerMapOf(result.document).size).toBe(0);
    expectNoNewErrors(document, result.document);
  });

  it('内层被解除后外层因为变空也一起删掉', () => {
    const document = docOf([
      textLit('a', 'x'),
      textLit('b', 'y'),
      groupNode('inner', 'merge', [['a', 'b']]),
      groupNode('outer', 'merge', [['inner']]),
    ]);
    const result = dissolveGroup(document, 'inner');

    expect(result.document.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('拒绝非组合节点', () => {
    const document = docOf([intLit('a', 1)]);
    const result = dissolveGroup(document, 'a');

    expect(codesOf(result)).toEqual(['unknown_kind']);
    expect(result.document).toBe(document);
  });
});

describe('行列操作', () => {
  function grid(): canvas.CanvasDocument {
    return docOf(
      [textLit('a', 'a'), textLit('b', 'b'), textLit('c', 'c'), groupNode('g1', 'merge', [['a', 'b'], ['c']])],
      [],
      { g1: { x: 2, y: 2 } },
    );
  }

  it('insertRowAfter 默认在末尾追加空行，并把成员坐标按行列压紧', () => {
    const document = grid();
    const result = insertRowAfter(document, 'g1');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a', 'b'], ['c'], []]));
    expectSchemaOk(result.document);
    // 新增的空行没有成员，所以不留坐标；组合自己的坐标不被压紧改动（需求 §6.2）。
    expect(result.document.layout).toEqual({
      g1: { x: 2, y: 2 },
      a: { x: 2, y: 2 },
      b: { x: 2 + COL_PITCH, y: 2 },
      c: { x: 2, y: 2 + ROW_PITCH },
    });
  });

  it('insertRowAfter 可以插在指定行之后', () => {
    const document = grid();
    const result = insertRowAfter(document, 'g1', 0);

    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a', 'b'], [], ['c']]));
  });

  it('insertRowAfter 越界就追加到末尾', () => {
    const document = grid();

    expect(nodeIn(insertRowAfter(document, 'g1', Number.MAX_SAFE_INTEGER).document, 'g1')).toEqual(
      groupNode('g1', 'merge', [['a', 'b'], ['c'], []]),
    );
  });

  it('removeRow 删掉指定行', () => {
    const document = grid();
    const result = removeRow(document, 'g1', 1);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a', 'b']]));
  });

  it('removeRow 删掉空行后行数减少', () => {
    const document = docOf([textLit('a', 'a'), groupNode('g1', 'merge', [['a'], []])], [], { g1: { x: 2, y: 2 } });
    const result = removeRow(document, 'g1', 1);

    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a']]));
  });

  it('removeRow 删空最后一行时组合也一起删', () => {
    const document = docOf(
      [textLit('a', 'a'), groupNode('g1', 'merge', [['a']])],
      [],
      { g1: { x: 2, y: 2 } },
    );
    const result = removeRow(document, 'g1', 0);

    expect(result.document.nodes.map((node) => node.id)).toEqual(['a']);
    expect(result.document.layout).toEqual({});
  });

  it('moveMember 把成员挪到另一行的指定列', () => {
    const document = grid();
    const result = moveMember(document, 'g1', 'a', 1, 0);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['b'], ['a', 'c']]));
    expectNoNewErrors(document, result.document);
  });

  it('moveMember 目标行越界时新开一行', () => {
    const document = grid();

    expect(nodeIn(moveMember(document, 'g1', 'a', 2, 0).document, 'g1')).toEqual(
      groupNode('g1', 'merge', [['b'], ['c'], ['a']]),
    );
  });

  it('moveMember 拒绝不属于这个组合的成员', () => {
    const document = docOf(
      [textLit('a', 'a'), textLit('b', 'b'), textLit('c', 'c'), groupNode('g1', 'merge', [['a', 'b']])],
    );
    const result = moveMember(document, 'g1', 'c', 0, 0);

    expect(codesOf(result)).toEqual(['ownership_conflict']);
    expect(result.document).toBe(document);
  });

  it('行列操作拒绝非组合节点', () => {
    const document = docOf([intLit('a', 1)]);

    expect(codesOf(insertRowAfter(document, 'a'))).toEqual(['unknown_kind']);
    expect(codesOf(removeRow(document, 'a', 0))).toEqual(['unknown_kind']);
    expect(codesOf(moveMember(document, 'a', 'a', 0, 0))).toEqual(['unknown_kind']);
  });
});

describe('流程序列', () => {
  function flowDoc(): canvas.CanvasDocument {
    return docOf(
      [startNode(), methodNode('m1', 'emit', {}), methodNode('m2', 'emit', {})],
      ['start', 'm1', 'm2'],
    );
  }

  it('appendStatement 把开始节点放进空 main', () => {
    const document = docOf([startNode()]);
    const result = appendStatement(document, 'start');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start']);
    expectNoNewErrors(document, result.document);
  });

  it('appendStatement 追加到 main 末尾', () => {
    const document = docOf([startNode(), methodNode('m1', 'emit', {})], ['start']);
    const result = appendStatement(document, 'm1');

    expect(result.document.main).toEqual(['start', 'm1']);
    expectNoNewErrors(document, result.document);
  });

  it('insertStatement 拒绝把已经排在 main 里的节点再插一次', () => {
    const document = flowDoc();
    const result = insertStatement(document, MAIN, 1, 'm2');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('m2');
    expect(result.document).toBe(document);
  });

  it('insertStatement 会把语句放到指定位置', () => {
    const document = docOf([startNode(), methodNode('m1', 'emit', {}), methodNode('m2', 'emit', {})], [
      'start',
      'm2',
    ]);
    const result = insertStatement(document, MAIN, 1, 'm1');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'm1', 'm2']);
  });

  it('insertStatement 下标越界就追加到末尾', () => {
    const document = docOf([startNode(), methodNode('m1', 'emit', {})], ['start']);

    expect(insertStatement(document, MAIN, 99, 'm1').document.main).toEqual(['start', 'm1']);
    expect(insertStatement(document, MAIN, -3, 'm1').document.main).toEqual(['start', 'm1']);
  });

  it('insertStatement 拒绝数据节点', () => {
    const document = docOf([startNode(), intLit('a', 1)], ['start']);
    const result = insertStatement(document, MAIN, 1, 'a');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('a');
  });

  it('insertStatement 拒绝已经放在别的序列里的节点', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', 'b1', [], []), methodNode('m1', 'emit', {})],
      ['start', 'if1', 'm1'],
    );
    const result = insertStatement(document, { ownerId: 'if1', kind: 'then' }, 0, 'm1');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('m1');
    expect(result.document).toBe(document);
  });

  it('insertStatement 拒绝不存在的所属容器', () => {
    const document = docOf([startNode(), methodNode('m1', 'emit', {})], ['start']);
    const result = insertStatement(document, { ownerId: 'ghost', kind: 'then' }, 0, 'm1');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('ghost');
  });

  it('insertStatement 拒绝区域种类与容器不匹配', () => {
    const document = docOf([startNode(), boolLit('b1', true), ifNode('if1', 'b1', [], [])], ['start', 'if1']);
    const result = insertStatement(document, { ownerId: 'if1', kind: 'body' }, 0, 'if1');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('if1');
  });

  it('insertStatement 要求 main 的 ownerId 是空串', () => {
    const document = docOf([startNode(), methodNode('m1', 'emit', {})], ['start']);
    const result = insertStatement(document, { ownerId: 'x', kind: 'main' }, 0, 'm1');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('x');
  });

  it('insertStatement 可以放进分支的成立分支', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', 'b1', [], []), methodNode('m1', 'emit', {})],
      ['start', 'if1'],
    );
    const result = insertStatement(document, { ownerId: 'if1', kind: 'then' }, 0, 'm1');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'if1')).toEqual(ifNode('if1', 'b1', ['m1'], []));
    expectNoNewErrors(document, result.document);
  });

  it('moveStatement 在同一条序列内换位', () => {
    const document = flowDoc();
    const result = moveStatement(document, MAIN, 1, 2);

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'm2', 'm1']);
    expectNoNewErrors(document, result.document);
  });

  it('moveStatement 的目标下标越界时夹到末尾', () => {
    const document = flowDoc();

    expect(moveStatement(document, MAIN, 1, 99).document.main).toEqual(['start', 'm2', 'm1']);
  });

  it('moveStatement 位置没变时原样返回', () => {
    const document = flowDoc();

    expect(moveStatement(document, MAIN, 2, 2).document).toBe(document);
  });

  it('moveStatement 拒绝越界的来源下标', () => {
    const document = flowDoc();
    const result = moveStatement(document, MAIN, 9, 0);

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.document).toBe(document);
  });

  it('moveStatement 拒绝不存在的区域', () => {
    const document = flowDoc();
    const result = moveStatement(document, { ownerId: 'if1', kind: 'then' }, 0, 1);

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('if1');
  });

  it('removeStatement 把语句从 main 与文档里都删掉', () => {
    const document = flowDoc();
    const result = removeStatement(document, 'm1');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'm2']);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['start', 'm2']);
  });

  it('removeStatement 连带删掉区域里的语句', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', 'b1', ['m1'], []), methodNode('m1', 'emit', {})],
      ['start', 'if1'],
    );
    const result = removeStatement(document, 'if1');

    expect(result.document.main).toEqual(['start']);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['start', 'b1']);
  });

  it('removeStatement 拒绝数据节点', () => {
    const document = docOf([startNode(), intLit('a', 1)], ['start']);
    const result = removeStatement(document, 'a');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.document).toBe(document);
  });
});

describe('区域查询与流程节点上的端口', () => {
  it('regionSequenceOf 读 main 与其他区域', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', 'b1', ['m1'], []), methodNode('m1', 'emit', {})],
      ['start', 'if1'],
    );

    expect(regionSequenceOf(document, MAIN)).toBe(document.main);
    expect(regionSequenceOf(document, { ownerId: 'if1', kind: 'then' })).toEqual(['m1']);
    expect(regionSequenceOf(document, { ownerId: 'if1', kind: 'else' })).toEqual([]);
    expect(regionSequenceOf(document, { ownerId: 'if1', kind: 'body' })).toBeUndefined();
    expect(regionSequenceOf(document, { ownerId: 'x', kind: 'main' })).toBeUndefined();
    expect(regionSequenceOf(document, { ownerId: 'ghost', kind: 'then' })).toBeUndefined();
  });

  it('regionRefsOf 列出 main、分支的两条与循环的一条', () => {
    const document = docOf([
      boolLit('b1', true),
      ifNode('if1', 'b1', [], []),
      loopNode('loop1', 'b1', []),
    ]);

    expect(regionRefsOf(document)).toEqual([
      { ownerId: '', kind: 'main' },
      { ownerId: 'if1', kind: 'then' },
      { ownerId: 'if1', kind: 'else' },
      { ownerId: 'loop1', kind: 'body' },
    ]);
  });

  it('regionOfId 找回流程节点所在的序列', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', 'b1', ['m1'], []), methodNode('m1', 'emit', {})],
      ['start', 'if1'],
    );

    expect(regionOfId(document, 'm1')).toEqual({ ownerId: 'if1', kind: 'then' });
    expect(regionOfId(document, 'start')).toEqual(MAIN);
    expect(regionOfId(document, 'b1')).toBeUndefined();
  });

  it('connect 可以接流程节点上的数据端口（分支条件）', () => {
    const document = docOf(
      [startNode(), boolLit('b1', true), ifNode('if1', '', [], [])],
      ['start', 'if1'],
    );
    const result = connect(document, 'if1', 'cond', 'b1');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'if1')).toEqual(ifNode('if1', 'b1', [], []));
    expectNoNewErrors(document, result.document);
  });

  it('connect 可以接方法参数端口（参数格已经列出来）', () => {
    const document = docOf(
      [startNode(), intLit('n1', 1), methodNode('m1', 'emit', { v: canvas.UNCONNECTED })],
      ['start', 'm1'],
    );
    const result = connect(document, 'm1', 'v', 'n1');

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'm1')).toEqual(methodNode('m1', 'emit', { v: 'n1' }));
    expectNoNewErrors(document, result.document);
  });

  it('删掉包络的一个成员后组合收缩，另一个成员仍然是它的成员', () => {
    const document = docOf(
      [textLit('a', 'x'), textLit('b', 'y'), groupNode('g1', 'merge', [['a', 'b']])],
      [],
      { g1: { x: 1, y: 1 } },
    );
    const result = removeNodes(document, ['b']);

    expect(result.removed).toEqual(['b']);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', 'merge', [['a']]));
    expect(canvas.ownerMapOf(result.document).get('a')).toBe('g1');
    expect(result.document.layout).toEqual({ g1: { x: 1, y: 1 } });
  });
});
