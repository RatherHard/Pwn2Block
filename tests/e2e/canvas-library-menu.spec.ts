import { expect } from '@playwright/test';
import { test, openChallenge, panelOf, editorOf, readGraph } from './helpers';
import type { canvas } from '../../packages/shared/src';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1440, height: 900 } });

test('节点库分级返回、常驻预览、加宽与无方括号', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page);
  await expect(panel.locator('.library-category')).toHaveCount(3);
  await expect(panel.locator('.library-option')).toHaveCount(0);
  expect((await panel.locator('.library').boundingBox())!.width).toBeGreaterThanOrEqual(280);
  await panel.locator('[data-category="data"]').click();
  await expect(panel.getByRole('button', { name: '← 返回分类' })).toBeVisible();
  await expect(panel.locator('.library-option')).toHaveCount(3);
  await page.mouse.move(0, 0);
  for (const preview of await panel.locator('.library-preview').all()) await expect(preview).toBeVisible();
  await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  await expect(panel.locator('.node[data-kind="constant"]')).toHaveCount(1);
  const decorations = await panel.locator('pwn2block-logic-canvas').evaluate((element) =>
    [...element.shadowRoot!.querySelectorAll('button')].flatMap((button) =>
      ['::before', '::after'].map((pseudo) => element.ownerDocument.defaultView!.getComputedStyle(button, pseudo).content)));
  expect(decorations.every((value) => !value.includes('[') && !value.includes(']'))).toBe(true);
  await panel.getByRole('button', { name: '← 返回分类' }).click();
  await panel.locator('[data-category="flow"]').click();
  await expect(panel.locator('.library-option')).toHaveCount(2);
  await panel.getByRole('button', { name: '+ 条件分支', exact: true }).click();
  await expect(panel.locator('.node[data-kind="branch"]')).toHaveCount(1);
  await panel.locator('.stage').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('library-preview.png') });
});

test('题目方法分页无遗漏，返回分类重置页码', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page);
  await editorOf(page).evaluate((element) => {
    const editor = element as typeof element & { methods: readonly canvas.CanvasMethodDecl[] };
    const method = editor.methods[0]!;
    editor.methods = Array.from({ length: 9 }, (_, i) => ({ ...method, id: `method-${i}`, label: `测试方法 ${i}` }));
  });
  await panel.locator('[data-category="methods"]').click();
  const pager = panel.getByRole('navigation', { name: '节点分页' });
  await expect(pager).toContainText('第 1 / 3 页');
  await expect(pager.getByRole('button', { name: '上一页' })).toBeDisabled();
  const labels: string[] = [];
  for (let i = 0; i < 3; i++) {
    labels.push(...await panel.locator('.library-option-label').allTextContents());
    if (i < 2) await pager.getByRole('button', { name: '下一页' }).click();
  }
  expect(labels).toEqual(Array.from({ length: 9 }, (_, i) => `测试方法 ${i}`));
  await expect(pager.getByRole('button', { name: '下一页' })).toBeDisabled();
  await pager.getByRole('button', { name: '上一页' }).click();
  await expect(pager).toContainText('第 2 / 3 页');
  await panel.getByRole('button', { name: '← 返回分类' }).click();
  await panel.locator('[data-category="methods"]').click();
  await expect(pager).toContainText('第 1 / 3 页');
});

test('右键菜单禁用状态、历史恢复、键盘关闭和视口边缘定位', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  const panel = panelOf(page), stage = panel.locator('.stage');
  const menu = panel.getByRole('menu', { name: '画布菜单' });
  await stage.click({ button: 'right', position: { x: 30, y: 130 } });
  await expect(menu.getByRole('menuitem', { name: /^撤销/ })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /^重做/ })).toBeDisabled();
  await menu.press('Escape');
  await expect(menu).toHaveCount(0);
  await panel.locator('[data-category="data"]').click();
  await panel.getByRole('button', { name: '+ 常量', exact: true }).click();
  const added = await readGraph(page);
  await stage.click({ button: 'right', position: { x: 30, y: 130 } });
  await menu.getByRole('menuitem', { name: /^撤销/ }).click();
  await expect(panel.locator('.node[data-kind="constant"]')).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await stage.click({ button: 'right', position: { x: 30, y: 130 } });
  await expect(menu.getByRole('menuitem', { name: /^重做/ })).toBeFocused();
  await menu.getByRole('menuitem', { name: /^重做/ }).press('Enter');
  expect(await readGraph(page)).toEqual(added);
  await panel.getByRole('button', { name: '+ 变量', exact: true }).click();
  await panel.locator('.toolbar').getByRole('button', { name: '撤销', exact: true }).click();
  await stage.click({ button: 'right', position: { x: 30, y: 130 } });
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: /^重做/ })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: /^撤销/ })).toBeFocused();
  await menu.press('Escape');
  await stage.click({ button: 'right', position: { x: 30, y: 130 } });
  await panel.locator('.toolbar').click({ position: { x: 4, y: 4 } });
  await expect(menu).toHaveCount(0);
  // Open at the viewport edge through the same DOM event to test clamping independently of page layout.
  await stage.evaluate((element) => {
    const view = element.ownerDocument.defaultView!;
    element.dispatchEvent(new view.MouseEvent('contextmenu', {
      bubbles: true, composed: true, cancelable: true, clientX: view.innerWidth - 2, clientY: view.innerHeight - 2,
    }));
  });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(1440 - 8);
  expect(box.y + box.height).toBeLessThanOrEqual(900 - 8);
  await page.screenshot({ path: info.outputPath('canvas-context-menu.png') });
  await menu.press('Escape');
  // Native text editing still gets its normal context menu.
  await panel.locator('.node[data-kind="constant"]').click();
  const input = panel.getByLabel('值', { exact: true });
  const native = await input.evaluate((element) => element.dispatchEvent(new element.ownerDocument.defaultView!.MouseEvent('contextmenu', {
    bubbles: true, composed: true, cancelable: true,
  })));
  expect(native).toBe(true);
  await expect(menu).toHaveCount(0);
});
