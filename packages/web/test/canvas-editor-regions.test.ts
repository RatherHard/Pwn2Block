import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_FLOW_DEPTH, canvas } from '@pwn2block/shared';
import {
  COL_PITCH,
  ROW_PITCH,
  insertRowAfter,
  moveMember,
  removeRow,
  unwrapBranch,
  unwrapLoop,
  wrapInBranch,
  wrapInLoop,
  type CanvasEdit,
} from '../src/canvas/editor';

/**
 * 流程区域包络与「落位后压紧」的验收测试（需求 §6.2、§6.3，验收表 AT-15、AT-16）。
 *
 * 四条结构命令的边界在用例里逐条钉住：
 * - 包络只吃**同一条序列里连续**的流程语句，包完原位置留下容器、被包的语句按原序进新区域；
 * - 区域嵌套深度先算后改，超过 `CANVAS_MAX_FLOW_DEPTH` 直接拒绝（中文原因）；
 * - 展开是确定的顺序拼接：循环体接回原位置，分支按「成立在前、不成立在后」接回；
 * - 组内行列改完后按 `ROW_PITCH` / `COL_PITCH` 压紧坐标，空行不留空洞、也不产生空坐标。
 */

// ---------------------------------------------------------------------------
// 文档与断言小工具
// ---------------------------------------------------------------------------

function docOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[] = [],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
): canvas.CanvasDocument {
  return { format: canvas.CANVAS_FORMAT, version: canvas.CANVAS_VERSION, nodes, layout, main };
}

function startNode(id = 'start'): canvas.CanvasNode {
  return { kind: 'start', id };
}

function methodNode(id: string): canvas.CanvasNode {
  return { kind: 'method', id, block: 'emit', args: {} };
}

function intNode(id: string, value: number): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'int', value: String(value) } };
}

function boolNode(id: string): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'bool', value: true } };
}

function groupNode(id: string, rows: readonly (readonly string[])[]): canvas.CanvasNode {
  return { kind: 'group', id, mode: 'list', rows };
}

function ifNode(id: string, cond: string, then: readonly string[], otherwise: readonly string[]): canvas.CanvasNode {
  return { kind: 'if', id, cond, then, else: otherwise };
}

function loopNode(id: string, count: string, body: readonly string[]): canvas.CanvasNode {
  return { kind: 'loop', id, count, body };
}

/** 开始 → m1 → m2 → m3，全部排在 main 里。 */
function flowDocument(): canvas.CanvasDocument {
  return docOf([startNode(), methodNode('m1'), methodNode('m2'), methodNode('m3')], ['start', 'm1', 'm2', 'm3']);
}

/** 开始 → 条件分支（两条空区域）→ m1，条件接布尔值。 */
function branchDocument(): canvas.CanvasDocument {
  return docOf(
    [startNode(), boolNode('flag'), ifNode('if1', 'flag', [], []), methodNode('m1')],
    ['start', 'if1', 'm1'],
  );
}

/** `levels` 层循环套循环，最内层循环体里放一条方法语句：语句的深度就是 `levels`。 */
function nestedLoopDocument(levels: number): canvas.CanvasDocument {
  const nodes: canvas.CanvasNode[] = [startNode(), methodNode('m1')];
  let inner: readonly string[] = ['m1'];
  for (let index = levels; index >= 1; index -= 1) {
    nodes.push(loopNode(`loop${index}`, canvas.UNCONNECTED, inner));
    inner = [`loop${index}`];
  }
  return docOf(nodes, ['start', ...inner]);
}

function nodeIn(document: canvas.CanvasDocument, id: string): canvas.CanvasNode {
  const node = canvas.nodeMapOf(document).get(id);
  if (node === undefined) throw new Error(`文档里缺少节点「${id}」`);
  return node;
}

function bodyOf(document: canvas.CanvasDocument, loopId: string): readonly string[] {
  const node = nodeIn(document, loopId);
  if (node.kind !== 'loop') throw new Error(`节点「${loopId}」不是循环`);
  return node.body;
}

