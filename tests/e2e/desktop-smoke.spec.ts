import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Projection } from '@pwn2block/shared';
import {
  canvasBlocks, connCenter, connectFromToolbox, dragFromToolboxTo,
  editBlockField, findCanvasBlock, openToolboxCategory, pickBottomConn, pickTopConn,
} from './gestures';

/** D7 桌面冒烟：真实静态构建、后端与鼠标；仅执行普通单步，不依赖参考解法。 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

/** 不把 DOM 可见误当作屏幕可用；允许面板内滚动，但不允许控件被裁切。 */
async function reachable(locator: Locator, borderTolerance = 0): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error('控件没有实际尺寸');
  // 带边框画布在 720 高度下有不足 1 CSS px 的舍入裁切；按钮仍要求完整可见。
  await expect(locator).toBeInViewport({ ratio: 1 - borderTolerance / Math.min(box.width, box.height) });
}

async function layout(page: Page): Promise<void> {
  const left = page.getByRole('region', { name: '视图管理器', exact: true });
  const right = page.getByRole('region', { name: 'payload 窗口', exact: true });
  await expect(left).toBeInViewport({ ratio: 1 });
  await expect(right).toBeInViewport({ ratio: 1 });
  const a = await left.boundingBox();
  const b = await right.boundingBox();
  if (a === null || b === null) throw new Error('左右面板必须有实际尺寸');
  expect(a.height).toBeGreaterThan(100);
  expect(Math.abs(a.width - b.width), '左右保持等宽').toBeLessThanOrEqual(2);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
}

