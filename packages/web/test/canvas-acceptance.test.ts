import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_ROW_MEMBERS, canvas } from '@pwn2block/shared';
import {
  COL_PITCH,
  addNode,
  appendStatement,
  connect,
  createGroup,
  dissolveGroup,
  insertRowAfter,
  insertStatement,
  moveMember,
  moveStatement,
  removeNodes,
  removeRow,
  setValue,
  unwrapBranch,
  unwrapLoop,
  wrapInLoop,
  type CanvasEdit,
} from '../src/canvas/editor';
import { layoutCanvas, type CanvasLayoutView, type Rect } from '../src/canvas/view-model';
import { unionRects } from '../src/canvas/view-model-geometry';
import { CanvasHistory } from '../src/components/canvas-panel-history';
import { dropEditOf } from '../src/components/canvas-panel-commands';
import { dropLabelOf, dropTargetFor, type DropTarget } from '../src/components/canvas-panel-geometry';
import { legacyDetailOf } from '../src/components/canvas-panel-legacy';
import {
  canvasV2StorageKey,
  loadCanvas,
  makeCanvasSave,
  parseCanvasSave,
  saveCanvas,
  type CanvasStore,
} from '../src/canvas/save';
import { discardLegacyArchives, legacyArchiveFile, legacyArchiveNotice, scanLegacyArchives } from '../src/canvas/archive';

/**
 * 《节点画布大型修改》验收表里能用自动化断言的三条：AT-15、AT-16、AT-20。
 *
 * 全部走**真实命令序列**（`canvas/editor`）+ 纯函数视图模型，不碰 DOM：
 * - AT-15 循环包络与条件分支的结构（区域归属、互不干扰、没有一键合并）；
 * - AT-16 吸附 / 脱离 / 换行 / 删成员 / 撤销（行与 main 的结构，加上吸附落位预览）；
 * - AT-20 旧存档扫描导出、旧档不静默覆盖、新版往返。
 *
 * 三处「结构等价」近似在各自用例的注释里写明了原因（界面断言无法在 node 环境里做）。
 */

function docOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[] = [],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
): canvas.CanvasDocument {
  return { format: canvas.CANVAS_FORMAT, version: canvas.CANVAS_VERSION, nodes, layout, main };
}

/** 命令必须成功：被拒绝就直接让用例失败，免得后续断言在旧文档上「碰巧」通过。 */
function applied(edit: CanvasEdit): canvas.CanvasDocument {
  if (edit.issues.length > 0) throw new Error(`命令被拒绝：${edit.issues.map((issue) => issue.message).join('；')}`);
  return edit.document;
}

/** 结构命令被拒绝时文档原样返回，只带一条问题（这是「不悄悄合并」的证据）。 */
function expectRefused(document: canvas.CanvasDocument, edit: CanvasEdit, code: string): void {
  expect(edit.document).toBe(document);
  expect(edit.issues.map((issue) => issue.code)).toEqual([code]);
}

function nodeIn(document: canvas.CanvasDocument, id: string): canvas.CanvasNode {
  const node = canvas.nodeMapOf(document).get(id);
  if (node === undefined) throw new Error(`文档里缺少节点「${id}」`);
  return node;
}

function groupRowsOf(document: canvas.CanvasDocument, groupId: string): readonly (readonly string[])[] {
  const node = nodeIn(document, groupId);
  if (node.kind !== 'group') throw new Error(`节点「${groupId}」不是组合`);
  return node.rows;
}

function bodyOf(document: canvas.CanvasDocument, loopId: string): readonly string[] {
  const node = nodeIn(document, loopId);
  if (node.kind !== 'loop') throw new Error(`节点「${loopId}」不是循环`);
  return node.body;
}

function regionsOf(
  document: canvas.CanvasDocument,
  ifId: string,
): { readonly then: readonly string[]; readonly else: readonly string[] } {
  const node = nodeIn(document, ifId);
  if (node.kind !== 'if') throw new Error(`节点「${ifId}」不是条件分支`);
  return { then: node.then, else: node.else };
}

