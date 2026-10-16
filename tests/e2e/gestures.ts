/**
 * 真实 Blockly 手势工具（F · D5，`tests/e2e/**` 独占写权限范围内）。
 *
 * 为什么要有这个文件：八步闭环的第 5 步要求**在积木窗口里用真实手势拼出 payload**，
 * 不许走测试后门（08 §9.3 / A 的巡检要求：只写 `tests/e2e/**`，不许为验收改 `packages/web/**`）。
 * 这里做的全部是真实指针手势：
 * - 点工具箱分类 → 展开 flyout；
 * - 拖 flyout 的滚动条手柄 → 把目标积木滚进可视区；
 * - 从 flyout 里按住一块积木拖到目标连接点上松手（Blockly 自己按吸附半径吸附）；
 * - 点字段 → 在 Blockly 弹出来的输入框里键入 → 回车。
 *
 * **几何全部从真实 DOM 读**（`g.blocklyDraggable` 与连接口 `<path>` 的
 * `getBoundingClientRect()` / `transform`）。这里不调用任何 Blockly API、不改产品代码、
 * 不注入脚本：页面看到的和用户看到的是同一份 DOM。
 *
 * ## 连接口坐标是怎么来的（踩过的坑，别再改回去）
 *
 * 1. **连接口的位置是 `transform`，不是外接矩形中心。** 连接口 `<path>` 的
 *    `transform="translate(x, y)"` 才是 Blockly 认定的连接点（积木原点 + (x, y)）；
 *    它的外接矩形整体偏 `(-8, -5)` 左右。用矩形中心对齐会引入约 8px 的固定偏差，
 *    在吸附半径内所以"看着也能连上"，但值输入这种左右两侧都要对的场景就不稳。
 * 2. **值积木的输出口在 DOM 里根本没有独立 `<path>`。** 输出口是画在积木自身轮廓
 *    (`path.blocklyPath`) 左上角的那段凹槽，`d` 里固定是 `H 8 V 20 c 0,-10 -8,8 -8,-7.5 s 8,2.5 8,-7.5 z`，
 *    也就是 y ∈ [5, 20] 的一条槽。用一个**已经插好的影子积木**反推：
 *    `bytes_padding` 的 `item0` 输入口 transform = (152, 35)，它的影子 `math_number`
 *    轮廓左上角在屏幕 (1089, 611)，而父积木原点在 (945, 581) →
 *    子积木输出口偏移 = (945+152−1089, 581+35−611) = **(8, 5)**，与它自己轮廓左上角的差值。
 *    `bytes_addr` 的 `item0` 给出同样的 (8, 5)。所以值积木的输出口 = 轮廓左上角 + (8, 5)。
 * 3. 拖拽落点 = 目标连接口屏幕点 + 抓取偏移 − 被拖积木的连接口偏移
 *    （拖动时积木跟着鼠标走，所以要把"连接口相对抓取点"的差补掉）。
 *
 * 注意：根 `tsconfig.json` 的 `lib` 只有 `ES2022`（没有 DOM），所以所有 `page.evaluate`
 * 一律传**字符串表达式**，由浏览器执行；这样既不依赖 DOM 类型，也不会被 tsc 拒绝。
 */
import type { Page } from '@playwright/test';

/** 屏幕矩形（`getBoundingClientRect()` 的可序列化子集）。 */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 一个连接口。 */
export interface ConnInfo {
  readonly id: string;
  /** 相对积木轮廓左上角的偏移（`transform` 的值）。 */
  readonly local: Point | null;
  /** 连接口在屏幕上的落点 = 积木轮廓左上角 + `local`。 */
  readonly point: Point | null;
  /** 连接口自身的外接矩形（诊断用；**不要**拿它的中心当连接点）。 */
  readonly box: Box;
  /** 竖长条（值输入/输出）还是横长条（语句块的上/下连接）。 */
  readonly vertical: boolean;
  /** 值积木的输出口在 DOM 里没有元素，是按几何推出来的。 */
  readonly synthetic: boolean;
}

export interface BlockInfo {
  readonly id: string;
  readonly cls: string;
  /** 积木自身轮廓（不含子积木）的屏幕矩形。 */
  readonly own: Box | null;
  readonly conns: readonly ConnInfo[];
  /** 直接子积木的 class 列表：连接成功与否的判据（Blockly 把子积木嵌进父积木的 `<g>`）。 */
  readonly childClasses: readonly string[];
  /** 父积木 id（顶层积木为 null）。 */
  readonly parentId: string | null;
}

