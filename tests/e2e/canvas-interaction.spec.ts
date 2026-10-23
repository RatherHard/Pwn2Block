import { expect, test, type Page } from '@playwright/test';
import {
  addToolNode,
  dragBy,
  dragBetween,
  inspectorOf,
  nodeIdOf,
  openChallenge,
  panelOf,
  portOf,
  readDocument,
  selectNode,
  stageOf,
  toolboxOf,
  type CanvasDocumentJson,
} from './helpers';

/**
 * 新版画布的交互回归（《节点画布大型修改》§6.1–§6.3；《改版计划》阶段三）。
 *
 * 覆盖的是「编辑一张图」的六条基本动作：
 * 1. 工具箱按目录分组，点一项就在空位加一个节点；
 * 2. 点选节点 → 检查器显示它的 id，侧栏改名同步到画布行，撤销恢复原值；
 * 3. 双击「值」行就地编辑：Enter 提交、Esc 取消；
 * 4. 拖动节点只改坐标、不改结构，Ctrl+Z 撤回；
 * 5. 从输入端口拉线接到别的节点上，Delete 删节点也能撤销；
 * 6. 空白处拖出选框，命中范围内的节点一起选中。
 *
 * 旧画布独有的交互（Blockly 节点库两级目录与搜索、拖入落点、缩放与适应窗口、
 * 点击—点击双模式接线、连线命中与端点改接）已随旧画布删除，这里不再保留用例。
 * 断言读数一律走面板公开的 `document`（见 `helpers.ts`），只有「看起来怎样」才查 DOM。
 */
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

test('双击「值」行就地编辑：Enter 提交、Esc 取消（§6.1）', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'value');
  const id = await nodeIdOf(page, 'value');
  const row = panelOf(page).locator(`.row.editable[data-node="${id}"]`).first();
  const input = panelOf(page).locator('.row-input');

  await row.dblclick();
  await expect(input).toBeVisible();
  await input.fill('7');
  await input.press('Enter');
  await expect.poll(async () => valueOf(await readDocument(page), id)).toBe('7');
  await expect(input).toHaveCount(0);

  // Esc 取消：输入框关掉，文档保持上一次提交的值。
  await row.dblclick();
  await expect(input).toBeVisible();
  await input.fill('9');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  expect(valueOf(await readDocument(page), id)).toBe('7');
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

test('从输入端口拉线接到别的节点，Delete 删节点可撤销（§6.3）', async ({ page }) => {
  await openChallenge(page);
  await addToolNode(page, 'method');
  const methodId = await nodeIdOf(page, 'method');
  await addToolNode(page, 'value');
  const valueId = await nodeIdOf(page, 'value');

  // 方法节点先选题目声明的方法，才会长出该方法的参数端口。
  await selectNode(page, methodId);
  await inspectorOf(page).locator('.field-block').selectOption('gets');
  const port = portOf(page, methodId, 'data');
  await expect(port).toHaveClass(/\bhollow\b/);

  // 新版画布只有输入端口：接线 = 把端口拖到提供值的节点身上。
  await dragBetween(page, port, panelOf(page).locator(`.node-box[data-node="${valueId}"]`));
  await expect.poll(async () => argsOf(await readDocument(page), methodId)?.['data']).toBe(valueId);
  await expect(portOf(page, methodId, 'data')).toHaveClass(/\bconnected\b/);

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
  if (nodeBox === null || stageBox === null) throw new Error('节点或画布没有实际尺寸');

  // 从画布右下角（空白处）往左上拖，选框覆盖到节点。
  await page.mouse.move(stageBox.x + stageBox.width - 16, stageBox.y + stageBox.height - 16);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + 4, nodeBox.y + 4, { steps: 6 });
  await expect(panelOf(page).locator('.marquee')).toBeVisible();
  await page.mouse.up();

  await expect(panelOf(page).locator(`.node-box.selected[data-node="${id}"]`)).toBeVisible();
});