/** 结构快照：只比「行」与「main」，坐标不参与（移动与重排的区别，需求 §2.2）。 */
function structureOf(
  document: canvas.CanvasDocument,
  groupId: string,
): { readonly rows: readonly (readonly string[])[]; readonly main: readonly string[] } {
  return { rows: groupRowsOf(document, groupId), main: document.main };
}

// ---------------------------------------------------------------------------
// AT-15：循环包络与条件分支
// ---------------------------------------------------------------------------

/** 开始 → 次数循环（循环体两条语句）→ 尾部语句，全部用真实命令搭。 */
function loopDocument(): canvas.CanvasDocument {
  let document = docOf([]);
  document = applied(addNode(document, 'start', 'start', { x: 0, y: 0 }));
  document = applied(appendStatement(document, 'start'));
  document = applied(addNode(document, 'loop', 'loop1', { x: 0, y: 200 }));
  document = applied(addNode(document, 'value', 'count', { x: 240, y: 200 }));
  document = applied(setValue(document, 'count', { kind: 'int', value: '2' }));
  document = applied(connect(document, 'loop1', 'count', 'count'));
  document = applied(addNode(document, 'method', 'm1', { x: 0, y: 320 }));
  document = applied(addNode(document, 'method', 'm2', { x: 240, y: 320 }));
  document = applied(insertStatement(document, { ownerId: 'loop1', kind: 'body' }, 0, 'm1'));
  document = applied(insertStatement(document, { ownerId: 'loop1', kind: 'body' }, 1, 'm2'));
  document = applied(appendStatement(document, 'loop1'));
  document = applied(addNode(document, 'method', 'tail', { x: 0, y: 440 }));
  return applied(appendStatement(document, 'tail'));
}

/** 开始 → 条件分支（成立/不成立各一条语句）→ 尾部语句。 */
function branchDocument(): canvas.CanvasDocument {
  let document = docOf([]);
  document = applied(addNode(document, 'start', 'start', { x: 0, y: 0 }));
  document = applied(appendStatement(document, 'start'));
  document = applied(addNode(document, 'value', 'flag', { x: 240, y: 0 }));
  document = applied(setValue(document, 'flag', { kind: 'bool', value: true }));
  document = applied(addNode(document, 'if', 'if1', { x: 0, y: 120 }));
  document = applied(connect(document, 'if1', 'cond', 'flag'));
  document = applied(appendStatement(document, 'if1'));
  document = applied(addNode(document, 'method', 'then1', { x: 0, y: 260 }));
  document = applied(addNode(document, 'method', 'else1', { x: 240, y: 260 }));
  document = applied(insertStatement(document, { ownerId: 'if1', kind: 'then' }, 0, 'then1'));
  document = applied(insertStatement(document, { ownerId: 'if1', kind: 'else' }, 0, 'else1'));
  document = applied(addNode(document, 'method', 'tail', { x: 0, y: 380 }));
  return applied(appendStatement(document, 'tail'));
}

/** 开始 → m1 → m2 → 尾部语句，全部排在 main 里（给「包络为循环」准备素材）。 */
function straightDocument(): canvas.CanvasDocument {
  let document = docOf([]);
  document = applied(addNode(document, 'start', 'start', { x: 0, y: 0 }));
  document = applied(appendStatement(document, 'start'));
  document = applied(addNode(document, 'method', 'm1', { x: 0, y: 120 }));
  document = applied(appendStatement(document, 'm1'));
  document = applied(addNode(document, 'method', 'm2', { x: 0, y: 240 }));
  document = applied(appendStatement(document, 'm2'));
  document = applied(addNode(document, 'method', 'tail', { x: 0, y: 360 }));
  return applied(appendStatement(document, 'tail'));
}

