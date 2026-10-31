import { test } from './helpers';
import { expect } from '@playwright/test';
import { constant, dragNode, editorOf, installGraph, openChallenge, panelOf, readGraph, stageOf } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });
test('节点库加入独立常量，侧栏编辑并撤销', async ({ page }) => {
  await openChallenge(page);
  const panel = panelOf(page);
  if (await panel.locator('[data-category="data"]').isVisible()) await panel.locator('[data-category="data"]').click();
  await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  await panel.getByLabel('数据类型').selectOption('string');
  await panel.getByLabel('值', { exact: true }).fill('hello');
  await panel.getByLabel('值', { exact: true }).press('Tab');
  await expect(panel.locator('[data-kind="constant"]')).toContainText('hello');
  await editorOf(page).press('Control+z');
  await expect(panel.locator('[data-kind="constant"]')).not.toContainText('hello');
});
test('拖动空白区域不产生连接，坐标可撤销', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 80, 220)]);
  const before = await readGraph(page);
  await dragNode(page, 'a', 450, 400);
  expect((await readGraph(page)).nodes.find((n) => n.id === 'a')).toMatchObject({ x: 450, y: 400 });
  expect((await readGraph(page)).edges).toEqual([]);
  await editorOf(page).press('Control+z');
  expect(await readGraph(page)).toEqual(before);
});
test('空白框选同类节点并创建包络', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 80, 220), constant('b', 348, 220)],
    [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }]);
  const stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  const box = await stage.boundingBox();
  if (!box) throw new Error('缺少画布');
  await page.mouse.move(box.x + 50, box.y + 190);
  await page.mouse.down();
  await page.mouse.move(box.x + 540, box.y + 320, { steps: 8 });
  await page.mouse.up();
  await expect(panelOf(page).locator('.node.selected')).toHaveCount(2);
  await editorOf(page).press('Control+g');
  await expect(panelOf(page).locator('.envelope')).toHaveCount(1);
});
test('连续新增节点不会遮挡已有节点', async ({ page }) => {
  await openChallenge(page);
  const panel = panelOf(page);
  if (await panel.locator('[data-category="data"]').isVisible()) await panel.locator('[data-category="data"]').click();
  for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  const nodes = (await readGraph(page)).nodes;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!,
        b = nodes[j]!;
      expect(Math.abs(a.x - b.x) >= 180 || Math.abs(a.y - b.y) >= 76).toBe(true);
    }
});
