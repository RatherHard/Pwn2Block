// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import type { CanvasLayoutView } from '../src/canvas/view-model';
import type { Point, Rect } from '../src/canvas/view-model';
import { compileCanvas } from '../src/canvas/compile';
import { layoutCanvas } from '../src/canvas/view-model';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { dropEditOf } from '../src/components/canvas-panel-commands';
import { FLOW_APPEND_GAP, FLOW_DATA_REFUSAL, flowBandAt, flowDropAt, flowDropLabelOf } from '../src/components/canvas-panel-flow-drop';
import type { DropTarget } from '../src/components/canvas-panel-geometry';

/**
 * 拖动落点 → 流程序列的插位（需求 §5.2、§6.2）。
 *
 * 这一层是「把语句排进流程」的入口：没有它，工具箱加出来的方法节点永远留在 `main` 外面，
 * 界面拼不出可执行程序。所以这里既测纯函数（区域、下标、末尾追加、最近行带），
 * 也测命令映射（`dropEditOf`）与面板级真实拖动（加节点 → 拖进 `main` → 编译得出来）。
 *
 * 坐标全部手写：`flowDropAt` 只读 `rectOf` 这张表，盒子怎么来与判定无关；
 * 面板级用例才走真实视图模型（`layoutCanvas`），因为那时要验的是「拖到开始节点下方」这条操作。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };
const MAIN: canvas.FlowRegionRef = { ownerId: '', kind: 'main' };

/** 开始节点在测试坐标里的盒子：100..280 × 100..172（下缘 172 是「末尾追加」的基准线）。 */
const START_RECT: Rect = { x: 100, y: 100, width: 180, height: 72 };

function methodNode(id: string): canvas.MethodNode {
  return { id, kind: 'method', block: 'emit', args: {} };
}

function valueNode(id: string): canvas.ValueNode {
  return { id, kind: 'value', value: { kind: 'int', value: '1' } };
}

/** 一个测试文档 + 它的盒子表：`rectOf` 就是判定要的那张表。 */
interface Fixture {
  readonly document: canvas.CanvasDocument;
  readonly rectOf: (nodeId: string) => Rect | undefined;
}

function fixtureOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[],
  rects: Readonly<Record<string, Rect>>,
): Fixture {
  const layout: Record<string, canvas.CanvasNodeLayout> = {};
  for (const [id, rect] of Object.entries(rects)) layout[id] = { x: rect.x, y: rect.y };
  return {
    document: { ...canvas.emptyCanvasDocument(), nodes, layout, main },
    rectOf: (nodeId: string) => rects[nodeId],
  };
}

/** 还没排进序列的文档：给 `dropEditOf` 用（它只读结构，不需要坐标）。 */
function looseDocument(nodes: readonly canvas.CanvasNode[], main: readonly string[]): canvas.CanvasDocument {
  const layout: Record<string, canvas.CanvasNodeLayout> = {};
  nodes.forEach((node, index) => (layout[node.id] = { x: 40 + index * 20, y: 40 + index * 20 }));
  return { ...canvas.emptyCanvasDocument(), nodes, layout, main };
}

function dropAt(fixture: Fixture, point: Point, dragged: readonly string[]): DropTarget | undefined {
  return flowDropAt({ document: fixture.document, rectOf: fixture.rectOf, point, dragged });
}

function flowTarget(region: canvas.FlowRegionRef, index: number): DropTarget {
  return { kind: 'flow', region, index, slot: { x: 0, y: 0, width: 4, height: 40 } };
}

// ---------------------------------------------------------------------------
// 纯函数：落点 → 区域 + 下标
// ---------------------------------------------------------------------------

