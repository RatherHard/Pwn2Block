import { expect, type Page } from '@playwright/test';
import { test, constant, editorOf, installGraph, openChallenge, panelOf, readGraph, stageOf, waitForSave } from './helpers';
import type { canvas } from '../../packages/shared/src';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });
const edge = (id: string, from: string, to: string, op: canvas.LogicOperator = '+'): canvas.LogicEdge =>
  ({ id, kind: 'data', from, to, op });

async function focusCanvas(page: Page, id: string) {
  await stageOf(page).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await editorOf(page).evaluate((editor, id) => {
    if ('locate' in editor && typeof editor.locate === 'function') editor.locate(id);
  }, id);
}
async function screenPoint(page: Page, x: number, y: number) {
  return stageOf(page).evaluate((stage, point) => {
    const rect = stage.getBoundingClientRect();
    const surface = stage.querySelector('.surface')!;
    const matrix = stage.ownerDocument.defaultView!.getComputedStyle(surface).transform.slice(7, -1).split(',').map(Number);
    return { x: rect.x + matrix[4]! + point.x * matrix[0]!, y: rect.y + matrix[5]! + point.y * matrix[3]! };
  }, { x, y });
}
async function startDrag(page: Page, id: string) {
  const box = await panelOf(page).locator(`.node[data-node="${id}"]`).boundingBox();
  if (!box) throw new Error('缺少拖动节点');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
async function moveTo(page: Page, x: number, y: number) {
  const point = await screenPoint(page, x, y);
  await page.mouse.move(point.x, point.y, { steps: 6 });
}

test('整段插入预览与提交一致，一次撤销恢复，关系框不可拖动', async ({ page }, info) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 100, 200), constant('b', 368, 200),
    constant('x', 100, 420), constant('y', 368, 420)], [edge('ab', 'a', 'b', '*'), edge('xy', 'x', 'y')]);
  await focusCanvas(page, 'b');
  const panel = panelOf(page), before = await readGraph(page);
  await startDrag(page, 'x');
  await moveTo(page, 324, 238);
  await expect(panel.locator('.relation.ghost')).toHaveCount(2);
  await expect(panel.locator('.snap-feedback')).toContainText('插入');
  expect(await readGraph(page)).toEqual(before);
  const preview = await panel.locator('[data-node="b"]').boundingBox();
  await page.screenshot({ path: info.outputPath('insertion-preview.png') });
  await page.mouse.up();
  await expect(panel.locator('.relation.ghost')).toHaveCount(0);
  const after = await readGraph(page);
  expect(after.edges).toContainEqual(expect.objectContaining({ from: 'a', to: 'x', op: '*' }));
  expect(after.edges).toContainEqual(expect.objectContaining({ from: 'y', to: 'b', op: '+' }));
  expect(await panel.locator('[data-node="b"]').boundingBox()).toEqual(preview);
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await readGraph(page)).toEqual(before);
  await panel.getByRole('button', { name: '重做', exact: true }).click();
  expect(await readGraph(page)).toEqual(after);
  const relation = await panel.locator('[data-edge="ab"]').boundingBox();
  await page.mouse.move(relation!.x + relation!.width / 2, relation!.y + relation!.height / 2);
  await page.mouse.down();
  await page.mouse.move(relation!.x + 50, relation!.y + 130, { steps: 5 });
  await page.mouse.up();
  expect(await readGraph(page)).toEqual(after);
  await expect(panel.locator('.marquee')).toHaveCount(0);
});

test('嵌套包络删除连接后尾段在最外框之外，撤销恢复归属和坐标', async ({ page }, info) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 100, 260), constant('b', 368, 260), constant('c', 636, 260),
    { id: 'inner', kind: 'envelope', category: 'data', members: ['a', 'b', 'c'], title: 'inner', x: 0, y: 0 },
    { id: 'outer', kind: 'envelope', category: 'data', members: ['inner'], title: 'outer', x: 0, y: 0 }],
  [edge('ab', 'a', 'b'), edge('bc', 'b', 'c', '*')]);
  await focusCanvas(page, 'b');
  const panel = panelOf(page), before = await readGraph(page);
  await panel.locator('[data-edge="ab"]').click();
  await page.keyboard.press('Delete');
  const after = await readGraph(page);
  expect(after.nodes.find((node) => node.id === 'inner')).toMatchObject({ members: ['a'] });
  expect(after.edges).toEqual([edge('bc', 'b', 'c', '*')]);
  const outer = await panel.locator('[data-node="outer"]').boundingBox(), b = await panel.locator('[data-node="b"]').boundingBox();
  expect(b!.x).toBeGreaterThan(outer!.x + outer!.width);
  await page.screenshot({ path: info.outputPath('envelope-tail-outside.png') });
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await readGraph(page)).toEqual(before);
});