/** 值积木输出口相对自身轮廓左上角的固定偏移（见文件头说明）。 */
export const VALUE_OUTPUT_OFFSET: Point = { x: 8, y: 5 };

/** 穿透 shadow root 的深查询 + 几何读取，全部在页面里执行。 */
const PAGE_HELPERS = `
function __deepAll(sel, root) {
  const found = [];
  const visit = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.matches(sel)) found.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root ?? document);
  return found;
}
function __mainCanvas() {
  return __deepAll('.blocklyBlockCanvas').filter((el) => el.closest('.blocklyFlyout') === null)[0] ?? null;
}
function __flyout() {
  return __deepAll('.blocklyToolboxFlyout')[0] ?? null;
}
function __box(el) {
  const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
function __parseTranslate(t) {
  const m = /translate\\(([-0-9.]+),\\s*([-0-9.]+)\\)/.exec(t ?? '');
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]) };
}
function __info(g) {
  const ownEl = g.querySelector(':scope > path.blocklyPath');
  const own = ownEl === null ? null : __box(ownEl);
  const conns = [...g.querySelectorAll(':scope > path[id*="_connection_"]')].map((c) => {
    const b = __box(c);
    const local = __parseTranslate(c.getAttribute('transform'));
    return {
      id: c.getAttribute('id'),
      local,
      point: own === null || local === null ? null : { x: own.x + local.x, y: own.y + local.y },
      box: b,
      vertical: b.height > b.width,
      synthetic: false,
    };
  });
  // 语句块的上/下连接口是横长条；没有横长条的积木是值积木，它的输出口没有 DOM 元素，按几何补一个。
  const hasStatementConn = conns.some((c) => c.local !== null && !c.vertical);
  if (!hasStatementConn && own !== null) {
    const px = ${String(VALUE_OUTPUT_OFFSET.x)}, py = ${String(VALUE_OUTPUT_OFFSET.y)};
    conns.push({
      id: g.getAttribute('data-id') + '_connection_output',
      local: { x: px, y: py },
      point: { x: own.x + px, y: own.y + py },
      box: { x: own.x, y: own.y + 5, width: 8, height: 15 },
      vertical: true,
      synthetic: true,
    });
  }
  return {
    id: g.getAttribute('data-id'),
    cls: g.getAttribute('class') ?? '',
    own,
    conns,
    childClasses: [...g.querySelectorAll(':scope > g.blocklyDraggable')].map((c) => c.getAttribute('class') ?? ''),
    parentId: g.parentElement && g.parentElement.closest('g.blocklyDraggable')
      ? g.parentElement.closest('g.blocklyDraggable').getAttribute('data-id')
      : null,
  };
}
`;

async function queryBlocks(page: Page, scope: 'main' | 'flyout', cls?: string): Promise<readonly BlockInfo[]> {
  return page.evaluate<BlockInfo[]>(`(() => { ${PAGE_HELPERS}
    const root = ${scope === 'main' ? '__mainCanvas()' : '__flyout()'};
    if (root === null) return [];
    const sel = ${cls === undefined ? "'g.blocklyDraggable'" : `'g.${cls}'`};
    const groups = ${cls === undefined ? '[...root.querySelectorAll(sel)]' : "[...root.querySelectorAll(sel)].filter((el) => el.matches('g.blocklyDraggable'))"};
    return groups.map((g) => __info(g));
  })()`);
}

/** 主画布上的全部积木（含被嵌套的子积木）。 */
export async function canvasBlocks(page: Page): Promise<readonly BlockInfo[]> {
  return queryBlocks(page, 'main');
}

/** 画布上按积木类型找第一块。 */
export async function canvasBlock(page: Page, cls: string): Promise<BlockInfo | undefined> {
  return (await canvasBlocks(page)).find((block) => block.cls.split(' ').includes(cls));
}

/** 在画布上按积木类型找一块（可限定父积木；`parentId === null` 表示离散块）。 */
export async function findCanvasBlock(
  page: Page,
  cls: string,
  parentId?: string | null,
): Promise<BlockInfo | undefined> {
  return (await canvasBlocks(page)).find(
    (block) => block.cls.split(' ').includes(cls) && (parentId === undefined || block.parentId === parentId),
  );
}

/** 工具箱里的分类名（真实点击目标）。 */
export async function toolboxCategories(page: Page): Promise<readonly string[]> {
  return page.evaluate<string[]>(`(() => { ${PAGE_HELPERS}
    return __deepAll('.blocklyToolboxCategory').map((el) => (el.textContent ?? '').trim());
  })()`);
}

