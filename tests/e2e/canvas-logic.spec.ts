import { test } from './helpers';
import { expect, type Page } from '@playwright/test';
import { openChallenge, panelOf } from './helpers';
import type { canvas } from '../../packages/shared/src';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });
const constant = (id: string, x: number, y: number, text = '2', type: canvas.LogicType = 'int'): canvas.LogicNode => ({
  id,
  kind: 'constant',
  value: { type, text },
  x,
  y,
});
async function install(page: Page, nodes: canvas.LogicNode[], edges: canvas.LogicEdge[] = []) {
  await panelOf(page).evaluate(
    (panel, logic) => {
      if (!('setDocument' in panel) || typeof panel.setDocument !== 'function') throw new Error('缺少导入入口');
      panel.setDocument({ format: 'pwn2block.canvas', version: 2, nodes: [], layout: {}, main: [], logic });
    },
    { version: 1 as const, nodes: [{ id: 'start', kind: 'start' as const, x: 70, y: 50 }, ...nodes], edges },
  );
}
async function graph(page: Page): Promise<canvas.LogicGraph> {
  return panelOf(page).evaluate((panel) => {
    if (!('document' in panel)) throw new Error('缺少文档');
    return (panel.document as canvas.CanvasDocument).logic!;
  });
}
async function drag(page: Page, id: string, x: number, y: number, release = true) {
  await panelOf(page)
    .locator('.stage')
    .evaluate((e) => e.scrollIntoView({ block: 'start' }));
  const stage = await panelOf(page).locator('.stage').boundingBox(),
    node = await panelOf(page).locator(`.node[data-node="${id}"]`).boundingBox();
  if (!stage || !node) throw new Error('缺少拖动几何');
  await page.mouse.move(node.x + 50, node.y + 20);
  await page.mouse.down();
  await page.mouse.move(stage.x + x + 50, stage.y + y + 20, { steps: 8 });
  if (release) await page.mouse.up();
}

test('格点、唯一开始、五种类型和变量名称属性', async ({ page }, info) => {
  await openChallenge(page);
  const panel = panelOf(page);
  await expect(panel.locator('[data-kind="start"]')).toHaveCount(1);
  await expect(panel.locator('pattern#logic-dots rect')).toHaveCount(1);
  if (await panel.locator('[data-category="data"]').isVisible()) await panel.locator('[data-category="data"]').click();
  await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  await expect(panel.getByLabel('数据类型')).toBeVisible();
  expect(await panel.getByLabel('数据类型').locator('option').allTextContents()).toEqual([
    'int',
    'double',
    'string',
    'bytes',
    'bool',
  ]);
  if (await panel.locator('[data-category="data"]').isVisible()) await panel.locator('[data-category="data"]').click();
  await panel.getByRole('button', { name: '+ 变量', exact: true }).click();
  await expect(panel.getByLabel('名称', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('数据类型')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('logic-canvas.png') });
});

test('最近吸附虚化预览、远离消失、松开实体化、右侧换运算和撤销', async ({ page }, info) => {
  await openChallenge(page);
  await install(page, [constant('a', 80, 220), constant('b', 500, 400), constant('c', 800, 220)]);
  const panel = panelOf(page);
  await drag(page, 'b', 300, 220, false);
  await expect(panel.locator('.relation.ghost')).toHaveCount(1);
  expect((await graph(page)).edges).toHaveLength(0);
  const stage = await panel.locator('.stage').boundingBox();
  if (!stage) throw new Error('stage');
  await page.mouse.move(stage.x + 550, stage.y + 450, { steps: 6 });
  await expect(panel.locator('.relation.ghost')).toHaveCount(0);
  await page.mouse.move(stage.x + 350, stage.y + 240, { steps: 6 });
  await expect(panel.locator('.relation.ghost')).toHaveCount(1);
  await page.mouse.up();
  await expect(panel.locator('.relation:not(.ghost)')).toHaveCount(1);
  expect((await graph(page)).edges).toHaveLength(1);
  const a = await panel.locator('[data-node="a"]').boundingBox(),
    b = await panel.locator('[data-node="b"]').boundingBox(),
    r = await panel.locator('.relation').boundingBox();
  if (!a || !b || !r) throw new Error('关系几何');
  expect(r.x - a.x - a.width).toBeGreaterThan(4);
  expect(b.x - r.x - r.width).toBeGreaterThan(4);
  await panel.locator('.relation').click();
  await panel.getByLabel('关系', { exact: true }).selectOption('*');
  await expect(panel.locator('.relation')).toHaveText('*');
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panel.locator('.relation')).toHaveText('+');
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panel.locator('.relation')).toHaveCount(0);
  await panel.getByRole('button', { name: '重做', exact: true }).click();
  await expect(panel.locator('.relation')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('logic-relation.png') });
});

