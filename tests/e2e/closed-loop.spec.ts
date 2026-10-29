import { test } from './helpers';
import { expect } from '@playwright/test';
import { constant, installGraph, openChallenge, panelOf, readGraph, waitForSave } from './helpers';

test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要真实后端');
test('画布闭环：全局派生、循环、公开方法、真实判题与恢复', async ({ page }, info) => {
  await openChallenge(page, 'ret2win');
  await installGraph(
    page,
    [
      constant('bytes', 80, 220, '41'.repeat(32), 'bytes'),
      { id: 'x', kind: 'variable', name: 'payload', x: 328, y: 220 },
      { id: 'read', kind: 'variable', name: 'payload', x: 80, y: 360 },
      { id: 'derived', kind: 'variable', name: 'derivedPayload', x: 328, y: 360 },
      { id: 'call', kind: 'method', method: 'gets', x: 500, y: 80 },
      { id: 'body', kind: 'envelope', category: 'flow', members: ['call'], title: '循环体', x: 470, y: 40 },
      { id: 'loop', kind: 'loop', count: '2', body: 'body', x: 750, y: 80 },
    ],
    [
      { id: 'init', kind: 'data', from: 'bytes', to: 'x', op: 'assign' },
      { id: 'derive', kind: 'data', from: 'read', to: 'derived', op: 'assign' },
      { id: 'flow', kind: 'flow', from: 'start', to: 'body', outlet: 'next' },
      { id: 'arg', kind: 'reference', from: 'derived', to: 'call', port: 'data' },
    ],
  );
  await expect(panelOf(page).locator('.feedback .error')).toHaveCount(0);
  await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/2');
  const submitted = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/submit'));
  const menu = page.locator('pwn2block-top-bar details.menu');
  await page
    .locator('pwn2block-top-bar summary')
    .filter({ hasText: /^运行$/ })
    .click();
  await menu.getByRole('button', { name: '提交判题', exact: true }).click();
  const request = await submitted;
  expect(JSON.stringify(request.postDataJSON())).toContain('41414141');
  const verdict = page.locator('pwn2block-verdict-panel');
  await expect(verdict).toContainText('payload 跑完了，但没有达成目标');
  await waitForSave(page, 'ret2win');
  const saved = await readGraph(page);
  await page.reload();
  await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/2');
  expect(await readGraph(page)).toEqual(saved);
  await page.screenshot({ path: info.outputPath('logic-backend.png') });
});
