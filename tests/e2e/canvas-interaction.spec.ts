import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 节点画布交互回归（10 §3–§5 的浏览器侧证据）：
 *
 * - 节点库：7 个分类、搜索、预览、拖入画布落点；
 * - 拖动节点：位置跟着指针走、不跳变、拖拽期间不选中文字；
 * - 双模式接线：点击—点击与拖拽都能连上，折线是正交路径且带箭头；
 * - 选中连线后 Delete 删除、Ctrl+Z 撤销；双击断线也能撤销；
 * - 空画布刷新后仍是空的，缺「开始」只提示、不自动补节点。
 *
 * 断言尽量读面板自己的文档（`currentDocument()`），只对「看起来怎样」用 DOM/SVG 断言。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

type Doc = {
  nodes: { id: string; kind: string; params: Record<string, unknown> }[];
  connections: { from: { node: string; port: string }; to: { node: string; port: string } }[];
  layout: Record<string, { x: number; y: number }>;
};

async function openChallenge(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) await picker.getByRole('button').first().click();
  await expect(page.locator('pwn2block-graph-panel')).toBeVisible();
}

async function readDoc(page: Page): Promise<Doc> {
  return page.locator('pwn2block-graph-panel').evaluate((element) =>
    (element as unknown as { currentDocument(): Doc }).currentDocument(),
  );
}

async function nodeIdOf(page: Page, kind: string): Promise<string> {
  const document = await readDoc(page);
  const node = document.nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`画布上没有 ${kind} 节点`);
  return node.id;
}

async function addNode(page: Page, label: string): Promise<void> {
  await page
    .locator('pwn2block-graph-panel')
    .getByRole('complementary', { name: '节点库' })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** 选中节点并把它挪进视野，返回画布上的节点元素。 */
async function focusNode(page: Page, id: string): Promise<Locator> {
  await page
    .locator('pwn2block-graph-panel')
    .evaluate((element, nodeId) => (element as unknown as { locate(request: { nodeId: string }): void }).locate({ nodeId }), id);
  const node = page.locator(`pwn2block-graph-canvas .node[data-node="${id}"]`);
  await expect(node).toBeVisible();
  return node;
}

async function setAuthorBlock(page: Page, id: string, block: string): Promise<void> {
  const inspector = page.locator('pwn2block-graph-panel aside.inspector');
  const input = inspector.locator(`input#${id}-id`);
  await input.fill(block);
  await input.press('Tab');
  await expect(inspector.locator(`input#${id}-data`)).toBeVisible();
}

/**
 * 取稳定后的包围盒：面板定位会触发一次视图更新，立刻读到的坐标可能还是旧的。
 * 连续两次读数一致才认为视图已经停稳。
 */
async function stableBox(page: Page, locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let previous = await locator.boundingBox();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await page.waitForTimeout(40);
    const next = await locator.boundingBox();
    if (previous !== null && next !== null && previous.x === next.x && previous.y === next.y) return next;
    previous = next;
  }
  if (previous === null) throw new Error('元素没有包围盒');
  return previous;
}

/**
 * 端口中心的屏幕坐标：先量包围盒，再用 `elementFromPoint`（穿透 shadow 根）确认那里
 * 真的是目标端口。面板刚重绘时坐标会短暂过期，所以要重试到指针确实落在端口上。
 *
 * E2E 的运行环境没有 DOM 类型（根 tsconfig 只开 ES2022），这里用结构化类型描述要用到的成员。
 */
interface PointableElement {
  closest(selector: string): PointableElement | null;
  getAttribute(name: string): string | null;
  readonly shadowRoot: { elementFromPoint(x: number, y: number): PointableElement | null } | null;
}

interface DocumentLike {
  elementFromPoint(x: number, y: number): PointableElement | null;
}

async function portCenter(
  page: Page,
  canvas: Locator,
  nodeId: string,
  port: string,
  kind: 'in' | 'out',
): Promise<{ x: number; y: number }> {
  const selector = `.port-hit.${kind}[data-node="${nodeId}"][data-port="${port}"]`;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const box = await canvas.locator(selector).boundingBox();
    if (box !== null) {
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const hit = await canvas.evaluate((element, at) => {
        const scope = element as unknown as { ownerDocument: DocumentLike };
        let current: PointableElement | null = scope.ownerDocument.elementFromPoint(at.x, at.y);
        while (current !== null) {
          const found = current.closest('[data-port]');
          if (found !== null) {
            return { node: found.getAttribute('data-node') ?? '', port: found.getAttribute('data-port') ?? '' };
          }
          current = current.shadowRoot?.elementFromPoint(at.x, at.y) ?? null;
        }
        return undefined;
      }, point);
      if (hit?.node === nodeId && hit.port === port) return point;
    }
    await page.waitForTimeout(60);
  }
  throw new Error(`端口 ${nodeId}.${port} 不在指针可达的位置`);
}

