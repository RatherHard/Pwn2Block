import { expect, test } from '@playwright/test';
import { findCanvasBlock, dragFromToolboxTo, openToolboxCategory } from './gestures';

// 当前源码/生产构建均可；真实后端与真实鼠标，不向组件注入测试状态。
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实本地后端与 PWN2BLOCK_E2E=1');
test.use({ viewport: { width: 1440, height: 900 } });
const sessions = new Set<string>();

test.beforeEach(async ({ page }) => {
  page.on('response', async response => {
    if (response.url().endsWith('/api/sessions') && response.request().method() === 'POST') {
      const body = await response.json() as { sessionId: string };
      sessions.add(body.sessionId);
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await expect(page.locator('pwn2block-payload-panel').getByRole('button', { name: '编译', exact: true })).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  for (const id of sessions) {
    const response = await request.delete(`/api/sessions/${id}`);
    expect([200, 204, 404]).toContain(response.status());
  }
  sessions.clear();
});

test('展开题面和提示仍能操作小桌面的工作区', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const next = page.getByRole('button', { name: '下一条提示', exact: true });
  while (await next.isEnabled()) await next.click();
  await expect.poll(async () => (await page.locator('main').boundingBox())!.height).toBeGreaterThan(300);
  const panel = page.locator('pwn2block-payload-panel');
  const canvas = panel.locator('#blockly-host');
  const clip = (await panel.boundingBox())!;
  const rect = (await canvas.boundingBox())!;
  expect(Math.min(clip.y + clip.height, rect.y + rect.height) - Math.max(clip.y, rect.y)).toBeGreaterThan(120);
  await expect(panel.getByRole('button', { name: '提交判题', exact: true })).toBeInViewport({ ratio: 1 });
});

test('运行步数校验立即显示并随更正消失，两处工具栏一致', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  for (const location of ['pwn2block-payload-panel', 'pwn2block-top-bar']) {
    if (location === 'pwn2block-top-bar') await page.locator(`${location} summary`).filter({ hasText: /^运行$/ }).click();
    const toolbar = page.locator(`${location} pwn2block-run-menu`);
    const input = toolbar.getByRole('spinbutton', { name: '运行步数' });
    for (const invalid of ['0', '', '1.5', '10001']) {
      await input.fill(invalid);
      await toolbar.getByRole('button', { name: '运行 N 步', exact: true }).click();
      await expect(toolbar.getByRole('alert')).toContainText('运行步数需要');
      await input.fill('1');
      await expect(toolbar.getByRole('alert')).toHaveCount(0);
    }
  }
});

test('菜单互斥，外部点击与 Esc 关闭且还原焦点', async ({ page }) => {
  const top = page.locator('pwn2block-top-bar');
  const views = top.locator('summary').filter({ hasText: /^视图$/ });
  const run = top.locator('summary').filter({ hasText: /^运行$/ });
  await views.click();
  await run.click();
  await expect(top.locator('details[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(top.locator('details[open]')).toHaveCount(0);
  await expect(run).toBeFocused();
  await views.click();
  await page.locator('pwn2block-payload-panel h2').click();
  await expect(top.locator('details[open]')).toHaveCount(0);
});

test('手动滚动更新范围，快捷键沿实际位置移动', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  const manager = page.locator('pwn2block-view-manager');
  const viewport = manager.locator('.viewport');
  await viewport.evaluate(el => {
    const view = el as unknown as { scrollTop: number; scrollHeight: number };
    view.scrollTop = view.scrollHeight;
  });
  await expect(manager.locator('.head')).toContainText('3–4 / 4');
  await expect(manager.locator('.head')).not.toContainText('下方还有视图');
  const bottom = await viewport.evaluate(el => (el as unknown as { scrollTop: number }).scrollTop);
  await page.keyboard.press('Control+ArrowUp');
  await expect(manager.locator('.head')).toContainText('2–3 / 4');
  await expect.poll(() => viewport.evaluate(el => (el as unknown as { scrollTop: number }).scrollTop)).toBeLessThan(bottom - 100);
  await page.keyboard.press('Control+ArrowUp');
  await expect(manager.locator('.head')).toContainText('1–2 / 4');
  await expect.poll(() => viewport.evaluate(el => (el as unknown as { scrollTop: number }).scrollTop)).toBeLessThan(2);
  await page.keyboard.press('Control+ArrowDown');
  await expect.poll(() => viewport.evaluate(el => (el as unknown as { scrollTop: number }).scrollTop)).toBeGreaterThan(2);
  await page.keyboard.press('Control+ArrowUp');
  await expect.poll(() => viewport.evaluate(el => (el as unknown as { scrollTop: number }).scrollTop)).toBeLessThan(2);
});

test('自由视图偏移重置、分页与越界规范化保持输入一致', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  const memory = page.locator('pwn2block-memory-view');
  await memory.getByRole('button', { name: 'stack', exact: true }).click();
  const input = memory.getByRole('textbox', { name: 'hex dump 字节偏移' });
  await input.fill('oops');
  await input.press('Tab');
  await expect(memory.getByRole('alert')).toBeVisible();
  await memory.getByRole('button', { name: '回到起点', exact: true }).click();
  await expect(input).toHaveValue('0x0');
  await expect(memory.getByRole('alert')).toHaveCount(0);
  await input.fill('999999');
  await input.press('Tab');
  const normalized = await input.inputValue();
  expect(normalized).toMatch(/^0x[\da-f]+$/);
  await input.fill('9999999');
  await input.press('Tab');
  await expect(input).toHaveValue(normalized);
  await input.fill('bad');
  await input.press('Tab');
  await memory.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(memory.getByRole('alert')).toHaveCount(0);
  await expect(input).toHaveValue(/^0x[\da-f]+$/);
});

test('积木原生右键菜单使用中文', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  await page.locator('#blockly-host').click({ button: 'right', position: { x: 350, y: 100 } });
  await expect(page.getByRole('menu')).toContainText('撤销');
  await expect(page.getByRole('menu')).not.toContainText('Clean up Blocks');
});