/** flyout 里顶层积木的类型名（诊断用）。 */
export async function flyoutBlockClasses(page: Page): Promise<readonly string[]> {
  return (await queryBlocks(page, 'flyout')).map((block) => block.cls.split(' ')[0] ?? '');
}

/** flyout 里某类积木的几何（尚未拖到画布）。 */
export async function flyoutBlock(page: Page, cls: string): Promise<BlockInfo | null> {
  const all = await queryBlocks(page, 'flyout', cls);
  return all.find((block) => block.cls.split(' ').includes(cls)) ?? null;
}

/**
 * 点开一个工具箱分类。
 *
 * Blockly 的分类是**开关**，而且实测里"点一下没换过来"会真的发生（前一次拖拽刚结束、
 * flyout 还在收合时点击会被咽掉）。所以这里不假设一次点击必然生效：传了 `expectBlock`
 * 就点完立刻核对 flyout 里有没有这块积木，没有就再点，最多 3 次。
 */
export async function openToolboxCategory(page: Page, name: string, expectBlock?: string): Promise<void> {
  const category = page.locator('pwn2block-payload-panel .blocklyToolboxCategory', { hasText: name }).first();
  // 已经开着就直接用：分类点击是**开关**，多按一下反而会把它关掉。
  if (expectBlock !== undefined && (await flyoutBlockVisible(page, expectBlock))) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await category.click();
    await page.waitForTimeout(280);
    if (expectBlock === undefined) return;
    if (await flyoutBlockVisible(page, expectBlock)) return;
  }
  if (expectBlock !== undefined) {
    const classes = await flyoutBlockClasses(page);
    const open = await flyoutOpen(page);
    throw new Error(
      `工具箱分类「${name}」展开后 flyout 里看不到 ${expectBlock}（flyout 打开着？${open}）；当前有：${classes.join('、')}`,
    );
  }
}

/**
 * flyout 现在是不是**真的展开着**（高度非 0）。
 *
 * 实测（真 Chromium + Blockly 13.4.0）：**从 flyout 里拖出一块积木之后，flyout 会自动收起**，
 * 而 Blockly 把积木元素留在 DOM 里，只是 `getBoundingClientRect()` 全变 0。
 * 所以「按 class 找得到」不等于「看得见、点得到」——只查前者会静默地拿到 0×0 坐标，
 * 下一步的 `mousedown` 就落到了空画布上（拖动被当成取消，什么都不发生）。
 */
export async function flyoutOpen(page: Page): Promise<boolean> {
  const rect = await flyoutRect(page);
  return rect !== null && rect.height > 1 && rect.width > 1;
}

/** `cls` 在 flyout 里是否**可见**（尺寸非 0）。 */
export async function flyoutBlockVisible(page: Page, cls: string): Promise<boolean> {
  const block = await flyoutBlock(page, cls);
  return block !== null && block.own !== null && block.own.width > 1 && block.own.height > 1;
}

export async function flyoutRect(page: Page): Promise<Box | null> {
  return page.evaluate<Box | null>(`(() => { ${PAGE_HELPERS}
    const f = __flyout();
    return f === null ? null : __box(f);
  })()`);
}

/** flyout 的竖向滚动条：轨道（`svg`）与手柄（`.blocklyScrollbarHandle`）的屏幕矩形。 */
export interface ScrollInfo {
  readonly track: Box;
  readonly handle: Box;
}

/**
 * 取 flyout 的竖向滚动条。页面上同时存在工作区自己的滚动条（class 也叫
 * `blocklyFlyoutScrollbar`，手柄高度为 0），所以按「手柄有高度 + 轨道落在 flyout 附近」筛。
 */
export async function flyoutScrollbar(page: Page): Promise<ScrollInfo | null> {
  return page.evaluate<ScrollInfo | null>(`(() => { ${PAGE_HELPERS}
    const f = __flyout();
    if (f === null) return null;
    const fr = __box(f);
    for (const bar of __deepAll('.blocklyFlyoutScrollbar')) {
      const handle = bar.querySelector('.blocklyScrollbarHandle');
      if (handle === null) continue;
      const track = __box(bar);
      const hb = __box(handle);
      if (hb.height < 2) continue;
      if (track.x < fr.x - 8 || track.x > fr.x + fr.width + 24) continue;
      return { track, handle: hb };
    }
    return null;
  })()`);
}

