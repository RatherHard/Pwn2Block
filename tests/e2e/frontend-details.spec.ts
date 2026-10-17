import { expect, test, type Page } from '@playwright/test';
import { findCanvasBlock, dragFromToolboxTo, openToolboxCategory } from './gestures';

// 当前源码/生产构建均可；真实后端与真实鼠标，不向组件注入测试状态。
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实本地后端与 PWN2BLOCK_E2E=1');
test.use({ viewport: { width: 1440, height: 900 } });
const sessions = new Set<string>();

/** 会话就绪：状态栏显示 ip（画布为空时「运行」仍禁用，不能拿它当信号）。 */
async function sessionReady(page: Page): Promise<void> {
  await expect(page.locator('pwn2block-app .status')).toContainText(/ip=0x[\da-f]+/);
}

/** 顶栏「运行」菜单默认收起，先展开再操作里面的按钮。 */
async function openRunMenu(page: Page): Promise<void> {
  await page.locator('pwn2block-top-bar summary').filter({ hasText: /^运行$/ }).click();
  await expect(page.locator('pwn2block-top-bar details.menu')).toHaveAttribute('open', '');
}

test.beforeEach(async ({ page }) => {
  page.on('response', async response => {
    if (response.url().endsWith('/api/sessions') && response.request().method() === 'POST') {
      const body = await response.json() as { sessionId: string };
      sessions.add(body.sessionId);
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await sessionReady(page);
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
  // 标题栏的「运行 / 终止」在小桌面上完整可见。
  for (const name of ['运行', '终止']) {
    await expect(panel.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test('运行步数校验立即显示并随更正消失', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  await openRunMenu(page);
  const toolbar = page.locator('pwn2block-top-bar pwn2block-run-menu');
  const input = toolbar.getByRole('spinbutton', { name: '运行步数' });
  for (const invalid of ['0', '', '1.5', '10001']) {
    await input.fill(invalid);
    await toolbar.getByRole('button', { name: '运行 N 步', exact: true }).click();
    await expect(toolbar.getByRole('alert')).toContainText('运行步数需要');
    await input.fill('1');
    await expect(toolbar.getByRole('alert')).toHaveCount(0);
  }
});

test('运行菜单：Esc 关闭并还原焦点，外部点击关闭', async ({ page }) => {
  const top = page.locator('pwn2block-top-bar');
  const run = top.locator('summary').filter({ hasText: /^运行$/ });
  await expect(top.locator('details.menu'), '顶栏只剩「运行」一个菜单').toHaveCount(1);
  await run.click();
  await expect(top.locator('details[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(top.locator('details[open]')).toHaveCount(0);
  await expect(run).toBeFocused();
  await run.click();
  await expect(top.locator('details[open]')).toHaveCount(1);
  await page.locator('pwn2block-payload-panel h2').click();
  await expect(top.locator('details[open]')).toHaveCount(0);
});

test('视图标签：方向键与 Ctrl+↑/↓ 切换', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  const tablist = page.getByRole('tablist', { name: '视图', exact: true });
  const tab = (name: RegExp) => tablist.getByRole('tab', { name });
  const panel = (kind: string) => page.locator(`pwn2block-view-manager #panel-${kind}`);
  await expect(tab(/栈/)).toHaveAttribute('aria-selected', 'true');
  await expect(panel('stack')).toBeVisible();
  await expect(panel('disasm')).toBeHidden();
  // 焦点在标签上：→ 切到下一个并移动焦点，只显示当前面板。
  await tab(/栈/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(/指令/)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(/指令/)).toBeFocused();
  await expect(panel('disasm')).toBeVisible();
  await expect(panel('stack')).toBeHidden();
  await page.keyboard.press('End');
  const last = tablist.getByRole('tab').last();
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tab(/栈/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(last, '在第一个标签上按 ← 回到最后一个').toHaveAttribute('aria-selected', 'true');
  // Ctrl+↓ / Ctrl+↑ 在页面上循环（焦点不在输入框里）：从最后一个绕回第一个。
  await page.locator('pwn2block-payload-panel h2').click();
  await page.keyboard.press('Control+ArrowDown');
  await expect(tab(/栈/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+ArrowDown');
  await expect(tab(/指令/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+ArrowUp');
  await expect(tab(/栈/)).toHaveAttribute('aria-selected', 'true');
});

test('当前视图标签写入 p2b:view-tab，跨刷新与题目共用，非法值回退到栈', async ({ page }) => {
  const tab = (name: RegExp) => page.getByRole('tablist', { name: '视图', exact: true }).getByRole('tab', { name });
  await page.locator('pwn2block-briefing-panel summary').click();
  await tab(/寄存器/).click();
  await expect(page.locator('pwn2block-view-manager #panel-registers')).toBeVisible();
  await expect.poll(() => page.evaluate<string | null>(`localStorage.getItem('p2b:view-tab')`)).toBe('registers');
  await page.reload();
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await sessionReady(page);
  await expect(tab(/寄存器/), '刷新后恢复上次的标签').toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '返回题目列表', exact: true }).click();
  const other = await page.locator('.boot button').filter({ hasNotText: '回到胜利' }).first().textContent();
  await page.getByRole('button', { name: other!.trim(), exact: true }).click();
  await sessionReady(page);
  await expect(tab(/寄存器/), '换一道题仍是同一个标签').toHaveAttribute('aria-selected', 'true');
  await page.evaluate(`localStorage.setItem('p2b:view-tab', 'bogus')`);
  await page.reload();
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await sessionReady(page);
  await expect(tab(/栈/), '非法存储值回退到栈').toHaveAttribute('aria-selected', 'true');
});

test('自由视图偏移重置、分页与越界规范化保持输入一致', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  // 自由视图在「内存」标签里；非当前标签的面板是 hidden 的，先切过去。
  await page.getByRole('tablist', { name: '视图', exact: true }).getByRole('tab', { name: /内存/ }).click();
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
  // 链接只渲染文字，不生成 <a>。
  await expect(briefing.locator('a')).toHaveCount(0);
});

test('返回选题并切换回来保留画布及服务端调试状态', async ({ page }) => {
  await page.locator('pwn2block-briefing-panel summary').click();
  const host = (await page.locator('#blockly-host').boundingBox())!;
  await openToolboxCategory(page, '开始', 'start');
  await dragFromToolboxTo(page, 'start', { x: host.x + 300, y: host.y + 50 });
  await expect.poll(async () => (await findCanvasBlock(page, 'start', null)) ? 1 : 0).toBe(1);
  await openRunMenu(page);
  const toolbar = page.locator('pwn2block-top-bar pwn2block-run-menu');
  await toolbar.getByRole('spinbutton', { name: '运行步数' }).fill('1');
  const action = page.waitForResponse(r => r.url().endsWith('/actions') && r.request().method() === 'POST');
  await toolbar.getByRole('button', { name: '运行 N 步', exact: true }).click();
  expect((await (await action).json() as { projection: { steps: number } }).projection.steps).toBe(1);
  await page.getByRole('button', { name: '返回题目列表', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择题目', exact: true })).toBeVisible();
  const otherTitle = await page.locator('.boot button').filter({ hasNotText: '回到胜利' }).first().textContent();
  await page.getByRole('button', { name: otherTitle!.trim(), exact: true }).click();
  await sessionReady(page);
  await page.getByRole('button', { name: '返回题目列表', exact: true }).click();
  await page.getByRole('button', { name: '回到胜利', exact: true }).click();
  await expect(page.locator('pwn2block-app .status')).toContainText('已执行 1 条指令');
  await expect.poll(async () => (await findCanvasBlock(page, 'start', null)) ? 1 : 0).toBe(1);
  expect(sessions.size).toBe(2);
});