interface PathLike {
  getTotalLength(): number;
  getPointAtLength(length: number): { x: number; y: number };
  getScreenCTM(): { a: number; b: number; c: number; d: number; e: number; f: number } | null;
}

/**
 * 点在线段中间：连线是细 SVG 路径，用几何中点比按元素中心点更稳。
 * 直接点坐标可以避免 force 点击把事件派发到别的元素上。
 */
async function clickEdge(page: Page, index: number, options?: { double?: boolean }): Promise<void> {
  const point = await page.locator('pwn2block-graph-canvas').evaluate((canvas, wanted) => {
    const host = canvas as unknown as { shadowRoot: { querySelectorAll(selector: string): unknown[] } | null };
    const path = host.shadowRoot?.querySelectorAll('path.edge-hit')[wanted] as PathLike | undefined;
    if (path === undefined) return undefined;
    const local = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (matrix === null) return undefined;
    return { x: local.x * matrix.a + local.y * matrix.c + matrix.e, y: local.x * matrix.b + local.y * matrix.d + matrix.f };
  }, index);
  if (point === undefined) throw new Error(`没有第 ${index + 1} 条连线`);
  if (options?.double === true) await page.mouse.dblclick(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

test('双入口参数编辑：节点内改完面板同步，撤销一次回到原值（10 §2.2）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });
  const inspector = panel.locator('aside.inspector');

  await addNode(page, '填充字节');
  const original = Number((await readDoc(page)).nodes.find((node) => node.kind === 'data.fill')?.params.count);
  await focusNode(page, 'fill');

  // 节点内直接改：改完和属性面板读同一份数据。
  const inline = canvas.locator('.node[data-node="fill"] input#fill-count');
  await inline.fill('3');
  await inline.press('Tab');
  await expect.poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.fill')?.params.count).toBe(3);
  await expect(inspector.locator('input#fill-count')).toHaveValue('3');

  // 面板内再改：节点内的摘要同步回来。
  await inspector.locator('input#fill-count').fill('5');
  await inspector.locator('input#fill-count').press('Tab');
  await expect
    .poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.fill')?.params.count)
    .toBe(5);

  // 两次修改各一条撤销记录：撤两次回到原值，而不是把同步也算进去。
  await canvas.press('Control+z');
  await expect.poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.fill')?.params.count).toBe(3);
  await canvas.press('Control+z');
  await expect
    .poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.fill')?.params.count)
    .toBe(original);
});

test('Python 编辑：没有文件导入入口，行号与扩大可用，代码随图保存（10 §6）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const inspector = panel.locator('aside.inspector');

  await addNode(page, 'Python 处理');
  const id = await nodeIdOf(page, 'data.python');
  await focusNode(page, id);
  // 文件导入入口已移除：面板里没有「导入…」类按钮。
  await expect(inspector.getByRole('button', { name: /导入/ })).toHaveCount(0);

  const editor = inspector.locator('pwn2block-code-editor');
  await expect(editor.locator('.gutter')).toHaveCount(1);
  await expect(editor.locator('.highlight')).toHaveCount(1);
  const area = editor.locator('textarea.input');
  await expect(area).toBeVisible();

  // 改代码 → Tab 缩进 → 行号跟着内容 → 扩大再退出不丢内容 → 随图保存。
  // 编辑器与多数输入框一样在失焦时提交，这里主动 blur 一次。
  await area.fill('result = in0\n');
  await area.evaluate((element) => (element as unknown as { blur(): void }).blur());
  await expect
    .poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.python')?.params.code)
    .toBe('result = in0\n');
  await expect(editor.locator('.gutter')).toHaveText('1\n2');

  await area.focus();
  const beforeTab = await area.inputValue();
  await area.press('Tab');
  const afterTab = await area.inputValue();
  expect(afterTab.length).toBeGreaterThan(beforeTab.length);
  expect(afterTab.startsWith(beforeTab)).toBe(true);
  await area.evaluate((element) => (element as unknown as { blur(): void }).blur());
  await expect
    .poll(async () => (await readDoc(page)).nodes.find((node) => node.kind === 'data.python')?.params.code)
    .toBe(afterTab);

  await editor.getByRole('button', { name: '扩大编辑' }).click();
  await expect(editor).toHaveAttribute('expanded', '');
  await editor.getByRole('button', { name: '退出扩大' }).click();
  await expect(editor).not.toHaveAttribute('expanded', '');
  await expect(area).toHaveValue(afterTab);
});