/**
 * 用**拖动滚动条手柄**的方式把 flyout 内容滚到「`cls` 完整可见」。
 *
 * 为什么不用滚轮：实测里滚轮会**不稳定地被外层滚动容器吃掉**（同一个坐标，有时滚 flyout、
 * 有时把整个 payload 面板滚走 170px），面板一滚，之前读到的所有屏幕坐标全部作废。
 * 手柄拖动是确定性的：手柄位置与内容滚动量成正比，可以直接算出来。
 */
export async function scrollFlyoutToBlock(page: Page, cls: string): Promise<BlockInfo | null> {
  for (let i = 0; i < 6; i += 1) {
    const flyRect = await flyoutRect(page);
    const block = await flyoutBlock(page, cls);
    if (flyRect === null || block === null || block.own === null) return null;
    // flyout 收起时积木还在 DOM 里，只是尺寸为 0：这不是「滚一滚就能看见」，必须让调用方重新点分类。
    if (block.own.width < 1 || block.own.height < 1 || flyRect.height < 1) return null;
    const inside =
      block.own.y >= flyRect.y - 2 && block.own.y + block.own.height <= flyRect.y + flyRect.height + 2;
    if (inside) return block;

    const sb = await flyoutScrollbar(page);
    if (sb === null) return null;

    // 内容高 C = 轨道高 × 视口高 ÷ 手柄高；可滚动内容 S = C − 视口高；手柄行程 T = 轨道高 − 手柄高。
    const view = flyRect.height;
    const content = (sb.track.height * view) / sb.handle.height;
    const scrollable = Math.max(content - view, 1);
    const travel = Math.max(sb.track.height - sb.handle.height, 1);
    const current = ((sb.handle.y - sb.track.y) / travel) * scrollable;
    // 目标：积木顶边落在 flyout 顶边下方 8px 处（滚到最底也不会越界）。
    const want = Math.min(Math.max(block.own.y - flyRect.y - 8, 0), scrollable);
    const handleDelta = ((want - current) * travel) / scrollable;

    const fromX = sb.handle.x + sb.handle.width / 2;
    const toY = Math.min(Math.max(sb.handle.y + handleDelta, sb.track.y), sb.track.y + travel);
    await page.mouse.move(fromX, sb.handle.y + sb.handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(fromX, toY + sb.handle.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  return flyoutBlock(page, cls);
}

/**
 * 让 `cls` 在 flyout 里完整可见。
 *
 * 顺序上有一条硬要求：**先滚动、再读目标连接口**。滚动会改变整个面板的滚动位置，
 * 滚动之前的屏幕坐标一律作废。
 */
export async function revealFlyoutBlock(page: Page, cls: string): Promise<BlockInfo> {
  const block = await scrollFlyoutToBlock(page, cls);
  if (block === null || block.own === null) {
    throw new Error(`积木 ${cls} 不在展开的 flyout 里（flyout 可能被上一次拖拽收起了，先重新点分类）`);
  }
  const rect = await flyoutRect(page);
  const inside =
    rect !== null && block.own.y >= rect.y - 2 && block.own.y + block.own.height <= rect.y + rect.height + 2;
  if (!inside) {
    throw new Error(
      `积木 ${cls} 在 flyout 里滚不到可见区：fly=${JSON.stringify(rect)} block=${JSON.stringify(block.own)}`,
    );
  }
  return block;
}

// ---------------------------------------------------------------------------
// 连接口选择
// ---------------------------------------------------------------------------

function locatedConns(conns: readonly ConnInfo[]): readonly ConnInfo[] {
  return conns.filter((conn) => conn.local !== null && conn.point !== null);
}

/** 语句块的**上**连接口（previous）：局部 y 最小的横长条。 */
export function pickTopConn(conns: readonly ConnInfo[]): ConnInfo | undefined {
  return [...locatedConns(conns)]
    .filter((conn) => !conn.vertical)
    .sort((a, b) => (a.local?.y ?? 0) - (b.local?.y ?? 0))[0];
}

/** 语句块的**下**连接口（next）：局部 y 最大的横长条。 */
export function pickBottomConn(conns: readonly ConnInfo[]): ConnInfo | undefined {
  return [...locatedConns(conns)]
    .filter((conn) => !conn.vertical)
    .sort((a, b) => (b.local?.y ?? 0) - (a.local?.y ?? 0))[0];
}

/** 值积木的**输出**连接口。 */
export function pickOutputConn(conns: readonly ConnInfo[]): ConnInfo | undefined {
  return locatedConns(conns).find((conn) => conn.synthetic);
}

/**
 * 值输入槽的连接口：竖长条、局部 x > 0（值积木的输出口在左侧 x≈8），
 * 按局部 y 从小到大取第 `index` 个（`concat` 的 `item0` 是第 0 个、`item1` 是第 1 个）。
 */
export function pickInputConn(conns: readonly ConnInfo[], index: number): ConnInfo | undefined {
  const inputs = locatedConns(conns)
    .filter((conn) => conn.vertical && !conn.synthetic && (conn.local?.x ?? 0) > 0)
    .sort((a, b) => (a.local?.y ?? 0) - (b.local?.y ?? 0));
  return inputs[index];
}

/** 连接口在屏幕上的落点（没有 `point` 时退化成外接矩形中心，只用于诊断）。 */
export function connCenter(conn: ConnInfo): Point {
  return conn.point ?? { x: conn.box.x + conn.box.width / 2, y: conn.box.y + conn.box.height / 2 };
}

// ---------------------------------------------------------------------------
// 真实拖拽
// ---------------------------------------------------------------------------

export interface GrabOffset {
  readonly x: number;
  readonly y: number;
}

/** 默认抓住积木自身轮廓左上角往右下各偏 25 / 15 px（避开连接口与徽标）。 */
export const DEFAULT_GRAB: GrabOffset = { x: 25, y: 15 };

/**
 * 把鼠标落点算成「让 `own` 这块积木的 `conn` 正好压在 `targetPoint` 上」。
 *
 * 拖动时积木跟着鼠标走：落点 = 目标点 + 抓取偏移 − 连接口相对积木左上角的偏移。
 */
export function dropPointAligning(own: Box, conn: ConnInfo, targetPoint: Point, grab: GrabOffset = DEFAULT_GRAB): Point {
  const point = connCenter(conn);
  return {
    x: targetPoint.x + grab.x - (point.x - own.x),
    y: targetPoint.y + grab.y - (point.y - own.y),
  };
}

async function dragFromPointToPoint(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y + 14, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 22 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

/**
 * 从工具箱把一块积木拖到画布上的指定位置（自身轮廓左上角落在 `ownTopLeft`）。
 * 用来先把「开始」积木放到画布上，再往下接程序。
 */
export async function dragFromToolboxTo(
  page: Page,
  cls: string,
  ownTopLeft: Point,
  grab: GrabOffset = DEFAULT_GRAB,
): Promise<void> {
  const source = await revealFlyoutBlock(page, cls);
  const own = source.own;
  if (own === null) throw new Error(`积木 ${cls} 拿不到自身轮廓`);
  await dragFromPointToPoint(
    page,
    { x: own.x + grab.x, y: own.y + grab.y },
    { x: ownTopLeft.x + grab.x, y: ownTopLeft.y + grab.y },
  );
}

export type ConnPicker = (conns: readonly ConnInfo[]) => ConnInfo | undefined;

/**
 * **把一块积木真正接到父积木的连接口上**，并校验接上了。
 *
 * 两个必须守住的次序与细节：
 * 1. **先让积木在 flyout 里可见（可能要拖滚动条），再读目标连接口的屏幕坐标**。反过来的话，
 *    滚动会把 payload 面板整个挪走，读到的是滚动前的旧坐标，落点整体偏移，吸附兜不住。
 * 2. 第一次失败时积木已经落在画布上了 → 第二次改为**拖动这块离散积木**（真实用户也是这么补救的），
 *    并在拖动前重新读一次目标坐标。
 *
 * 返回接上的子积木；`attempts` 次都没接上则返回 `undefined`（调用方据此报告缺陷）。
 */
export async function connectFromToolbox(
  page: Page,
  cls: string,
  sourcePicker: ConnPicker,
  parentId: string,
  resolveTarget: () => Promise<Point | null>,
  options: { readonly attempts?: number; readonly grab?: GrabOffset } = {},
): Promise<BlockInfo | undefined> {
  const attempts = options.attempts ?? 3;
  const grab = options.grab ?? DEFAULT_GRAB;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt === 0) {
      const source = await revealFlyoutBlock(page, cls);
      const own = source.own;
      const conn = sourcePicker(source.conns);
      if (own === null || conn === undefined) {
        throw new Error(`积木 ${cls} 拿不到自身轮廓或输出连接口`);
      }
      const target = await resolveTarget();
      if (target === null) return undefined;
      await dragFromPointToPoint(
        page,
        { x: own.x + grab.x, y: own.y + grab.y },
        dropPointAligning(own, conn, target, grab),
      );
    } else {
      const floating = await findCanvasBlock(page, cls, null);
      if (floating === undefined || floating.own === null) return undefined;
      const conn = sourcePicker(floating.conns);
      const target = await resolveTarget();
      if (conn === undefined || target === null) return undefined;
      await dragFromPointToPoint(
        page,
        { x: floating.own.x + grab.x, y: floating.own.y + grab.y },
        dropPointAligning(floating.own, conn, target, grab),
      );
    }
    const child = await findCanvasBlock(page, cls, parentId);
    if (child !== undefined) return child;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 字段编辑
// ---------------------------------------------------------------------------

/** 在积木里按顺序找可编辑字段（含影子数字积木里的字段），点开并输入新值。 */
export async function editBlockField(page: Page, blockId: string, index: number, value: string): Promise<void> {
  const fieldExists = await page.evaluate<boolean>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    if (main === null) return false;
    const g = main.querySelector('g.blocklyDraggable[data-id=' + JSON.stringify(${JSON.stringify(blockId)}) + ']');
    if (g === null) return false;
    return [...g.querySelectorAll('.blocklyEditableField')][${index}] !== undefined;
  })()`);
  if (!fieldExists) throw new Error(`积木 ${blockId} 的第 ${index} 个可编辑字段不存在`);

  await page.evaluate<void>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    const g = main?.querySelector('g.blocklyDraggable[data-id=' + JSON.stringify(${JSON.stringify(blockId)}) + ']');
    const field = g === null || g === undefined ? undefined : [...g.querySelectorAll('.blocklyEditableField')][${index}];
    field?.scrollIntoView({ block: 'center', inline: 'center' });
  })()`);

  // 滚动后重新读取坐标；Blockly 的画布位置可能已改变，不能复用滚动前的矩形。
  const box = await page.evaluate<Box | null>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    if (main === null) return null;
    const g = main.querySelector('g.blocklyDraggable[data-id=' + JSON.stringify(${JSON.stringify(blockId)}) + ']');
    if (g === null) return null;
    const field = [...g.querySelectorAll('.blocklyEditableField')][${index}];
    return field === undefined ? null : __box(field);
  })()`);
  if (box === null) throw new Error(`积木 ${blockId} 的第 ${index} 个可编辑字段不存在`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  // 点完必须**真的**打开编辑器。实测踩过：积木互相压住时，点字段中心的点击会落到上层积木上，
  // 编辑器根本不开，后面那串键盘输入就打到页面别处——字段还是旧值，静默失效。
  // （当时的实例：action_step 的影子数字被旁边接进来的 concat 压住，编译出来 count 还是 1。）
  const opened = await page.evaluate<boolean>(`(() => { ${PAGE_HELPERS}
    return __deepAll('.blocklyHtmlInput').length > 0;
  })()`);
  if (!opened) {
    throw new Error(
      `点开积木 ${blockId} 的第 ${index} 个字段（${JSON.stringify(box)}）后编辑器没有出现：可能被上层积木或面板遮住了`,
    );
  }
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}

/** 积木里可编辑字段的数量（用于先确认字段存在）。 */
export async function editableFieldCount(page: Page, blockId: string): Promise<number> {
  return page.evaluate<number>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    if (main === null) return -1;
    const g = main.querySelector('g.blocklyDraggable[data-id=' + JSON.stringify(${JSON.stringify(blockId)}) + ']');
    return g === null ? -1 : g.querySelectorAll('.blocklyEditableField').length;
  })()`);
}

/** 某块积木里所有字段的显示文字（断言字段值真的变了，而不是只看输入框）。 */
export async function blockFieldTexts(page: Page, blockId: string): Promise<readonly string[]> {
  return page.evaluate<string[]>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    if (main === null) return [];
    const g = main.querySelector('g.blocklyDraggable[data-id=' + JSON.stringify(${JSON.stringify(blockId)}) + ']');
    if (g === null) return [];
    return [...g.querySelectorAll('.blocklyEditableField')].map((f) => (f.textContent ?? '').trim());
  })()`);
}

/** 画布上的整块程序文本（积木标签 + 字段值），用于诊断。 */
export async function canvasText(page: Page): Promise<string> {
  return page.evaluate<string>(`(() => { ${PAGE_HELPERS}
    const main = __mainCanvas();
    return main === null ? '' : (main.textContent ?? '').replace(/\\s+/g, ' ');
  })()`);
}
