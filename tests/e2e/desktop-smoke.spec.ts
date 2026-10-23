import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { addToolNode, inspectorOf, nodeIdOf, openChallenge, panelOf, readDocument, selectNode, stageOf, toolboxOf } from './helpers';

/**
 * 新版画布的桌面冒烟：六种 viewport 跑同一份断言，守住「窄高窗口也能用」的底线。
 *
 * 断言三件事：工具箱 / 画布 / 检查器都在视口内可达；页面能竖直滚动且没有横向越界；
 * 选中节点后方向键把它挪 8px（吸附网格也是 8px），刷新后从 v2 存档原样装回来。
 *
 * 旧画布独有的「`f` 适应窗口、缩放、节点库拖入」不再存在，本文件不再保留对应步骤。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('桌面冒烟：上下布局、方向键微调与刷新恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openChallenge(page);
  const panel = panelOf(page);
  const toolbox = toolboxOf(page);
  const inspector = inspectorOf(page);
  const stage = stageOf(page);
  const viewport = page.viewportSize();
  const size = `${String(viewport?.width)}x${String(viewport?.height)}`;

  await test.step(`布局在 ${size} 内完整可达，且页面可竖直滚动`, async () => {
    await expect(toolbox).toBeVisible();
    await expect(stage).toBeVisible();
    await expect(inspector).toBeVisible();
    // 视图区在上、画布工作区在下：画布的顶边必须落在视图区底边之下。
    const viewsBox = await page.locator('pwn2block-view-manager').boundingBox();
    const stageBox = await stage.boundingBox();
    if (viewsBox === null || stageBox === null) throw new Error('视图区或画布没有实际尺寸');
    expect(stageBox.y).toBeGreaterThanOrEqual(viewsBox.y + viewsBox.height - 4);
    expect(stageBox.width).toBeGreaterThan(240);
    expect(viewsBox.height).toBeGreaterThanOrEqual(500);
    expect(stageBox.height).toBeGreaterThan(320);
    // 窄高排布后靠页面滚动，不能出现横向越界。
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate<boolean>('document.documentElement.scrollHeight > innerHeight')).toBe(true);
    await capture(page, info, `desktop-layout-${size}`);
  });

  await test.step('工具箱加节点后选中，方向键移动 8px', async () => {
    await addToolNode(page, 'var-decl');
    const id = await nodeIdOf(page, 'var-decl');
    await selectNode(page, id);
    const before = (await readDocument(page)).layout[id];
    if (before === undefined) throw new Error('新加的节点没有布局');

    await panel.press('ArrowRight');
    await expect.poll(async () => (await readDocument(page)).layout[id]?.x).toBe(before.x + 8);
    // 新建节点默认坐标就在 8px 网格上，所以这里应当精确 +8 而不是近似。
    expect((await readDocument(page)).layout[id]?.y).toBe(before.y);
    await expect(inspector).toContainText(id);
  });

  await test.step('刷新后画布从 v2 存档装回来', async () => {
    const before = (await readDocument(page)).nodes.map((node) => `${node.kind}:${node.id}`);
    await page.reload();
    await expect(panel).toBeVisible();
    const after = (await readDocument(page)).nodes.map((node) => `${node.kind}:${node.id}`);
    expect(after).toEqual(before);
    await expect(panel.locator('.node-box[data-node]')).toHaveCount(before.length);
    await capture(page, info, `desktop-restored-${size}`);
  });

  expect(errors).toEqual([]);
});
