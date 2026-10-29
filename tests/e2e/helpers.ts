import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { canvas } from '../../packages/shared/src';

export const PANEL_TAG = 'pwn2block-canvas-panel';
export const panelOf = (page: Page): Locator => page.locator(PANEL_TAG);
export const editorOf = (page: Page): Locator => panelOf(page).locator('pwn2block-logic-canvas');
export const stageOf = (page: Page): Locator => panelOf(page).locator('.stage');
export const canvasKey = (id: string): string => `pwn2block.canvas.v2.${id}`;
export async function openChallenge(page: Page, id?: string): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) {
    const item = id ? picker.locator('li').filter({ hasText: id }) : picker.locator('li').first();
    await item.getByRole('button').click();
  }
  await expect(panelOf(page)).toBeVisible();
}
export async function readGraph(page: Page): Promise<canvas.LogicGraph> {
  const raw = await panelOf(page).evaluate((panel) => {
    if (!('document' in panel)) throw new Error('缺少文档');
    return (panel.document as canvas.CanvasDocument).logic;
  });
  return canvas.LogicGraphSchema.parse(raw);
}
export async function installGraph(
  page: Page,
  nodes: canvas.LogicNode[],
  edges: canvas.LogicEdge[] = [],
): Promise<void> {
  await panelOf(page).evaluate(
    (panel, logic) => {
      if (!('setDocument' in panel) || typeof panel.setDocument !== 'function') throw new Error('缺少导入入口');
      panel.setDocument({ format: 'pwn2block.canvas', version: 2, nodes: [], layout: {}, main: [], logic });
    },
    { version: 1 as const, nodes: [{ id: 'start', kind: 'start' as const, x: 70, y: 50 }, ...nodes], edges },
  );
}
export async function waitForSave(page: Page, id: string): Promise<void> {
  const graph = await readGraph(page);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { document?: canvas.CanvasDocument }).document?.logic : undefined;
      }, canvasKey(id)),
    )
    .toEqual(graph);
}
export async function dragNode(page: Page, id: string, x: number, y: number, release = true): Promise<void> {
  await stageOf(page).evaluate((e) => e.scrollIntoView({ block: 'start' }));
  const stage = await stageOf(page).boundingBox();
  const node = await panelOf(page).locator(`.node[data-node="${id}"]`).boundingBox();
  if (!stage || !node) throw new Error('缺少拖动几何');
  const scroll = await stageOf(page).evaluate((e) => ({ x: e.scrollLeft, y: e.scrollTop }));
  await page.mouse.move(node.x + 50, node.y + 20);
  await page.mouse.down();
  await page.mouse.move(stage.x + x + 50 - scroll.x, stage.y + y + 20 - scroll.y, { steps: 8 });
  if (release) await page.mouse.up();
}
export const constant = (
  id: string,
  x: number,
  y: number,
  text = '2',
  type: canvas.LogicType = 'int',
): canvas.LogicNode => ({ id, kind: 'constant', value: { type, text }, x, y });

/** 每个浏览器用例释放自己创建的会话，避免重复回归耗尽服务端容量。 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const sessions: Promise<string | undefined>[] = [];
    page.on('response', (response) => {
      if (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/sessions' &&
        response.ok()
      ) {
        sessions.push(response.json().then((body: { sessionId?: string }) => body.sessionId));
      }
    });
    await use(page);
    for (const id of await Promise.all(sessions)) if (id) await page.request.delete(`/api/sessions/${id}`);
  },
});