describe('AT-15 循环包络与条件分支', () => {
  it('连续流程放进循环体：body 顺序即执行顺序，main 顺序不变', () => {
    const document = loopDocument();

    expect(document.main).toEqual(['start', 'loop1', 'tail']);
    expect(bodyOf(document, 'loop1')).toEqual(['m1', 'm2']);

    const layout = canvas.analyzeFlow(document);
    expect(layout.issues).toEqual([]);
    expect(layout.regionOf.get('loop1')).toEqual({ ownerId: '', kind: 'main' });
    expect(layout.regionOf.get('m1')).toEqual({ ownerId: 'loop1', kind: 'body' });
    expect(layout.regionOf.get('tail')).toEqual({ ownerId: '', kind: 'main' });
    expect(layout.depthOf.get('m1')).toBe(1);
    expect(layout.depthOf.get('tail')).toBe(0);
  });

  it('包络为循环：同一区域连续语句进 body，原位置留循环，展开后回到原来的顺序', () => {
    // 验收表 AT-15「同一区域连续流程包络为循环再解除」：一个来回，两边的顺序都写死。
    const document = straightDocument();
    const wrapped = applied(
      wrapInLoop(document, { ownerId: '', from: 1, to: 2, loopId: 'loop1', count: canvas.UNCONNECTED }),
    );

    expect(wrapped.main).toEqual(['start', 'loop1', 'tail']);
    expect(bodyOf(wrapped, 'loop1')).toEqual(['m1', 'm2']);
    const wrappedLayout = canvas.analyzeFlow(wrapped);
    expect(wrappedLayout.issues).toEqual([]);
    expect(wrappedLayout.regionOf.get('m1')).toEqual({ ownerId: 'loop1', kind: 'body' });
    expect(wrappedLayout.depthOf.get('m1')).toBe(1);

    const unwrapped = applied(unwrapLoop(wrapped, 'loop1'));
    expect(unwrapped.main).toEqual(['start', 'm1', 'm2', 'tail']);
    expect(unwrapped.nodes.some((node) => node.id === 'loop1')).toBe(false);
  });

  it('解除循环：循环体按原顺序接回 main，循环节点消失，深度回到 0', () => {
    const document = loopDocument();
    const unwrapped = applied(unwrapLoop(document, 'loop1'));

    expect(unwrapped.main).toEqual(['start', 'm1', 'm2', 'tail']);
    expect(unwrapped.nodes.map((node) => node.id)).toEqual(['start', 'count', 'm1', 'm2', 'tail']);
    expect(unwrapped.layout.loop1).toBeUndefined();

    const layout = canvas.analyzeFlow(unwrapped);
    expect(layout.issues).toEqual([]);
    expect(layout.regionOf.get('m1')).toEqual({ ownerId: '', kind: 'main' });
    expect(layout.depthOf.get('m1')).toBe(0);

    // 数据组合的命令仍然只认组合：循环不会被当成组合悄悄删掉或合并。
    expectRefused(document, dissolveGroup(document, 'loop1'), 'unknown_kind');
    expect(bodyOf(document, 'loop1')).toEqual(['m1', 'm2']);
  });

  it('条件分支自带两个区域，两条区域互不干扰', () => {
    const document = branchDocument();

    expect(regionsOf(document, 'if1')).toEqual({ then: ['then1'], else: ['else1'] });
    const layout = canvas.analyzeFlow(document);
    expect(layout.issues).toEqual([]);
    expect(layout.regionOf.get('then1')).toEqual({ ownerId: 'if1', kind: 'then' });
    expect(layout.regionOf.get('else1')).toEqual({ ownerId: 'if1', kind: 'else' });
    expect(layout.depthOf.get('then1')).toBe(1);
    expect(layout.depthOf.get('tail')).toBe(0);

    // 往成立分支再加一条语句：不成立分支一个字节都不动。
    const extended = applied(
      insertStatement(
        applied(addNode(document, 'method', 'then2', { x: 240, y: 260 })),
        { ownerId: 'if1', kind: 'then' },
        1,
        'then2',
      ),
    );
    expect(regionsOf(extended, 'if1')).toEqual({ then: ['then1', 'then2'], else: ['else1'] });

    // 同一条语句不能同时出现在两条区域里：两条路径不共享节点，也就不存在「合流」结构。
    expectRefused(extended, insertStatement(extended, { ownerId: 'if1', kind: 'else' }, 0, 'then1'), 'flow_error');

    // 区域内部换位只影响自己那条序列。
    const moved = applied(moveStatement(extended, { ownerId: 'if1', kind: 'then' }, 1, 0));
    expect(regionsOf(moved, 'if1')).toEqual({ then: ['then2', 'then1'], else: ['else1'] });
    expect(moved.main).toEqual(document.main);
  });

  it('不存在含糊的一键合并分支：解除分支按「成立在前、不成立在后」顺序展开，删除分支也不会合并两条路径', () => {
    const document = branchDocument();

    // 数据组合的命令仍然只认组合：条件分支不是组合，行列命令也不认它。
    expectRefused(document, dissolveGroup(document, 'if1'), 'unknown_kind');
    expectRefused(document, removeRow(document, 'if1', 0), 'unknown_kind');
    expectRefused(document, insertRowAfter(document, 'if1'), 'unknown_kind');
    expectRefused(document, moveMember(document, 'if1', 'then1', 0, 0), 'unknown_kind');

    // 唯一的「解除」是确定的顺序展开：then 在前、else 在后接回原位置。没有合流节点，
    // 也没有任何一步把两条路径的语句同时放进一条序列（那才是「含糊合并」）。
    const expanded = applied(unwrapBranch(document, 'if1'));
    expect(expanded.main).toEqual(['start', 'then1', 'else1', 'tail']);
    expect(expanded.nodes.some((node) => node.kind === 'if')).toBe(false);
    expect(expanded.layout.if1).toBeUndefined();

    // 删分支是「删除」，连带删两条区域的语句；没有任何序列同时装着两条路径的语句。
    const removal = removeNodes(document, ['if1']);
    expect(removal.removed).toEqual(['if1', 'then1', 'else1']);
    expect(removal.document.main).toEqual(['start', 'tail']);
    expect(removal.document.nodes.map((node) => node.id)).toEqual(['start', 'flag', 'tail']);
    for (const node of removal.document.nodes) {
      for (const sequence of canvas.flowChildrenOf(node)) {
        expect(sequence.includes('then1') && sequence.includes('else1')).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AT-16：吸附、脱离、换行、删除组内成员并撤销
// ---------------------------------------------------------------------------

/**
 * 两个成员两行的吸附组：a b c 在第一行、d 在第二行。
 *
 * 坐标按视图模型的盒子尺寸摆（值节点 180×94：标题 + 「值」「预览」两行），所以
 * 第一行行带是 y 0–94、第二行 100–194，组合包络外扩 12、吸附命中区再外扩 32。
 * 下面两条吸附用例的落点坐标就按这套几何算，改视图模型尺寸时它们会立刻红。
 */
function gridDocument(): canvas.CanvasDocument {
  const nodes: readonly canvas.CanvasNode[] = [
    { kind: 'start', id: 'start' },
    { kind: 'value', id: 'a', value: { kind: 'byte', hex: '20' } },
    { kind: 'value', id: 'b', value: { kind: 'byte', hex: '21' } },
    { kind: 'value', id: 'c', value: { kind: 'byte', hex: '22' } },
    { kind: 'value', id: 'd', value: { kind: 'byte', hex: '23' } },
  ];
  const layout = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 400, y: 0 }, d: { x: 0, y: 100 } };
  let document = docOf(nodes, ['start'], layout);
  document = applied(createGroup(document, ['a', 'b', 'c', 'd'], 'g1'));
  return applied(moveMember(document, 'g1', 'd', 1, 0));
}

function boxRectOf(view: CanvasLayoutView, nodeId: string): Rect {
  const box = view.boxes.find((item) => item.id === `node:${nodeId}`);
  if (box === undefined) throw new Error(`视图里没有节点「${nodeId}」的盒子`);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** 一行在画布上占的带：成员盒子的并集（与 `canvas-panel-geometry.rowBandsOf` 同口径）。 */
function rowBandOf(view: CanvasLayoutView, memberIds: readonly string[]): Rect {
  const union = unionRects(memberIds.map((memberId) => boxRectOf(view, memberId)));
  if (union === undefined) throw new Error('行带算不出来：成员没有盒子');
  return union;
}

function groupTargetOf(target: DropTarget | undefined): Extract<DropTarget, { readonly kind: 'group' }> {
  if (target === undefined || target.kind !== 'group') throw new Error('落点不在组合里');
  return target;
}

describe('AT-16 吸附、脱离、换行、删除组内成员并撤销', () => {
  it('成组时按 CANVAS_MAX_ROW_MEMBERS 换行，行内顺序与成员总数一致', () => {
    const ids = Array.from({ length: CANVAS_MAX_ROW_MEMBERS + 1 }, (_, index) => `n${index + 1}`);
    const nodes = ids.map((id): canvas.CanvasNode => ({ kind: 'value', id, value: { kind: 'byte', hex: '00' } }));
    const document = applied(createGroup(docOf(nodes), ids, 'g1'));

    const rows = groupRowsOf(document, 'g1');
    expect(rows.map((row) => row.length)).toEqual([CANVAS_MAX_ROW_MEMBERS, 1]);
    expect(rows.flat()).toEqual(ids);
    expect(rows.every((row) => row.length > 0 && row.length <= CANVAS_MAX_ROW_MEMBERS)).toBe(true);
  });

  it('吸附预览「插入当前行」：指示条整行高亮，落位行列与预览一致', () => {
    const document = gridDocument();
    const view = layoutCanvas({ document });
    const target = groupTargetOf(dropTargetFor(document, view, { x: 100, y: 40 }, ['d']));

    expect(target.groupId).toBe('g1');
    expect(target.newRow).toBe(false);
    expect(target.rowIndex).toBe(0);
    expect(target.columnIndex).toBe(1);
    expect(dropLabelOf(target)).toBe('插入当前行');
    // 「预览清楚」的结构断言：指示条就是这一行的行带（成员盒子并集），不是一条没有含义的缝。
    expect(target.slot).toEqual(rowBandOf(view, ['a', 'b', 'c']));

    const moved = applied(moveMember(document, 'g1', 'd', target.rowIndex, target.columnIndex));
    const rows = groupRowsOf(moved, 'g1');
    expect(rows).toEqual([['a', 'd', 'b', 'c']]);
    expect(rows[0]?.[1]).toBe('d');
    expect(rows.every((row) => row.length > 0)).toBe(true);
    // 落位后压紧（需求 §6.2）：行 y = 组顶 + 行号 × ROW_PITCH、列 x = 组左 + 列号 × COL_PITCH。
    // 这个组合没有自身坐标，组顶/组左取成员左上角（a 的 (0, 0)），所以 `d` 正好落在 (200, 0)：
    // 「插到当前行的第 1 列」在坐标上就是它真的排到了 a 右边，而不是只改了 `rows`。
    expect(moved.layout).toEqual({
      a: { x: 0, y: 0 },
      d: { x: COL_PITCH, y: 0 },
      b: { x: 2 * COL_PITCH, y: 0 },
      c: { x: 3 * COL_PITCH, y: 0 },
    });
    expect(moved.layout).not.toEqual(document.layout);
  });

  it('吸附预览「新增一行」，落位后成为最后一行', () => {
    const document = gridDocument();
    const view = layoutCanvas({ document });
    const target = groupTargetOf(dropTargetFor(document, view, { x: 100, y: 220 }, ['a']));

    expect(target.newRow).toBe(true);
    expect(target.rowIndex).toBe(groupRowsOf(document, 'g1').length);
    expect(target.columnIndex).toBe(0);
    expect(dropLabelOf(target)).toBe('新增一行');

    const moved = applied(moveMember(document, 'g1', 'a', target.rowIndex, target.columnIndex));
    const rows = groupRowsOf(moved, 'g1');
    expect(rows).toEqual([['b', 'c'], ['d'], ['a']]);
    expect(rows.length - 1).toBe(target.rowIndex);
    expect(rows.every((row) => row.length > 0)).toBe(true);
  });

  it('删除组内成员后空行消失，幸存成员的相对顺序不变', () => {
    const document = gridDocument();
    const before = groupRowsOf(document, 'g1').flat();

    const removal = removeNodes(document, ['d']);
    expect(removal.removed).toEqual(['d']);
    const rows = groupRowsOf(removal.document, 'g1');
    expect(rows).toEqual([['a', 'b', 'c']]);
    expect(rows.every((row) => row.length > 0)).toBe(true);
    expect(rows.flat()).toEqual(before.filter((id) => id !== 'd'));
    expect(removal.document.main).toEqual(['start']);
  });

  it('成员移出组合（脱离）：行里去掉它、剩余成员补位，组合与 main 都还在', () => {
    const document = gridDocument();
    const outcome = dropEditOf(document, { kind: 'stage', slot: { x: 0, y: 600, width: 0, height: 0 } }, ['d']);

    expect(outcome.message).toContain('移出组合');
    const rows = groupRowsOf(outcome.edit.document, 'g1');
    expect(rows).toEqual([['a', 'b', 'c']]);
    expect(rows.every((row) => row.length > 0)).toBe(true);
    expect(canvas.ownerMapOf(outcome.edit.document).get('d')).toBeUndefined();
    expect(outcome.edit.document.main).toEqual(document.main);
  });

  it('每次结构操作都能单次撤销回到操作前的行与 main', () => {
    const initial = gridDocument();
    const history = new CanvasHistory();
    let current = initial;

    const operations: readonly ((document: canvas.CanvasDocument) => CanvasEdit)[] = [
      (document) => moveMember(document, 'g1', 'd', 0, 1),
      (document) => insertRowAfter(document, 'g1', 0),
      (document) => moveMember(document, 'g1', 'c', 1, 0),
      (document) => removeRow(document, 'g1', 1),
      (document) => ({ document: removeNodes(document, ['b']).document, issues: [] }),
    ];

    for (const operation of operations) {
      const before = structureOf(current, 'g1');
      history.push(current);
      current = applied(operation(current));
      const undone = history.undo(current);
      expect(undone).toBeDefined();
      if (undone === undefined) return;
      current = undone;
      expect(structureOf(current, 'g1')).toEqual(before);
    }

    // 五次撤销走完整圈：回到最初那份文档本身，不是「结构碰巧一样」的新文档。
    expect(current).toBe(initial);
  });
});

// ---------------------------------------------------------------------------
// AT-20：旧存档、导出、新建
// ---------------------------------------------------------------------------

type TestStore = CanvasStore & {
  readonly length: number;
  key(index: number): string | null;
};

function memoryStore(initial: Readonly<Record<string, string>> = {}): {
  readonly store: TestStore;
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const store: TestStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
      return true;
    },
    removeItem: (key) => data.delete(key),
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
  };
  return { store, data };
}

/** Blockly 时代的积木存档：没有 `format`，只能靠顶层 `blocks` 认出。 */
const BLOCKLY_RAW = JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'p2b_action_feed' }] } });
/** 上一版画布文档：`format` 对、版本不是 2。 */
const OLD_CANVAS_RAW = JSON.stringify({ format: 'pwn2block.canvas', version: 1, nodes: [], layout: {}, main: [] });
/** 旧工作流文档：既是「不兼容」提示的来源，也是旧画布时代真正会存下来的东西。 */
const WORKFLOW_RAW = JSON.stringify({ format: 'pwn2block.workflow', version: 3, nodes: [] });

