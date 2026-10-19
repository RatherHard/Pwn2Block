import { expect, test, type Page } from '@playwright/test';

/**
 * 节点画布的细节回归：编译错误定位、坏存档不覆盖、键盘可达与视图标签。
 *
 * 全部走真实后端与生产构建；只有「读当前图」用面板公开方法，不从 localStorage 猜结构。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实本地后端与 PWN2BLOCK_E2E=1');

const INTERIM_KEY = 'pwn2block.graph.ret2win';
const CURRENT_KEY = 'pwn2block.graph.v1.ret2win';
const VALID_INTERIM = JSON.stringify({
  format: 'pwn2block.workflow',
  version: 1,
  nodes: [{ id: 'start', kind: 'start', params: {} }],
  connections: [],
  main: [],
  layout: { start: { x: 40, y: 40 } },
});

async function openChallenge(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) await picker.getByRole('button').first().click();
  await expect(page.locator('pwn2block-graph-panel')).toBeVisible();
}

test('编译错误在输出区列出，点「定位」选中出错的节点', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  // 默认 author 没选题目积木：编译一定失败。
  await panel.getByRole('complementary', { name: '节点库' })
    .getByRole('searchbox', { name: '搜索节点' }).fill('题目专用动作');
  await panel.getByRole('complementary', { name: '节点库' })
    .getByRole('button', { name: '题目专用动作', exact: true })
    .click();
  await panel.getByRole('button', { name: '编译', exact: true }).click();
  await expect(panel).toContainText('编译失败');

  const issues = panel.locator('.issues');
  await expect(issues).toContainText('题目专用动作');
  await issues.getByRole('button', { name: '定位' }).first().click();
  const canvas = panel.getByRole('application', { name: '节点画布' });
  // 出错节点先被自动高亮（running），定位后同时带上选中样式（10 §3.6）。
  await expect(canvas.locator('.node[data-node="author"]')).toHaveClass(/\b(running|selected)\b/);
  await expect(canvas.locator('.node.selected[data-node="author"]')).toBeVisible();
});

test('当前存档损坏时不回退到旧键，保留原文并提供导出', async ({ page }) => {
  await page.addInitScript(
    ([current, interim]) => {
      localStorage.setItem(current[0], current[1]);
      localStorage.setItem(interim[0], interim[1]);
    },
    [[CURRENT_KEY, '{not-json'], [INTERIM_KEY, VALID_INTERIM]] as const,
  );
  await openChallenge(page);

  const panel = page.locator('pwn2block-graph-panel');
  await expect(panel.locator('.load-failure')).toBeVisible();
  await expect(panel.locator('.load-failure')).toContainText('存档');
  await expect(panel.getByRole('button', { name: '导出原文' })).toBeVisible();
  // 坏存档不覆盖旧键：旧键仍在 localStorage，坏的新键也原样保留。
  expect(await page.evaluate((key) => localStorage.getItem(key), CURRENT_KEY)).toBe('{not-json');
  expect(await page.evaluate((key) => localStorage.getItem(key), INTERIM_KEY)).toBe(VALID_INTERIM);
  // 没有偷偷把旧存档装进来：画布保持空白（10 §5 不再自动插入开始节点）。
  const count = await panel.evaluate((element) =>
    (element as unknown as { currentDocument(): { nodes: unknown[] } }).currentDocument().nodes.length,
  );
  expect(count).toBe(0);
  await expect(panel.locator('.empty-hint')).toBeVisible();
});

test('画布键盘：Delete 删除、Ctrl+Z 撤销、方向键移动选中节点', async ({ page }) => {
  await openChallenge(page);
  const panel = page.locator('pwn2block-graph-panel');
  const canvas = panel.getByRole('application', { name: '节点画布' });
  await panel.getByRole('complementary', { name: '节点库' })
    .getByRole('searchbox', { name: '搜索节点' }).fill('填充字节');
  await panel.getByRole('complementary', { name: '节点库' })
    .getByRole('button', { name: '填充字节', exact: true })
    .click();
  await panel.evaluate((element) => {
    (element as unknown as { locate(request: { nodeId: string }): void }).locate({ nodeId: 'fill' });
  });
  const before = await panel.evaluate((element) =>
    (element as unknown as { currentDocument(): { layout: Record<string, { x: number }> } })
      .currentDocument().layout.fill?.x,
  );
  await canvas.press('ArrowRight');
  const moved = await panel.evaluate((element) =>
    (element as unknown as { currentDocument(): { layout: Record<string, { x: number }> } })
      .currentDocument().layout.fill?.x,
  );
  expect(moved).toBe((before ?? 0) + 8);

  await canvas.press('Delete');
  expect(await panel.evaluate((element) =>
    (element as unknown as { currentDocument(): { nodes: { id: string }[] } })
      .currentDocument().nodes.some((node) => node.id === 'fill'),
  )).toBe(false);
  await canvas.press('Control+z');
  expect(await panel.evaluate((element) =>
    (element as unknown as { currentDocument(): { nodes: { id: string }[] } })
      .currentDocument().nodes.some((node) => node.id === 'fill'),
  )).toBe(true);
});

test('视图标签仍可用方向键切换，Home 回到第一个', async ({ page }) => {
  await openChallenge(page);
  const tablist = page.getByRole('tablist', { name: '视图' });
  const stack = tablist.getByRole('tab').first();
  await stack.focus();
  await stack.press('ArrowRight');
  await expect(tablist.getByRole('tab', { selected: true })).toContainText('指令');
  await tablist.getByRole('tab', { selected: true }).press('Home');
  await expect(stack).toHaveAttribute('aria-selected', 'true');
});