function regionOfIf(document: canvas.CanvasDocument, ifId: string): readonly (readonly string[])[] {
  const node = nodeIn(document, ifId);
  if (node.kind !== 'if') throw new Error(`节点「${ifId}」不是条件分支`);
  return [node.then, node.else];
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

/** 命令必须成功：被拒绝就立刻失败，免得后面的断言在旧文档上「碰巧」通过。 */
function applied(edit: CanvasEdit): canvas.CanvasDocument {
  if (edit.issues.length > 0) throw new Error(`命令被拒绝：${edit.issues.map((issue) => issue.message).join('；')}`);
  return edit.document;
}

// ---------------------------------------------------------------------------
// 包进循环
// ---------------------------------------------------------------------------

describe('包进循环', () => {
  it('连续两条语句进循环体，原位置留循环，main 其余顺序不变', () => {
    const document = flowDocument();
    const result = wrapInLoop(document, { ownerId: '', from: 1, to: 2, loopId: 'loop1', count: canvas.UNCONNECTED });

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'loop1', 'm3']);
    expect(bodyOf(result.document, 'loop1')).toEqual(['m1', 'm2']);
    expect(nodeIn(result.document, 'loop1')).toEqual(loopNode('loop1', canvas.UNCONNECTED, ['m1', 'm2']));
    expectSchemaOk(result.document);
    expectNoNewErrors(document, result.document);
  });

  it('循环次数端口写进新节点，不再报未接线', () => {
    const document = docOf(
      [startNode(), intNode('n1', 3), methodNode('m1')],
      ['start', 'm1'],
      {},
    );
    const result = wrapInLoop(document, { ownerId: '', from: 1, to: 1, loopId: 'loop1', count: 'n1' });

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'loop1')).toEqual(loopNode('loop1', 'n1', ['m1']));
    expect(errorKeys(result.document)).toEqual(new Set());
  });

  it('新循环继承第一个被包语句的坐标，成员坐标不动', () => {
    const document = docOf(
      [startNode(), methodNode('m1'), methodNode('m2'), methodNode('m3')],
      ['start', 'm1', 'm2', 'm3'],
      { m1: { x: 40, y: 60 }, m3: { x: 40, y: 180 } },
    );
    const result = wrapInLoop(document, { ownerId: '', from: 1, to: 2, loopId: 'loop1', count: canvas.UNCONNECTED });

    expect(result.document.layout).toEqual({ m1: { x: 40, y: 60 }, m3: { x: 40, y: 180 }, loop1: { x: 40, y: 60 } });
  });

  it('区间倒序被拒绝', () => {
    const document = flowDocument();
    const result = wrapInLoop(document, { ownerId: '', from: 2, to: 1, loopId: 'loop1', count: canvas.UNCONNECTED });

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.document).toBe(document);
    expect(result.issues[0].message).toContain('不是连续的一段');
  });

  it('区间越界被拒绝', () => {
    const document = flowDocument();
    const result = wrapInLoop(document, { ownerId: '', from: 1, to: 9, loopId: 'loop1', count: canvas.UNCONNECTED });

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.document).toBe(document);
  });

  it('区间里夹着数据节点被拒绝', () => {
    const document = docOf(
      [startNode(), methodNode('m1'), intNode('n1', 1)],
      ['start', 'm1', 'n1'],
    );
    const result = wrapInLoop(document, { ownerId: '', from: 1, to: 2, loopId: 'loop1', count: canvas.UNCONNECTED });

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('n1');
    expect(result.issues[0].message).toContain('数据节点');
  });

  it('跨序列的区间被拒绝：按另一条区域的坐标找不到这一段', () => {
    const document = branchDocument();
    const result = wrapInLoop(document, {
      ownerId: 'if1',
      kind: 'then',
      from: 0,
      to: 1,
      loopId: 'loop1',
      count: canvas.UNCONNECTED,
    });

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].nodeId).toBe('if1');
    expect(result.document).toBe(document);
  });

  it('包进去后会超出嵌套深度上限时被拒绝', () => {
    const document = nestedLoopDocument(CANVAS_MAX_FLOW_DEPTH);
    const result = wrapInLoop(document, {
      ownerId: `loop${CANVAS_MAX_FLOW_DEPTH}`,
      from: 0,
      to: 0,
      loopId: 'extra',
      count: canvas.UNCONNECTED,
    });

    expect(codesOf(result)).toEqual(['limit_exceeded']);
    expect(result.document).toBe(document);
    expect(result.issues[0].message).toContain(`超过上限 ${CANVAS_MAX_FLOW_DEPTH}`);
  });

  it('正好落在上限上时允许包（深度不超过上限即可）', () => {
    const document = nestedLoopDocument(CANVAS_MAX_FLOW_DEPTH - 1);
    const result = wrapInLoop(document, {
      ownerId: `loop${CANVAS_MAX_FLOW_DEPTH - 1}`,
      from: 0,
      to: 0,
      loopId: 'extra',
      count: canvas.UNCONNECTED,
    });

    expect(result.issues).toEqual([]);
    expect(canvas.analyzeFlow(result.document).depthOf.get('m1')).toBe(CANVAS_MAX_FLOW_DEPTH);
  });

  it('循环 id 已存在或非法时被拒绝', () => {
    const document = flowDocument();
    const duplicate = wrapInLoop(document, { ownerId: '', from: 1, to: 1, loopId: 'start', count: '' });
    const illegal = wrapInLoop(document, { ownerId: '', from: 1, to: 1, loopId: 'bad id', count: '' });

    expect(codesOf(duplicate)).toEqual(['duplicate_id']);
    expect(codesOf(illegal)).toEqual(['invalid_id']);
    expect(duplicate.document).toBe(document);
    expect(illegal.document).toBe(document);
  });
});

