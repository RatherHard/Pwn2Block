import { expect, type Page } from '@playwright/test';
import { test, openChallenge, panelOf, editorOf } from './helpers';
import type { canvas } from '../../packages/shared/src';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });
async function install(page: Page, nodes: canvas.LogicNode[], edges: canvas.LogicEdge[] = []) {
  await panelOf(page).evaluate((element, logic) => {
    const panel = element as typeof element & { setDocument: (doc: canvas.CanvasDocument) => void };
    panel.setDocument({ format: 'pwn2block.canvas', version: 2, nodes: [], layout: {}, main: [], logic });
  }, { version: 1 as const, nodes: [{ id: 'start', kind: 'start' as const, x: 70, y: 50 }, ...nodes], edges });
  await panelOf(page).locator('.stage').evaluate((element) => element.scrollIntoView({ block: 'center' }));
}
async function graph(page: Page): Promise<canvas.LogicGraph> {
  return panelOf(page).evaluate((element) => (element as typeof element & { document: canvas.CanvasDocument }).document.logic!);
}
async function libraryDrag(page: Page, name: string, x: number, y: number) {
  const option = await panelOf(page).getByRole('button', { name, exact: true }).boundingBox();
  const stage = await panelOf(page).locator('.stage').boundingBox();
  if (!option || !stage) throw new Error('missing geometry');
  await page.mouse.move(option.x + option.width / 2, option.y + option.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + x, stage.y + y, { steps: 12 });
}

test('从库拖拽预览左向赋值，单次撤销恢复，取消或放到库外不新增节点', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await install(page, [{ id: 'v', kind: 'variable', name: 'x', x: 120, y: 220 }]);
  const panel = panelOf(page);
  await panel.locator('[data-category="data"]').click();
  await libraryDrag(page, '+ 常量', 450, 258);
  await expect(panel.locator('.relation.ghost')).toHaveText('← 赋值');
  expect((await graph(page)).nodes).toHaveLength(2);
  await page.mouse.up();
  await expect(panel.locator('.relation.assignment:not(.ghost)')).toHaveText('← 赋值');
  const added = await graph(page);
  expect(added.nodes).toHaveLength(3);
  expect(added.edges[0]).toMatchObject({ op: 'assign', to: 'v' });
  expect(added.nodes.find((n) => n.kind === 'constant')!.x).toBeGreaterThan(300);
  await editorOf(page).press('Control+z');
  await expect(panel.locator('.node[data-kind="constant"]')).toHaveCount(0);
  await libraryDrag(page, '+ 常量', 450, 258);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await graph(page)).nodes).toHaveLength(2);
  await libraryDrag(page, '+ 常量', 450, 258);
  await page.mouse.move(5, 5);
  await page.mouse.up();
  expect((await graph(page)).nodes).toHaveLength(2);
  await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  await expect(panel.locator('.node[data-kind="constant"]')).toHaveCount(1);
});

test('循环从库拖到包络后融入标题，仍可编辑和解除附着', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  await install(page, [
    { id: 'b', kind: 'branch', x: 420, y: 250 },
    { id: 'env', kind: 'envelope', category: 'flow', title: '流程包络', members: ['b'], x: 420, y: 250 },
  ]);
  const panel = panelOf(page);
  await panel.locator('[data-category="flow"]').click();
  await libraryDrag(page, '+ 次数循环', 710, 288);
  await expect(panel.locator('.envelope-header .attachment.ghost')).toBeVisible();
  await expect(panel.locator('.node[data-kind="loop"]')).toHaveCount(0);
  await page.mouse.up();
  const attachment = panel.locator('.envelope-header [data-attachment]');
  await expect(attachment).toContainText('1 次');
  await attachment.click();
  await panel.getByLabel('次数', { exact: true }).fill('3');
  await panel.getByLabel('次数', { exact: true }).press('Tab');
  await expect(attachment).toContainText('3 次');
  await page.screenshot({ path: info.outputPath('envelope-attachment.png') });
  await panel.getByLabel('附着包络').selectOption('');
  await expect(panel.locator('.node[data-kind="loop"]')).toHaveCount(1);
  await expect(attachment).toHaveCount(0);
});