test('节点库：7 个分类、搜索过滤、悬停预览、拖入画布落点（10 §4）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const library = panel.getByRole('complementary', { name: '节点库' });
  const canvas = panel.getByRole('application', { name: '节点画布' });

  // 7 个分类，层级最多两级（分类 → 分组 → 条目）。
  await expect(library.locator('details')).toHaveCount(7);
  expect(await library.locator('details details').count()).toBe(0);

  // 搜索按名字过滤，并显示路径。
  await library.getByRole('searchbox', { name: '搜索节点' }).fill('异或');
  await expect(library.getByRole('button', { name: /逐字节异或/ })).toBeVisible();
  await expect(library.getByRole('button', { name: '填充字节', exact: true })).toHaveCount(0);
  await library.getByRole('searchbox', { name: '搜索节点' }).fill('');

  // 悬停预览：只读预览，不执行、不请求。
  await library.getByRole('button', { name: '填充字节', exact: true }).hover();
  await expect(library.getByRole('region', { name: '节点预览' })).toBeVisible();

  // 拖入画布：落点附近生成节点，且不落在画布外。
  const entry = await library.getByRole('button', { name: '填充字节', exact: true }).boundingBox();
  const area = await canvas.boundingBox();
  if (entry === null || area === null) throw new Error('节点库条目或画布没有尺寸');
  await page.mouse.move(entry.x + entry.width / 2, entry.y + entry.height / 2);
  await page.mouse.down();
  const targetX = area.x + area.width * 0.55;
  const targetY = area.y + area.height * 0.5;
  await page.mouse.move(entry.x + entry.width / 2 + 20, entry.y + entry.height / 2 + 20, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.mouse.up();

  const created = (await readDoc(page)).layout.fill;
  expect(created).toBeDefined();
  // 视口默认 1 倍缩放：落点换算成图坐标后应与指针位置一致（允许图标偏移与取整）。
  const worldX = await panel.evaluate((element, point) => {
    const host = element as unknown as {
      renderRoot: { querySelector(selector: string): unknown };
    };
    const canvasElement = host.renderRoot.querySelector('pwn2block-graph-canvas') as unknown as {
      worldFromClient(x: number, y: number): { x: number; y: number };
    };
    return canvasElement.worldFromClient(point.x, point.y);
  }, { x: targetX, y: targetY });
  expect(Math.abs((created?.x ?? 0) - worldX.x)).toBeLessThan(40);
  expect(Math.abs((created?.y ?? 0) - worldX.y)).toBeLessThan(40);
});

test('拖动节点：位置跟着指针走、不跳变、拖拽期间不选中文字（10 §3.2）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });
  await addNode(page, '填充字节');
  const node = await focusNode(page, 'fill');

  const before = (await readDoc(page)).layout.fill;
  const head = await stableBox(page, node.locator('.node-head'));
  if (before === undefined) throw new Error('节点没有布局');
  // 按在标题左侧（避开右上角的「配置」按钮），这是节点的拖动把手。
  const startX = Math.round(head.x + 28);
  const startY = Math.round(head.y + head.height / 2);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 按下后立刻检查：还没移动时位置不能变（这就是「跳变」的判定）。
  expect((await readDoc(page)).layout.fill).toEqual(before);
  // 拖拽期间正文不可选中。
  expect(await page.evaluate<string>('getSelection()?.toString() ?? ""')).toBe('');

  await page.mouse.move(startX + 40, startY + 30, { steps: 4 });
  await page.mouse.move(startX + 90, startY + 60, { steps: 6 });
  await page.mouse.up();

  const after = (await readDoc(page)).layout.fill;
  // 图坐标位移 = 指针位移 ÷ 缩放（适应窗口后默认不是 1 倍），允许 ±2px 的取整误差。
  const zoom = await canvas.evaluate((element) => (element as unknown as { zoom: number }).zoom);
  expect(Math.abs((after?.x ?? 0) - (before.x + 90 / zoom))).toBeLessThanOrEqual(2);
  expect(Math.abs((after?.y ?? 0) - (before.y + 60 / zoom))).toBeLessThanOrEqual(2);
  expect(await page.evaluate<string>('getSelection()?.toString() ?? ""')).toBe('');
  await expect(canvas.locator('.node[data-node="fill"]')).toBeVisible();
});

