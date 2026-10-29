import { test } from './helpers';
import { expect } from '@playwright/test';
import { canvasKey, constant, editorOf, installGraph, openChallenge, panelOf, readGraph } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test('错误引用阻止运行，并能定位错误方法', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(
    page,
    [constant('value', 80, 220), { id: 'call', kind: 'method', method: 'gets', x: 400, y: 50 }],
    [
      { id: 'flow', kind: 'flow', from: 'start', to: 'call', outlet: 'next' },
      { id: 'ref', kind: 'reference', from: 'value', to: 'call', port: 'data' },
    ],
  );
  const panel = panelOf(page);
  await expect(panel.locator('.feedback')).toContainText('需要 bytes');
  await expect(panel.locator('.btn-run')).toBeDisabled();
  await panel.locator('.feedback .error button').click();
  await expect(panel.locator('[data-node="call"]')).toHaveClass(/selected/);
});
test('损坏存档保留原文，旧键不会被覆盖', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await page.evaluate((key) => {
    localStorage.setItem(key, '{broken');
    localStorage.setItem('pwn2block.canvas.v1.ret2win', 'old');
  }, canvasKey('ret2win'));
  await page.reload();
  await expect(panelOf(page).locator('.archive')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), canvasKey('ret2win'))).toBe('{broken');
  expect(await page.evaluate(() => localStorage.getItem('pwn2block.canvas.v1.ret2win'))).toBe('old');
  const download = page.waitForEvent('download');
  await panelOf(page).getByRole('button', { name: '导出原存档', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('ret2win');
});
test('Delete 删除、撤销恢复，输入名称不会触发画布快捷键', async ({ page }) => {
  await openChallenge(page);
  const panel = panelOf(page);
  await panel.getByRole('button', { name: '+ 变量', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('变量x');
  await panel.getByLabel('名称', { exact: true }).press('Tab');
  const before = await readGraph(page);
  await editorOf(page).press('Delete');
  expect((await readGraph(page)).nodes).toHaveLength(1);
  await editorOf(page).press('Control+z');
  expect(await readGraph(page)).toEqual(before);
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
