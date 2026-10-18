import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Projection } from '@pwn2block/shared';
import {
  blockFieldTexts, canvasBlocks, connCenter, connectFromToolbox, dragFromToolboxTo,
  editBlockField, findCanvasBlock, openToolboxCategory, pickBottomConn, pickTopConn,
} from './gestures';

/** D7 桌面冒烟：真实静态构建、后端与鼠标；仅执行普通单步，不依赖参考解法。 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

/** 检查屏幕内可达；启用按钮另做试点击，确认能接收事件且不改变页面状态。 */
async function reachable(locator: Locator, borderTolerance = 0): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error('控件没有实际尺寸');
  // 带边框画布滚入视口后底边有 1–2 CSS px 的舍入裁切（scrollY 取整、画布顶边是小数）；按钮仍要求完整可见。
  await expect(locator).toBeInViewport({ ratio: 1 - borderTolerance / Math.min(box.width, box.height) });
  const isButton = await locator.evaluate<boolean, void>('element => element.matches("button, [role=button]")');
  if (isButton && await locator.isEnabled()) await locator.click({ trial: true });
}

/** 只比较积木身份与连接，不把刷新后可能变化的位置/尺寸当成存档内容。 */
async function canvasStructure(page: Page) {
  return (await canvasBlocks(page))
    .map(({ id, cls, parentId, childClasses }) => ({ id, cls, parentId, childClasses }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 改积木自动编译：状态栏给出唯一一个动作，「运行」可用（动作内容在提交请求里逐字核对）。 */
async function expectCompiledStep(page: Page, pointer = '动作 0/1'): Promise<void> {
  await expect(page.locator('pwn2block-app .status')).toContainText(pointer);
  await expect(page.locator('pwn2block-payload-panel').getByRole('button', { name: '运行', exact: true })).toBeEnabled();
  await expect(page.locator('pwn2block-output-view')).not.toContainText('编译错误');
}

/** 顶栏「运行」菜单默认收起：展开后菜单里的按钮才可点击。 */
async function openRunMenu(page: Page): Promise<void> {
  const menu = page.locator('pwn2block-top-bar details.menu');
  if (await menu.getAttribute('open') === null) {
    await page.locator('pwn2block-top-bar summary').filter({ hasText: /^运行$/ }).click();
  }
  await expect(menu).toHaveAttribute('open', '');
}

async function closeRunMenu(page: Page): Promise<void> {
  const menu = page.locator('pwn2block-top-bar details.menu');
  if (await menu.getAttribute('open') === null) return;
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
}

async function layout(page: Page): Promise<void> {
  const left = page.getByRole('region', { name: '视图管理器', exact: true });
  const right = page.getByRole('region', { name: 'payload 窗口', exact: true });
  // 页面改为整页纵向滚动：两栏可以比视口高，只要求露出来且横向完整落在视口内。
  await expect(left).toBeInViewport();
  await expect(right).toBeInViewport();
  const a = await left.boundingBox();
  const b = await right.boundingBox();
  if (a === null || b === null) throw new Error('左右面板必须有实际尺寸');
  const width = await page.evaluate<number>('innerWidth');
  expect(a.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, '右栏不越出视口右缘').toBeLessThanOrEqual(width);
  expect(a.height).toBeGreaterThan(100);
  expect(Math.abs(a.width - b.width), '左右保持等宽').toBeLessThanOrEqual(2);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  // scrollIntoViewIfNeeded 在 overflow: hidden 下也能滚动，所以要单独确认用户能用滚动条和滚轮滚整页。
  const overflowY = await page.evaluate<string[]>(
    '[document.documentElement, document.body].map(element => getComputedStyle(element).overflowY)',
  );
  expect(overflowY, '整页不得禁止纵向滚动').not.toContain('hidden');
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
  const toolbar = page.locator('pwn2block-top-bar pwn2block-run-menu');
  const payload = page.locator('pwn2block-payload-panel');
  const action = async (name: string): Promise<Projection> => {
    await openRunMenu(page);
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
      await expect(page.locator('pwn2block-app .status')).toContainText('动作 0/0');
      await capture(page, info, '02-briefing-expanded');
    });

    await test.step('键盘折叠题面、等宽布局、视图标签与工具栏可达', async () => {
      const summary = page.locator('pwn2block-briefing-panel summary');
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('pwn2block-briefing-panel details')).not.toHaveAttribute('open');
      await layout(page);
      for (const name of ['运行', '终止']) {
        await reachable(payload.getByRole('button', { name, exact: true }));
      }
      // 视图标签只靠键盘就能逐个切换：→ / End / Home，Ctrl+↓ 在页面任何位置循环。
      const tabs = page.getByRole('tablist', { name: '视图', exact: true }).getByRole('tab');
      const count = await tabs.count();
      expect(count, '至少有栈 / 指令 / 寄存器 / 内存四个标签').toBeGreaterThanOrEqual(4);
      await tabs.first().click();
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      for (let i = 1; i < count; i++) {
        await page.keyboard.press('ArrowRight');
        await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
        await expect(tabs.nth(i)).toBeFocused();
      }
      await page.keyboard.press('Home');
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Control+ArrowDown');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Control+ArrowUp');
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      // 顶栏「运行」菜单：键盘展开后六个按钮全部可达，Esc 收起并把焦点还给菜单标题。
      const runSummary = page.locator('pwn2block-top-bar summary').filter({ hasText: /^运行$/ });
      await runSummary.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('pwn2block-top-bar details.menu')).toHaveAttribute('open', '');
      for (const name of ['单步', '运行 N 步', '后退一步', '撤销', '重置', '提交判题']) {
        await reachable(toolbar.getByRole('button', { name, exact: true }));
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('pwn2block-top-bar details.menu')).not.toHaveAttribute('open', '');
      await expect(runSummary).toBeFocused();
      await capture(page, info, '03-desktop-layout');
    });

    await test.step('真实鼠标拖出开始与单步积木，自动编译出一个动作', async () => {
      const canvas = page.locator('pwn2block-payload-panel #blockly-host');
      await reachable(canvas, 2);
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
      await expectCompiledStep(page);
      await reachable(page.getByRole('region', { name: '输出区', exact: true }));
      await capture(page, info, '04-compiled-payload');
    });

    await test.step('单步、回退、判题回放与调试隔离', async () => {
      expect((await action('单步')).steps).toBe(1);
      expect((await action('后退一步')).steps).toBe(0);
      const [submitted] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith('/submit') && res.request().method() === 'POST'),
        toolbar.getByRole('button', { name: '提交判题', exact: true }).click(),
      ]);
      expect(submitted.status()).toBe(200);
      expect(submitted.request().postDataJSON()).toMatchObject({ actions: [{ type: 'step', count: 1 }] });
      const verdict = await submitted.json() as { verdict: string };
      expect(verdict.verdict).toBe('incomplete');
      await expect(button('判题结果')).toHaveAttribute('aria-pressed', 'true');
      await closeRunMenu(page);
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

    await test.step('刷新接回原会话，保留积木连接与字段并自动重新编译', async () => {
      const before = await canvasStructure(page);
      const start = before.find(block => block.cls.split(' ').includes('start'));
      const step = before.find(block => block.cls.split(' ').includes('action_step'));
      const count = before.find(block => block.cls.split(' ').includes('math_number'));
      expect(before, '刷新前应有开始、单步及数值参数三个积木').toHaveLength(3);
      if (start === undefined || step === undefined || count === undefined) {
        throw new Error('刷新前程序积木不完整');
      }
      expect(start.parentId).toBeNull();
      expect(step.parentId, '单步必须连接在开始下面').toBe(start.id);
      expect(start.childClasses).toEqual([step.cls]);
      expect(count.parentId, '数值参数必须连接到单步').toBe(step.id);
      expect(step.childClasses).toEqual([count.cls]);
      const fields = await blockFieldTexts(page, step.id);
      expect(fields, '单步参数应明确为 1').toEqual(['1']);
      // 程序指针随会话记录一起恢复：单步后再后退一步，指令回退但动作指针仍停在 1/1。
      const pointer = (await page.locator('pwn2block-app .status').textContent())?.match(/动作 \d+\/\d+/)?.[0];
      expect(pointer, '刷新前状态栏应有动作指针').toBeDefined();
      // history 路由：刷新直接回到题目页，不用再点一次题目。
      const [restored] = await Promise.all([
        page.waitForResponse(res => new URL(res.url()).pathname === `/api/sessions/${sessionId}`),
        page.reload(),
      ]);
      expect(restored.status()).toBe(200);
      await expect.poll(() => canvasStructure(page), {
        message: '刷新必须恢复原积木 id、类型、父子连接，不能只恢复孤立块',
      }).toEqual(before);
      await expect.poll(() => blockFieldTexts(page, step.id)).toEqual(fields);
      await expectCompiledStep(page, pointer);
      await reachable(payload.getByRole('button', { name: '运行', exact: true }));
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