test('双模式接线：点击—点击与拖拽都能连上，折线正交且带箭头（10 §3.3、§3.4）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });

  await addNode(page, '开始');
  await addNode(page, '十六进制字节');
  await addNode(page, '题目专用动作');
  const author = await nodeIdOf(page, 'action.author');
  await focusNode(page, author);
  await setAuthorBlock(page, author, 'gets');
  const hexFirst = await nodeIdOf(page, 'data.hex');
  await focusNode(page, hexFirst);

  // ① 点击—点击：先点输出端口，再点兼容的输入端口。
  await canvas.locator(`.port-hit.out[data-node="${hexFirst}"]`).click();
  await expect(canvas.locator('.port-hit.in.compatible').first()).toBeVisible();
  await canvas.locator(`.port-hit.in[data-node="${author}"][data-port="data"]`).click();
  await expect
    .poll(async () => (await readDoc(page)).connections.length)
    .toBe(1);
  const edge = (await readDoc(page)).connections[0];
  expect(edge?.from.node).toBe(hexFirst);
  expect(edge?.to).toMatchObject({ node: author, port: 'data' });

  // 折线只有水平/垂直段（允许 M/L 命令），并且带箭头 marker。
  const path = canvas.locator('path.edge-line').first();
  const d = (await path.getAttribute('d')) ?? '';
  expect(d).toMatch(/^M [\d.-]+ [\d.-]+/);
  expect(d).not.toMatch(/[CQAST]/);
  const points = [...d.matchAll(/([\d.-]+) ([\d.-]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
  expect(points.length).toBeGreaterThan(1);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from === undefined || to === undefined) continue;
    expect(from.x === to.x || from.y === to.y).toBe(true);
  }
  expect(await path.getAttribute('marker-end')).toContain('arrow');

  // ② 拖拽接线：第二个十六进制节点连到第二个题目动作的 data 端口。
  await addNode(page, '十六进制字节');
  await addNode(page, '题目专用动作');
  const document = await readDoc(page);
  const hexSecond = document.nodes.filter((node) => node.kind === 'data.hex')[1]?.id;
  const authorSecond = document.nodes.filter((node) => node.kind === 'action.author')[1]?.id;
  if (hexSecond === undefined || authorSecond === undefined) throw new Error('第二个节点没有建出来');
  // 选中第二个动作节点，去属性面板选积木，让 data 输入端口出现；随后 fit 一屏放下所有节点。
  await focusNode(page, authorSecond);
  await setAuthorBlock(page, authorSecond, 'gets');
  await canvas.evaluate((element) => (element as unknown as { fit(): void }).fit());
  const from = await portCenter(page, canvas, hexSecond, 'out', 'out');
  const to = await portCenter(page, canvas, authorSecond, 'data', 'in');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await readDoc(page)).connections.length)
    .toBe(2);
});

test('接到已占用的输入端口会替换原连接，撤销后恢复（10 §3.3）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });

  await addNode(page, '十六进制字节');
  await addNode(page, '十六进制字节');
  await addNode(page, '题目专用动作');
  const document = await readDoc(page);
  const [first, second] = document.nodes.filter((node) => node.kind === 'data.hex').map((node) => node.id);
  const author = document.nodes.find((node) => node.kind === 'action.author')?.id;
  if (first === undefined || second === undefined || author === undefined) throw new Error('节点没有建全');
  await focusNode(page, author);
  await setAuthorBlock(page, author, 'gets');
  // 画布在视图下方：先滚到画布，再 fit，保证两个端口都落在窗口内（elementFromPoint 才有结果）。
  await canvas.scrollIntoViewIfNeeded();
  await canvas.evaluate((element) => (element as unknown as { fit(): void }).fit());
  await page.waitForTimeout(200);
  // 先接第一根：点击端口两次（点击接线模式）。
  const source = await portCenter(page, canvas, first, 'out', 'out');
  const target = await portCenter(page, canvas, author, 'data', 'in');
  await page.mouse.click(source.x, source.y);
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);

  // 拖第二根到同一个输入端口：单输入端口只保留一根，新的替换旧的。
  const replacement = await portCenter(page, canvas, second, 'out', 'out');
  const again = await portCenter(page, canvas, author, 'data', 'in');
  await page.mouse.move(replacement.x, replacement.y);
  await page.mouse.down();
  await page.mouse.move(again.x, again.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);
  await expect
    .poll(async () => (await readDoc(page)).connections[0]?.from.node)
    .toBe(second);

  // 替换是一次可撤销操作：撤销后回到原来的连接。
  await canvas.press('Control+z');
  await expect
    .poll(async () => (await readDoc(page)).connections[0]?.from.node)
    .toBe(first);
});