test('直线双击添加转折点，拖动成曲线，撤销、保存恢复及删除最后一点', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  await install(page, [{ id: 'b', kind: 'branch', x: 600, y: 50 }], [
    { id: 'flow', kind: 'flow', from: 'start', to: 'b', outlet: 'next' },
  ]);
  const panel = panelOf(page), path = panel.locator('[data-edge="flow"] .flow-line');
  await expect(path).toHaveAttribute('d', 'M 263 88 L 587 88');
  await panel.locator('.stage').evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  const stage = (await panel.locator('.stage').boundingBox())!;
  await page.mouse.dblclick(stage.x + 425, stage.y + 88);
  await expect(panel.locator('.bend-handle')).toHaveCount(1);
  const initial = (await graph(page)).edges[0];
  expect(initial).toMatchObject({ points: [{ x: expect.any(Number), y: expect.any(Number) }] });
  await panel.locator('.bend-handle').click();
  expect((await graph(page)).edges[0]).toEqual(initial);
  const handle = (await panel.locator('.bend-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + 440, stage.y + 210, { steps: 8 });
  await page.mouse.up();
  expect((await graph(page)).edges[0]).toMatchObject({ points: [{ x: 440, y: 210 }] });
  await expect(path).toHaveAttribute('d', /C.*440 210 C/);
  await page.screenshot({ path: info.outputPath('curved-flow.png') });
  await editorOf(page).press('Control+z');
  expect((await graph(page)).edges[0]).toEqual(initial);
  await editorOf(page).press('Control+Shift+z');
  expect((await graph(page)).edges[0]).toMatchObject({ points: [{ x: 440, y: 210 }] });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pwn2block.canvas.v2.ret2win'))).toContain('"y":210');
  await page.reload();
  await openChallenge(page, 'ret2win');
  await expect(panel.locator('[data-edge="flow"] .flow-line')).toHaveAttribute('d', /C.*440 210 C/);
  await panel.locator('.stage').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await panel.locator('.stage').evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  const restoredStage = (await panel.locator('.stage').boundingBox())!;
  await page.mouse.click(restoredStage.x + 440, restoredStage.y + 210);
  await expect(panel.locator('.bend-handle')).toHaveCount(1);
  await panel.locator('.bend-handle').click();
  await page.keyboard.press('Delete');
  await expect(path).toHaveAttribute('d', 'M 263 88 L 587 88');
  expect((await graph(page)).edges).toHaveLength(1);
});

test('从库拖入流程节点时预览直线箭头，滚动画布后仍落在鼠标位置', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await install(page, []);
  const panel = panelOf(page);
  await panel.locator('[data-category="flow"]').click();
  const viewport = (await panel.locator('.stage').boundingBox())!;
  await page.mouse.move(viewport.x + 500, viewport.y + 300);
  await page.mouse.wheel(60, 0);
  await expect(panel.locator('.surface')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -60, 0)');
  await libraryDrag(page, '+ 条件分支', 340, 88);
  await expect(panel.locator('.ghost .flow-line')).toHaveAttribute('d', 'M 263 88 L 297 88');
  expect((await graph(page)).nodes).toHaveLength(1);
  await page.mouse.up();
  await expect(panel.locator('.flow-line')).toHaveCount(1);
  expect((await graph(page)).nodes.find((n) => n.kind === 'branch')).toMatchObject({ x: 310, y: 50 });
});


test('空白拖动画布双向平移，取消恢复视图，Shift 框选，平移后库拖入坐标准确', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await install(page, []);
  const panel = panelOf(page), stage = panel.locator('.stage');
  await stage.evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  const rect = (await stage.boundingBox())!;
  const before = await graph(page);
  const undoDisabled = await panel.getByRole('button', { name: '撤销', exact: true }).isDisabled();
  const start = panel.locator('[data-node="start"]');
  const original = (await start.boundingBox())!;
  await page.mouse.move(rect.x + 500, rect.y + 350);
  await page.mouse.down();
  await page.mouse.move(rect.x + 620, rect.y + 410, { steps: 6 });
  await expect(stage).toHaveClass('stage panning');
  await page.mouse.up();
  await expect(stage).toHaveClass('stage');
  let box = (await start.boundingBox())!;
  expect(box.x - original.x).toBeCloseTo(120, 0);
  expect(box.y - original.y).toBeCloseTo(60, 0);
  await page.mouse.move(rect.x + 620, rect.y + 410);
  await page.mouse.down();
  await page.mouse.move(rect.x + 580, rect.y + 390, { steps: 4 });
  await page.mouse.up();
  box = (await start.boundingBox())!;
  expect(box.x - original.x).toBeCloseTo(80, 0);
  expect(box.y - original.y).toBeCloseTo(40, 0);
  expect(await graph(page)).toEqual(before);
  expect(await panel.getByRole('button', { name: '撤销', exact: true }).isDisabled()).toBe(undoDisabled);
  await page.mouse.down();
  await page.mouse.move(rect.x + 640, rect.y + 420, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await start.boundingBox())!.x).toBeCloseTo(box.x, 0);
  await expect(stage).toHaveClass('stage');
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x - 10, box.y - 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 10, box.y + box.height + 10, { steps: 6 });
  await expect(panel.locator('.marquee')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(start).toHaveClass(/selected/);
  expect(await graph(page)).toEqual(before);
  await panel.locator('[data-category="data"]').click();
  await libraryDrag(page, '+ 常量', 600, 280);
  await page.mouse.up();
  const added = (await graph(page)).nodes.find((n) => n.kind === 'constant')!;
  expect(added).toMatchObject({ x: 430, y: 202 });
  const dropped = (await panel.locator(`[data-node="${added.id}"]`).boundingBox())!;
  expect(dropped.x - rect.x).toBeCloseTo(510, 0);
  expect(dropped.y - rect.y).toBeCloseTo(242, 0);
});