test('题面将列表和行内代码呈现为可读结构', async ({ page }) => {
  const briefing = page.locator('pwn2block-briefing-panel .briefing');
  await expect(briefing.locator('ul > li')).toHaveCount(3);
  await expect(briefing.locator('code').filter({ hasText: /^vuln$/ }).first()).toBeVisible();
  await expect(briefing).not.toContainText('`vuln`');
});

test('返回选题并切换回来保留画布及服务端调试状态', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  const host = (await page.locator('#blockly-host').boundingBox())!;
  await openToolboxCategory(page, '开始', 'start');
  await dragFromToolboxTo(page, 'start', { x: host.x + 300, y: host.y + 50 });
  await expect.poll(async () => (await findCanvasBlock(page, 'start', null)) ? 1 : 0).toBe(1);
  const toolbar = page.locator('pwn2block-payload-panel pwn2block-run-menu');
  await toolbar.getByRole('spinbutton', { name: '运行步数' }).fill('1');
  const action = page.waitForResponse(r => r.url().endsWith('/actions') && r.request().method() === 'POST');
  await toolbar.getByRole('button', { name: '运行 N 步', exact: true }).click();
  expect((await (await action).json() as { projection: { steps: number } }).projection.steps).toBe(1);
  await page.getByRole('button', { name: '返回题目列表', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择题目', exact: true })).toBeVisible();
  const otherTitle = await page.locator('.boot button').filter({ hasNotText: '回到胜利' }).first().textContent();
  await page.getByRole('button', { name: otherTitle!.trim(), exact: true }).click();
  await expect(page.locator('pwn2block-payload-panel').getByRole('button', { name: '编译', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '返回题目列表', exact: true }).click();
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await expect(page.locator('pwn2block-app .status')).toContainText('已执行 1 条指令');
  await expect.poll(async () => (await findCanvasBlock(page, 'start', null)) ? 1 : 0).toBe(1);
  expect(sessions.size).toBe(2);
});