const LEGACY_SEED: Readonly<Record<string, string>> = {
  'pwn2block.canvas.v1.demo': OLD_CANVAS_RAW,
  'pwn2block.graph.v1.demo': BLOCKLY_RAW,
};

describe('AT-20 旧存档、导出、新建', () => {
  it('两条旧档都能扫出来，导出的原文与写入逐字相等', () => {
    const { store } = memoryStore(LEGACY_SEED);
    const archives = scanLegacyArchives(store, 'demo');

    expect(archives.map((archive) => archive.key)).toEqual([
      'pwn2block.canvas.v1.demo',
      'pwn2block.graph.v1.demo',
    ]);
    expect(archives.map((archive) => archive.format)).toEqual(['pwn2block.canvas', 'blockly']);

    const exported = Object.fromEntries(archives.map((archive) => [archive.key, legacyArchiveFile(archive).text]));
    expect(exported).toEqual(LEGACY_SEED);

    const notice = legacyArchiveNotice(archives);
    expect(notice.title).toContain('新版画布读不了');
    expect(notice.body).toContain('旧存档不会被自动迁移');
  });

  it('只有旧档时 loadCanvas 不读旧键，旧档的「不兼容」由扫描与存档解析给出', () => {
    // 与任务描述的差别记在这里：`loadCanvas` 只读 `pwn2block.canvas.v2.<题目>`，
    // 所以「只有旧键」时它回答 `empty`（新画布），不是 `corrupt`；`corrupt` 只出现在
    // v2 键里装着读不出来的内容时（旧工作流原文就是这种情况）。
    const memory = memoryStore(LEGACY_SEED);
    const loaded = loadCanvas(memory.store, 'demo');
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('empty');
    expect([...memory.data.entries()]).toEqual(Object.entries(LEGACY_SEED));

    const seeded = memoryStore({ [canvasV2StorageKey('demo')]: WORKFLOW_RAW });
    const corrupt = loadCanvas(seeded.store, 'demo');
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) return;
    expect(corrupt.reason).toBe('corrupt');
    expect(corrupt.raw).toBe(WORKFLOW_RAW);

    const detail = legacyDetailOf(WORKFLOW_RAW, 'demo');
    expect(detail?.legacy.reason).toBe('legacy');
    expect(detail?.legacy.message).toContain('旧版画布存档');

    // 上一版画布原文（format 对、version 1）经 `parseCanvasSave` 得到的失败原因是 `version`
    // 而不是 `legacy`，所以 `legacyDetailOf` 不会为它发「旧版画布存档」提示。
    // 也就是说「旧档明确提示不兼容」目前只覆盖 `pwn2block.workflow` 这一类。
    expect(legacyDetailOf(OLD_CANVAS_RAW, 'demo')).toBeUndefined();
  });

  it('主动新建并保存新版画布：旧档原样保留，v2 档能读回', () => {
    const memory = memoryStore(LEGACY_SEED);
    const document = gridDocument();

    expect(saveCanvas(memory.store, 'demo', document)).toBe(true);
    expect(memory.data.get('pwn2block.canvas.v1.demo')).toBe(OLD_CANVAS_RAW);
    expect(memory.data.get('pwn2block.graph.v1.demo')).toBe(BLOCKLY_RAW);
    expect(memory.data.has(canvasV2StorageKey('demo'))).toBe(true);

    const loaded = loadCanvas(memory.store, 'demo');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document).toEqual(document);
  });

  it('丢弃旧档只删探测到的旧键，v2 键不受影响', () => {
    const memory = memoryStore({ ...LEGACY_SEED });
    expect(saveCanvas(memory.store, 'demo', gridDocument())).toBe(true);

    expect(discardLegacyArchives(memory.store, 'demo')).toBe(2);
    expect([...memory.data.keys()]).toEqual([canvasV2StorageKey('demo')]);
    expect(loadCanvas(memory.store, 'demo').ok).toBe(true);
  });

  it('新版往返：makeCanvasSave → parseCanvasSave 与原文档等价', () => {
    // 实际签名是 `makeCanvasSave(challengeId, document)`（题目 id 在前）。
    const document = gridDocument();
    const save = makeCanvasSave('demo', document);

    const parsed = parseCanvasSave(JSON.parse(JSON.stringify(save)), 'demo');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.challengeId).toBe('demo');
    expect(parsed.save.document).toEqual(document);
  });
});