test('数据节点拖动预脱离旧连接，松手按新吸附结果排列', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  const constant = (id: string, x: number, y: number): canvas.LogicNode => ({
    id, kind: 'constant', value: { type: 'int', text: '2' }, x, y,
  });
  await install(page, [constant('a', 70, 220), constant('b', 320, 220), constant('c', 700, 350)], [
    { id: 'existing', kind: 'data', from: 'a', to: 'b', op: '+' },
  ]);
  const panel = panelOf(page);
  await panel.locator('.stage').evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  const stage = (await panel.locator('.stage').boundingBox())!;
  const node = (await panel.locator('[data-node="b"]').boundingBox())!;
  await page.mouse.move(node.x + 40, node.y + 20);
  await page.mouse.down();
  await page.mouse.move(stage.x + 540, stage.y + 370, { steps: 8 });
  await expect(panel.locator('.relation:not(.ghost)')).toHaveCount(0);
  await expect(panel.locator('.relation.ghost')).toHaveCount(1);
  expect((await graph(page)).edges[0].id).toBe('existing');
  await page.mouse.up();
  expect((await graph(page)).edges).toHaveLength(1);
  expect((await graph(page)).edges[0]).toMatchObject({ kind: 'data', from: 'b', to: 'c', op: '+' });
  expect((await graph(page)).nodes.find((n) => n.id === 'b')).toMatchObject({ x: 432, y: 350 });
});

test('隐藏附件不出现在连接目标中，拖近标题只连接到包络', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await install(page, [
    { id: 'member', kind: 'constant', value: { type: 'int', text: '2' }, x: 400, y: 300 },
    { id: 'z-env', kind: 'envelope', category: 'data', members: ['member'], title: '数据包络', x: 400, y: 300 },
    { id: 'a-convert', kind: 'convert', input: 'z-env', value: { type: 'int', text: '0' }, target: 'int',
      width: '8', endian: 'little', signed: false, x: 900, y: 900 },
  ]);
  const panel = panelOf(page);
  await panel.locator('.stage').evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  await panel.locator('[data-attachment="a-convert"]').click();
  await expect(panel.getByLabel('连接到').locator('option[value="a-convert"], option[value="z-env"]')).toHaveCount(0);
  await panel.locator('[data-category="data"]').click();
  await libraryDrag(page, '+ 常量', 580, 208);
  await expect(panel.locator('.relation.ghost')).toHaveCount(1);
  await page.mouse.up();
  const updated = await graph(page);
  expect(updated.edges).toHaveLength(1);
  expect([updated.edges[0].from, updated.edges[0].to]).toContain('z-env');
  expect([updated.edges[0].from, updated.edges[0].to]).not.toContain('a-convert');
  await expect(panel.getByLabel('连接到').locator('option[value="a-convert"]')).toHaveCount(0);
});


test('画布平移后双击连线和拖动转折点仍使用画布坐标', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await install(page, [{ id: 'b', kind: 'branch', x: 600, y: 50 }], [
    { id: 'flow', kind: 'flow', from: 'start', to: 'b', outlet: 'next' },
  ]);
  const panel = panelOf(page);
  await panel.locator('.stage').evaluate((e) => { e.scrollLeft = 0; e.scrollTop = 0; });
  const stage = (await panel.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 500, stage.y + 300);
  await page.mouse.down();
  await page.mouse.move(stage.x + 580, stage.y + 340, { steps: 5 });
  await page.mouse.up();
  await page.mouse.dblclick(stage.x + 505, stage.y + 128);
  await expect(panel.locator('.bend-handle')).toHaveCount(1);
  const edge = (await graph(page)).edges[0];
  if (edge.kind !== 'flow') throw new Error('expected flow edge');
  // Native dblclick MouseEvents round client coordinates to whole pixels.
  expect(Math.abs(edge.points![0].x - 425)).toBeLessThan(1);
  expect(Math.abs(edge.points![0].y - 88)).toBeLessThan(1);
  const handle = (await panel.locator('.bend-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + 520, stage.y + 250, { steps: 6 });
  await page.mouse.up();
  expect((await graph(page)).edges[0]).toMatchObject({ points: [{ x: 440, y: 210 }] });
  await expect(panel.locator('[data-edge="flow"] .flow-line')).toHaveAttribute('d', /C.*440 210 C/);
});
