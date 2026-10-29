import { test, expect, type Page } from '@playwright/test';
import { openChallenge, panelOf, stageOf, toolboxOf, dragBy, dragBetween, readDocument } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 } });

async function install(page: Page, nodes: unknown[], layout: Record<string, { x: number; y: number }>, main = ['start']) {
  await panelOf(page).evaluate((element, next) => {
    if (!('setDocument' in element) || typeof element.setDocument !== 'function') throw new Error('缺少导入入口');
    element.setDocument(next);
  }, { format: 'pwn2block.canvas', version: 2, nodes: [{ id: 'start', kind: 'start' }, ...nodes], layout: { start: { x: 40, y: 40 }, ...layout }, main });
}
const value = (id: string) => ({ id, kind: 'value', value: { kind: 'int', value: '2' } });

async function selectArea(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const stage = await stageOf(page).boundingBox();
  if (stage === null) throw new Error('缺少画布');
  await page.mouse.move(stage.x + from.x, stage.y + from.y);
  await page.mouse.down();
  await page.mouse.move(stage.x + to.x, stage.y + to.y, { steps: 8 });
  await page.mouse.up();
}

test('吸附形成有间距的关系框，点击换运算，链中脱离并撤销', async ({ page }, info) => {
  await openChallenge(page);
  await install(page, [value('a'), value('b'), value('c')], { a: { x: 60, y: 210 }, b: { x: 350, y: 390 }, c: { x: 650, y: 400 } });
  const panel = panelOf(page);
  await dragBetween(page, panel.locator('.node-box[data-node="b"] .title'), panel.locator('.node-box[data-node="a"]'));
  await expect(panel.locator('.relation-box')).toHaveCount(1);
  const relation = panel.locator('.relation-box');
  await expect(relation).toHaveText('+');
  await expect(relation).not.toHaveAttribute('data-node');
  const [a, r, b] = await Promise.all(['.node-box[data-node="a"]', '.relation-box', '.node-box[data-node="b"]'].map((selector) => panel.locator(selector).boundingBox()));
  if (a === null || r === null || b === null) throw new Error('缺少关系几何');
  expect(r.x - a.x - a.width).toBeGreaterThan(8);
  expect(b.x - r.x - r.width).toBeGreaterThan(8);
  const appearance = await panel.locator('.node-box[data-node="a"]').evaluate((node) => {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node); return { border: style.borderColor, text: style.color, background: style.backgroundColor };
  });
  expect(appearance.border).toBe(appearance.text);
  expect(appearance.border).not.toBe(appearance.background);
  await relation.click();
  await expect(relation).toHaveText('−');
  await dragBetween(page, panel.locator('.node-box[data-node="c"] .title'), panel.locator('.node-box[data-node="b"]'));
  await expect(panel.locator('.relation-box')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('data-chain.png') });
  await dragBy(page, panel.locator('.node-box[data-node="b"] .title'), 0, 250);
  await expect(panel.locator('.relation-box')).toHaveCount(1);
  await panel.locator('.btn-undo').click();
  await expect(panel.locator('.relation-box')).toHaveCount(2);
});

test('完整表达式框选后右键包络、附着转换、解除及撤销重做', async ({ page }, info) => {
  await openChallenge(page);
  await install(page, [value('a'), value('b'), { id: 'sum', kind: 'relation', op: 'int.add', left: 'a', right: 'b' }], { a: { x: 60, y: 210 }, b: { x: 352, y: 210 }, sum: { x: 270, y: 210 } });
  const panel = panelOf(page);
  await selectArea(page, { x: 570, y: 340 }, { x: 45, y: 195 });
  // 右击选区内的叶子不得丢掉刚框选的表达式根。
  await panel.locator('.node-box[data-node="a"]').click({ button: 'right' });
  await panel.locator('.menu-wrap').click();
  await expect(panel.locator('.group-box')).toHaveCount(1);
  await expect.poll(async () => (await readDocument(page)).nodes.filter((node) => node.kind === 'group').length).toBe(1);
  await panel.locator('.group-title').click({ button: 'right' });
  await panel.locator('.menu-wrap-convert').click();
  await expect(panel.locator('.envelope-box')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('envelope-conversion.png') });
  await panel.locator('.group-title').click({ button: 'right' });
  await panel.locator('.menu-dissolve').click();
  await expect(panel.locator('.group-box, .envelope-box')).toHaveCount(0);
  expect((await readDocument(page)).nodes.map((node) => node.kind)).toEqual(['start', 'value', 'value', 'relation']);
  await stageOf(page).click({ button: 'right', position: { x: 550, y: 400 } });
  await panel.locator('.menu-undo').click();
  await expect(panel.locator('.envelope-box')).toHaveCount(1);
  await stageOf(page).click({ button: 'right', position: { x: 550, y: 400 } });
  await panel.locator('.menu-redo').click();
  await expect(panel.locator('.group-box, .envelope-box')).toHaveCount(0);
  await stageOf(page).click({ button: 'right', position: { x: 550, y: 400 } });
  await panel.locator('[role="menu"]').press('Escape');
  await expect(panel.locator('[role="menu"]')).toHaveCount(0);
});

test('节点库分类返回、每项常驻预览、分页与关系可读性', async ({ page }, info) => {
  await openChallenge(page);
  const toolbox = toolboxOf(page);
  await expect(toolbox.locator('.library-list')).toBeHidden();
  await toolbox.locator('.library-tab[data-tab="operator"]').click();
  const previews = toolbox.locator('.tool:visible .library-preview');
  await expect(previews).toHaveCount(2);
  const colors = await toolbox.locator('.preview-relation').first().evaluate((element) => {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element); return { color: style.color, background: element.ownerDocument.defaultView!.getComputedStyle(element.closest('button')!).backgroundColor };
  });
  expect(colors.color).not.toBe(colors.background);
  await expect(toolbox.locator('.preview-port')).toHaveCount(0);
  await toolbox.locator('.library-back').click();
  await expect(toolbox.locator('.library-list')).toBeHidden();
  await toolbox.locator('.library-query').fill('');
  await toolbox.locator('.library-tab[data-tab="collection"]').click();
  await expect(toolbox.locator('.tool:visible .library-preview')).toHaveCount(5);
  await toolbox.locator('.btn-page-next').click();
  await expect(toolbox.locator('.tool:visible .library-preview')).toHaveCount(1);
  await expect(toolbox.locator('.btn-page-next')).toBeDisabled();
  await toolbox.locator('.btn-page-prev').click();
  await expect(toolbox.locator('.tool:visible .library-preview')).toHaveCount(5);
  await toolbox.locator('.library-back').click();
  await toolbox.locator('.library-tab[data-tab="flow"]').click();
  await page.screenshot({ path: info.outputPath('library.png') });
});
