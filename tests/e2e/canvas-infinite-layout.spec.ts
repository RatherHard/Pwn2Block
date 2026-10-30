import { expect } from '@playwright/test';
import { test, openChallenge, panelOf, editorOf, stageOf, installGraph, readGraph, constant, waitForSave } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });

test('画布可越过原点和旧尺寸限制，负坐标节点保存刷新后可定位', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('far', -200000, -300000)]);
  const panel = panelOf(page), stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const rect = (await stage.boundingBox())!;
  await panel.evaluate((e) => { (e as typeof e & { locate: (id: string) => void }).locate('far'); });
  await page.mouse.move(rect.x + 500, rect.y + 300);
  await page.mouse.down();
  await page.mouse.move(rect.x + 400, rect.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(panel.locator('.surface')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 200000, 300000)');
  await expect(panel.locator('.grid')).toBeVisible();
  await expect(panel.locator('pattern#logic-dots rect')).toHaveCount(1);
  expect(await stage.evaluate((e) => ({ x: e.scrollLeft, y: e.scrollTop })))
    .toEqual({ x: 0, y: 0 });
  await expect(stage).toHaveCSS('overflow', 'clip');
  await panel.locator('[data-category="data"]').click();
  const option = (await panel.getByRole('button', { name: '+ 常量', exact: true }).boundingBox())!;
  await page.mouse.move(option.x + 40, option.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 400, rect.y + 250, { steps: 8 });
  await page.mouse.up();
  const node = (await readGraph(page)).nodes.find((n) => n.kind === 'constant' && n.id !== 'far')!;
  expect(node).toMatchObject({ x: -199690, y: -299788 });
  await waitForSave(page, 'ret2win');
  await page.reload();
  await openChallenge(page, 'ret2win');
  expect((await readGraph(page)).nodes.find((n) => n.id === node.id)).toEqual(node);
  await panel.evaluate((e, id) => {
    (e as typeof e & { locate: (id: string) => void }).locate(id);
  }, node.id);
  const located = (await panel.locator(`[data-node="${node.id}"]`).boundingBox())!;
  const viewport = (await stage.boundingBox())!;
  expect(located.x - viewport.x).toBeCloseTo(100, 0);
  expect(located.y - viewport.y).toBeCloseTo(100, 0);
});

test('手动连接后水平固定间距，拖动预脱离可取消，释放和撤销为一次操作', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 100, 220), constant('b', 650, 400)]);
  const panel = panelOf(page), stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await panel.locator('[data-node="a"]').click();
  await panel.getByLabel('连接到', { exact: true }).selectOption('b');
  await panel.getByRole('button', { name: '建立连接', exact: true }).click();
  const connected = await readGraph(page);
  expect(connected.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 368, y: 220 });
  const a = (await panel.locator('[data-node="a"]').boundingBox())!;
  const b = (await panel.locator('[data-node="b"]').boundingBox())!;
  const relation = (await panel.locator('.relation').boundingBox())!;
  expect(relation.x - a.x - a.width).toBeCloseTo(12, 0);
  expect(b.x - relation.x - relation.width).toBeCloseTo(12, 0);
  const rect = (await stage.boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 700, rect.y + 420, { steps: 8 });
  await expect(panel.locator('.relation')).toHaveCount(0);
  expect(await readGraph(page)).toEqual(connected);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(panel.locator('.relation')).toHaveCount(1);
  expect(await readGraph(page)).toEqual(connected);
  await page.mouse.move(b.x + 40, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 700, rect.y + 420, { steps: 8 });
  await page.mouse.up();
  expect((await readGraph(page)).edges).toEqual([]);
  expect((await readGraph(page)).nodes.find((n) => n.id === 'b')).toMatchObject({ x: 660, y: 400 });
  await editorOf(page).press('Control+z');
  expect(await readGraph(page)).toEqual(connected);
  await editorOf(page).press('Control+Shift+z');
  expect((await readGraph(page)).edges).toEqual([]);
});

test('负坐标流程线可添加和移动转折点，流程节点拖动保留连接', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [{ id: 'b', kind: 'branch', x: -600, y: -300 },
    { id: 'c', kind: 'branch', x: -100, y: -300 }], [
    { id: 'flow', kind: 'flow', from: 'b', to: 'c', outlet: 'then' },
  ]);
  const panel = panelOf(page), stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await panel.evaluate((e) => { (e as typeof e & { locate: (id: string) => void }).locate('b'); });
  const rect = (await stage.boundingBox())!;
  // b is at viewport (100, 100), and its output is (293, 124).
  await page.mouse.dblclick(rect.x + 440, rect.y + 131);
  await expect(panel.locator('.bend-handle')).toHaveCount(1);
  const handle = (await panel.locator('.bend-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + 450, rect.y + 250, { steps: 8 });
  await page.mouse.up();
  expect((await readGraph(page)).edges[0]).toMatchObject({ points: [{ x: -250, y: -150 }] });
  const b = (await panel.locator('[data-node="b"]').boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x - 10, b.y + 220, { steps: 8 });
  await expect(panel.locator('.ghost')).toHaveCount(0);
  await page.mouse.up();
  expect((await readGraph(page)).edges).toHaveLength(1);
  expect((await readGraph(page)).nodes.find((n) => n.id === 'b')).toMatchObject({ x: -650, y: -100 });
});

test('wheel zoom anchors the cursor and preserves dragging and library drop coordinates', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 100, 220)]);
  const panel = panelOf(page), stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const node = panel.locator('[data-node="a"]');
  const before = (await node.boundingBox())!;
  const anchor = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const original = await readGraph(page);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await node.boundingBox())!.width).toBeGreaterThan(before.width);
  const zoomed = (await node.boundingBox())!, scale = zoomed.width / before.width;
  expect(zoomed.x + zoomed.width / 2).toBeCloseTo(anchor.x, 0);
  expect(zoomed.y + zoomed.height / 2).toBeCloseTo(anchor.y, 0);
  expect(await readGraph(page)).toEqual(original);
  await page.mouse.down();
  await page.mouse.move(anchor.x + 120, anchor.y + 60, { steps: 8 });
  await page.mouse.up();
  const moved = (await readGraph(page)).nodes.find((n) => n.id === 'a')!;
  expect(moved.x).toBeCloseTo(100 + 120 / scale, 0);
  expect(moved.y).toBeCloseTo(220 + 60 / scale, 0);

  await panel.locator('[data-category="data"]').click();
  const option = (await panel.getByRole('button', { name: '+ 常量', exact: true }).boundingBox())!;
  const rect = (await stage.boundingBox())!;
  const transform = await panel.locator('.surface').evaluate((e) => {
    const matrix = e.ownerDocument.defaultView!.getComputedStyle(e).transform.slice(7, -1).split(',').map(Number);
    return { x: matrix[4]!, y: matrix[5]!, scale: matrix[0]! };
  });
  await page.mouse.move(option.x + 40, option.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 650, rect.y + 150, { steps: 8 });
  await page.mouse.up();
  const added = (await readGraph(page)).nodes.find((n) => n.kind === 'constant' && n.id !== 'a')!;
  expect(added.x).toBeCloseTo((650 - transform.x) / transform.scale - 90, 0);
  expect(added.y).toBeCloseTo((150 - transform.y) / transform.scale - 38, 0);
});
