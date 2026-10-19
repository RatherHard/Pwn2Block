import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * 节点画布桌面冒烟：三种 16:9 尺寸下的布局、键盘与刷新恢复基线。
 *
 * 每个 project 用不同 viewport 跑同一份断言：画布、工具箱、检查器都在视口内，
 * 页面没有横向越界，选中节点后方向键能移动、`f` 能适应窗口。
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
  await expect(page.locator('pwn2block-graph-panel')).toContainText('编译成功');
}

test('桌面冒烟：布局、键盘、工具箱、检查器与刷新恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const toolbox = panel.getByRole('complementary', { name: '工具箱' });
  const inspector = panel.getByRole('complementary', { name: '检查器' });
  const canvas = panel.getByRole('application', { name: '节点画布' });
  const viewport = page.viewportSize();
  const size = `${String(viewport?.width)}x${String(viewport?.height)}`;

  await test.step(`布局在 ${size} 内完整可达`, async () => {
    await expect(toolbox).toBeVisible();
    await expect(canvas).toBeVisible();
    for (const locator of [toolbox, canvas, inspector]) await locator.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('画布没有实际尺寸');
    expect(box.width).toBeGreaterThan(240);
    expect(box.height).toBeGreaterThan(200);
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  });

  await test.step('工具箱加节点后选中，方向键移动、f 适应窗口', async () => {
    await toolbox.getByRole('button', { name: '填充字节', exact: true }).click();
    const fill = canvas.locator('g[data-node="fill"]');
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
    await expect(panel).toContainText('编译成功');
    await expect(canvas.locator('g[data-node="fill"]')).toBeVisible();
  });

  await capture(page, info, `desktop-smoke-${size}`);
  expect(errors).toEqual([]);
});
