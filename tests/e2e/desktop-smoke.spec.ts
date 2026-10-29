import { test } from './helpers';
import { expect } from '@playwright/test';
import { editorOf, openChallenge, panelOf, readGraph, stageOf, waitForSave } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test('桌面冒烟：工作区可达、键盘移动、刷新恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page),
    stage = stageOf(page);
  await expect(panel.locator('.library')).toBeVisible();
  await expect(panel.locator('.inspector')).toBeVisible();
  const views = await page.locator('pwn2block-view-manager').boundingBox();
  const box = await stage.boundingBox();
  if (!views || !box) throw new Error('工作区没有尺寸');
  expect(box.y).toBeGreaterThanOrEqual(views.y + views.height - 4);
  expect(box.width).toBeGreaterThan(240);
  expect(box.height).toBeGreaterThan(320);
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await panel.getByRole('button', { name: '+ 变量', exact: true }).click();
  const before = (await readGraph(page)).nodes.find((n) => n.kind === 'variable')!;
  await editorOf(page).press('ArrowRight');
  expect((await readGraph(page)).nodes.find((n) => n.id === before.id)?.x).toBe(before.x + 4);
  await waitForSave(page, 'ret2win');
  const saved = await readGraph(page);
  await page.reload();
  await expect(panel).toBeVisible();
  expect(await readGraph(page)).toEqual(saved);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath('desktop-canvas.png') });
  expect(errors).toEqual([]);
});