test('拖动连线端点改接：接到另一个节点的输入端口，撤销后回到原位（10 §3.3）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });

  await addNode(page, '十六进制字节');
  await addNode(page, '题目专用动作');
  await addNode(page, '题目专用动作');
  await addNode(page, '题目专用动作');
  const document = await readDoc(page);
  const hex = document.nodes.find((node) => node.kind === 'data.hex')?.id;
  const authors = document.nodes.filter((node) => node.kind === 'action.author').map((node) => node.id);
  const [first, second] = authors;
  if (hex === undefined || first === undefined || second === undefined) throw new Error('节点没有建全');
  await focusNode(page, first);
  await setAuthorBlock(page, first, 'gets');
  await focusNode(page, second);
  await setAuthorBlock(page, second, 'gets');

  await canvas.scrollIntoViewIfNeeded();
  await canvas.evaluate((element) => (element as unknown as { fit(): void }).fit());
  await page.waitForTimeout(200);

  // 先接上第一个动作节点。
  const source = await portCenter(page, canvas, hex, 'out', 'out');
  const firstData = await portCenter(page, canvas, first, 'data', 'in');
  await page.mouse.click(source.x, source.y);
  await page.mouse.click(firstData.x, firstData.y);
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);

  // 拖动「输入端」把手到第二个动作节点的 data 端口：改接成功才替换。
  // 把手只在连线被悬停或选中时可点，先点中这条线。
  await clickEdge(page, 0);
  await expect(canvas.locator('g.edge.selected')).toHaveCount(1);
  const handle = canvas.locator('.edge-end[data-edge-end="to"]').first();
  const from = await handle.boundingBox();
  if (from === null) throw new Error('改成把手没有尺寸');
  const secondData = await portCenter(page, canvas, second, 'data', 'in');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondData.x, secondData.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);
  await expect
    .poll(async () => (await readDoc(page)).connections[0]?.to.node)
    .toBe(second);

  await canvas.press('Control+z');
  await expect
    .poll(async () => (await readDoc(page)).connections[0]?.to.node)
    .toBe(first);
});

test('选中连线后 Delete 删除、Ctrl+Z 撤销；双击断线也能撤销（10 §3.3）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });

  await addNode(page, '十六进制字节');
  await addNode(page, '题目专用动作');
  const author = await nodeIdOf(page, 'action.author');
  await focusNode(page, author);
  await setAuthorBlock(page, author, 'gets');
  const hex = await nodeIdOf(page, 'data.hex');
  await focusNode(page, hex);
  await canvas.locator(`.port-hit.out[data-node="${hex}"]`).click();
  await canvas.locator(`.port-hit.in[data-node="${author}"][data-port="data"]`).click();
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);

  // 点连线本体选中，再 Delete。
  await clickEdge(page, 0);
  await canvas.press('Delete');
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(0);
  await canvas.press('Control+z');
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);

  // 双击断线是快捷键，同样可撤销。
  await clickEdge(page, 0, { double: true });
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(0);
  await canvas.press('Control+z');
  await expect.poll(async () => (await readDoc(page)).connections.length).toBe(1);
});

test('空存档刷新后仍是空的；缺「开始」只提示、不自动补节点（10 §5）', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  await expect(panel.locator('.empty-hint')).toBeVisible();
  expect((await readDoc(page)).nodes).toEqual([]);

  // 刷新：空存档仍然是空的（不会偷偷塞一个开始节点）。
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.empty-hint')).toBeVisible();
  expect((await readDoc(page)).nodes).toEqual([]);

  // 只放一个动作节点：编译失败于缺「开始」，节点列表原样保留。
  await addNode(page, '题目专用动作');
  await panel.getByRole('button', { name: '编译', exact: true }).click();
  await expect(panel).toContainText('编译失败');
  await expect(panel.locator('.issues')).toContainText('开始');
  expect((await readDoc(page)).nodes.map((node) => node.kind)).toEqual(['action.author']);
});