describe('flowDropAt：顶层序列与下标', () => {
  it('落在第一个成员中心左侧 → index 0', () => {
    const fixture = fixtureOf([START, methodNode('m1')], ['start'], { start: START_RECT });
    const target = dropAt(fixture, { x: 120, y: 130 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: MAIN, index: 0 });
  });

  it('落在第一个成员中心右侧 → index 1', () => {
    const fixture = fixtureOf([START, methodNode('m1')], ['start'], { start: START_RECT });
    const target = dropAt(fixture, { x: 260, y: 130 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: MAIN, index: 1 });
  });

  it('落在最后一个成员下方 → 插到末尾，指示条是一根横条', () => {
    const fixture = fixtureOf([START, methodNode('m1')], ['start'], { start: START_RECT });
    const target = dropAt(fixture, { x: 190, y: 200 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: MAIN, index: 1 });
    if (target === undefined) throw new Error('没有命中流程带');
    // 横条：宽度等于行带，高度是指示条粗细（4）。
    expect(target.slot.width).toBe(START_RECT.width);
    expect(target.slot.height).toBe(4);
    expect(target.slot.y).toBeGreaterThan(START_RECT.y + START_RECT.height);
  });

  it('末尾追加的余量正好是 FLOW_APPEND_GAP：差一点也算，再远就不算', () => {
    const fixture = fixtureOf([START, methodNode('m1')], ['start'], { start: START_RECT });
    const bottom = START_RECT.y + START_RECT.height;
    expect(dropAt(fixture, { x: 190, y: bottom + FLOW_APPEND_GAP }, ['m1'])).toMatchObject({ index: 1 });
    expect(dropAt(fixture, { x: 190, y: bottom + FLOW_APPEND_GAP + 1 }, ['m1'])).toBeUndefined();
  });

  it('离行带太远（下方远处、横向走开）都不命中', () => {
    const fixture = fixtureOf([START, methodNode('m1')], ['start'], { start: START_RECT });
    expect(dropAt(fixture, { x: 190, y: 600 }, ['m1'])).toBeUndefined();
    expect(dropAt(fixture, { x: 600, y: 130 }, ['m1'])).toBeUndefined();
  });
});

describe('flowDropAt：区域序列', () => {
  /** 循环体在顶层那句的下方：240..312 是成员盒子，吸附光环 216..336。 */
  function loopFixture(): Fixture {
    return fixtureOf(
      [START, { id: 'loop1', kind: 'loop', count: '', body: ['b1'] }, methodNode('b1'), methodNode('m1')],
      ['start', 'loop1'],
      {
        start: START_RECT,
        loop1: { x: 400, y: 100, width: 180, height: 72 },
        b1: { x: 400, y: 240, width: 180, height: 72 },
      },
    );
  }

  it('落在循环体成员上 → 该循环的 body', () => {
    const target = dropAt(loopFixture(), { x: 450, y: 260 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: { ownerId: 'loop1', kind: 'body' }, index: 0 });
  });

  it('落在成立分支的成员上 → 该分支的 then', () => {
    const fixture = fixtureOf(
      [START, { id: 'if1', kind: 'if', cond: '', then: ['t1'], else: [] }, methodNode('t1'), methodNode('m1')],
      ['start', 'if1'],
      {
        start: START_RECT,
        if1: { x: 400, y: 100, width: 180, height: 120 },
        t1: { x: 400, y: 400, width: 180, height: 72 },
      },
    );
    const target = dropAt(fixture, { x: 450, y: 430 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: { ownerId: 'if1', kind: 'then' }, index: 0 });
  });

  it('空的不成立分支：容器下半部分就是命中区', () => {
    const fixture = fixtureOf(
      [START, { id: 'if1', kind: 'if', cond: '', then: ['t1'], else: [] }, methodNode('t1'), methodNode('m1')],
      ['start', 'if1'],
      {
        start: START_RECT,
        if1: { x: 400, y: 100, width: 180, height: 120 },
        t1: { x: 400, y: 400, width: 180, height: 72 },
      },
    );
    const target = dropAt(fixture, { x: 490, y: 200 }, ['m1']);
    expect(target).toMatchObject({ kind: 'flow', region: { ownerId: 'if1', kind: 'else' }, index: 0 });
  });

  it('两条分支都空：下半部分左右分开，右边才是不成立分支', () => {
    const fixture = fixtureOf(
      [START, { id: 'if1', kind: 'if', cond: '', then: [], else: [] }, methodNode('m1')],
      ['start', 'if1'],
      { start: START_RECT, if1: { x: 400, y: 100, width: 180, height: 120 } },
    );
    expect(dropAt(fixture, { x: 430, y: 200 }, ['m1'])).toMatchObject({ region: { ownerId: 'if1', kind: 'then' } });
    expect(dropAt(fixture, { x: 560, y: 200 }, ['m1'])).toMatchObject({ region: { ownerId: 'if1', kind: 'else' } });
  });

  it('两条序列上下相邻时取离 point.y 最近的那条', () => {
    const fixture = fixtureOf(
      // 循环体 190..262：吸附光环 166..286，与顶层（76..196）重叠一段。
      [START, { id: 'loop1', kind: 'loop', count: '', body: ['b1'] }, methodNode('b1'), methodNode('m1')],
      ['start', 'loop1'],
      {
        start: START_RECT,
        loop1: { x: 400, y: 100, width: 180, height: 72 },
        b1: { x: 400, y: 190, width: 180, height: 72 },
      },
    );
    expect(dropAt(fixture, { x: 190, y: 170 }, ['m1'])).toMatchObject({ region: MAIN });
    expect(dropAt(fixture, { x: 500, y: 190 }, ['m1'])).toMatchObject({ region: { ownerId: 'loop1', kind: 'body' } });
  });
});

