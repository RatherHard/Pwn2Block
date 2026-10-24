import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 真实浏览器回归的公共入口：**新版画布**（`pwn2block-canvas-panel`）的选择器与读取口径。
 *
 * 旧画布（`pwn2block-graph-panel` / `pwn2block-graph-canvas` / 节点库 / Blockly 侧栏）已删除，
 * 所以这里只认新版画布的 DOM：
 * - 顶栏：`.top` 里的 `.btn-undo` / `.btn-redo` / `.btn-delete` / `.btn-run` 与 `.status-*` 计数；
 * - 工具箱：`aside.toolbox` 里每组 `.toolbox-group[data-category]` 下的 `.tool[data-kind]`
 *   （本题方法是 `.tool-block[data-block]`；搜索 `.library-query`、分类页 `.library-tab`，
 *   不在当前页或不匹配搜索的条目带 `hidden`，计数仍然算得到）；
 * - 画布：`.stage > .surface` 里的 `.node-box[data-node]`、`.relation-box`、`.group-box`、
 *   `.port[data-node][data-port]`、`.marquee`；
 * - 检查器：`aside.inspector` 里按字段名生成的 `.field-<key>` 控件。
 *
 * 读文档一律走面板的公开属性 `document`（面板由父组件注入或自己读存档），不从 localStorage 猜结构；
 * 但返回值在 Node 侧按形状**重新校验并复制**一遍，所以断言读的是纯数据，不是页面对象。
 */

/** 画布面板的标签名。 */
export const PANEL_TAG = 'pwn2block-canvas-panel';

/** 新版画布的存档键（`v2`）；与旧画布的 `pwn2block.canvas.v1.*` 分属两套。 */
export function canvasKey(challengeId: string): string {
  return `pwn2block.canvas.v2.${challengeId}`;
}

export interface CanvasNodeJson {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly block?: string;
  readonly args?: Readonly<Record<string, string>>;
  readonly value?: Readonly<Record<string, unknown>>;
}

export interface CanvasDocumentJson {
  readonly nodes: readonly CanvasNodeJson[];
  readonly layout: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly main: readonly string[];
}

export function panelOf(page: Page): Locator {
  return page.locator(PANEL_TAG);
}

export function toolboxOf(page: Page): Locator {
  return panelOf(page).getByRole('complementary', { name: '工具箱' });
}

export function inspectorOf(page: Page): Locator {
  return panelOf(page).getByRole('complementary', { name: '检查器' });
}

export function stageOf(page: Page): Locator {
  return panelOf(page).locator('.stage');
}

/**
 * 打开题目并等画布面板出现。
 *
 * 不给 id 时点第一道（多数用例只关心「随便一道题」）；需要某题特有动作（`gets`、`capture`）时必须
 * 指定 id，否则用例会在别的题目上找端口，最后以超时收场而不是给出可读的原因。
 */
export async function openChallenge(page: Page, challengeId?: string): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) {
    const item = challengeId === undefined ? picker.locator('li').first() : picker.locator('li').filter({ hasText: challengeId });
    await item.getByRole('button').click();
  }
  await expect(panelOf(page)).toBeVisible();
}

/**
 * 等自动保存真的落盘：面板的保存是 400ms 防抖，编辑完立刻 `reload()` 会读到上一版。
 *
 * 判定读的是存档里的节点 id 序列与面板当前文档一致——不看时间、不 sleep，改一次就等一次。
 */
export async function waitForSave(page: Page, challengeId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const current = (await readDocument(page)).nodes.map((node) => node.id);
        const saved = await page.evaluate(
          (key) => {
            const raw = localStorage.getItem(key);
            if (raw === null) return undefined;
            return raw;
          },
          canvasKey(challengeId),
        );
        if (saved === undefined) return { saved: [], current };
        const parsed: unknown = JSON.parse(saved);
        const document = isRecord(parsed) ? asDocument(parsed['document']) : undefined;
        return { saved: document === undefined ? [] : document.nodes.map((node) => node.id), current };
      },
      { timeout: 5000 },
    )
    .toEqual(await readIds(page));
}

/** `waitForSave` 的期望值：当前文档的节点 id（读两次省掉一个临时变量）。 */
async function readIds(page: Page): Promise<{ readonly saved: readonly string[]; readonly current: readonly string[] }> {
  const ids = (await readDocument(page)).nodes.map((node) => node.id);
  return { saved: ids, current: ids };
}

/** 读面板当前的文档；面板还没装载文档时显式报错，不返回空文档糊弄断言。 */
export async function readDocument(page: Page): Promise<CanvasDocumentJson> {
  const raw = await panelOf(page).evaluate((element) => ('document' in element ? element.document : undefined));
  const document = asDocument(raw);
  if (document === undefined) throw new Error('画布面板还没有装载文档');
  return document;
}

/** 按种类找节点 id；找不到就是测试前提没成立。 */
export async function nodeIdOf(page: Page, kind: string): Promise<string> {
  const document = await readDocument(page);
  const node = document.nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`画布上没有 ${kind} 节点`);
  return node.id;
}

/** 工具箱点一项：在空位加一个该种类的默认节点。 */
export async function addToolNode(page: Page, kind: string): Promise<void> {
  await toolboxOf(page).locator(`.tool[data-kind="${kind}"]`).click();
}

