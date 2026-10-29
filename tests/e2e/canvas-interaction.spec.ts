import { expect, test, type Page } from '@playwright/test';
import {
  addToolNode,
  dragBy,
  inspectorOf,
  nodeIdOf,
  openChallenge,
  panelOf,
  placeInFlow,
  readDocument,
  selectNode,
  stageOf,
  toolboxOf,
  type CanvasDocumentJson,
} from './helpers';

/** 按《节点画布UI与交互重构》验证节点库、侧栏配置、拖动、框选与撤销。 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

/** 面板顶栏的修订号：每次文档变化 +1，用来确认编辑真的落进了文档。 */
function revisionOf(page: Page) {
  return panelOf(page).locator('.status-revision');
}

/** 读出「修订 N」里的 N；读不出来就报错，不拿默认值糊弄断言。 */
async function revisionValue(page: Page): Promise<number> {
  const text = await revisionOf(page).innerText();
  const value = Number(text.replace(/\D+/g, ''));
  if (!Number.isFinite(value)) throw new Error(`读不出修订号：${text}`);
  return value;
}

function nameOf(document: CanvasDocumentJson, id: string): string | undefined {
  return document.nodes.find((node) => node.id === id)?.name;
}

function valueOf(document: CanvasDocumentJson, id: string): unknown {
  return document.nodes.find((node) => node.id === id)?.value?.['value'];
}

function argsOf(document: CanvasDocumentJson, id: string): Readonly<Record<string, string>> | undefined {
  return document.nodes.find((node) => node.id === id)?.args;
}

test('工具箱按分类分组，点一项就在空位加一个节点（§6.2）', async ({ page }) => {
  await openChallenge(page);
  const toolbox = toolboxOf(page);

  // 七个分类、十八种节点：分类顺序就是目录顺序，同一分类不切开。
  await expect(toolbox.locator('.toolbox-group')).toHaveCount(7);
  await expect(toolbox.locator('.tool[data-kind]')).toHaveCount(18);
  await expect(toolbox.locator('.toolbox-group[data-category="value"] .tool')).toHaveCount(1);

  // 首屏只有「开始」节点：新画布不再要求用户先自己放一个。
  expect((await readDocument(page)).nodes.map((node) => node.kind)).toEqual(['start']);
  const initial = await revisionValue(page);

  await addToolNode(page, 'var-decl');
  const document = await readDocument(page);
  expect(document.nodes.map((node) => node.kind)).toEqual(['start', 'var-decl']);
  await expect(panelOf(page).locator('.node-box[data-node]')).toHaveCount(2);
  // 加一个节点是**一次**文档变化：修订号只 +1（载入时那一次另有一次）。
  await expect(revisionOf(page)).toHaveText(`修订 ${String(initial + 1)}`);
});

test('点选节点后检查器显示 id，侧栏改名同步到画布行，撤销恢复（§6.1）', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'var-decl');
  const id = await nodeIdOf(page, 'var-decl');

  await selectNode(page, id);
  const inspector = inspectorOf(page);
  await expect(inspector.locator('.inspector-id')).toHaveText(id);

  const nameField = inspector.locator('.field-name');
  await expect(nameField).toHaveValue('a');
  await nameField.fill('count');
  await nameField.press('Tab');
  await expect.poll(async () => nameOf(await readDocument(page), id)).toBe('count');
  await expect(panelOf(page).locator(`.node-box[data-node="${id}"]`)).toContainText('count');

  // 一次改名 = 一条撤销记录：撤销回到目录默认名，画布行跟着回去。
  await panelOf(page).locator('.btn-undo').click();
  await expect.poll(async () => nameOf(await readDocument(page), id)).toBe('a');
  await expect(panelOf(page).locator(`.node-box[data-node="${id}"]`)).not.toContainText('count');
});

test('节点只读展示，值在侧栏编辑并可撤销', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'value');
  const id = await nodeIdOf(page, 'value');
  await selectNode(page, id);
  const field = inspectorOf(page).locator('.field-value');
  await field.fill('7');
  await field.press('Tab');
  await expect.poll(async () => valueOf(await readDocument(page), id)).toBe('7');
  await expect(panelOf(page).locator('.surface input, .surface select, [data-port]')).toHaveCount(0);
  await panelOf(page).locator('.btn-undo').click();
  await expect.poll(async () => valueOf(await readDocument(page), id)).toBe('0');
});

