import { expect } from '@playwright/test';
import { test, constant, installGraph, openChallenge, panelOf, readGraph, dragNode } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', 'Requires real backend');
test.use({ viewport: { width: 1920, height: 1080 } });

test('branch text occupies a separate column from outlet labels', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [{ id: 'branch', kind: 'branch', x: 300, y: 160 }]);
  const branch = panelOf(page).locator('[data-node="branch"]');
  for (const scale of [1, 1.6, 0.7]) {
    await panelOf(page).locator('.surface').evaluate((node, value) => { node.setAttribute('style', `transform: scale(${value})`); }, scale);
    for (const content of ['.node-title', '.node-summary']) {
      const body = await branch.locator(content).boundingBox();
      const label = await branch.locator('.then-label').boundingBox();
      expect(body).not.toBeNull();
      expect(label).not.toBeNull();
      expect(body!.x + body!.width).toBeLessThanOrEqual(label!.x);
    }
    const input = await branch.locator('.port-in').boundingBox();
    const output = await branch.locator('.port-then').boundingBox();
    const box = await branch.boundingBox();
    expect(input!.x + input!.width).toBeLessThan(box!.x);
    expect(output!.x).toBeGreaterThan(box!.x + box!.width);
  }
});

test('input-to-output gesture permits merges and rejects a second outgoing edge', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [
    { id: 'branch', kind: 'branch', x: 300, y: 80 },
    { id: 'sink', kind: 'method', method: 'gets', x: 580, y: 220 },
  ]);
  const panel = panelOf(page);
  await panel.locator('[data-node="start"] .port-out').click();
  await panel.locator('[data-node="branch"] .node-title').click();
  expect((await readGraph(page)).edges).toHaveLength(0);
  await panel.locator('[data-node="branch"] .port-in').click();
  await panel.locator('[data-node="start"] .port-out').click();
  for (const outlet of ['then', 'else']) {
    await panel.locator('[data-node="sink"] .port-in').click();
    await panel.locator(`[data-node="branch"] .port-${outlet}`).click();
  }
  expect((await readGraph(page)).edges.filter((edge) => edge.to === 'sink')).toHaveLength(2);
  await panel.locator('[data-node="sink"] .port-in').click();
  await panel.locator('[data-node="start"] .port-out').click();
  expect((await readGraph(page)).edges).toHaveLength(3);
});

test('assignment dragging carries nested expressions, displays their result and supports undo', async ({ page }) => {
  await openChallenge(page);
  await installGraph(page, [
    { id: 'v', kind: 'variable', name: 'payload', x: 50, y: 250 },
    constant('a', 330, 250, '41', 'bytes'), constant('b', 598, 250, '00', 'bytes'),
    { id: 'inner', kind: 'envelope', category: 'data', members: ['a', 'b'], title: 'inner', x: 300, y: 200 },
    { id: 'outer', kind: 'envelope', category: 'data', members: ['inner'], title: 'outer', x: 280, y: 160 },
  ], [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' },
    { id: 'assign', kind: 'data', from: 'outer', to: 'v', op: 'assign' }]);
  const panel = panelOf(page);
  for (const id of ['inner', 'outer']) {
    await expect(panel.locator(`[data-node="${id}"] .envelope-summary`)).toContainText('bytes 41 00');
  }
  const before = await readGraph(page);
  await dragNode(page, 'v', 120, 350);
  const after = await readGraph(page);
  expect(after.edges).toEqual(before.edges);
  for (const node of before.nodes.filter((node) => node.id !== 'start')) {
    expect(after.nodes.find((n) => n.id === node.id)).toMatchObject({ x: node.x + 70, y: node.y + 100 });
  }
  const summary = await panel.locator('[data-node="inner"] .envelope-summary').boundingBox();
  const member = await panel.locator('[data-node="a"]').boundingBox();
  expect(summary!.y + summary!.height).toBeLessThanOrEqual(member!.y);
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await readGraph(page)).toEqual(before);
  await panel.getByRole('button', { name: '重做', exact: true }).click();
  expect(await readGraph(page)).toEqual(after);
});
