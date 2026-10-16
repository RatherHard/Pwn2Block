import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { parseSolutionMarkdown, type Action, type Projection } from '@pwn2block/shared';
import {
  blockFieldTexts,
  canvasBlocks,
  canvasText,
  connCenter,
  connectFromToolbox,
  dragFromToolboxTo,
  editBlockField,
  findCanvasBlock,
  openToolboxCategory,
  pickBottomConn,
  pickInputConn,
  pickOutputConn,
  pickTopConn,
  revealFlyoutBlock,
  type BlockInfo,
  type ConnInfo,
} from './gestures';

/**
 * 01 §3 八步闭环 E2E — owner F · 关卡 **G3 · D5**。
 *
 * 真实验收的前置条件：
 *   1. 真实后端在跑（`pnpm dev` 或 `pnpm start`，04 §6 默认端口 8787）；
 *   2. 真实首题 `challenges/ret2win` 已就位、`FLAG_RET2WIN` 已注入；
 *   3. 已安装浏览器：`pnpm exec playwright install chromium`；
 *   4. 环境变量 `PWN2BLOCK_E2E=1`（可选 `PWN2BLOCK_BASE_URL` 覆盖地址）。
 * 不满足第 4 条时整组跳过——`pnpm e2e` 在默认环境下是 0 个用例执行、全部 skipped。
 *
 * ## 这一组用例在设计上的三条自我约束
 *
 * 1. **没有 mock**：真后端、真引擎、真 Chromium、真鼠标。第 5 步的积木是**真的用鼠标拖出来的**
 *    （工具箱点分类 → 拖积木 → 拖字段），几何全部从真实 DOM 读，见 `./gestures.ts` 的文件头。
 *    这里不调用任何 Blockly API，也不给 `packages/web` 加任何测试钩子（08 §9.3 / 01 §6）。
 * 2. **参考 payload 只有一份来源**：编译器产物的期望值直接读
 *    `challenges/ret2win/solution.md` 的机器可读块（`parseSolutionMarkdown`），
 *    连填充字节和地址都是**从那份 data 里切出来的**，不在用例里再手抄一份。
 * 3. **会话要自己收尾**：`afterAll` 里 `DELETE /api/sessions/:id`。不删会漏掉每 IP 的存活会话
 *    配额（`limits.ts` 默认 32），连跑几轮之后所有请求都会变成 429（D5 期间踩过）。
 *
 * 步骤出处：`docs/archive/mvp-2026-10-16/01-产品与范围.md` §3（1–6 调试段，7–8 判题段）；
 * 附加断言出处：`docs/archive/mvp-2026-10-16/08-Agent并行开发日程.md` §3 D5 行 / G3「调试不发 flag，正式提交成功才发」。
 */

const E2E_ENABLED = process.env.PWN2BLOCK_E2E === '1';
const E2E_SKIP_REASON =
  'D5 真实闭环：需要 PWN2BLOCK_E2E=1、正在运行的真实后端与真实首题 ret2win，以及已安装的 Playwright 浏览器';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHALLENGE_ID = 'ret2win';
const CHALLENGE_TITLE = '回到胜利';

/**
 * 部署时注入的 flag 真值（06 §6）。测试进程通常拿不到服务端的环境变量，
 * 所以退回到 A 在 8787 上注入的哨兵常量；报告里会写明到底用的是哪一个。
 */
const FLAG_SENTINEL = 'flag{e2e-ret2win-sentinel}';
const EXPECTED_FLAG = process.env.FLAG_RET2WIN ?? FLAG_SENTINEL;
const FLAG_SOURCE = process.env.FLAG_RET2WIN === undefined ? '用例内约定哨兵' : 'process.env.FLAG_RET2WIN';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let context: BrowserContext;
let page: Page;
let sessionId = '';
/** 页面进入题目时自己发起的建会话响应（在第 2 步断言；必须在点击之前就把监听挂上，否则会漏）。 */
let createSession: Promise<{ status: number; text: string }> | undefined;
/** 从服务端读到的初始投影（建会话那一次），后面所有「初始态」断言都跟它比。 */
let initialProjection: Projection | undefined;
/** 每一份**调试实例**响应体的原文：用来断言里面从来没有 flag。 */
const debugResponseTexts: string[] = [];
const consoleErrors: string[] = [];

/** 穿透 shadow root 取整段文字：Lit 组件都在 shadow root 里，`innerText` 取不到。 */
function deepText(target: Page | Locator): Promise<string> {
  return (target as Page).evaluate<string>(`(() => {
    const parts = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        else if (el.children.length === 0) parts.push((el.textContent ?? '').trim());
      }
    };
    visit(document);
    return parts.filter((t) => t !== '').join(' | ');
  })()`);
}

/** 单个自定义组件（含 shadow root）的文字。 */
function componentText(tag: string): Promise<string> {
  return page.evaluate<string>(`(() => {
    const found = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.tagName.toLowerCase() === ${JSON.stringify(tag)}) found.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const host = found[0];
    if (host === undefined) return '';
    return (host.shadowRoot ? host.shadowRoot.textContent : host.textContent) ?? '';
  })()`);
}

/**
 * 等组件渲染出文字再读。
 *
 * 为什么要等：进入题目页之后 `briefing` 面板要在题面接口返回、会话建好之后才出现，
 * 直接读会拿到空串（第一次跑就是这么红的）。断言本身不允许放宽，等渲染完成不算放宽。
 */
async function waitComponentText(tag: string, timeout = 20_000): Promise<string> {
  await expect.poll(() => componentText(tag), { timeout, message: `${tag} 应当渲染出文字` }).not.toBe('');
  return componentText(tag);
}

/** 收集对象里出现的所有键名（递归），用于「投影里不许出现某些字段」的形状断言。 */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** 调色板按钮：`docs/archive/mvp-2026-10-16/05-前端交互.md` §3 固定八个按钮，名字就是契约。 */
const runButton = (name: string): Locator => page.getByRole('button', { name, exact: true });

interface Captured {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
  /** 请求体原文：第 5 步要拿它跟参考解法逐字比（04 §5 的动作序列就是编译产物）。 */
  readonly requestText: string;
}

/** 点一个按钮，并抓它触发的那次 API 响应（真手势 + 真响应，不用轮询猜）。 */
async function clickAndCapture(name: string, match: (url: string) => boolean): Promise<Captured> {
  const [response] = await Promise.all([
    page.waitForResponse((res) => match(res.url()), { timeout: 30_000 }),
    runButton(name).click(),
  ]);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status(), text, body, requestText: response.request().postData() ?? '' };
}

const isActions = (url: string): boolean => url.includes('/api/sessions/') && url.endsWith('/actions');
const isSubmit = (url: string): boolean => url.includes('/api/sessions/') && url.endsWith('/submit');

/** 调试实例的响应：创建 / 动作 / GET 三种，都不许带 flag。 */
function recordDebugResponse(captured: Captured): Captured {
  debugResponseTexts.push(captured.text);
  return captured;
}