test('拖动节点只改坐标，松手后写回文档，Ctrl+Z 撤回（§6.2）', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'value');
  const id = await nodeIdOf(page, 'value');
  const before = (await readDocument(page)).layout[id];
  if (before === undefined) throw new Error('新加的节点没有布局');

  await dragBy(page, panelOf(page).locator(`.node-box[data-node="${id}"] .title`), 64, 32);

  // 松手时坐标吸附到 8px 网格，所以允许一格误差；结构（节点与主序列）不变。
  await expect
    .poll(async () => {
      const after = (await readDocument(page)).layout[id];
      return after === undefined ? Number.NaN : after.x - before.x;
    })
    .toBeGreaterThan(56);
  const moved = await readDocument(page);
  expect(Math.abs((moved.layout[id]?.x ?? 0) - before.x - 64)).toBeLessThanOrEqual(8);
  expect(Math.abs((moved.layout[id]?.y ?? 0) - before.y - 32)).toBeLessThanOrEqual(8);
  expect(moved.nodes.map((node) => node.kind)).toEqual(['start', 'value']);

  await panelOf(page).locator('.btn-undo').click();
  await expect.poll(async () => (await readDocument(page)).layout[id]?.x).toBe(before.x);
});

test('侧栏配置方法数据来源，Delete 删节点可撤销', async ({ page }) => {
  // 端口来自题目声明的公开方法：`gets(buf)` 只有 ret2win 有，别的题目上根本没有这个方法可选。
  await openChallenge(page, 'ret2win');
  await addToolNode(page, 'method');
  const methodId = await nodeIdOf(page, 'method');
  await addToolNode(page, 'value');
  const valueId = await nodeIdOf(page, 'value');

  // 方法节点先排进流程、再选题目声明的方法，才会长出该方法的参数端口。
  await placeInFlow(page, methodId);
  await selectNode(page, methodId);
  await inspectorOf(page).locator('.field-block').selectOption('gets');
  await expect(inspectorOf(page).locator('.field-param-data')).toHaveValue('');
  await inspectorOf(page).locator('.field-param-data').selectOption(valueId);
  await expect.poll(async () => argsOf(await readDocument(page), methodId)?.['data']).toBe(valueId);
  await expect(panelOf(page).locator('[data-port]')).toHaveCount(0);

  // Delete 删掉选中的方法节点；撤销把它连同那条接线一起装回来。
  await selectNode(page, methodId);
  await panelOf(page).press('Delete');
  await expect.poll(async () => (await readDocument(page)).nodes.map((node) => node.kind)).toEqual(['start', 'value']);
  await panelOf(page).locator('.btn-undo').click();
  await expect.poll(async () => argsOf(await readDocument(page), methodId)?.['data']).toBe(valueId);
});

test('空白处拖出选框，框到的节点一起选中（§6.2）', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'value');
  const id = await nodeIdOf(page, 'value');
  const node = panelOf(page).locator(`.node-box[data-node="${id}"]`);
  const nodeBox = await node.boundingBox();
  const stageBox = await stageOf(page).boundingBox();
  const viewport = page.viewportSize();
  if (nodeBox === null || stageBox === null || viewport === null) throw new Error('节点或画布没有实际尺寸');

  // 画布比视口高：鼠标坐标是视口坐标，所以起点要先夹进可见范围，否则指针事件落在屏幕外。
  const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);
  const startX = clamp(nodeBox.x + nodeBox.width + 160, stageBox.x + 8, Math.min(stageBox.x + stageBox.width - 16, viewport.width - 16));
  const startY = clamp(nodeBox.y + nodeBox.height + 120, stageBox.y + 8, viewport.height - 16);
  if (startX <= nodeBox.x + nodeBox.width + 8 || startY <= nodeBox.y + nodeBox.height + 8) {
    throw new Error('画布上没有足够的空白起点，改用滚动后重试');
  }

  // 从节点右下方的空白处往左上拖，选框覆盖到节点。
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + 4, nodeBox.y + 4, { steps: 6 });
  await expect(panelOf(page).locator('.marquee')).toBeVisible();
  await page.mouse.up();

  await expect(panelOf(page).locator(`.node-box.selected[data-node="${id}"]`)).toBeVisible();
});
