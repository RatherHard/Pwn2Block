import { expect, type Locator, type Page } from '@playwright/test';
import { test, constant, installGraph, openChallenge, panelOf, readGraph, stageOf, waitForSave } from './helpers';
import type { canvas } from '../../packages/shared/src';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });

async function grab(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
async function move(page: Page, x: number, y: number) {
  const rect = (await stageOf(page).boundingBox())!;
  await page.mouse.move(rect.x + x, rect.y + y, { steps: 8 });
}
const envelope = (members: string[], category: 'data' | 'flow' = 'data'): canvas.LogicNode =>
  ({ id: 'env', kind: 'envelope', title: '保留包络', category, members, x: 0, y: 0 });

test('拔出全部成员保留空包络，可拖回整段并保存恢复', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 200, 300), constant('b', 468, 300), envelope(['a', 'b'])],
    [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }]);
  const panel = panelOf(page), original = await readGraph(page);
  const originalBox = (await panel.locator('[data-node="env"]').boundingBox())!;
  await grab(page, panel.locator('[data-node="a"]'));
  await move(page, 700, 500);
  await expect(panel.locator('.empty-envelope-hint')).toBeVisible();
  expect(await readGraph(page)).toEqual(original);
  await page.mouse.up();
  const empty = await readGraph(page);
  expect(empty.nodes.find((node) => node.id === 'env')).toMatchObject({ members: [], title: '保留包络' });
  const box = (await panel.locator('[data-node="env"]').boundingBox())!;
  expect(box.x).toBe(originalBox.x);
  expect(box.y).toBe(originalBox.y);
  await grab(page, panel.locator('[data-node="a"]'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40, { steps: 8 });
  await expect(panel.locator('.snap-feedback')).toContainText('放入包络');
  expect(await readGraph(page)).toEqual(empty);
  await page.mouse.up();
  const filled = await readGraph(page);
  expect(filled.nodes.find((node) => node.id === 'env')).toMatchObject({ members: ['a', 'b'] });
  expect(filled.edges).toEqual(original.edges);
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await readGraph(page)).toEqual(empty);
  await waitForSave(page, 'ret2win');
  await page.reload();
  await openChallenge(page, 'ret2win');
  expect(await readGraph(page)).toEqual(empty);
  await expect(panel.locator('.empty-envelope-hint')).toBeVisible();
  await page.screenshot({ path: info.outputPath('empty-envelope.png') });
});

for (const kind of ['convert', 'loop'] as const) test(`拖出 ${kind} 附件可解除，撤销和取消恢复原归属`, async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  const modifier: canvas.LogicNode = kind === 'convert'
    ? { id: 'attachment', kind, input: 'env', target: 'bytes', value: { type: 'int', text: '0' }, width: '8', endian: 'little', signed: false, x: 900, y: 600 }
    : { id: 'attachment', kind, body: 'env', count: '2', x: 900, y: 600 };
  await installGraph(page, [kind === 'convert' ? constant('a', 200, 300) : { id: 'a', kind: 'method', method: 'gets', x: 200, y: 300 },
    envelope(['a'], kind === 'convert' ? 'data' : 'flow'), modifier,
    ...(kind === 'loop' ? [constant('count', 900, 200)] : [])],
  kind === 'loop' ? [{ id: 'count-ref', kind: 'reference', from: 'count', to: 'attachment', port: 'count' }] : []);
  const panel = panelOf(page), original = await readGraph(page), badge = panel.locator('[data-attachment="attachment"]');
  await badge.click();
  expect(await readGraph(page)).toEqual(original);
  await grab(page, badge);
  await move(page, 800, 500);
  await expect(panel.locator('[data-node="attachment"]')).toBeVisible();
  expect(await readGraph(page)).toEqual(original);
  await page.mouse.up();
  expect((await readGraph(page)).nodes.find((node) => node.id === 'attachment')).not.toHaveProperty(kind === 'convert' ? 'input' : 'body');
  if (kind === 'convert') {
    await expect(panel.getByLabel('连接到', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('独立类型转换不可连接', { exact: false })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath(`${kind}-detached.png`) });
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await readGraph(page)).toEqual(original);
  const originalBadge = (await badge.boundingBox())!;
  await grab(page, badge);
  await move(page, 800, 500);
  await page.mouse.move(originalBadge.x + originalBadge.width / 2, originalBadge.y + originalBadge.height / 2, { steps: 8 });
  await expect(panel.locator('[data-attachment="attachment"].ghost')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await readGraph(page)).toEqual(original);
  await expect(badge).toBeVisible();
});

test('数据预览与标题边框分开，嵌套时不遮挡父框与成员', async ({ page }, info) => {
  await openChallenge(page);
  await installGraph(page, [constant('a', 200, 300), envelope(['a']),
    { id: 'outer', kind: 'envelope', category: 'data', title: '外框', members: ['env'], x: 0, y: 0 }]);
  for (const id of ['env', 'outer']) {
    const box = (await panelOf(page).locator(`[data-node="${id}"]`).boundingBox())!;
    const title = (await panelOf(page).locator(`[data-node="${id}"] .envelope-title`).boundingBox())!;
    const summary = (await panelOf(page).locator(`[data-node="${id}"] .envelope-summary`).boundingBox())!;
    expect(summary.y - title.y - title.height).toBeGreaterThanOrEqual(5);
    expect(summary.x).toBeGreaterThan(box.x + 8);
    expect(summary.x + summary.width).toBeLessThan(box.x + box.width - 8);
    const member = (await panelOf(page).locator(`[data-node="${id === 'env' ? 'a' : 'env'}"]`).boundingBox())!;
    expect(summary.y + summary.height).toBeLessThan(member.y);
  }
  await page.screenshot({ path: info.outputPath('envelope-summary-spacing.png') });
});

test('附着循环可从双方属性栏和拖拽建立次数引用，支持撤销与保存', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('count', 800, 200),
    { id: 'member', kind: 'method', method: 'gets', x: 300, y: 400 }, envelope(['member'], 'flow'),
    { id: 'loop', kind: 'loop', body: 'env', count: '2', x: 900, y: 600 }]);
  const panel = panelOf(page), original = await readGraph(page);
  const badge = panel.locator('[data-attachment="loop"]');
  for (const selected of ['count', 'loop']) {
    await (selected === 'count' ? panel.locator('[data-node="count"]') : badge).click();
    await panel.getByLabel('连接到', { exact: true }).selectOption(selected === 'count' ? 'loop' : 'count');
    await panel.getByRole('button', { name: '建立连接', exact: true }).click();
    expect((await readGraph(page)).edges).toEqual([
      expect.objectContaining({ kind: 'reference', from: 'count', to: 'loop', port: 'count' }),
    ]);
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    expect(await readGraph(page)).toEqual(original);
  }
  const target = (await badge.boundingBox())!;
  await grab(page, panel.locator('[data-node="count"]'));
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await expect(panel.locator('.reference-wires .ghost')).toBeVisible();
  expect(await readGraph(page)).toEqual(original);
  await page.mouse.up();
  const connected = await readGraph(page);
  expect(connected.edges).toEqual([
    expect.objectContaining({ kind: 'reference', from: 'count', to: 'loop', port: 'count' }),
  ]);
  expect(connected.nodes.find((node) => node.id === 'loop')).toHaveProperty('body', 'env');
  await waitForSave(page, 'ret2win');
  await page.reload();
  await openChallenge(page, 'ret2win');
  expect(await readGraph(page)).toEqual(connected);
});