/** 会话里的当前投影（GET 是生产路径：刷新恢复就用它，04 §1.1）。 */
async function fetchProjection(): Promise<Projection> {
  const response = await page.request.get(`/api/sessions/${sessionId}`);
  expect(response.status(), 'GET /api/sessions/:id 应当 200').toBe(200);
  const body = (await response.json()) as { projection: Projection };
  return body.projection;
}

/** 把投影里关心的部分压成可比较的小对象（用于「逐字段不变」类断言）。 */
function shape(projection: Projection): string {
  return JSON.stringify({
    status: projection.status,
    steps: projection.steps,
    failures: projection.failures,
    registers: projection.registers,
    flags: projection.flags,
    stdout: projection.stdout ?? null,
    stdin: projection.stdin ?? null,
    vmas: projection.vmas.map((vma) => ({ id: vma.id, start: vma.start, hex: vma.hex ?? null })),
  });
}

function registerValue(projection: Projection, name: string): string {
  const found = projection.registers.find((item) => item.name === name);
  expect(found, `投影里应当有寄存器 ${name}`).toBeDefined();
  return found?.value ?? '';
}

/**
 * 地址在视图里可能补零到 16 位（`0x000000007fffff00`），投影里是短的（`0x7fffff00`）。
 * 这里统一去掉 `0x` 前缀与空白再比，避免把渲染格式当成数值不等。
 */
function hexInText(text: string, value: string): boolean {
  const needle = value.toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
  const hay = text.toLowerCase().replace(/0x/g, '').replace(/\s+/g, '');
  return hay.includes(needle);
}