// ---------------------------------------------------------------------------
// 包进条件分支
// ---------------------------------------------------------------------------

describe('包进条件分支', () => {
  it('语句进成立分支，不成立分支为空，条件写进新节点', () => {
    const document = docOf(
      [startNode(), boolNode('flag'), methodNode('m1'), methodNode('m2')],
      ['start', 'm1', 'm2'],
    );
    const result = wrapInBranch(document, { ownerId: '', from: 1, to: 2, ifId: 'if2', cond: 'flag' });

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'if2']);
    expect(regionOfIf(result.document, 'if2')).toEqual([['m1', 'm2'], []]);
    expect(nodeIn(result.document, 'if2')).toEqual(ifNode('if2', 'flag', ['m1', 'm2'], []));
    expectSchemaOk(result.document);
    expectNoNewErrors(document, result.document);
  });

  it('新分支自带两个空区域（包之前没有任何区域内容）', () => {
    const document = docOf([startNode(), methodNode('m1')], ['start', 'm1']);
    const result = wrapInBranch(document, { ownerId: '', from: 1, to: 1, ifId: 'if1', cond: canvas.UNCONNECTED });

    expect(regionOfIf(result.document, 'if1')).toEqual([['m1'], []]);
  });

  it('ownerId 指向条件分支时必须指明是哪一条区域', () => {
    const document = branchDocument();
    const result = wrapInBranch(document, { ownerId: 'if1', from: 0, to: 0, ifId: 'if2', cond: '' });

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].message).toContain('请指明包进哪一条');
    expect(result.document).toBe(document);
  });

  it('可以包进分支自己的成立分支（嵌套一层）', () => {
    const document = docOf(
      [startNode(), boolNode('flag'), ifNode('if1', 'flag', ['m1'], []), methodNode('m1')],
      ['start', 'if1'],
    );
    const result = wrapInBranch(document, {
      ownerId: 'if1',
      kind: 'then',
      from: 0,
      to: 0,
      ifId: 'if2',
      cond: 'flag',
    });

    expect(result.issues).toEqual([]);
    expect(regionOfIf(result.document, 'if1')).toEqual([['if2'], []]);
    expect(regionOfIf(result.document, 'if2')).toEqual([['m1'], []]);
    expectNoNewErrors(document, result.document);
  });
});

// ---------------------------------------------------------------------------
// 解除循环
// ---------------------------------------------------------------------------

