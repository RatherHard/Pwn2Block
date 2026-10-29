import { test } from './helpers';
import { expect } from '@playwright/test';
import { constant, installGraph, openChallenge, panelOf, readGraph } from './helpers';

// 替代旧 UI 方案的分组/分页约束；只验收功能逻辑基准下的包络操作。
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test('附着循环的流程包络有可点击的外置端口，附件可解除', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(
    page,
    [
      constant('data', 100, 320, '41', 'bytes'),
      { id: 'm', kind: 'method', method: 'gets', x: 400, y: 220 },
      { id: 'body', kind: 'envelope', category: 'flow', title: '循环体', members: ['m'], x: 370, y: 180 },
      { id: 'loop', kind: 'loop', count: '3', x: 700, y: 220 },
    ],
    [{ id: 'arg', kind: 'reference', from: 'data', to: 'm', port: 'data' }],
  );
  const panel = panelOf(page);
  await panel.locator('[data-node="loop"]').click();
  await panel.getByLabel('附着包络').selectOption('body');
  await expect(panel.locator('.envelope-title')).toContainText('次数循环');
  await panel.locator('[data-node="start"] .port-out').click();
  await panel.locator('[data-node="body"] .port-in').click();
  await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/3');
  await panel.locator('[data-node="loop"]').click();
  await panel.getByLabel('附着包络').selectOption('');
  expect((await readGraph(page)).nodes.find((n) => n.id === 'loop')).not.toHaveProperty('body');
});
test('包络内外的引用连接保留为三条直线', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(
    page,
    [
      constant('v', 100, 220, 'true', 'bool'),
      { id: 'group', kind: 'envelope', category: 'data', title: '条件', members: ['v'], x: 80, y: 180 },
      { id: 'branch', kind: 'branch', x: 500, y: 220 },
    ],
    [{ id: 'ref', kind: 'reference', from: 'v', to: 'branch', port: 'condition' }],
  );
  await expect(panelOf(page).locator('.reference-line')).toHaveCount(3);
  expect((await readGraph(page)).nodes.find((n) => n.id === 'group')).toMatchObject({ members: ['v'] });
});

test('赋值包络既能引用为参数，也能通过外置端口接入流程', async ({ page }) => {
  await openChallenge(page, 'ret2win');
  await installGraph(
    page,
    [
      constant('data', 150, 220, '41', 'bytes'),
      { id: 'v', kind: 'variable', name: 'payload', x: 390, y: 220 },
      { id: 'group', kind: 'envelope', category: 'data', title: '赋值', members: ['data', 'v'], x: 120, y: 180 },
      { id: 'm', kind: 'method', method: 'gets', x: 750, y: 220 },
    ],
    [{ id: 'assign', kind: 'data', from: 'data', to: 'v', op: 'assign' }],
  );
  const panel = panelOf(page);
  await panel.locator('[data-node="group"] .envelope-title').click();
  await panel.getByLabel('连接到', { exact: true }).selectOption('m');
  await panel.getByRole('button', { name: '建立连接', exact: true }).click();
  expect((await readGraph(page)).edges).toContainEqual(
    expect.objectContaining({ kind: 'reference', from: 'group', to: 'm', port: 'data' }),
  );
  await panel.locator('[data-node="start"] .port-out').click();
  await panel.locator('[data-node="group"] .port-in').click();
  await panel.locator('[data-node="group"] .port-out').click();
  await panel.locator('[data-node="m"] .port-in').click();
  expect((await readGraph(page)).edges.filter((e) => e.kind === 'flow')).toHaveLength(2);
  await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/1');
});