test('拖中间节点只拔右段，Esc 和画布外释放均恢复原图', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 100, 200), constant('b', 368, 200), constant('c', 636, 200)],
    [edge('ab', 'a', 'b', '*'), edge('bc', 'b', 'c')]);
  await focusCanvas(page, 'b');
  const before = await readGraph(page), panel = panelOf(page);
  await startDrag(page, 'b');
  await moveTo(page, 458, 438);
  await expect(panel.locator('[data-edge="ab"]')).toHaveCount(0);
  await expect(panel.locator('[data-edge="bc"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await readGraph(page)).toEqual(before);
  await startDrag(page, 'b');
  await page.mouse.move(5, 5, { steps: 5 });
  await page.mouse.up();
  expect(await readGraph(page)).toEqual(before);
  await startDrag(page, 'b');
  await moveTo(page, 458, 438);
  await page.mouse.up();
  const after = await readGraph(page);
  expect(after.nodes.find((node) => node.id === 'a')).toEqual(before.nodes.find((node) => node.id === 'a'));
  expect(after.nodes.find((node) => node.id === 'b')).toMatchObject({ x: 368, y: 400 });
  expect(after.nodes.find((node) => node.id === 'c')).toMatchObject({ x: 636, y: 400 });
  expect(after.edges).toEqual([edge('bc', 'b', 'c')]);
});

for (const scale of [0.25, 1, 3]) test(`${scale * 100}% 缩放下插入保持 24px 进入和 36px 退出阈值`, async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 100, 180), constant('b', 368, 180), constant('x', 240, 280)],
    [edge('ab', 'a', 'b', '*')]);
  const anchor = await screenPoint(page, 324, 218);
  await page.mouse.move(anchor.x, anchor.y);
  if (scale !== 1) await page.mouse.wheel(0, scale === 3 ? -2000 : 2000);
  await expect.poll(async () => (await panelOf(page).locator('[data-node="x"]').boundingBox())!.width)
    .toBeCloseTo(180 * scale, 0);
  await startDrag(page, 'x');
  await moveTo(page, 324, 500);
  await moveTo(page, 324, 232 + 20 / scale);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(2);
  await moveTo(page, 324, 232 + 30 / scale);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(2);
  await moveTo(page, 324, 232 + 37 / scale);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(0);
  await moveTo(page, 324, 232 + 30 / scale);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(0);
  await moveTo(page, 324, 232 + 20 / scale);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(2);
  await page.mouse.up();
  expect((await readGraph(page)).edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: 'a', to: 'x', op: '*' }), expect.objectContaining({ from: 'x', to: 'b', op: '+' })]));
});

test('整段接入包络，Alt 单取不补桥，保存刷新恢复最终归属', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 100, 200), constant('x', 100, 400), constant('y', 368, 400),
    { id: 'env', kind: 'envelope', category: 'data', members: ['a'], title: 'env', x: 0, y: 0 }],
  [edge('xy', 'x', 'y')]);
  await startDrag(page, 'x');
  await moveTo(page, 280, 238);
  await expect(panelOf(page).locator('.relation.ghost')).toHaveCount(1);
  await page.mouse.up();
  expect((await readGraph(page)).nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a', 'x', 'y'] });
  await page.keyboard.down('Alt');
  await startDrag(page, 'x');
  await page.keyboard.up('Alt');
  await moveTo(page, 458, 438);
  await page.mouse.up();
  const after = await readGraph(page);
  expect(after.edges).toEqual([]);
  expect(after.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a'] });
  const y = after.nodes.find((node) => node.id === 'y')!;
  expect(y.y).toBe(200);
  await waitForSave(page, 'ret2win');
  await page.reload();
  await openChallenge(page, 'ret2win');
  expect(await readGraph(page)).toEqual(after);
});