describe('flowDropAt：只认单节点拖动的流程节点', () => {
  it('数据节点落在流程带上返回 undefined，但同一落点的流程带仍然存在（用来给原因）', () => {
    const fixture = fixtureOf([START, valueNode('v1'), methodNode('m1')], ['start'], { start: START_RECT });
    const point = { x: 190, y: 130 };
    expect(dropAt(fixture, point, ['v1'])).toBeUndefined();
    expect(flowBandAt({ document: fixture.document, rectOf: fixture.rectOf, point, dragged: ['v1'] })).toMatchObject({
      region: MAIN,
    });
  });

  it('多选拖动不命中流程带（也不给「数据节点不进流程」那类提示）', () => {
    const fixture = fixtureOf([START, methodNode('m1'), methodNode('m2')], ['start'], { start: START_RECT });
    const point = { x: 190, y: 130 };
    expect(dropAt(fixture, point, ['m1', 'm2'])).toBeUndefined();
    expect(flowBandAt({ document: fixture.document, rectOf: fixture.rectOf, point, dragged: ['m1', 'm2'] })).toBeUndefined();
  });

  it('文档里没有的节点不命中', () => {
    const fixture = fixtureOf([START], ['start'], { start: START_RECT });
    expect(dropAt(fixture, { x: 190, y: 130 }, ['ghost'])).toBeUndefined();
  });
});

describe('flowDropLabelOf：吸附提示文案', () => {
  it('顶层序列说「插入第几步」，下标按 1 起数', () => {
    expect(flowDropLabelOf({ kind: 'flow', region: MAIN, index: 1, slot: START_RECT })).toBe('插入第 2 步');
  });

  it('区域说清是哪条区域', () => {
    const target = { kind: 'flow', region: { ownerId: 'if1', kind: 'then' }, index: 0, slot: START_RECT } as const;
    expect(flowDropLabelOf(target)).toBe('放进「if1」的成立分支第 1 步');
  });
});

// ---------------------------------------------------------------------------
// 命令映射：落点 → insertStatement / moveStatementTo
// ---------------------------------------------------------------------------

