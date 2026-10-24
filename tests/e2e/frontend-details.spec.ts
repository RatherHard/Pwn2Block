import { expect, test } from '@playwright/test';
import { addToolNode, canvasKey, inspectorOf, nodeIdOf, openChallenge, panelOf, readDocument, selectNode } from './helpers';

/**
 * 新版画布的细节回归：编译错误在输出区定位、坏存档不覆盖旧键、键盘可达与视图标签。
 *
 * 全部走真实后端与生产构建；只有「读当前图」用面板公开属性，不从 localStorage 猜结构。
 * 旧画布的 `.issues` / `.load-failure` / `.empty-hint` 与「导出原文」按钮已随旧面板删除，
 * 对应的三处断言分别换成：输出区的编译错误条目、`pwn2block-legacy-archive-bar`、键盘走新版画布。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实本地后端与 PWN2BLOCK_E2E=1');

/** 旧世代的两个键：`pwn2block.graph.<题目>`（裸图）与 `pwn2block.graph.v1.<题目>`（包装 + 依赖表）。 */
const INTERIM_KEY = 'pwn2block.graph.ret2win';
const PACKED_KEY = 'pwn2block.graph.v1.ret2win';
const OLD_WORKFLOW = JSON.stringify({
  format: 'pwn2block.workflow',
  version: 1,
  nodes: [{ id: 'start', kind: 'start', params: {} }],
  connections: [],
  main: [],
  layout: { start: { x: 40, y: 40 } },
});

test('方法节点没选题目方法时编译失败，输出区能定位到出错的节点', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page);

  // 方法节点默认是「未选择方法」：一定编译失败，且错误挂在节点自己身上。
  await addToolNode(page, 'method');
  const methodId = await nodeIdOf(page, 'method');
  await expect(panel.locator('.status-error')).not.toContainText('错误 0');

  const output = page.locator('pwn2block-app .output');
  await expect(output).toContainText('方法');
  await output.getByRole('button', { name: '定位积木' }).first().click();
  // 定位只给 1.2s 的高亮，所以等的是「出现过」。
  await expect(panel.locator(`.node-box.highlight[data-node="${methodId}"]`)).toBeVisible();
});

test('新档损坏时不回退到旧档，原文与旧键都原样保留', async ({ page }) => {
  await page.addInitScript(
    ([current, interim, packed]) => {
      localStorage.setItem(current[0], current[1]);
      localStorage.setItem(interim[0], interim[1]);
      localStorage.setItem(packed[0], packed[1]);
    },
    [
      [canvasKey('ret2win'), '{not-json'],
      [INTERIM_KEY, OLD_WORKFLOW],
      [PACKED_KEY, OLD_WORKFLOW],
    ] as const,
  );
  await openChallenge(page, 'ret2win');

  // 读不出新档 → 退回默认文档（只有一个开始节点），绝不擅自把旧档装进来。
  expect((await readDocument(page)).nodes.map((node) => node.kind)).toEqual(['start']);
  // 旧档只在提示条里汇报、可导出；不删、不改、不迁移。
  const legacy = page.locator('pwn2block-legacy-archive-bar');
  await expect(legacy).toBeVisible();
  await expect(legacy.getByRole('button', { name: '导出旧存档' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), canvasKey('ret2win'))).toBe('{not-json');
  expect(await page.evaluate((key) => localStorage.getItem(key), INTERIM_KEY)).toBe(OLD_WORKFLOW);
  expect(await page.evaluate((key) => localStorage.getItem(key), PACKED_KEY)).toBe(OLD_WORKFLOW);
});

test('画布键盘：Delete 删除、Ctrl+Z 撤销、方向键移动选中节点', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page);
  await addToolNode(page, 'var-decl');
  const id = await nodeIdOf(page, 'var-decl');
  await selectNode(page, id);
  await expect(inspectorOf(page).locator('.inspector-id')).toHaveText(id);

  const before = (await readDocument(page)).layout[id];
  if (before === undefined) throw new Error('新加的节点没有布局');
  await panel.press('ArrowRight');
  await expect.poll(async () => (await readDocument(page)).layout[id]?.x).toBe(before.x + 8);

  await panel.press('Delete');
  await expect.poll(async () => (await readDocument(page)).nodes.map((node) => node.kind)).toEqual(['start']);
  await panel.press('Control+z');
  await expect.poll(async () => (await readDocument(page)).nodes.map((node) => node.id)).toContain(id);
});

test('视图标签仍可用方向键切换，Home 回到第一个', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  const tablist = page.getByRole('tablist', { name: '视图' });
  const stack = tablist.getByRole('tab').first();
  await stack.focus();
  await stack.press('ArrowRight');
  await expect(tablist.getByRole('tab', { selected: true })).toContainText('指令');
  await tablist.getByRole('tab', { selected: true }).press('Home');
  await expect(stack).toHaveAttribute('aria-selected', 'true');
});