describe('解除循环', () => {
  function loopInMain(): canvas.CanvasDocument {
    return docOf(
      [startNode(), loopNode('loop1', canvas.UNCONNECTED, ['m1', 'm2']), methodNode('m1'), methodNode('m2'), methodNode('m3')],
      ['start', 'loop1', 'm3'],
      { loop1: { x: 10, y: 20 }, m1: { x: 30, y: 40 } },
    );
  }

  it('循环体按原顺序接回，循环节点消失，main 前后顺序不变，循环坐标被清理', () => {
    const document = loopInMain();
    const result = unwrapLoop(document, 'loop1');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'm1', 'm2', 'm3']);
    expect(result.document.nodes.map((node) => node.id)).toEqual(['start', 'm1', 'm2', 'm3']);
    expect(result.document.layout).toEqual({ m1: { x: 30, y: 40 } });
    expectSchemaOk(result.document);
    expectNoNewErrors(document, result.document);
  });

  it('解除循环后语句回到深度 0', () => {
    const document = loopInMain();
    const layout = canvas.analyzeFlow(applied(unwrapLoop(document, 'loop1')));

    expect(layout.issues).toEqual([]);
    expect(layout.regionOf.get('m1')).toEqual({ ownerId: '', kind: 'main' });
    expect(layout.depthOf.get('m1')).toBe(0);
  });

  it('嵌套：解除内层循环后外层结构不变', () => {
    const document = docOf(
      [startNode(), loopNode('outer', canvas.UNCONNECTED, ['inner', 'm2']), loopNode('inner', canvas.UNCONNECTED, ['m1']), methodNode('m1'), methodNode('m2')],
      ['start', 'outer'],
    );
    const result = unwrapLoop(document, 'inner');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 'outer']);
    expect(bodyOf(result.document, 'outer')).toEqual(['m1', 'm2']);
    expect(result.document.nodes.some((node) => node.id === 'inner')).toBe(false);
    expectNoNewErrors(document, result.document);
  });

  it('拒绝非循环节点', () => {
    const document = flowDocument();
    const result = unwrapLoop(document, 'm1');

    expect(codesOf(result)).toEqual(['unknown_kind']);
    expect(result.issues[0].message).toContain('不是次数循环');
    expect(result.document).toBe(document);
  });

  it('拒绝还没接进任何序列的循环', () => {
    const document = docOf([startNode(), loopNode('loop1', '', ['m1']), methodNode('m1')], ['start', 'm1']);
    const result = unwrapLoop(document, 'loop1');

    expect(codesOf(result)).toEqual(['flow_error']);
    expect(result.issues[0].message).toContain('还没有接进任何序列');
    expect(result.document).toBe(document);
  });
});

// ---------------------------------------------------------------------------
// 解除条件分支
// ---------------------------------------------------------------------------

describe('解除条件分支', () => {
  it('成立分支在前、不成立分支在后接回原位置', () => {
    const document = docOf(
      [
        startNode(),
        ifNode('if1', 'flag', ['t1', 't2'], ['e1']),
        methodNode('t1'),
        methodNode('t2'),
        methodNode('e1'),
        methodNode('tail'),
      ],
      ['start', 'if1', 'tail'],
      { if1: { x: 0, y: 0 } },
    );
    const result = unwrapBranch(document, 'if1');

    expect(result.issues).toEqual([]);
    expect(result.document.main).toEqual(['start', 't1', 't2', 'e1', 'tail']);
    expect(result.document.layout).toEqual({});
    expectSchemaOk(result.document);
    expectNoNewErrors(document, result.document);
  });

  it('嵌套：循环体里的分支展开后，循环体顺序是「成立在前、不成立在后」', () => {
    const document = docOf(
      [
        startNode(),
        loopNode('loop1', canvas.UNCONNECTED, ['if1', 'm2']),
        ifNode('if1', 'flag', ['t1'], ['e1']),
        methodNode('t1'),
        methodNode('e1'),
        methodNode('m2'),
      ],
      ['start', 'loop1'],
    );
    const result = unwrapBranch(document, 'if1');

    expect(result.issues).toEqual([]);
    expect(bodyOf(result.document, 'loop1')).toEqual(['t1', 'e1', 'm2']);
    expectNoNewErrors(document, result.document);
  });

  it('拒绝非条件分支节点', () => {
    const document = branchDocument();
    const result = unwrapBranch(document, 'm1');

    expect(codesOf(result)).toEqual(['unknown_kind']);
    expect(result.issues[0].message).toContain('不是条件分支');
    expect(result.document).toBe(document);
  });
});