/**
 * 点选一个节点，并等它带上选中样式。
 *
 * 点的是标题：节点已选中时单击可编辑行会直接开就地编辑框（工具箱加出来的节点本来就是选中的），
 * 点标题只改选中，后续按键才会落到画布上。
 */
export async function selectNode(page: Page, nodeId: string): Promise<void> {
  await panelOf(page).locator(`.node-box[data-node="${nodeId}"] .title`).click();
  await expect(panelOf(page).locator(`.node-box.selected[data-node="${nodeId}"]`)).toBeVisible();
}

/** 某个输入端口（新版画布只有输入端口：接线 = 把它拖到提供值的节点上）。 */
export function portOf(page: Page, nodeId: string, port: string): Locator {
  return panelOf(page).locator(`.port[data-node="${nodeId}"][data-port="${port}"]`);
}

/** 按住左键从 `from` 中心拖到 `to` 中心，分步移动以便先越过 4px 拖动阈值。 */
export async function dragBetween(page: Page, from: Locator, to: Locator, steps = 8): Promise<void> {
  const start = await centerOf(from);
  const end = await centerOf(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(start.x + ((end.x - start.x) * step) / steps, start.y + ((end.y - start.y) * step) / steps);
  }
  await page.mouse.up();
}

/** 按住左键原地拖一段位移。 */
export async function dragBy(page: Page, from: Locator, dx: number, dy: number, steps = 6): Promise<void> {
  const start = await centerOf(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(start.x + (dx * step) / steps, start.y + (dy * step) / steps);
  }
  await page.mouse.up();
}

/**
 * 把一个游离节点拖进顶层序列（工具箱加出来的节点只是「放在画布上」，还没排进流程）。
 *
 * 落点是「开始节点正下方」：吸附按行带算，行带是序列里各节点盒子的并集，所以贴着开始节点往下拖
 * 一定命中它所在的那一行，插入位置由横向位置决定（这里取同一列，于是排在开始节点之后）。
 * 拖完断言它真的进了 `main`，否则后面的编译断言会以难读的方式失败。
 */
export async function placeInFlow(page: Page, nodeId: string, afterNodeId = 'start'): Promise<void> {
  const node = panelOf(page).locator(`.node-box[data-node="${nodeId}"]`);
  const anchor = panelOf(page).locator(`.node-box[data-node="${afterNodeId}"]`);
  const nodeBox = await centerOf(node);
  const anchorBox = await anchor.boundingBox();
  const viewport = page.viewportSize();
  if (anchorBox === null || viewport === null) throw new Error(`找不到 ${afterNodeId} 的盒子`);
  const targetY = Math.min(anchorBox.y + anchorBox.height + 24, viewport.height - 24);
  await page.mouse.move(nodeBox.x, nodeBox.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      nodeBox.x + ((anchorBox.x + anchorBox.width / 2 - nodeBox.x) * step) / 8,
      nodeBox.y + ((targetY - nodeBox.y) * step) / 8,
    );
  }
  await page.mouse.up();
  const main = (await readDocument(page)).main;
  if (!main.includes(nodeId)) throw new Error(`${nodeId} 没有被拖进顶层序列：main = ${main.join(',')}`);
}

async function centerOf(locator: Locator): Promise<{ readonly x: number; readonly y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box === null) throw new Error('目标元素没有包围盒');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// ---------------------------------------------------------------------------
// 文档形状校验（Node 侧，不用 `as` 硬转）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPoint(value: unknown): { readonly x: number; readonly y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = value['x'];
  const y = value['y'];
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  return { x, y };
}

function asArgs(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const args: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    args[key] = item;
  }
  return args;
}

function asNode(value: unknown): CanvasNodeJson | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value['id']);
  const kind = asString(value['kind']);
  if (id === undefined || kind === undefined) return undefined;
  const name = asString(value['name']);
  const block = asString(value['block']);
  const args = asArgs(value['args']);
  const payload = isRecord(value['value']) ? { ...value['value'] } : undefined;
  return {
    id,
    kind,
    ...(name === undefined ? {} : { name }),
    ...(block === undefined ? {} : { block }),
    ...(args === undefined ? {} : { args }),
    ...(payload === undefined ? {} : { value: payload }),
  };
}

function asDocument(value: unknown): CanvasDocumentJson | undefined {
  if (!isRecord(value)) return undefined;
  const nodes = value['nodes'];
  const layout = value['layout'];
  const main = value['main'];
  if (!Array.isArray(nodes) || !isRecord(layout) || !Array.isArray(main)) return undefined;
  const parsedNodes: CanvasNodeJson[] = [];
  for (const item of nodes) {
    const node = asNode(item);
    if (node === undefined) return undefined;
    parsedNodes.push(node);
  }
  const parsedLayout: Record<string, { readonly x: number; readonly y: number }> = {};
  for (const [id, position] of Object.entries(layout)) {
    const point = asPoint(position);
    if (point === undefined) return undefined;
    parsedLayout[id] = point;
  }
  const order: string[] = [];
  for (const item of main) {
    const id = asString(item);
    if (id === undefined) return undefined;
    order.push(id);
  }
  return { nodes: parsedNodes, layout: parsedLayout, main: order };
}
