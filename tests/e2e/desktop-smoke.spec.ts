import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * 节点画布桌面冒烟：多种屏幕比例下的布局、键盘与刷新恢复基线。
 *
 * 每个 project 用不同 viewport 跑同一份断言：画布、节点库、检查器都在视口内，
 * 上下排布后整页可以竖直滚动、没有横向越界，选中节点后方向键能移动、`f` 能适应窗口。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function openChallenge(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) await picker.getByRole('button').first().click();
  await expect(page.locator('pwn2block-graph-panel')).toBeVisible();
}

test('桌面冒烟：上下布局、键盘、节点库、检查器与刷新恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const library = panel.getByRole('complementary', { name: '节点库' });
  const inspector = panel.getByRole('complementary', { name: '属性' });
  const canvas = panel.getByRole('application', { name: '节点画布' });
  const viewport = page.viewportSize();
  const size = `${String(viewport?.width)}x${String(viewport?.height)}`;

  await test.step(`布局在 ${size} 内完整可达，且页面可竖直滚动（10 §1）`, async () => {
    await expect(library).toBeVisible();
    await expect(canvas).toBeVisible();
    await expect(inspector).toBeVisible();
    // 视图区在上、画布工作区在下：画布顶边必须低于视图区。
    const views = page.locator('pwn2block-view-manager');
    const viewsBox = await views.boundingBox();
    const canvasBox = await canvas.boundingBox();
    if (viewsBox === null || canvasBox === null) throw new Error('视图区或画布没有实际尺寸');
    expect(canvasBox.y).toBeGreaterThanOrEqual(viewsBox.y + viewsBox.height - 4);
    expect(canvasBox.width).toBeGreaterThan(240);
    expect(viewsBox.height).toBeGreaterThanOrEqual(500);
    expect(canvasBox.height).toBeGreaterThanOrEqual(480);
    // 窄高排布后靠页面滚动，不能出现横向越界。
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate<boolean>('document.documentElement.scrollHeight > innerHeight')).toBe(true);
    await capture(page, info, `desktop-layout-${size}`);
  });

  await test.step('节点库加节点后选中，方向键移动、f 适应窗口', async () => {
    await library.getByRole('button', { name: '字节与载荷', exact: true }).click();
    const fillCard = library.getByRole('button', { name: '填充字节', exact: true });
    await expect(fillCard.locator('.preview')).toBeVisible();
    expect(await fillCard.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element, '::before').content)).toBe('none');
    expect(await fillCard.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element, '::after').content)).toBe('none');
    await fillCard.click();
    const fill = canvas.locator('.node[data-node="fill"]');
    await expect(fill).toBeVisible();
    await panel.evaluate((element) => {
      (element as unknown as { locate(request: { nodeId: string }): void }).locate({ nodeId: 'fill' });
    });
    const before = await panel.evaluate((element) => {
      const document = (element as unknown as { currentDocument(): { layout: Record<string, { x: number; y: number }> } })
        .currentDocument();
      return document.layout.fill;
    });
    await canvas.press('ArrowRight');
    await canvas.press('f');
    const after = await panel.evaluate((element) => {
      const document = (element as unknown as { currentDocument(): { layout: Record<string, { x: number; y: number }> } })
        .currentDocument();
      return document.layout.fill;
    });
    expect(after?.x).toBe((before?.x ?? 0) + 8);
    await expect(inspector).toContainText('fill');
  });

  await test.step('刷新后画布装回来', async () => {
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(canvas.locator('.node[data-node="fill"]')).toBeVisible();
    await capture(page, info, `desktop-restored-${size}`);
  });

  expect(errors).toEqual([]);
});
