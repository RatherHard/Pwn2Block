import { expect } from '@playwright/test';
import { test, openChallenge, panelOf, editorOf, stageOf, installGraph, readGraph, constant } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test.use({ viewport: { width: 1920, height: 1080 }, permissions: ['clipboard-read', 'clipboard-write'] });

test('真实快捷键复制剪切粘贴保留内部连接、唯一开始节点并支持撤销重做', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 350, 200), constant('b', 618, 200)], [
    { id: 'sum', kind: 'data', from: 'a', to: 'b', op: '+' },
  ]);
  const editor = editorOf(page);
  await editor.press('Control+a');
  await editor.press('Control+c');
  await editor.press('Control+v');
  await expect.poll(async () => (await readGraph(page)).nodes.length).toBe(5);
  const copied = await readGraph(page);
  expect(copied.nodes.filter((n) => n.kind === 'start')).toHaveLength(1);
  expect(copied.edges).toHaveLength(2);
  expect(copied.edges[1]).toMatchObject({ from: copied.nodes[3]!.id, to: copied.nodes[4]!.id, op: '+' });
  expect(copied.nodes[4]!.x - copied.nodes[3]!.x).toBe(268);
  await editor.press('Control+z');
  await expect.poll(async () => (await readGraph(page)).nodes.length).toBe(3);
  await editor.press('Control+Shift+z');
  expect(await readGraph(page)).toEqual(copied);
  await panelOf(page).locator('[data-node="a"]').click({ position: { x: 30, y: 20 } });
  await editor.press('Control+x');
  await expect(panelOf(page).locator('[data-node="a"]')).toHaveCount(0);
  expect((await readGraph(page)).edges).toHaveLength(1);
  await editor.press('Control+z');
  expect(await readGraph(page)).toEqual(copied);
  await editor.press('Control+v');
  await expect.poll(async () => (await readGraph(page)).nodes.length).toBe(6);
  expect((await readGraph(page)).edges).toHaveLength(2);
  await editor.press('Control+v');
  const repeated = await readGraph(page);
  expect(repeated.nodes).toHaveLength(7);
  expect(repeated.nodes[6]!.x - repeated.nodes[5]!.x).toBe(24);
});

test('工具栏复制、右键定位粘贴和输入框原生剪贴板互不干扰', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 350, 200, '12345')]);
  const panel = panelOf(page), editor = editorOf(page), stage = stageOf(page);
  await panel.locator('[data-node="a"]').click({ position: { x: 30, y: 20 } });
  await panel.locator('.toolbar').getByRole('button', { name: '复制', exact: true }).click();
  await stage.click({ button: 'right', position: { x: 700, y: 300 } });
  await panel.getByRole('menu').getByRole('menuitem', { name: /^粘贴/ }).click();
  await expect.poll(async () => (await readGraph(page)).nodes.length).toBe(3);
  const pasted = (await readGraph(page)).nodes.at(-1)!;
  expect(Math.abs(pasted.x - 700)).toBeLessThan(1);
  expect(Math.abs(pasted.y - 300)).toBeLessThan(1);
  await panel.locator('.toolbar').getByRole('button', { name: '剪切', exact: true }).click();
  await expect(panel.locator(`[data-node="${pasted.id}"]`)).toHaveCount(0);
  await panel.locator('.toolbar').getByRole('button', { name: '粘贴', exact: true }).click();
  await expect.poll(async () => (await readGraph(page)).nodes.length).toBe(3);
  await panel.locator('[data-node="a"]').click({ position: { x: 30, y: 20 } });
  const input = panel.getByLabel('值', { exact: true });
  await input.selectText();
  await input.press('Control+x');
  await expect(input).toHaveValue('');
  expect((await readGraph(page)).nodes).toHaveLength(3);
  await input.press('Control+v');
  await expect(input).toHaveValue('12345');
  await input.selectText();
  await input.press('Control+c');
  await editor.press('Control+v');
  await expect(panel.getByRole('status')).toContainText('剪贴板中没有可粘贴的节点');
  expect((await readGraph(page)).nodes).toHaveLength(3);
});

test('复制附着包络后仍只显示标题栏附件，内部关系独立', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [constant('a', 350, 220),
    { id: 'env', kind: 'envelope', category: 'data', title: '表达式', members: ['a'], x: 350, y: 220 },
    { id: 'convert', kind: 'convert', input: 'env', target: 'int', value: { type: 'int', text: '0' }, width: '8', endian: 'little', signed: false, x: 350, y: 220 },
  ]);
  const panel = panelOf(page), editor = editorOf(page);
  await panel.locator('[data-node="env"]').click({ position: { x: 20, y: 16 } });
  await editor.press('Control+c');
  await editor.press('Control+v');
  await expect(panel.locator('[data-attachment]')).toHaveCount(2);
  await expect(panel.locator('.node[data-kind="convert"]')).toHaveCount(0);
  const copied = await readGraph(page);
  expect(copied.nodes).toHaveLength(7);
  const added = copied.nodes.slice(4);
  expect(added.find((n) => n.kind === 'convert')).toMatchObject({ input: added.find((n) => n.kind === 'envelope')!.id });
  await editor.press('Delete');
  expect((await readGraph(page)).nodes).toHaveLength(4);
  await expect(panel.locator('[data-attachment="convert"]')).toHaveCount(1);
});

test('流程线覆盖节点时可添加和拖动转折点，线外节点仍可选择', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(page, [
    { id: 'from', kind: 'branch', x: 100, y: 200 },
    { id: 'to', kind: 'branch', x: 800, y: 200 },
    constant('middle', 450, 200),
  ], [{ id: 'flow', kind: 'flow', from: 'from', to: 'to', outlet: 'next' }]);
  const panel = panelOf(page), stage = stageOf(page);
  await stage.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const rect = (await stage.boundingBox())!;
  await expect(panel.locator('.flow-wires')).toHaveCSS('z-index', '1000');
  await page.mouse.dblclick(rect.x + 500, rect.y + 238);
  await expect(panel.locator('.bend-handle')).toHaveCount(1);
  const handle = (await panel.locator('.bend-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + 540, rect.y + 350, { steps: 8 });
  await page.mouse.up();
  expect((await readGraph(page)).edges[0]).toMatchObject({ points: [{ x: 540, y: 350 }] });
  await panel.locator('[data-node="middle"]').click({ position: { x: 20, y: 15 } });
  await expect(panel.getByLabel('值', { exact: true })).toHaveValue('2');
  await expect(panel.locator('.flow-line')).toHaveAttribute('d', / C /);
});