describe('dropEditOf：流程带落位', () => {
  it('游离语句插进 main 的第 2 步', () => {
    const document = looseDocument([START, methodNode('m1')], ['start']);
    const outcome = dropEditOf(document, flowTarget(MAIN, 1), ['m1']);
    expect(outcome.message).toBeUndefined();
    expect(outcome.edit.document.main).toEqual(['start', 'm1']);
  });

  it('已在 main 的语句换位：顺序变了、节点数不变', () => {
    const document = looseDocument([START, methodNode('a'), methodNode('b')], ['start', 'a', 'b']);
    const outcome = dropEditOf(document, flowTarget(MAIN, 1), ['b']);
    expect(outcome.edit.document.main).toEqual(['start', 'b', 'a']);
    expect(outcome.edit.document.nodes).toHaveLength(document.nodes.length);
  });

  it('拖进循环体：循环体里多一条，main 不变', () => {
    const document = looseDocument(
      [START, { id: 'loop1', kind: 'loop', count: '', body: ['b1'] }, methodNode('b1'), methodNode('m1')],
      ['start', 'loop1'],
    );
    const outcome = dropEditOf(document, flowTarget({ ownerId: 'loop1', kind: 'body' }, 1), ['m1']);
    expect(outcome.edit.document.main).toEqual(['start', 'loop1']);
    expect(outcome.edit.document.nodes.find((node) => node.id === 'loop1')).toMatchObject({ body: ['b1', 'm1'] });
  });

  it('跨序列移动：从 main 挪进循环体，两边的序列同时更新', () => {
    const document = looseDocument(
      [START, { id: 'loop1', kind: 'loop', count: '', body: [] }, methodNode('a')],
      ['start', 'loop1', 'a'],
    );
    const outcome = dropEditOf(document, flowTarget({ ownerId: 'loop1', kind: 'body' }, 0), ['a']);
    expect(outcome.edit.document.main).toEqual(['start', 'loop1']);
    expect(outcome.edit.document.nodes.find((node) => node.id === 'loop1')).toMatchObject({ body: ['a'] });
  });

  it('开始节点被拒绝：给原因，main 不动', () => {
    const document = looseDocument([START, methodNode('a')], ['start', 'a']);
    const outcome = dropEditOf(document, flowTarget(MAIN, 1), ['start']);
    expect(outcome.message).toContain('开始节点');
    expect(outcome.edit.document).toBe(document);
  });

  it('数据节点落在流程带上：只给一句原因，文档一个字节都不变', () => {
    const document = looseDocument([START, valueNode('v1')], ['start']);
    const blocked: DropTarget = { kind: 'flow-blocked', slot: { x: 0, y: 0, width: 180, height: 4 } };
    const outcome = dropEditOf(document, blocked, ['v1']);
    expect(outcome.message).toBe(FLOW_DATA_REFUSAL);
    expect(outcome.edit.document).toBe(document);
  });

  it('落点算出来是第一步时给开始节点让位：新语句排到它后面', () => {
    const document = looseDocument([START, methodNode('m1')], ['start']);
    const outcome = dropEditOf(document, flowTarget(MAIN, 0), ['m1']);
    expect(outcome.edit.document.main).toEqual(['start', 'm1']);
  });

  it('容器不能放进自己的区域：命令层拒绝并说清原因', () => {
    const document = looseDocument(
      [START, { id: 'if1', kind: 'if', cond: '', then: ['t1'], else: [] }, methodNode('t1')],
      ['start', 'if1'],
    );
    const outcome = dropEditOf(document, flowTarget({ ownerId: 'if1', kind: 'then' }, 0), ['if1']);
    expect(outcome.edit.document).toBe(document);
    expect(outcome.edit.issues[0]?.message).toContain('不能把「if1」放进');
  });

  it('落在空白处脱离流程，保留独立节点', () => {
    const document = looseDocument([START, methodNode('a')], ['start', 'a']);
    const stage: DropTarget = { kind: 'stage', slot: { x: 0, y: 600, width: 48, height: 16 } };
    const outcome = dropEditOf(document, stage, ['a']);
    expect(outcome.edit.document.main).toEqual(['start']);
    expect(outcome.edit.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 面板级：工具箱加一个方法节点 → 拖到开始节点下方 → 进 main
// ---------------------------------------------------------------------------

function panelOf(document: canvas.CanvasDocument): CanvasPanelElement {
  const element = window.document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = CHALLENGE;
  element.document = document;
  window.document.body.append(element);
  panels.push(element);
  return element;
}

async function settle(panel: CanvasPanelElement): Promise<void> {
  await panel.updateComplete;
  await Promise.resolve();
  await panel.updateComplete;
}

function rootOf(panel: CanvasPanelElement): ShadowRoot {
  const root = panel.shadowRoot;
  if (root === null) throw new Error('面板没有影子根');
  return root;
}

function requireElement(panel: CanvasPanelElement, selector: string): HTMLElement {
  const found = rootOf(panel).querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`找不到 ${selector}`);
  return found;
}

function fire(target: EventTarget, type: string, point: Point): void {
  target.dispatchEvent(
    new MouseEvent(type, { clientX: point.x, clientY: point.y, bubbles: true, cancelable: true, button: 0 }),
  );
}

/** 按下并拖到位，但**不松手**：用例可以先后断言吸附提示与落位结果。 */
function startDrag(target: HTMLElement, from: Point, to: Point): void {
  fire(target, 'pointerdown', from);
  fire(window, 'pointermove', { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) });
  fire(window, 'pointermove', to);
}

function finishDrag(to: Point): void {
  fire(window, 'pointerup', to);
}

/** 拖一个节点：从它的盒子里按下，拖到别处。 */
function dragNode(panel: CanvasPanelElement, nodeId: string, from: Point, to: Point): void {
  startDrag(requireElement(panel, `.node-box[data-node="${nodeId}"]`), from, to);
  finishDrag(to);
}

/** 点一下节点（不拖动）：选中它，侧栏才会显示它的字段。 */
function clickNode(panel: CanvasPanelElement, nodeId: string): void {
  const element = requireElement(panel, `.node-box[data-node="${nodeId}"]`);
  fire(element, 'pointerdown', { x: 0, y: 0 });
  finishDrag({ x: 0, y: 0 });
}

function boxOf(view: CanvasLayoutView, nodeId: string): Rect {
  const box = view.boxes.find((item) => item.nodeId === nodeId);
  if (box === undefined) throw new Error(`没有盒子 ${nodeId}`);
  return box;
}


function viewOf(panel: CanvasPanelElement): CanvasLayoutView {
  const document = panel.document;
  if (document === undefined) throw new Error('面板没有文档');
  return layoutCanvas({ document, methods: [] });
}

/** 编译这份文档时的问题文案；空数组 = 能编译出可执行程序。 */
function compileMessagesOf(document: canvas.CanvasDocument): readonly string[] {
  const authorBlocks = CHALLENGE.authorBlocks;
  const outcome = compileCanvas({
    document,
    ...(authorBlocks === undefined ? {} : { authorBlocks }),
    documentRevision: 0,
  });
  return outcome.ok ? [] : outcome.issues.map((issue) => issue.message);
}

function nodeOf(panel: CanvasPanelElement, nodeId: string): canvas.CanvasNode {
  const node = panel.document?.nodes.find((item) => item.id === nodeId);
  if (node === undefined) throw new Error(`没有节点 ${nodeId}`);
  return node;
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

describe('画布面板：从工具箱加出来的语句能排进 main', () => {
  it('加一个方法节点 → 拖到开始节点下方 → main 是 [start, method1]，提示说「插入第 2 步」', async () => {
    const panel = panelOf({ ...canvas.emptyCanvasDocument(), nodes: [START], layout: { start: { x: 64, y: 64 } }, main: ['start'] });
    await settle(panel);
    requireElement(panel, '.tool[data-kind="method"]').click();
    await settle(panel);

    const added = panel.document;
    if (added === undefined) throw new Error('面板没有文档');
    // 还没排进流程：编译直接报「没有接进流程」，这就是本任务要补的缺口。
    expect(compileMessagesOf(added).some((message) => message.includes('没有接进流程'))).toBe(true);

    const start = boxOf(viewOf(panel), 'start');
    const drop = { x: Math.round(start.x + start.width / 2), y: Math.round(start.y + start.height + 30) };
    startDrag(requireElement(panel, '.node-box[data-node="method1"]'), { x: 0, y: 0 }, drop);
    await settle(panel);

    expect(panel.shadowRoot?.querySelector('.snap-hint')).toBeNull();
    finishDrag(drop);
    await settle(panel);
    expect(panel.document?.main).toEqual(['start', 'method1']);
    expect(added.layout['method1']).toBeDefined();
    expect(compileMessagesOf(panel.document ?? added).some((message) => message.includes('没有接进流程'))).toBe(false);
  });

  it('完整链路：加方法 → 侧栏选方法 → 接上参数 → 拖进 main → 编译通过', async () => {
    const bytes: canvas.ValueNode = { id: 'v1', kind: 'value', value: { kind: 'byte', hex: '4141' } };
    const panel = panelOf({
      ...canvas.emptyCanvasDocument(),
      nodes: [START, bytes],
      layout: { start: { x: 64, y: 64 }, v1: { x: 64, y: 320 } },
      main: ['start'],
    });
    await settle(panel);
    requireElement(panel, '.tool[data-kind="method"]').click();
    await settle(panel);

    // 1. 选中新节点，在侧栏选题目声明的方法（`gets`）；参数由命令层按声明补齐成「未接线」。
    clickNode(panel, 'method1');
    await settle(panel);
    const select = requireElement(panel, '.field-block');
    if (!(select instanceof HTMLSelectElement)) throw new Error('侧栏没有方法下拉');
    select.value = 'gets';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'method1')).toMatchObject({ block: 'gets' });

    // 2. 在侧栏连接字节参数。
    const param = requireElement(panel, '.field-param-data');
    if (!(param instanceof HTMLSelectElement)) throw new Error('没有参数选项');
    param.value = 'v1';
    param.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'method1')).toMatchObject({ args: { data: 'v1' } });

    // 3. 拖到开始节点下方：这一条就是 E2E 的 `placeInFlow`。
    const start = boxOf(viewOf(panel), 'start');
    dragNode(panel, 'method1', { x: 0, y: 0 }, { x: start.x + 20, y: start.y + start.height + 30 });
    await settle(panel);

    const document = panel.document;
    if (document === undefined) throw new Error('面板没有文档');
    expect(document.main).toEqual(['start', 'method1']);
    expect(compileMessagesOf(document)).toEqual([]);
  });

  it('再拖回空白处：节点脱离流程，坐标跟随拖动', async () => {
    const panel = panelOf(looseDocument([START, methodNode('a')], ['start', 'a']));
    await settle(panel);
    const before = panel.document?.layout['a'];
    const from = boxOf(viewOf(panel), 'a');
    dragNode(panel, 'a', { x: from.x + 20, y: from.y + 20 }, { x: 900, y: 700 });
    await settle(panel);

    expect(panel.document?.main).toEqual(['start']);
    expect(panel.document?.layout['a']).not.toEqual(before);
  });
});

describe('纵向流程的插位', () => {
  it('C 放在 A、B 之间时按纵坐标插入，得到 start→A→C→B', () => {
    const fixture = fixtureOf([START, methodNode('a'), methodNode('b'), methodNode('c')], ['start', 'a', 'b'], {
      start: { x: 100, y: 40, width: 180, height: 72 },
      a: { x: 100, y: 180, width: 180, height: 72 },
      b: { x: 100, y: 320, width: 180, height: 72 },
      c: { x: 500, y: 200, width: 180, height: 72 },
    });
    const target = dropAt(fixture, { x: 190, y: 285 }, ['c']);
    expect(target).toMatchObject({ kind: 'flow', region: MAIN, index: 2 });
    const result = dropEditOf(fixture.document, target, ['c']);
    expect(result.edit.issues).toEqual([]);
    expect(result.edit.document.main).toEqual(['start', 'a', 'c', 'b']);
  });
});