// ---------------------------------------------------------------------------
// 落位后压紧
// ---------------------------------------------------------------------------

describe('落位后压紧', () => {
  /** 组合 g1 自己的坐标是 (10, 20)，行 [['a', 'b'], ['c']]。 */
  function gridDocument(): canvas.CanvasDocument {
    return docOf(
      [startNode(), intNode('a', 1), intNode('b', 2), intNode('c', 3), groupNode('g1', [['a', 'b'], ['c']])],
      ['start'],
      { g1: { x: 10, y: 20 } },
    );
  }

  it('moveMember 后坐标 = 组顶 + 行列 × 间距，组合自身坐标不动', () => {
    const document = gridDocument();
    const result = moveMember(document, 'g1', 'a', 1, 0);

    expect(codesOf(result)).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', [['b'], ['a', 'c']]));
    expect(result.document.layout).toEqual({
      g1: { x: 10, y: 20 },
      b: { x: 10, y: 20 },
      a: { x: 10, y: 20 + ROW_PITCH },
      c: { x: 10 + COL_PITCH, y: 20 + ROW_PITCH },
    });
  });

  it('removeRow 后下一行成员上移一行（坐标断言）', () => {
    const document = docOf(
      [startNode(), intNode('a', 1), intNode('b', 2), intNode('c', 3), groupNode('g1', [['a'], ['b'], ['c']])],
      ['start'],
      { g1: { x: 10, y: 20 } },
    );
    const result = removeRow(document, 'g1', 0);

    expect(result.issues).toEqual([]);
    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', [['b'], ['c']]));
    expect(result.document.layout).toEqual({
      g1: { x: 10, y: 20 },
      b: { x: 10, y: 20 },
      c: { x: 10, y: 20 + ROW_PITCH },
    });
  });

  it('insertRowAfter 插入的空行不产生空坐标，成员仍按行压紧', () => {
    const document = gridDocument();
    const result = insertRowAfter(document, 'g1', 0);

    expect(nodeIn(result.document, 'g1')).toEqual(groupNode('g1', [['a', 'b'], [], ['c']]));
    expect(result.document.layout).toEqual({
      g1: { x: 10, y: 20 },
      a: { x: 10, y: 20 },
      b: { x: 10 + COL_PITCH, y: 20 },
      c: { x: 10, y: 20 + 2 * ROW_PITCH },
    });
    expect(Object.keys(result.document.layout).filter((id) => id === '')).toEqual([]);
  });

  it('组合没有自身坐标时用成员左上角作为组顶/组左', () => {
    const document = docOf(
      [startNode(), intNode('a', 1), intNode('b', 2), intNode('c', 3), groupNode('g1', [['a', 'b'], ['c']])],
      ['start'],
      { a: { x: 5, y: 7 }, b: { x: 400, y: 7 }, c: { x: 5, y: 300 } },
    );
    const result = moveMember(document, 'g1', 'c', 0, 2);

    expect(result.document.layout).toEqual({
      a: { x: 5, y: 7 },
      b: { x: 5 + COL_PITCH, y: 7 },
      c: { x: 5 + 2 * COL_PITCH, y: 7 },
    });
    expect(result.document.layout.g1).toBeUndefined();
  });

  it('压紧只改坐标，不新增校验错误', () => {
    const document = gridDocument();
    const moved = applied(moveMember(document, 'g1', 'b', 1, 1));
    const inserted = applied(insertRowAfter(moved, 'g1', 1));
    const removed = applied(removeRow(inserted, 'g1', 0));

    expectNoNewErrors(document, removed);
  });
});