test('桌面冒烟：布局、键盘、积木、调试、回放与刷新', async ({ page, browser }, info) => {
  const errors: string[] = [];
  const sessions = new Set<string>();
  let creates = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') creates++;
  });
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  await info.attach('browser-environment', {
    body: JSON.stringify({ project: info.project.name, viewport: page.viewportSize(),
      browser: browser.browserType().name(), version: browser.version(),
      channel: 'Playwright bundled Chromium (headless shell)', processes,
      baseURL: info.project.use.baseURL }, null, 2),
    contentType: 'application/json',
  });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const toolbar = page.locator('pwn2block-payload-panel pwn2block-run-menu');
  const action = async (name: string): Promise<Projection> => {
    const [response] = await Promise.all([
      page.waitForResponse(res => res.url().endsWith('/actions') && res.request().method() === 'POST'),
      toolbar.getByRole('button', { name, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    const body = await response.json() as { projection: Projection; results: { ok: boolean }[] };
    expect(body.results.every(result => result.ok)).toBe(true);
    return body.projection;
  };
  let sessionId = '';
  let initial: Projection;
  try {
    await test.step('生产静态入口、六题列表与真实会话', async () => {
      const [list, document] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith('/api/challenges')),
        page.goto('/'),
      ]);
      expect(document?.status()).toBe(200);
      const html = await document!.text();
      expect(html).toMatch(/\/assets\/[^" ]+\.js/);
      expect(html).not.toContain('/@vite/client');
      expect(list.status()).toBe(200);
      const challenges = await list.json() as { id: string }[];
      expect(challenges.map(item => item.id).sort()).toEqual(
        ['callret', 'endian', 'localvar', 'pushpop', 'ret2win', 'stackframe'],
      );
      await reachable(button('回到胜利'));
      await capture(page, info, '01-challenge-list');
      const [created] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith('/api/sessions') && res.request().method() === 'POST'),
        button('回到胜利').click(),
      ]);
      expect(created.status()).toBe(200);
      const body = await created.json() as { sessionId: string; projection: Projection };
      sessionId = body.sessionId;
      sessions.add(sessionId);
      initial = body.projection;
      expect(initial.status).toBe('ready');
      await expect(button('编译')).toBeEnabled();
      await capture(page, info, '02-briefing-expanded');
    });

    await test.step('键盘折叠题面、等宽布局与工具栏可达', async () => {
      const summary = page.locator('pwn2block-briefing-panel summary');
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('pwn2block-briefing-panel details')).not.toHaveAttribute('open');
      await layout(page);
      for (const name of ['编译', '试运行', '单步', '运行 N 步', '后退一步', '撤销', '重置', '提交判题']) {
        await reachable(toolbar.getByRole('button', { name, exact: true }));
      }
      const menu = page.locator('pwn2block-top-bar summary').filter({ hasText: /^视图$/ });
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox').first()).toBeVisible();
      await page.keyboard.press('Enter');
      await capture(page, info, '03-desktop-layout');
    });

    await test.step('真实鼠标拖出开始与单步积木，并编译', async () => {
      const canvas = page.locator('pwn2block-payload-panel #blockly-host');
      await reachable(canvas, 1);
      const host = await canvas.boundingBox();
      if (host === null) throw new Error('画布没有实际尺寸');
      await openToolboxCategory(page, '开始', 'start');
      await dragFromToolboxTo(page, 'start', { x: host.x + 300, y: host.y + 40 });
      const start = await findCanvasBlock(page, 'start', null);
      if (start === undefined) throw new Error('开始积木未落入画布');
      await openToolboxCategory(page, '动作', 'action_step');
      const step = await connectFromToolbox(page, 'action_step', pickTopConn, start.id, async () => {
        const fresh = (await canvasBlocks(page)).find(block => block.id === start.id);
        const conn = fresh && pickBottomConn(fresh.conns);
        return conn === undefined ? null : connCenter(conn);
      });
      if (step === undefined) throw new Error('单步积木未连接');
      await editBlockField(page, step.id, 0, '1');
      await button('编译').click();
      const program = page.locator('pwn2block-program-view');
      await expect(program.locator('li')).toHaveCount(1);
      await reachable(program);
      await capture(page, info, '04-compiled-program');
    });

    await test.step('单步、回退、判题回放与调试隔离', async () => {
      expect((await action('单步')).steps).toBe(1);
      expect((await action('后退一步')).steps).toBe(0);
      const [submitted] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith('/submit') && res.request().method() === 'POST'),
        button('提交判题').click(),
      ]);
      expect(submitted.status()).toBe(200);
      expect(submitted.request().postDataJSON()).toMatchObject({ actions: [{ type: 'step', count: 1 }] });
      const verdict = await submitted.json() as { verdict: string };
      expect(verdict.verdict).toBe('incomplete');
      await expect(button('判题结果')).toHaveAttribute('aria-pressed', 'true');
      const timeline = page.getByRole('slider', { name: '回放时间线' });
      await reachable(timeline);
      await timeline.focus();
      await page.keyboard.press('Home');
      await expect(timeline).toHaveValue('0');
      await page.keyboard.press('End');
      await expect(timeline).not.toHaveValue('0');
      await capture(page, info, '05-verdict-replay');
      await button('回到调试').click();
      await expect(button('调试模式')).toHaveAttribute('aria-pressed', 'true');
      const response = await page.request.get(`/api/sessions/${sessionId}`);
      expect(response.status()).toBe(200);
      const current = await response.json() as { projection: Projection };
      expect(current.projection.steps).toBe(initial.steps);
      expect(current.projection.registers).toEqual(initial.registers);
      await reachable(page.locator('pwn2block-output-view'));
      await capture(page, info, '06-debug-output');
    });

    await test.step('刷新接回原会话并恢复积木', async () => {
      await page.reload();
      const [restored] = await Promise.all([
        page.waitForResponse(res => new URL(res.url()).pathname === `/api/sessions/${sessionId}`),
        button('回到胜利').click(),
      ]);
      expect(restored.status()).toBe(200);
      await expect.poll(() => findCanvasBlock(page, 'action_step', undefined)).toBeDefined();
      expect(creates).toBe(1);
      await capture(page, info, '07-restored');
      expect(errors).toEqual([]);
    });
  } finally {
    for (const id of sessions) {
      const removed = await page.request.delete(`/api/sessions/${id}`);
      expect.soft(removed.status(), '必须释放测试会话配额').toBe(200);
      expect.soft(await removed.json()).toEqual({ ok: true });
    }
  }
});