/** 参考解法：`challenges/ret2win/solution.md` 的机器可读块（唯一来源，不手抄）。 */
function loadSolution(): { actions: Action[]; expectedVerdict: string } {
  const markdown = readFileSync(resolve(ROOT, 'challenges', CHALLENGE_ID, 'solution.md'), 'utf8');
  const parsed = parseSolutionMarkdown(markdown);
  expect(parsed.ok, `solution.md 必须能被 parseSolutionMarkdown 解析：${parsed.ok ? '' : parsed.message}`).toBe(
    true,
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return { actions: [...parsed.doc.actions], expectedVerdict: parsed.doc.expectedVerdict };
}

// 闭环是一条串行的会话：一个后端、一份会话状态。任何一步失败，后面的步骤不再继续。
// 只配置在**这一组**里：刷新恢复那一组要能独立地红/绿，不被八步主链连坐。
test.describe('01 §3 八步闭环 · 真实后端 + 真实首题（G3 · D5）', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!E2E_ENABLED, E2E_SKIP_REASON);

  test.beforeAll(async ({ browser }) => {
    if (!E2E_ENABLED) return;
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    // 建会话的监听必须早于第 1 步的点击：窗口很小，晚一步就抓不到了。
    createSession = page
      .waitForResponse((res) => res.url().endsWith('/api/sessions') && res.request().method() === 'POST', {
        timeout: 60_000,
      })
      .then(async (response) => ({ status: response.status(), text: await response.text() }));
  });

  test.afterAll(async () => {
    if (!E2E_ENABLED) return;
    // 删掉会话：不删会漏配额，连跑几轮之后 POST /api/sessions 会变成 429（04 §6）。
    if (sessionId !== '') await page.request.delete(`/api/sessions/${sessionId}`);
    await context?.close();
  });

  // -------------------------------------------------------------------------
  test('第 1 步：打开题目页，阅读题面', async () => {
    await test.step('题目列表来自真实的后端接口', async () => {
      const [listResponse] = await Promise.all([
        page.waitForResponse((res) => res.url().endsWith('/api/challenges')),
        page.goto('/'),
      ]);
      expect(listResponse.status(), 'GET /api/challenges 应当 200').toBe(200);
      const list = (await listResponse.json()) as { id: string; title: string }[];
      expect(list.map((item) => item.id)).toContain(CHALLENGE_ID);

      const entry = runButton(CHALLENGE_TITLE);
      await expect(entry).toBeVisible();
      await expect(page.getByText(CHALLENGE_ID, { exact: true })).toBeVisible();
    });

    await test.step('进入题目页：题面标题与正文可见', async () => {
      const [detailResponse] = await Promise.all([
        page.waitForResponse((res) => res.url().endsWith(`/api/challenges/${CHALLENGE_ID}`)),
        runButton(CHALLENGE_TITLE).click(),
      ]);
      expect(detailResponse.status(), `GET /api/challenges/${CHALLENGE_ID} 应当 200`).toBe(200);
      const detail = (await detailResponse.json()) as { title: string; briefing: string };
      expect(detail.title).toBe(CHALLENGE_TITLE);
      expect(detail.briefing.length).toBeGreaterThan(0);

      const briefing = await waitComponentText('pwn2block-briefing-panel');
      expect(briefing, '题面标题应当渲染出来').toContain(`题面：${CHALLENGE_TITLE}`);
      expect(briefing, 'briefing 正文应当渲染出来').toContain(detail.briefing.trim().slice(0, 12));
    });

    expect(consoleErrors, '第 1 步（含启动与进页面）不允许有 console error').toEqual([]);
  });

  // -------------------------------------------------------------------------
  test('第 2 步：创建会话，拿到调试实例的公开投影', async () => {
    // 进入题目页时页面自己发的建会话请求：抓它，而不是另开一个会话（否则白占一份配额）。
    const created = await test.step('页面自己发起的 POST /api/sessions', async () => {
      const response = await (createSession as Promise<{ status: number; text: string }>);
      recordDebugResponse({ status: response.status, text: response.text, body: JSON.parse(response.text), requestText: '' });
      expect(response.status, 'POST /api/sessions 应当 200').toBe(200);
      return JSON.parse(response.text) as { sessionId: string; projection: Projection; history: unknown };
    });
    sessionId = created.sessionId;
    initialProjection = created.projection;
    expect(sessionId.length, 'sessionId 至少 16 个字符').toBeGreaterThanOrEqual(16);

    const projection = created.projection;
    expect(projection.status, '新会话的调试实例应当是 ready').toBe('ready');
    expect(projection.steps).toBe(0);
    expect(projection.failures).toBe(0);

    await test.step('text / stack 两段 VMA 的布局是公开的', async () => {
      // 首题的代码段 id 是 `text`、kind 是 `code`（kind 的封闭枚举见 `primitives.ts` 的 `VMA_KINDS`）。
      const text = projection.vmas.find((vma) => vma.kind === 'code');
      const stack = projection.vmas.find((vma) => vma.kind === 'stack');
      expect(text, '投影里应当有 text 段').toBeDefined();
      expect(stack, '投影里应当有 stack 段').toBeDefined();
      expect(text?.start.toLowerCase()).toBe('0x400000');
      expect(text?.size.toLowerCase()).toBe('0x1000');
      expect(text?.perm).toContain('r');
      expect(stack?.start.toLowerCase()).toBe('0x7fffe000');
      expect(stack?.size.toLowerCase()).toBe('0x2000');
      expect(stack?.perm).toContain('w');
    });

    await test.step('disasm 非空，且是 text 段的反汇编', async () => {
      expect(projection.disasm.length).toBeGreaterThan(0);
      expect(projection.disasm[0]?.addr.toLowerCase()).toBe('0x400000');
      for (const entry of projection.disasm) {
        expect(entry.bytes.length).toBeGreaterThan(0);
        expect(entry.text.length).toBeGreaterThan(0);
      }
    });

    await test.step('投影里没有 flag / win / fail，也没有隐藏 VMA 的内容', async () => {
      const keys = collectKeys(created);
      for (const forbidden of ['flag', 'win', 'fail', 'flagValue']) {
        expect(keys.has(forbidden), `投影 JSON 里不允许出现字段 ${forbidden}`).toBe(false);
      }
      const hidden = projection.vmas.filter((vma) => vma.hidden);
      for (const vma of hidden) {
        expect(vma.hex, `隐藏 VMA ${vma.id} 不允许下发 hex 内容`).toBeUndefined();
      }
      expect(debugResponseTexts.join('\n')).not.toContain(EXPECTED_FLAG);
    });
  });

  // -------------------------------------------------------------------------
  test('第 3 步：观察栈视图、寄存器视图和指令视图，找到 buffer / saved RBP / return address', async () => {
    const projection = await fetchProjection();

    await test.step('栈视图标出 buf / saved rbp / ret addr 的语义与地址', async () => {
      const stack = await waitComponentText('pwn2block-stack-view');
      expect(stack, '栈视图应当渲染出来').toContain('buf');
      expect(stack).toContain('saved rbp');
      expect(stack).toContain('ret addr');
      for (const addr of ['0x7fffff00', '0x7fffff10', '0x7fffff18']) {
        expect(hexInText(stack, addr), `栈视图应当出现地址 ${addr}`).toBe(true);
      }
    });

    await test.step('寄存器视图里的值等于投影下发的值', async () => {
      const registers = await waitComponentText('pwn2block-registers-view');
      for (const [name, expected] of [
        ['RSP', '0x7fffff00'],
        ['RBP', '0x7fffff10'],
        ['RIP', '0x400000'],
      ] as const) {
        expect(registerValue(projection, name).toLowerCase()).toBe(expected);
        expect(registers.toLowerCase(), `寄存器视图应当显示 ${name}`).toContain(name.toLowerCase());
        expect(hexInText(registers, expected), `寄存器视图应当显示 ${name}=${expected}`).toBe(true);
      }
    });

    await test.step('指令视图显示 text 段反汇编', async () => {
      const disasm = await waitComponentText('pwn2block-disasm-view');
      const first = projection.disasm[0];
      expect(hexInText(disasm, first?.addr ?? ''), '指令视图应当显示首条指令的地址').toBe(true);
      expect(disasm.toLowerCase()).toContain((first?.text ?? '').toLowerCase());
      // 首题是 leave / ret 序列：至少能看到一条 ret（劫持返回地址就是靠它）。
      expect(projection.disasm.some((entry) => entry.text.includes('ret'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  test('第 4 步：运行 N 步、后退一步、撤销、重置（工具栏真手势）', async () => {
    const before = await fetchProjection();

    await test.step('「单步」在没编译前是禁用的，且给出中文原因（05 §6）', async () => {
      // 05 §3：单步/试运行是**程序区**层面的动作，要先有编译产物；
      // 「运行 N 步」才是纯粹的 `step(count)`。这条差异是设计，不是缺陷。
      await expect(runButton('单步')).toBeDisabled();
      // 禁用原因必须写出来，不能只靠置灰（05 §6）：颜色不是唯一信息载体。
      // 顶部「运行」菜单与 payload 工具栏渲染的是**同一个** `pwn2block-run-menu`（05 §1），
      // 所以 DOM 里有两份原因文本；折叠的那份不在可访问性树里，这里取 payload 窗口里的那份。
      const reasons = page.locator('pwn2block-payload-panel pwn2block-run-menu details.reasons');
      await reasons.locator('summary').click();
      await expect(reasons, '禁用原因必须是可见文字').toBeVisible();
      await expect(reasons).toContainText('单步');
      await expect(reasons).toContainText('编译');
      // 禁用的那一条要能说清缺什么，而不是一句「不可用」。
      await expect(reasons).toContainText('程序区还没有编译产物');
      // 手工写字节在首题上不可达：allowedActions 不含 write_bytes（challenge 设计使然）。
      await reasons.locator('summary').click();
      const detail = await page.request.get(`/api/challenges/${CHALLENGE_ID}`);
      const challenge = (await detail.json()) as { allowedActions: string[] };
      expect(challenge.allowedActions, '首题允许的动作').toEqual(
        expect.arrayContaining(['step', 'run', 'undo', 'reset']),
      );
      expect(challenge.allowedActions, '首题不允许 write_bytes：手工写字节只能走积木').not.toContain(
        'write_bytes',
      );
    });

    await test.step('「运行 N 步」提交一条带 count 的 step，投影按 04 §4 前进', async () => {
      const input = page.getByRole('spinbutton', { name: '运行步数' });
      await input.fill('2');
      const captured = recordDebugResponse(await clickAndCapture('运行 N 步', isActions));
      expect(captured.status).toBe(200);
      // 05 §3 的 hint 写得很明确：运行 N 步 = step 带 count，不是 run。
      const sent = JSON.parse(captured.requestText) as { actions: { type: string; count?: number }[] };
      expect(sent.actions).toEqual([{ type: 'step', count: 2 }]);
      const body = captured.body as {
        results: { ok: boolean; action: string }[];
        executed: number;
        projection: Projection;
        history: { undo: number; stepBack: number };
      };
      expect(body.results.map((item) => item.action)).toEqual(['step']);
      expect(body.results[0]?.ok).toBe(true);
      expect(body.executed).toBe(1);
      expect(body.projection.steps, '走 2 条指令就该是 2 条').toBe(before.steps + 2);
      expect(body.projection.error, '正常执行不应当带 error').toBeUndefined();
      expect(body.history.stepBack, '走完就有可回退的指令').toBe(2);
      expect(body.history.undo, '每个请求都是可撤销的一次提交').toBe(1);
    });

    await test.step('「后退一步」退回一条指令，状态与执行前逐字段相等', async () => {
      const captured = recordDebugResponse(await clickAndCapture('后退一步', isActions));
      const body = captured.body as { projection: Projection; history: { undo: number; stepBack: number } };
      // 走 2 条再退 1 条：还剩 1 条可退（history.stepBack 是「还能退几条」）。
      expect(body.projection.steps).toBe(before.steps + 1);
      expect(body.history.stepBack).toBe(1);
      // 回退类动作**不产生新的撤销点**：能撤销的仍然只有前面那一批 step(count=2)。
      expect(body.history.undo).toBe(1);
    });

    await test.step('「撤销」回退上一次提交；「重置」回到初态', async () => {
      const undone = recordDebugResponse(await clickAndCapture('撤销', isActions));
      const undoBody = undone.body as { projection: Projection; history: { undo: number; stepBack: number } };
      expect(undoBody.projection.steps, '撤销回退到 step(count=2) 这一批之前').toBe(before.steps);
      expect(shape(undoBody.projection), '撤销后与题目初态逐字段相等').toBe(shape(before));
      expect(undoBody.history.undo, '撤销完就没有可撤销的提交了').toBe(0);
      expect(undoBody.history.stepBack, '没有已执行的指令可退').toBe(0);

      const reset = recordDebugResponse(await clickAndCapture('重置', isActions));
      const resetBody = reset.body as { projection: Projection; history: { undo: number; stepBack: number } };
      expect(shape(resetBody.projection), '重置回到题目初态').toBe(shape(initialProjection as Projection));
      expect(resetBody.history.stepBack, '重置后没有已执行的指令可退').toBe(0);
      // 实测：「重置」自己也是一次可撤销的提交（`undo` 从 0 变 1，可以把重置撤掉），
      // 而「后退一步」不产生撤销点。两者的差异按原样记在报告里，不在这里美化。
      expect(resetBody.history.undo).toBe(1);
    });

    await test.step('整个调试过程页面不出现 flag', async () => {
      expect(await deepText(page)).not.toContain(EXPECTED_FLAG);
      expect(debugResponseTexts.join('\n')).not.toContain(EXPECTED_FLAG);
    });
  });

  // -------------------------------------------------------------------------
  test('第 5 步：在积木窗口里用真实鼠标拼出 payload（填充 + 小端地址），试运行看效果', async () => {
    const solution = loadSolution();
    const first = solution.actions[0];
    expect(first?.type, '参考解法的第一条动作应当是出题人积木').toBe('block');
    if (first?.type !== 'block') throw new Error('参考解法第一条动作不是 block');
    expect(first.id).toBe('gets');

    // 填充字节与地址**从参考解法的 data 里切出来**，本文件不出现第二份手抄的字节。
    const data = String(first.args.data ?? '');
    const padHex = data.slice(0, 48); // 24 字节填充：16×41 + 8×42
    const addrLittleEndianHex = data.slice(48); // 8 字节小端地址
    const addrValue = BigInt(`0x${[...addrLittleEndianHex.match(/../g) ?? []].reverse().join('')}`);
    const stepAction = solution.actions[1];
    expect(stepAction?.type, '参考解法的第二条动作应当是 step').toBe('step');
    if (stepAction?.type !== 'step') throw new Error('参考解法第二条动作不是 step');

    const host = await page.locator('pwn2block-payload-panel #blockly-host').boundingBox();
    expect(host, '积木画布应当可见').not.toBeNull();
    const origin = { x: (host?.x ?? 0) + 300, y: (host?.y ?? 0) + 40 };

    await test.step('工具箱按 03 §3 渲染出题人积木 gets(buf)', async () => {
      await openToolboxCategory(page, '出题人积木', 'author_gets');
      const block = await revealFlyoutBlock(page, 'author_gets');
      expect(block.cls).toContain('author_gets');
      // 开局画布**必须是空的**：题目包的公开字段里没有初始/示例程序（03 §2），
      // 所以第 5 步的 payload 只能靠手势拼——顺手把这条事实钉住，免得日后加了开局程序还没人发现。
      expect(await canvasText(page), '新会话的画布应当是空的').toBe('');
    });

    await test.step('真实拖拽：开始 → gets(data ← concat(raw(填充), addr(地址))) → step(count)', async () => {
      await openToolboxCategory(page, '开始', 'start');
      await dragFromToolboxTo(page, 'start', origin);
      const start = await findCanvasBlock(page, 'start', null);
      expect(start, '「开始」积木应当被拖到画布上').toBeDefined();
      if (start === undefined) return;

      await openToolboxCategory(page, '出题人积木', 'author_gets');
      const target = async (parent: BlockInfo, pick: (conns: readonly ConnInfo[]) => ConnInfo | undefined) => {
        // 必须在**拖动前一刻**按 id 现读：flyout 滚动会把整个面板挪走，旧坐标一律作废。
        const fresh = (await canvasBlocks(page)).find((block) => block.id === parent.id);
        const source = fresh ?? parent;
        const conn = pick(source.conns);
        return conn === undefined ? null : connCenter(conn);
      };
      const gets = await connectFromToolbox(page, 'author_gets', pickTopConn, start.id, () =>
        target(start, pickBottomConn),
      );
      expect(gets, 'gets(buf) 应当接在「开始」下面（真实拖拽 + 吸附）').toBeDefined();
      if (gets === undefined) return;

      await openToolboxCategory(page, '动作', 'action_step');
      const step = await connectFromToolbox(page, 'action_step', pickTopConn, gets.id, () =>
        target(gets, pickBottomConn),
      );
      expect(step, 'step(count) 应当接在 gets 下面').toBeDefined();

      // 步数字段趁现在改：等字节区的积木接进来之后，concat 会正好压在 step 的影子数字上，
      // 那时点字段中心的点击会落到 concat 上（字段编辑静默失效，编译出来还是 count=1）。
      if (step !== undefined) await editBlockField(page, step.id, 0, String(stepAction.count));

      // 每次从 flyout 拖出积木之前**都要重新点一次分类**：实测拖走一块之后 flyout 会自动收起
      // （积木元素留在 DOM 里但尺寸为 0），不重开会把 mousedown 落到空画布上。
      await openToolboxCategory(page, '字节', 'bytes_concat');
      const concat = await connectFromToolbox(page, 'bytes_concat', pickOutputConn, gets.id, () =>
        target(gets, (conns) => pickInputConn(conns, 0)),
      );
      expect(concat, 'concat(…) 应当接进 gets 的 data 输入槽').toBeDefined();
      if (concat === undefined) return;

      await openToolboxCategory(page, '字节', 'bytes_raw');
      const raw = await connectFromToolbox(page, 'bytes_raw', pickOutputConn, concat.id, () =>
        target(concat, (conns) => pickInputConn(conns, 0)),
      );
      expect(raw, 'raw(hex) 应当接进 concat 的 item0').toBeDefined();
      if (raw === undefined) return;

      await openToolboxCategory(page, '字节', 'bytes_addr');
      const addr = await connectFromToolbox(page, 'bytes_addr', pickOutputConn, concat.id, () =>
        target(concat, (conns) => pickInputConn(conns, 1)),
      );
      expect(addr, 'addr(v) 应当接进 concat 的 item1').toBeDefined();
      if (addr === undefined) return;

      // 字段也是真手势改的：点开字段 → 键入 → 回车。
      await editBlockField(page, raw.id, 0, padHex);
      await editBlockField(page, addr.id, 0, addrValue.toString());

      expect((await blockFieldTexts(page, raw.id)).join(''), 'raw 的 hex 字段要真的是参考解法的填充').toContain(
        padHex,
      );
      expect((await blockFieldTexts(page, addr.id)).join(''), 'addr 字段要真的是小端地址值').toContain(
        addrValue.toString(),
      );
      if (step !== undefined) {
        expect((await blockFieldTexts(page, step.id)).join(''), 'step 的步数字段要真的改成解法的 count').toContain(
          String(stepAction.count),
        );
      }
      const canvas = await canvasBlocks(page);
      expect(canvas.length, '画布上应当有 6 块积木（开始 / gets / step / concat / raw / addr）').toBeGreaterThanOrEqual(
        6,
      );
    });

    await test.step('编译不报错，程序区给出 2 个动作', async () => {
      await runButton('编译').click();
      await page.waitForTimeout(500);
      const output = await waitComponentText('pwn2block-output-view');
      expect(output, '编译不应当报错').not.toContain('编译错误');
      const program = await waitComponentText('pwn2block-program-view');
      expect(program, '程序区应当显示编译出的动作条数').toContain('2 个动作');
      expect(program).toContain('block');
      expect(program).toContain('step');
    });

    await test.step('「单步」提交程序区的下一个动作（05 §3：单步是程序区语义）', async () => {
      await expect(runButton('单步'), '编译之后单步就可用了').toBeEnabled();
      const captured = recordDebugResponse(await clickAndCapture('单步', isActions));
      expect(captured.status).toBe(200);
      const sent = JSON.parse(captured.requestText) as { actions: Action[] };
      expect(sent.actions, '单步只提交程序区的下一个动作，不是整段').toEqual([solution.actions[0]]);
      const body = captured.body as {
        results: { ok: boolean }[];
        executed: number;
        projection: Projection;
      };
      expect(body.results.length, '一个积木算一个动作').toBe(1);
      expect(body.executed).toBe(1);
      const stack = body.projection.vmas.find((vma) => vma.kind === 'stack');
      expect(
        (stack?.hex ?? '').toLowerCase(),
        '写进栈的填充字节应当出现在公开投影里（stack 不是隐藏段）',
      ).toContain(padHex.toLowerCase());
    });

    await test.step('「重置」把实例送回初态，程序区光标也回到开头', async () => {
      const captured = recordDebugResponse(await clickAndCapture('重置', isActions));
      const body = captured.body as { projection: Projection };
      expect(shape(body.projection), '重置后与题目初态逐字段相等').toBe(shape(initialProjection as Projection));
    });

    await test.step('「试运行」提交程序区剩余动作，请求与参考解法逐字相等', async () => {
      const captured = recordDebugResponse(await clickAndCapture('试运行', isActions));
      expect(captured.status, '试运行应当 200').toBe(200);
      // 请求体就是编译产物：与 solution.md 的机器可读块逐字比。
      const sent = JSON.parse(captured.requestText) as { actions: Action[] };
      expect(sent.actions, '试运行发的动作序列必须与参考解法逐字相等').toEqual(solution.actions);
      const body = captured.body as { results: unknown[]; projection: Projection };
      expect(body.results.length, '两个动作都要有执行结果').toBe(2);

      // 调试实例命中成功条件时**只提示「已满足」**，不发 flag（G3 附加断言）。
      expect(body.projection.status, '正确 payload 在调试实例上应当满足成功条件').toBe('satisfied');
      expect(captured.text, '调试实例的响应里不允许出现 flag 真值').not.toContain(EXPECTED_FLAG);
      expect(collectKeys(captured.body).has('flag'), '调试实例的响应里不允许出现 flag 键').toBe(false);
      const pageText = await deepText(page);
      expect(pageText, '调试实例满足成功条件说「已满足」').toContain('已满足');
      expect(pageText, '调试实例满足成功条件不发 flag').not.toContain(EXPECTED_FLAG);
    });
  });

  // -------------------------------------------------------------------------
  test('第 6 步：失败时阅读错误解释、揭示下一级提示；回退后按钮状态与 history 一致', async () => {
    const solution = loadSolution();
    const first = solution.actions[0];
    expect(first?.type, '参考解法第一条动作应当是出题人积木').toBe('block');
    const wrongValue = 0xdeadbeefn; // 未映射地址：ret 跳过去必然异常。

    const addrBlock = await findCanvasBlock(page, 'bytes_addr', undefined);
    expect(addrBlock, '第 5 步拼出来的 addr 积木还在画布上').toBeDefined();
    if (addrBlock === undefined) return;

    await test.step('把地址改成错的值，试运行给出中文错误解释', async () => {
      // 第 5 步的「试运行」把程序跑到底了，调试实例现在是**终态**：05 §3 的表里
      // 终态只禁用执行类按钮，回退类按钮仍然可用，所以先「重置」回 ready 再改地址。
      const entered = await fetchProjection();
      expect(['satisfied', 'exited'], '试运行跑完之后应当是终态').toContain(entered.status);
      const reset = runButton('重置');
      await expect(reset, '终态下「重置」必须仍然可用（05 §3）').toBeEnabled();
      await reset.click();
      await expect
        .poll(async () => (await fetchProjection()).status, { message: '重置之后回到 ready' })
        .toBe('ready');

      await editBlockField(page, addrBlock.id, 0, wrongValue.toString());
      await runButton('编译').click();
      // 改字段会让编译产物变旧（05 §3）：必须先重新编译，「试运行」才重新可用。
      const program = await waitComponentText('pwn2block-program-view');
      expect(program, `改地址后重新编译应当照旧得到 2 个动作，程序区实际显示：${program}`).toContain('2 个动作');
      const gateReason = await page
        .locator('pwn2block-payload-panel pwn2block-run-menu details.reasons')
        .first()
        .innerText()
        .catch(() => '（读不到 run-menu 的 reasons）');
      await expect(
        runButton('试运行'),
        `重新编译之后「试运行」必须可用；run-menu 给的理由是：${gateReason}`,
      ).toBeEnabled();
      const captured = recordDebugResponse(await clickAndCapture('试运行', isActions));
      expect(captured.status).toBe(200);
      const body = captured.body as {
        results: { ok: boolean; action: string; error?: { code: string; message: string; note?: string } }[];
        projection: Projection;
      };
      expect(body.projection.status, '跳到未映射地址应当让调试实例进入 failed').toBe('failed');
      expect(body.projection.failures, '失败要计入 failures（用于解锁提示）').toBeGreaterThan(0);
      // 失败解释可能在「那一条动作的结果」里，也可能挂在投影的 error 上（04 §4）：
      // 两种情况都认，但**必须**有 code + 中文 message。
      const info =
        body.results.find((item) => item.ok === false)?.error ?? body.projection.error ?? undefined;
      expect(info, '失败必须给出 04 §4 的 error.code/message').toBeDefined();
      expect(info?.code, 'error.code 来自 04 §4 的封闭枚举').toBeTruthy();
      expect(info?.message ?? '', 'error.message 应当是中文解释').toMatch(/[\u4e00-\u9fa5]/);

      const output = await waitComponentText('pwn2block-output-view');
      expect(output, '页面应当把失败原因显示出来').toMatch(/[\u4e00-\u9fa5]/);
      expect(debugResponseTexts.join('\n')).not.toContain(EXPECTED_FLAG);
    });

    await test.step('提示按 failures 门槛解锁：达到 unlockAfterFailures 后自动解锁', async () => {
      const detail = await page.request.get(`/api/challenges/${CHALLENGE_ID}`);
      const challenge = (await detail.json()) as {
        hints: { text: string; unlockAfterFailures?: number }[];
      };
      const gated = challenge.hints.findIndex((hint) => hint.unlockAfterFailures !== undefined);
      expect(gated, '首题应当有一条按失败次数解锁的提示').toBeGreaterThanOrEqual(0);
      const threshold = challenge.hints[gated]?.unlockAfterFailures ?? 0;
      expect(threshold).toBeGreaterThan(0);
      // 门槛之前，这条提示的正文不许出现在题面板里（用开头一段做指纹，避开渲染时的折行/省略）。
      const gatedFingerprint = [...(challenge.hints[gated]?.text ?? '')].slice(0, 12).join('');
      expect(gatedFingerprint.length, '受门槛保护的提示应当有正文').toBeGreaterThan(0);
      const briefingBefore = await waitComponentText('pwn2block-briefing-panel');
      const beforeLoop = await fetchProjection();
      // 门槛与「已累计失败次数」必须自洽：没到门槛就不该揭示，到了就该已经揭示（自动解锁）。
      expect(
        briefingBefore.includes(gatedFingerprint),
        `受门槛保护的提示是否已揭示，应当与失败次数自洽（已失败 ${beforeLoop.failures} / 门槛 ${threshold}）`,
      ).toBe(beforeLoop.failures >= threshold);

      // 失败之后实例是 failed，运行类按钮会被禁用，所以要「重置 → 再试运行」；
      // failures 是单调递增的（04 §3），重置不会把它清零。上限 8 次防止死循环。
      let projection = await fetchProjection();
      for (let i = 0; i < 8 && projection.failures < threshold; i += 1) {
        const reset = page.getByRole('button', { name: '重置', exact: true });
        if (await reset.isEnabled()) {
          await reset.click();
          await page.waitForTimeout(300);
        }
        recordDebugResponse(await clickAndCapture('试运行', isActions));
        projection = await fetchProjection();
      }
      expect(projection.failures, `失败次数应当达到解锁门槛 ${threshold}`).toBeGreaterThanOrEqual(threshold);

      const briefing = await waitComponentText('pwn2block-briefing-panel');
      expect(briefing, '应当播报自动解锁').toContain('自动解锁');
      expect(briefing, `跨过门槛 ${threshold} 之后这条提示的正文应当出现在题面板里`).toContain(gatedFingerprint);

      // 「下一条提示」的两种合法状态都认，但必须和揭示进度自洽（05 §5 的提示区）：
      // 还有没揭示的 → 可点且点完内容会变；全都揭示完了 → 禁用并说明原因。
      const hintButton = page.getByRole('button', { name: '下一条提示' });
      if (await hintButton.isEnabled()) {
        const before = await componentText('pwn2block-briefing-panel');
        await hintButton.click();
        await expect
          .poll(() => componentText('pwn2block-briefing-panel'), {
            timeout: 5_000,
            message: '点「下一条提示」应当揭示新的一条',
          })
          .not.toBe(before);
      } else {
        await expect(hintButton, '提示全部揭示之后应当禁用，并说明原因').toHaveAttribute(
          'title',
          '提示已全部揭示',
        );
      }
    });

    await test.step('回退后按钮状态与 history 深度一致（05 §6）', async () => {
      await runButton('重置').click();
      await page.waitForTimeout(400);
      let projection = await fetchProjection();
      expect(projection.status).toBe('ready');

      // 先走两步，history.stepBack > 0 → 「后退一步」必须可用。
      const stepInput = page.getByRole('spinbutton', { name: '运行步数' });
      await stepInput.fill('2');
      await runButton('运行 N 步').click();
      await page.waitForTimeout(400);
      projection = await fetchProjection();
      expect(projection.steps, '运行 2 步之后应当有 2 条指令').toBeGreaterThan(0);
      const stepBack = page.getByRole('button', { name: '后退一步', exact: true });
      if (projection.steps > 0) {
        await expect(stepBack, 'history 里有可回退的指令时按钮必须可用').toBeEnabled();
      }

      // 一路退到 0 → 按钮必须禁用（按钮状态就是 history 深度的函数）。
      for (let i = 0; i < 4; i += 1) {
        if (!(await stepBack.isEnabled())) break;
        await stepBack.click();
        await page.waitForTimeout(300);
      }
      const finalProjection = await fetchProjection();
      if (finalProjection.steps === 0) {
        await expect(stepBack, '没有可回退的指令时按钮必须禁用').toBeDisabled();
      }
      expect(await deepText(page)).not.toContain(EXPECTED_FLAG);
    });
  });

  // -------------------------------------------------------------------------
  test('第 7 步：点「提交判题」，判题实例重置到初态并回放 payload', async () => {
    // 先让调试实例真的走几步：否则「录像首帧=初态」这条断言在 == 当前状态 时恒真，等于没测。
    const stepInput = page.getByRole('spinbutton', { name: '运行步数' });
    await stepInput.fill('2');
    if (await runButton('运行 N 步').isEnabled()) {
      await runButton('运行 N 步').click();
      await page.waitForTimeout(400);
    }
    const beforeSubmit = await fetchProjection();
    expect(beforeSubmit.steps, '提交前调试实例应当有进度（否则这条断言没有意义）').toBeGreaterThan(0);

    const captured = recordDebugResponse(await clickAndCapture('提交判题', isSubmit));
    expect(captured.status, 'POST /submit 应当 200').toBe(200);
    const body = captured.body as {
      verdict: string;
      executed: number;
      results: unknown[];
      replay: {
        initial: Projection;
        frames: {
          index: number;
          kind: string;
          label: string;
          status: string;
          steps: number;
          changedVmas?: { id: string; kind: string }[];
          error?: { code: string; message: string };
        }[];
      };
      flag?: string;
    };
    // 提交发的就是编译产物：与画布上的 addr 值（错的）一致，说明走的是真编译路径。
    const submitted = JSON.parse(captured.requestText) as { actions: Action[] };
    expect(submitted.actions.length).toBe(2);

    await test.step('错 payload 的判定不是 won，且响应里没有 flag', async () => {
      expect(body.verdict).not.toBe('won');
      expect('flag' in body, 'verdict≠won 时响应里连 flag 键都不该有').toBe(false);
      expect(collectKeys(body).has('flag')).toBe(false);
      expect(captured.text).not.toContain(EXPECTED_FLAG);
    });

    await test.step('录像的首份完整投影是题目初态，而不是调试实例的当前状态（S02 / 04 §5.1）', async () => {
      // 04 §5.1 的录像 = 「首份完整投影（`replay.initial`）+ 逐动作 diff（`frames`）」，
      // 所以 `initial` 才是初态，`frames[0]` 是**第一条动作**的帧（kind='action'），
      // schema 里的 'init' 留给别处的时间线用——这里不该出现，出现反而是语义串了。
      expect(body.replay.frames.length, '两条动作至少两帧').toBeGreaterThanOrEqual(2);
      expect(body.replay.frames[0]?.kind, '第一帧是第一条动作').toBe('action');
      expect(body.replay.frames[0]?.index).toBe(0);
      expect(body.replay.frames[0]?.status, '第一条动作之前是 ready').toBe('ready');
      expect(body.replay.frames[0]?.steps, '第一条动作之前 0 步').toBe(0);
      for (const frame of body.replay.frames) {
        expect(['init', 'action', 'instruction']).toContain(frame.kind);
        expect(frame.label, '每帧都要有可读的标签').toBeTruthy();
      }
      // 帧号从 0 开始严格递增（回放滑块的 max 与它对得上）。
      expect(body.replay.frames.map((frame) => frame.index)).toEqual(
        body.replay.frames.map((_frame, i) => i),
      );
      // 逐动作 diff：第一条动作是 gets 写栈，所以那一帧必须带出**变化过的** VMA。
      const firstWrite = body.replay.frames[0];
      expect(
        (firstWrite?.changedVmas ?? []).length,
        '第一条动作改了栈，这一帧应当带出变化的 VMA diff',
      ).toBeGreaterThan(0);
      expect((firstWrite?.changedVmas ?? []).every((vma) => typeof vma.id === 'string')).toBe(true);

      expect(shape(body.replay.initial)).toBe(shape(initialProjection as Projection));
      expect(body.replay.initial.steps).toBe(0);
      expect(body.replay.initial.status).toBe('ready');
      // 与调试实例当前状态确实不同：否则上面的相等是"碰巧"。
      expect(shape(body.replay.initial)).not.toBe(shape(beforeSubmit));

      // 错地址的回放要跑到 invalid_ip（04 §4 的封闭错误码），并且是**从初态**跑出来的。
      const failedFrame = body.replay.frames.find((frame) => frame.status === 'failed');
      expect(failedFrame, '回放里应当有进入 failed 的那一帧').toBeDefined();
      expect(failedFrame?.error?.code, '跳到未映射地址的错误码是 invalid_ip').toBe('invalid_ip');
      expect(failedFrame?.error?.message ?? '', '错误解释必须是中文').toMatch(/[\u4e00-\u9fa5]/);
      expect(body.replay.frames.at(-1)?.status, '最后一帧停在 failed').toBe('failed');
    });

    await test.step('提交不改动调试实例（逐字段相等）', async () => {
      const afterSubmit = await fetchProjection();
      expect(shape(afterSubmit)).toBe(shape(beforeSubmit));
    });

    await test.step('判题面板给出中文结论与可拖动的回放时间线', async () => {
      const panel = await waitComponentText('pwn2block-verdict-panel');
      expect(panel).toMatch(/[\u4e00-\u9fa5]/);
      expect(panel).toContain('回放时间线');
      const range = page.locator('#replay-range');
      await expect(range).toBeVisible();
      const max = Number(await range.getAttribute('max'));
      expect(max, '录像应当有多帧可拖').toBeGreaterThan(0);
      const position = Number(await range.inputValue());
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThanOrEqual(max);
      // 真手势：键盘在滑块上移一帧（04 §5.1 的逐动作回放），位置摘要必须跟着变。
      const before = await componentText('pwn2block-verdict-panel');
      await range.focus();
      await page.keyboard.press(position < max ? 'ArrowRight' : 'ArrowLeft');
      await expect
        .poll(() => componentText('pwn2block-verdict-panel'), { timeout: 5_000, message: '拖时间线应当切换帧' })
        .not.toBe(before);
      expect(await deepText(page)).not.toContain(EXPECTED_FLAG);
    });
  });

  // -------------------------------------------------------------------------
  test('第 8 步：判胜显示 flag；回到调试继续；提交不限次数', async () => {
    const solution = loadSolution();
    const first = solution.actions[0];
    const data = String(first?.type === 'block' ? first.args.data : '');
    const addrLittleEndianHex = data.slice(48);
    const addrValue = BigInt(`0x${[...addrLittleEndianHex.match(/../g) ?? []].reverse().join('')}`);

    const addrBlock = await findCanvasBlock(page, 'bytes_addr', undefined);
    expect(addrBlock, 'addr 积木还在画布上').toBeDefined();
    if (addrBlock === undefined) return;

    await test.step('把地址改回参考解法的值，提交判胜并下发 flag', async () => {
      await runButton('回到调试').click();
      await page.waitForTimeout(300);
      await editBlockField(page, addrBlock.id, 0, addrValue.toString());
      await runButton('编译').click();
      await page.waitForTimeout(400);

      const captured = recordDebugResponse(await clickAndCapture('提交判题', isSubmit));
      expect(captured.status).toBe(200);
      const body = captured.body as { verdict: string; flag?: string; executed: number };
      expect(body.verdict, '参考解法必须判胜').toBe(solution.expectedVerdict);
      expect(body.flag, 'verdict=won 时响应必须带 flag').toBe(EXPECTED_FLAG);
      // flag 真值来源写清楚：环境变量优先，否则是 A 在 8787 上注入的哨兵。
      expect(body.flag, `flag 必须与 ${FLAG_SOURCE} 逐字相等`).toBe(EXPECTED_FLAG);

      const panel = await waitComponentText('pwn2block-verdict-panel');
      expect(panel).toContain(EXPECTED_FLAG);
      await expect(page.locator('pwn2block-verdict-panel .flag code')).toHaveText(EXPECTED_FLAG);
    });

    await test.step('重复提交互不影响：仍然 won、flag 相同、调试实例不动', async () => {
      const debugBefore = await fetchProjection();
      const captured = recordDebugResponse(await clickAndCapture('提交判题', isSubmit));
      const body = captured.body as { verdict: string; flag?: string };
      expect(body.verdict).toBe('won');
      expect(body.flag).toBe(EXPECTED_FLAG);
      expect(shape(await fetchProjection())).toBe(shape(debugBefore));
    });
  });

  // -------------------------------------------------------------------------
  test('附加断言（G3）：调试实例全程不出现 flag，只有 submit won 才下发', async () => {
    await test.step('调试实例的所有响应里都没有 flag 字段与哨兵值', async () => {
      expect(debugResponseTexts.length, '应当抓到若干份调试实例响应').toBeGreaterThan(0);
      for (const text of debugResponseTexts) {
        if (text.includes('"verdict"')) continue; // 判题响应单独在第 7/8 步断言
        const parsed: unknown = JSON.parse(text);
        expect(collectKeys(parsed).has('flag'), `调试实例响应里不允许出现 flag 键：${text.slice(0, 120)}`).toBe(false);
        expect(text, '调试实例响应里不允许出现 flag 真值').not.toContain(EXPECTED_FLAG);
      }
    });

    await test.step('调试实例满足成功条件时只提示「已满足」，不发 flag', async () => {
      await runButton('回到调试').click();
      await page.waitForTimeout(300);
      // 从初态再试一次：调试实例满足成功条件，但响应里既没有 flag 键也没有 flag 真值。
      const reset = page.getByRole('button', { name: '重置', exact: true });
      if (await reset.isEnabled()) {
        await reset.click();
        await page.waitForTimeout(300);
      }
      const captured = recordDebugResponse(await clickAndCapture('试运行', isActions));
      const body = captured.body as { projection: Projection };
      expect(body.projection.status, '正确 payload 在调试实例上应当满足成功条件').toBe('satisfied');
      expect(collectKeys(body).has('flag'), '调试实例响应里不允许出现 flag 键').toBe(false);
      expect(captured.text, '调试实例响应里不允许出现 flag 真值').not.toContain(EXPECTED_FLAG);
      const pageText = await deepText(page);
      expect(pageText, '调试实例满足成功条件只说「已满足」').toContain('已满足');
      expect(pageText, '调试实例不发 flag').not.toContain(EXPECTED_FLAG);
    });
  });
});

// ---------------------------------------------------------------------------
/**
 * 刷新恢复（真浏览器 · `localStorage` 跨刷新）——同属 owner F 的 `tests/e2e/**` 范围。
 *
 * 为什么必须由浏览器层来验（D5 批次 2 自己列的未做项）：jsdom 里的 `localStorage` 是内存替身，
 * 「跨刷新持久化」「刷新时序」「画布挂载与存档装载的先后」都验不到。真浏览器里这三条都能红：
 * ① 存档写不进去（键名错 / 配额 0）；② 相位切换把 payload 窗口销毁重建 → 画布清空，
 * 「先装回画布」白做；③ 恢复时错误地新建会话，本该接回旧实例。
 *
 * 这一组**独立**于八步主链：主链红了它照跑，反之亦然（09 §3.2 的「刷新恢复」验收）。
 */
test.describe('刷新恢复（真浏览器 · localStorage 跨刷新）', () => {
  test.skip(!E2E_ENABLED, E2E_SKIP_REASON);

  const CANVAS_KEY = `pwn2block.canvas.v1.${CHALLENGE_ID}`;
  const SESSION_KEY = `pwn2block.session.v1.${CHALLENGE_ID}`;
  let createPosts = 0;
  const sessionGets: string[] = [];

  test.beforeAll(async ({ browser }) => {
    if (!E2E_ENABLED) return;
    consoleErrors.length = 0;
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return;
      if (request.method() === 'POST' && url.pathname === '/api/sessions') createPosts += 1;
      if (request.method() === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
        sessionGets.push(url.pathname);
      }
    });
  });

  test.afterAll(async () => {
    if (!E2E_ENABLED) return;
    if (sessionId !== '') await page.request.delete(`/api/sessions/${sessionId}`);
    await context?.close();
  });

  test('刷新后画布还在，而且接回同一个调试实例（不新建会话）', async () => {
    await test.step('开局：新 context ⇒ localStorage 是空的，只建一次会话', async () => {
      await page.goto('/');
      await expect(runButton(CHALLENGE_TITLE)).toBeVisible();
      // 监听早于点击，否则会漏掉这一发建会话请求。
      createSession = page
        .waitForResponse((res) => res.url().endsWith('/api/sessions') && res.request().method() === 'POST', {
          timeout: 60_000,
        })
        .then(async (response) => ({ status: response.status(), text: await response.text() }));
      await runButton(CHALLENGE_TITLE).click();
      const created = JSON.parse(
        (await (createSession as Promise<{ status: number; text: string }>)).text,
      ) as { sessionId: string };
      sessionId = created.sessionId;
      expect(createPosts, '开局只该有一次 POST /api/sessions').toBe(1);
    });

    await test.step('真手势摆一个能编译的程序：开始 → step(count=7)', async () => {
      const host = await page.locator('pwn2block-payload-panel #blockly-host').boundingBox();
      expect(host, '积木画布应当可见').not.toBeNull();
      if (host === null) return;

      await openToolboxCategory(page, '开始', 'start');
      await dragFromToolboxTo(page, 'start', { x: host.x + 300, y: host.y + 40 });
      const start = await findCanvasBlock(page, 'start', null);
      expect(start, '「开始」积木应当落到画布上').toBeDefined();
      if (start === undefined) return;

      await openToolboxCategory(page, '动作', 'action_step');
      const step = await connectFromToolbox(page, 'action_step', pickTopConn, start.id, async () => {
        const fresh = (await canvasBlocks(page)).find((block) => block.id === start.id) ?? start;
        const conn = pickBottomConn(fresh.conns);
        return conn === undefined ? null : connCenter(conn);
      });
      expect(step, 'step 积木应当接在「开始」下面').toBeDefined();
      if (step === undefined) return;

      // 字段是程序的一部分，恢复必须连字段一起回来。
      await editBlockField(page, step.id, 0, '7');
      expect((await blockFieldTexts(page, step.id)).join('')).toContain('7');
    });

    await test.step('用户手势之后画布立即落盘（05 §3.1 的键名归 D）', async () => {
      await expect
        .poll(() => page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CANVAS_KEY)})`), {
          timeout: 10_000,
          message: '改完积木应当把画布存进 localStorage',
        })
        .toContain('action_step');

      const stored = await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(SESSION_KEY)})`);
      expect(stored, '会话记录也要落盘').not.toBeNull();
      expect(JSON.parse(stored ?? '{}'), '会话记录里存的是服务端会话 id').toMatchObject({ sessionId });

      const keys = await page.evaluate<string[]>(`Object.keys(localStorage).sort()`);
      expect(keys, `localStorage 里应当有画布与会话两条记录，实际：${keys.join('、')}`).toEqual(
        expect.arrayContaining([CANVAS_KEY, SESSION_KEY]),
      );
    });

    await test.step('刷新（page.reload）后重新进题：画布与字段从存档装回来', async () => {
      await page.reload();
      // 刷新后回到题目列表——真实用户也是再点一次同一道题，恢复就发生在这一步。
      await expect(runButton(CHALLENGE_TITLE)).toBeVisible();
      await runButton(CHALLENGE_TITLE).click();
      await expect(runButton('编译'), '会话应当接回来了（编译按钮可用）').toBeEnabled();

      await expect
        .poll(() => canvasText(page), { timeout: 20_000, message: '刷新后画布上的积木应当还在' })
        .toContain('开始');
      const restored = await findCanvasBlock(page, 'action_step', undefined);
      expect(restored, 'step 积木应当被装回画布').toBeDefined();
      if (restored !== undefined) {
        expect((await blockFieldTexts(page, restored.id)).join(''), '字段值也要恢复').toContain('7');
      }
    });

    await test.step('恢复走的是「接回旧会话」：没有新的 POST /api/sessions', async () => {
      expect(createPosts, '刷新恢复不许偷偷新建会话').toBe(1);
      expect(sessionGets, '应当用 GET /api/sessions/:id 接回旧实例').toContain(`/api/sessions/${sessionId}`);
      expect(consoleErrors, '恢复过程不允许有 console error').toEqual([]);
    });
  });
});