test('内部吸附纳入包络、转换附着与解除、刷新保留结构', async ({ page }, info) => {
  await openChallenge(page);
  await install(page, [
    constant('a', 130, 240),
    constant('b', 520, 420),
    { id: 'g', kind: 'envelope', title: '表达式', category: 'data', members: ['a'], x: 100, y: 200 },
    {
      id: 'convert',
      kind: 'convert',
      value: { type: 'int', text: '0' },
      target: 'bytes',
      width: '8',
      endian: 'little',
      signed: false,
      x: 750,
      y: 420,
    },
  ]);
  const panel = panelOf(page);
  await drag(page, 'b', 220, 240);
  await expect
    .poll(async () => (await graph(page)).nodes.find((n) => n.id === 'g'))
    .toMatchObject({ members: ['a', 'b'] });
  await panel.locator('[data-node="convert"]').click();
  await panel.getByLabel('附着包络').selectOption('g');
  await expect(panel.locator('.node[data-node="convert"]')).toHaveCount(0);
  await expect(panel.locator('.envelope-header [data-attachment="convert"]')).toContainText('类型转换');
  await expect
    .poll(async () => page.evaluate(() => Object.values(localStorage).some((v) => v.includes('"input":"g"'))))
    .toBe(true);
  await page.reload();
  await expect(panel.locator('.envelope-header [data-attachment="convert"]')).toContainText('类型转换');
  await panel.locator('.envelope-title').click();
  await panel.getByRole('button', { name: '解除包络', exact: true }).click();
  await expect(panel.locator('.envelope')).toHaveCount(0);
  await expect(panel.locator('[data-node="a"]')).toHaveCount(1);
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panel.locator('.envelope')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('logic-envelope.png') });
});

test('流程外置端口、直线箭头、三条引用线和分支侧栏', async ({ page }, info) => {
  await openChallenge(page);
  await install(page, [
    { id: 'branch', kind: 'branch', x: 400, y: 80 },
    constant('condition', 100, 280, 'true', 'bool'),
  ]);
  const panel = panelOf(page);
  await panel.locator('[data-node="start"] .port-out').click();
  await panel.locator('[data-node="branch"] .node-title').click();
  await expect(panel.locator('.flow-line')).toHaveCount(1);
  await expect(panel.locator('.flow-line')).toHaveAttribute('d', 'M 263 88 L 387 118');
  await expect(panel.locator('.flow-line')).toHaveAttribute('marker-end', 'url(#logic-arrow)');
  await panel.locator('[data-node="condition"]').click();
  await panel.getByLabel('连接到', { exact: true }).selectOption('branch');
  await panel.getByRole('button', { name: '建立连接', exact: true }).click();
  await expect(panel.locator('.reference-line')).toHaveCount(3);
  await expect(panel.locator('[data-node="branch"] .port-then')).toHaveCount(1);
  await expect(panel.locator('[data-node="branch"] .port-else')).toHaveCount(1);
  const node = await panel.locator('[data-node="start"]').boundingBox(),
    port = await panel.locator('[data-node="start"] .port-out').boundingBox();
  if (!node || !port) throw new Error('端口几何');
  expect(port.x - node.x - node.width).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('logic-flow-reference.png') });
});

test('同类多选包络、循环附着与 Esc 取消拖动', async ({ page }) => {
  await openChallenge(page);
  await install(
    page,
    [constant('a', 70, 220), constant('b', 318, 220)],
    [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }],
  );
  const panel = panelOf(page);
  await panel.locator('[data-node="a"]').click();
  await panel.locator('[data-node="b"]').click({ modifiers: ['Shift'] });
  await panel.getByRole('button', { name: '包络', exact: true }).click();
  await expect(panel.locator('.envelope')).toHaveCount(1);
  const before = await graph(page);
  await drag(page, 'b', 500, 350, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await graph(page)).toEqual(before);
});

test('拖动期间导入新图，松手不能把旧图写回来', async ({ page }) => {
  await openChallenge(page);
  await install(page, [constant('old', 80, 220)]);
  await drag(page, 'old', 500, 350, false);
  await install(page, [constant('fresh', 300, 220)]);
  await page.mouse.up();
  expect((await graph(page)).nodes.map((n) => n.id)).toEqual(['start', 'fresh']);
});

test('nested envelope with internal edges previews and commits its outer reference', async ({ page }) => {
  await openChallenge(page);
  await install(page, [
    constant('left', 200, 300), constant('right', 448, 300),
    { id: 'inner', kind: 'envelope', category: 'data', title: 'inner', members: ['left', 'right'], x: 0, y: 0 },
    { id: 'outer', kind: 'envelope', category: 'data', title: 'outer', members: ['inner'], x: 0, y: 0 },
    { id: 'loop', kind: 'loop', count: '1', x: 900, y: 300 },
  ], [{ id: 'sum', kind: 'data', from: 'left', to: 'right', op: '+' }]);
  const panel = panelOf(page);
  await panel.locator('.stage').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  const title = panel.locator('[data-node="outer"] .envelope-title');
  const box = await title.boundingBox();
  if (!box) throw new Error('Missing outer envelope title');
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 222, box.y + box.height / 2, { steps: 8 });
  await expect(panel.locator('.reference-line')).toHaveCount(3);
  expect((await graph(page)).edges).toHaveLength(1);
  await page.mouse.up();
  expect((await graph(page)).edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reference', from: 'outer', to: 'loop', port: 'count' }),
    expect.objectContaining({ id: 'sum', from: 'left', to: 'right' }),
  ]));
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panel.locator('.reference-line')).toHaveCount(0);
  await panel.getByRole('button', { name: '重做', exact: true }).click();
  await expect(panel.locator('.reference-line')).toHaveCount(3);
});
