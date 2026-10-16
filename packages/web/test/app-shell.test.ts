// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/app-shell';
import type { Pwn2BlockApp } from '../src/components/app-shell';
import { ApiClientError } from '../src/api';
import { mountBlockly } from '../src/blocks/mount';
import { BLOCK_TYPES, MESSAGE_ACTION_NOT_ALLOWED, MESSAGE_NO_START_BLOCK } from '../src/compiler/types';
import { MESSAGE_REPLAY_DISASM_STALE } from '../src/viewmodel/replay';
import { canvasStorageKey, sessionStorageKey } from '../src/viewmodel/storage';
import {
  CHANGED_CODE_VMA,
  createFakeApi,
  FAKE_SESSION_ID,
  makeReplay,
  makeSubmitResponse,
  type FakeApi,
} from './fake-api';
import { makeProjection } from './helpers';

/**
 * 单页骨架的端到端接线（D02）：真实控制器 + 假后端 + 真实 Blockly。
 *
 * 这个文件答的是「首屏有没有真的走接口」「积木改动 → 过期 → 提交 → 判题模式 → 回到调试」
 * 这条主链在装配层面是否真的通——纯逻辑的单测在 `controller.test.ts` / `toolbar.test.ts` 里。
 */

const apps: Pwn2BlockApp[] = [];

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`等待超时：${label}`);
}

async function settle(app: Pwn2BlockApp, times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await app.updateComplete;
    await Promise.resolve();
  }
}

interface Mounted {
  readonly app: Pwn2BlockApp;
  readonly api: FakeApi;
}

function startApp(api: FakeApi): Pwn2BlockApp {
  const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
  app.api = api.client;
  document.body.append(app);
  apps.push(app);
  return app;
}

async function mountApp(api: FakeApi): Promise<Mounted> {
  const app = startApp(api);
  await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
  await settle(app);
  return { app, api };
}

/** 影子根读取器：`querySelector` 不穿影子根，所以每一层都要从各自的 `renderRoot` 往下找。 */
function shadowOf(element: Element | null | undefined): ShadowRoot | undefined {
  return (element as { readonly renderRoot?: ShadowRoot } | null | undefined)?.renderRoot;
}

function panelOf(app: Pwn2BlockApp) {
  const panel = app.renderRoot.querySelector('pwn2block-payload-panel');
  if (panel === null) throw new Error('payload 面板没渲染');
  return panel;
}

function inPanel(app: Pwn2BlockApp, selector: string): Element | null {
  return shadowOf(panelOf(app))?.querySelector(selector) ?? null;
}

function runMenuOf(app: Pwn2BlockApp): Element {
  const menu = inPanel(app, 'pwn2block-run-menu');
  if (menu === null) throw new Error('运行菜单没渲染');
  return menu;
}

function runButtons(app: Pwn2BlockApp): HTMLButtonElement[] {
  return [...(shadowOf(runMenuOf(app))?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
}

/** 按可见文字点运行菜单里的按钮（真实点击路径：按钮 → p2b-run → 控制器）。 */
function clickRun(app: Pwn2BlockApp, label: string): void {
  const button = runButtons(app).find((each) => each.textContent?.trim() === label);
  if (button === undefined) throw new Error(`没找到运行按钮：${label}`);
  button.click();
}

function disasmOf(app: Pwn2BlockApp): Element | null {
  const manager = app.renderRoot.querySelector('pwn2block-view-manager');
  return shadowOf(manager)?.querySelector('pwn2block-disasm-view') ?? null;
}

function textOf(element: Element | null | undefined): string {
  return shadowOf(element)?.textContent ?? '';
}

function buttonsOf(element: Element | null | undefined): HTMLButtonElement[] {
  return [...(shadowOf(element)?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
}

function buttonLabels(element: Element | null | undefined): readonly string[] {
  return buttonsOf(element).map((button) => button.textContent?.trim() ?? '');
}

/** Blockly 没有公开的高亮读取接口，读它自己记录的运行时数组（同 `payload-panel.test.ts`）。 */
function highlightedIds(workspace: Blockly.WorkspaceSvg): readonly string[] {
  const internal = workspace as unknown as { readonly highlightedBlocks: readonly Blockly.Block[] };
  return internal.highlightedBlocks.map((block) => block.id);
}

/** 把「开始 → 给定积木」接起来；返回接在开始积木下面的那块。 */
function chainAfterStart(workspace: Blockly.WorkspaceSvg, types: readonly string[]): readonly Blockly.Block[] {
  const start = workspace.newBlock(BLOCK_TYPES.start);
  let previous = start;
  const blocks: Blockly.Block[] = [];
  for (const type of types) {
    const block = workspace.newBlock(type);
    const next = previous.nextConnection;
    const before = block.previousConnection;
    if (next === null || before === null) throw new Error('语句连接不存在：定义有误');
    next.connect(before);
    blocks.push(block);
    previous = block;
  }
  return blocks;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.remove();
  // 本地保存走的是 jsdom 的真实 `localStorage`（D5 批次 2），用例之间必须清干净：
  // 否则上一条用例存的画布存档/会话记录会被下一条当成「上次的程序」恢复起来。
  localStorage.clear();
});

describe('单页骨架：首屏与装配（05 §1）', () => {
  it('首屏走真实接口：题目列表 → 题目 → 会话，然后渲染视图管理器与 payload 窗口', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);

    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(app.renderRoot.querySelector('pwn2block-payload-panel')).not.toBeNull();
    // 样例切换条已经删除：生产路径不再使用 fixtures/sample（本批任务第 7 条）。
    expect(app.renderRoot.querySelector('.sample-bar')).toBeNull();
    expect(app.renderRoot.querySelector('.sample')).toBeNull();
    // 状态行说明当前模式，且带符号与文字（05 §7：颜色不是唯一信息载体）。
    const status = app.renderRoot.querySelector('.status');
    expect(status?.textContent).toContain('调试模式');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('多道题时停在选题界面，点题目才创建会话', async () => {
    const api = createFakeApi({
      challenges: [
        { id: 'a', title: '题目 A' },
        { id: 'b', title: '题目 B' },
      ],
    });
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.textContent?.includes('题目 B') ?? false, '选题列表出现');
    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges']);

    const button = [...app.renderRoot.querySelectorAll<HTMLButtonElement>('.boot button')].find(
      (each) => each.textContent?.trim() === '题目 B',
    );
    if (button === undefined) throw new Error('没找到题目按钮');
    button.click();
    // 等「会话建好了」而不是「payload 窗口出现了」：D5 批次 2 起，第一相位（题面 + 画布）
    // 就会渲染 payload 窗口，用它当就绪信号会等到 createSession 之前。
    await until(() => api.calls.some((call) => call.method === 'createSession'), '会话就绪');
    await settle(app);
    expect(app.renderRoot.querySelector('pwn2block-payload-panel')).not.toBeNull();
    expect(api.calls.find((call) => call.method === 'createSession')?.challengeId).toBe('b');
  });
});

describe('单页骨架：编译与运行按钮的门禁（05 §3）', () => {
  it('空画布编译：错误逐条进输出区，提交被判门禁拦住', async () => {
    const { app, api } = await mountApp(createFakeApi());
    panelOf(app).recompile();
    await settle(app);

    const output = inPanel(app, 'pwn2block-output-view');
    expect(textOf(output)).toContain('编译失败');
    expect(textOf(output)).toContain(MESSAGE_NO_START_BLOCK);

    clickRun(app, '提交判题');
    await settle(app);
    // 没有产物：控制器与按钮都不放行，且一个请求都没发出去。
    expect(api.calls.some((call) => call.method === 'submit')).toBe(false);
    expect(textOf(runMenuOf(app))).toContain('编译失败');
  });

  it('拼出「开始 → step(1)」后编译成功：输出区没有错误（走画布桥）', async () => {
    const { app } = await mountApp(createFakeApi());
    const workspace = panelOf(app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);

    // 程序化装载不会派发 Blockly 事件，所以必须自己调 recompile()（05 §3.1）。
    panelOf(app).recompile();
    await settle(app);

    expect(textOf(inPanel(app, 'pwn2block-output-view'))).not.toContain('编译失败');
  });

  it('Ctrl+方向键在视图内切换，但不抢走影子根内输入框的按键', async () => {
    const { app } = await mountApp(createFakeApi());
    const manager = app.renderRoot.querySelector('pwn2block-view-manager');
    const stack = manager?.renderRoot.querySelector('pwn2block-stack-view');
    const input = stack?.renderRoot.querySelector('input');
    if (!manager || !input) throw new Error('视图未挂载');
    const key = () => new KeyboardEvent('keydown', {
      key: 'ArrowDown', ctrlKey: true, bubbles: true, composed: true, cancelable: true,
    });
    const typing = key();
    input.dispatchEvent(typing);
    await settle(app);
    expect(typing.defaultPrevented).toBe(false);
    expect(manager.views.offset).toBe(0);
    manager.dispatchEvent(key());
    await settle(app);
    expect(manager.views.offset).toBe(1);
  });

  it('调试实例已退出（satisfied + lastStop exit）：执行类按钮禁用并写出原因，提交与回退仍可用', async () => {
    // 判胜那一刻程序已经结束：status 是 satisfied，退出事实只在 lastStop 上（04 §1.1）。
    const api = createFakeApi({
      projection: makeProjection({
        status: 'satisfied',
        steps: 12,
        lastStop: { reason: 'exit', addr: '0x400003' },
      }),
    });
    const { app } = await mountApp(api);
    const workspace = panelOf(app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);
    // 先编译出产物，排除「没有产物」这个同样会禁用执行按钮的原因。
    // 程序化装载不会派发 Blockly 事件，所以自己调 recompile()（编译不再是按钮）。
    panelOf(app).recompile();
    await settle(app);

    const buttonOf = (label: string) => runButtons(app).find((each) => each.textContent?.trim() === label);
    expect(buttonOf('单步')?.disabled).toBe(true);
    expect(buttonOf('运行 N 步')?.disabled).toBe(true);
    expect(buttonOf('重置')?.disabled).toBe(false);
    expect(buttonOf('提交判题')?.disabled).toBe(false);
    // 原因写在界面上，而不是只置灰（05 §6）。
    expect(textOf(runMenuOf(app))).toContain('程序已退出');
    expect(app.renderRoot.querySelector('.status')?.textContent).toContain('程序已经退出');
    for (const action of ['后退一步', '撤销', '重置', '提交判题']) {
      expect(app.renderRoot.querySelector('.status')?.textContent).toContain(`「${action}」`);
      expect(textOf(inPanel(app, 'pwn2block-output-view'))).toContain(`「${action}」`);
    }

    // 点「单步」不会发请求：组件渲染与控制器门禁用的是同一张表（05 §1）。
    clickRun(app, '单步');
    await settle(app);
    expect(api.calls.some((call) => call.method === 'actions')).toBe(false);
  });

  it('调试实例已判负（status failed）：执行类按钮禁用且原因写「判负」，点击不发请求', async () => {
    const api = createFakeApi({
      projection: makeProjection({
        status: 'failed',
        steps: 7,
        error: { code: 'memory_fault', message: '访问了未映射的地址' },
        lastStop: { reason: 'exception', addr: '0x400001' },
      }),
    });
    const { app } = await mountApp(api);
    const workspace = panelOf(app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);
    panelOf(app).recompile();
    await settle(app);

    const buttonOf = (label: string) => runButtons(app).find((each) => each.textContent?.trim() === label);
    expect(buttonOf('单步')?.disabled).toBe(true);
    expect(buttonOf('运行 N 步')?.disabled).toBe(true);
    // 回退类与提交不受影响（04 §1.1）：回退类的深度判定见 controller 的用例，
    // 这里只断言它们不是因为「判负」而被禁（重置与提交与终止态无关）。
    expect(buttonOf('重置')?.disabled).toBe(false);
    expect(buttonOf('提交判题')?.disabled).toBe(false);
    // 判负的文案必须与「已退出」不同：说「已退出」会让学习者找错方向（05 §6）。
    expect(textOf(runMenuOf(app))).toContain('已被判负');
    expect(textOf(runMenuOf(app))).not.toContain('程序已退出');

    // 执行类按钮点了也不发请求（「运行」先 reset，不受终止态限制，见 controller-run.test.ts）。
    clickRun(app, '单步');
    await settle(app);
    expect(api.calls.some((call) => call.method === 'actions')).toBe(false);
  });
});

describe('单页骨架：提交判题与「回到调试」（05 §6）', () => {
  async function submitted(): Promise<Mounted> {
    const replay = makeReplay([{ kind: 'action', label: 'step', changedVmas: [CHANGED_CODE_VMA] }]);
    const api = createFakeApi({
      submit: makeSubmitResponse('won', { flag: 'flag{demo}', results: [{ ok: true, action: 'step' }], replay }),
    });
    const mounted = await mountApp(api);
    const workspace = panelOf(mounted.app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);
    panelOf(mounted.app).recompile();
    await settle(mounted.app);
    return mounted;
  }

  it('点「提交判题」切到判题结果：通过横幅与 flag，左侧视图改用录像帧', async () => {
    const { app, api } = await submitted();
    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const submitCall = api.calls.find((call) => call.method === 'submit');
    expect(submitCall?.actions).toEqual([{ type: 'step', count: 1 }]);

    const verdict = app.renderRoot.querySelector('pwn2block-verdict-panel');
    expect(textOf(verdict)).toContain('通过');
    expect(textOf(verdict)).toContain('flag{demo}');
    expect(shadowOf(verdict)?.querySelector('input[type="range"]')).not.toBeNull();

    // 判题模式的视图读的是录像帧：这一帧改写了代码段 → 指令视图必须报不可用（09 §3.4）。
    expect(textOf(disasmOf(app))).toContain(MESSAGE_REPLAY_DISASM_STALE);
  });

  it('「回到调试」回到调试实例：视图换回调试投影，指令视图恢复可用', async () => {
    const { app } = await submitted();
    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const verdict = app.renderRoot.querySelector('pwn2block-verdict-panel');
    const back = buttonsOf(verdict).find((button) => button.textContent?.trim() === '回到调试');
    if (back === undefined) throw new Error('没找到「回到调试」按钮');
    back.click();
    await settle(app);

    const status = app.renderRoot.querySelector('.status');
    expect(status?.textContent).toContain('调试模式');
    expect(textOf(disasmOf(app))).not.toContain(MESSAGE_REPLAY_DISASM_STALE);
  });
  it('判题结果模式下调试按钮禁用并说明原因，提交仍然可用（提交不限次数）', async () => {
    const { app } = await submitted();
    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const submit = runButtons(app).find((button) => button.textContent?.trim() === '提交判题');
    const step = runButtons(app).find((button) => button.textContent?.trim() === '单步');
    expect(submit?.disabled).toBe(false);
    expect(step?.disabled).toBe(true);
    expect(textOf(runMenuOf(app))).toContain('回到调试');
  });

  it('题面面板拿到题目的 hints 与调试实例的 failures：达标条目自动解锁（05 §5）', async () => {
    // failures 是调试实例的：判题结果模式里也不许拿录像的帧去覆盖它（05 §5、§6）。
    const api = createFakeApi({
      projection: makeProjection({ status: 'satisfied', failures: 3 }),
    });
    const { app } = await mountApp(api);

    const panel = app.renderRoot.querySelector('pwn2block-briefing-panel');
    const root = shadowOf(panel);
    expect(root).toBeDefined();
    // ret2win 的第 3 条提示带 unlockAfterFailures: 3：failures 达标 ⇒ 三条一起揭示。
    expect(root?.querySelectorAll('li .text')).toHaveLength(3);
    expect(root?.querySelectorAll('.tag')).toHaveLength(3);
    expect(root?.querySelector('[role="status"]')?.textContent).toContain('自动解锁第 1、2、3 条提示');
  });
});

describe('单页骨架：编译错误 → 出错积木的定位（D5 ②，05 §4）', () => {
  it('画布高亮与输出区条目指向同一块积木，点定位按钮能重新高亮', async () => {
    const { app } = await mountApp(createFakeApi());
    const workspace = panelOf(app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    // ret2win 的 allowedActions 里没有 push：这块积木一定编译失败，且错误带得到它的 id。
    const [push] = chainAfterStart(workspace, [BLOCK_TYPES.actionPush]);

    panelOf(app).recompile();
    await settle(app);

    // ① 输出区：错误逐条列出，条目带定位出口。
    const output = inPanel(app, 'pwn2block-output-view');
    expect(textOf(output)).toContain(MESSAGE_ACTION_NOT_ALLOWED('push'));
    expect(buttonLabels(output)).toEqual(['定位积木']);

    // ② 画布：出错积木被自动高亮（第一条可定位的错误）。
    expect(highlightedIds(workspace)).toEqual([push?.id]);

    // 手动清掉高亮后点输出区的定位按钮：同一块积木又被点亮——两处读的是同一个 id。
    workspace.highlightBlock(null);
    expect(highlightedIds(workspace)).toEqual([]);
    buttonsOf(output)
      .find((button) => button.textContent?.trim() === '定位积木')
      ?.click();
    await settle(app);
    expect(highlightedIds(workspace)).toEqual([push?.id]);
  });

  it('没有具体位置的编译错误（缺开始积木）不给定位出口，也不把空串当积木 id', async () => {
    const { app } = await mountApp(createFakeApi());
    panelOf(app).recompile();
    await settle(app);

    expect(textOf(inPanel(app, 'pwn2block-output-view'))).toContain(MESSAGE_NO_START_BLOCK);
    expect(buttonLabels(inPanel(app, 'pwn2block-output-view'))).toEqual([]);
  });
});

/** 用真实画布编一份存档（存档格式归 H，测试不手写序列化内容）。 */
function archiveWithStep(): Record<string, unknown> {
  const host = document.createElement('div');
  document.body.append(host);
  const bridge = mountBlockly(host, ret2winPublic);
  const workspace = bridge.workspace;
  if (workspace === undefined) throw new Error('画布没挂上');
  chainAfterStart(workspace, [BLOCK_TYPES.actionStep]);
  const archive = bridge.save();
  bridge.dispose();
  host.remove();
  return archive;
}

describe('单页骨架：刷新后装回本地程序并接回会话（D5 批次 2，05 §3.1）', () => {
  /** 画布上的积木类型（不含影子积木：`action_step` 的计数输入是影子块，不是用户拼的）。 */
  function blockTypesOf(app: Pwn2BlockApp): readonly (string | undefined)[] {
    return (
      panelOf(app)
        .workspace?.getAllBlocks(false)
        .filter((block) => !block.isShadow())
        .map((block) => block.type) ?? []
    );
  }

  function storeSession(cursor: number, actionsLength: number): void {
    localStorage.setItem(
      sessionStorageKey('ret2win'),
      JSON.stringify({
        sessionId: FAKE_SESSION_ID,
        cursor,
        results: cursor === 0 ? [] : [{ ok: true, action: 'step' }],
        actionsLength,
      }),
    );
  }

  it('刷新：先装回画布，再 GET /api/sessions/:id；编译产物立刻就位', async () => {
    localStorage.setItem(canvasStorageKey('ret2win'), JSON.stringify(archiveWithStep()));
    storeSession(1, 1);

    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    // 探针：会话请求发出的那一刻，画布上必须已经有恢复出来的积木（05 §3.1 的硬顺序）。
    // 探针只是包一层，真正的请求仍走假客户端（调用记录、响应形状都保持一致）。
    let typesAtSessionFetch: readonly (string | undefined)[] = [];
    const originalSessionState = api.client.sessionState;
    api.client.sessionState = (sessionId) => {
      const probe = app.renderRoot.querySelector('pwn2block-payload-panel');
      typesAtSessionFetch =
        probe?.workspace
          ?.getAllBlocks(false)
          .filter((block) => !block.isShadow())
          .map((block) => block.type) ?? [];
      return originalSessionState(sessionId);
    };
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);

    // 没有新建会话：列表 → 题目 → 接回旧会话。
    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'sessionState']);
    expect(typesAtSessionFetch).toEqual([BLOCK_TYPES.start, BLOCK_TYPES.actionStep]);
    // 画布是恢复出来的内容，产物也编出来了（输出区没有编译错误，不是半恢复）。
    expect(blockTypesOf(app)).toEqual([BLOCK_TYPES.start, BLOCK_TYPES.actionStep]);
    expect(textOf(inPanel(app, 'pwn2block-output-view'))).not.toContain('编译失败');
    // 接回成功不说废话（没有 notice）。
    expect(app.renderRoot.querySelector('.notice')).toBeNull();
    // 记录被刷新成当前状态：下一次刷新还接着走。
    expect(JSON.parse(localStorage.getItem(sessionStorageKey('ret2win')) ?? '{}')).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      actionsLength: 1,
    });
  });

  it('没有会话记录时照常新建会话，本地画布仍然先装回去（不是半恢复）', async () => {
    localStorage.setItem(canvasStorageKey('ret2win'), JSON.stringify(archiveWithStep()));

    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    let typesAtCreate: readonly (string | undefined)[] = [];
    const originalCreate = api.client.createSession;
    api.client.createSession = (challengeId) => {
      typesAtCreate =
        app.renderRoot
          .querySelector('pwn2block-payload-panel')
          ?.workspace?.getAllBlocks(false)
          .filter((block) => !block.isShadow())
          .map((block) => block.type) ?? [];
      return originalCreate(challengeId);
    };
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);

    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(typesAtCreate).toEqual([BLOCK_TYPES.start, BLOCK_TYPES.actionStep]);
    expect(textOf(inPanel(app, 'pwn2block-output-view'))).not.toContain('编译失败');
  });

  it('旧会话已被回收（404）：提示一句并新建，程序还在画布上', async () => {
    localStorage.setItem(canvasStorageKey('ret2win'), JSON.stringify(archiveWithStep()));
    storeSession(0, 1);

    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    // 让这一次接回会话返回 404：只在**这个请求**上下毒（`failNext` 会被紧随其后的 settle 消费）。
    const originalSessionState = api.client.sessionState;
    api.client.sessionState = (sessionId) => {
      api.failNext(
        new ApiClientError('session_expired', '会话不存在', { status: 404, sessionExpired: true }),
      );
      return originalSessionState(sessionId);
    };
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);

    expect(api.calls.map((call) => call.method)).toEqual([
      'listChallenges',
      'getChallenge',
      'sessionState',
      'createSession',
    ]);
    const notice = app.renderRoot.querySelector('.notice');
    expect(notice?.textContent).toContain('本地保存的程序还在');
    expect(textOf(inPanel(app, 'pwn2block-output-view'))).not.toContain('编译失败');
  });
});

describe('单页骨架：判题被拒与回放时间线的可访问性（D5 ③，05 §6/§7）', () => {
  async function rejected(): Promise<Mounted> {
    const replay = makeReplay([
      { kind: 'action', label: 'step', status: 'ready' },
      { kind: 'action', label: 'step', status: 'failed', error: { code: 'invalid_ip', message: '指令指针越界' } },
    ]);
    const api = createFakeApi({
      submit: makeSubmitResponse('rejected', {
        executed: 1,
        results: [
          { ok: true, action: 'step' },
          {
            ok: false,
            action: 'step',
            error: { code: 'invalid_ip', message: '指令指针越界', note: '看看 ret 弹到哪去' },
          },
        ],
        replay,
      }),
    });
    const mounted = await mountApp(api);
    const workspace = panelOf(mounted.app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    chainAfterStart(workspace, [BLOCK_TYPES.actionStep, BLOCK_TYPES.actionStep]);
    panelOf(mounted.app).recompile();
    await settle(mounted.app);
    return mounted;
  }

  it('输出区标出被拒绝的那个动作，并高亮产生它的那块积木', async () => {
    const { app } = await rejected();
    const workspace = panelOf(app).workspace;
    const blocks = [...(workspace?.getAllBlocks(false) ?? [])].filter(
      (block) => block.type === BLOCK_TYPES.actionStep,
    );
    const second = blocks[1];
    if (workspace === undefined || second === undefined) throw new Error('画布上应有两块 step 积木');

    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const verdict = app.renderRoot.querySelector('pwn2block-verdict-panel');
    expect(textOf(verdict)).toContain('动作被拒绝');
    expect(textOf(verdict)).toContain('第 2 个动作 step 被拒绝');
    // 被拒绝的动作对应录像里那一帧：默认选中它。
    expect(shadowOf(verdict)?.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('2');

    // 画布高亮的是产生被拒动作的那块积木（来源表 index 1）：没有程序区之后，
    // 画布高亮是唯一的定位线索，颜色之外判题面板的文字已经说明是哪一步被拒绝（05 §7）。
    expect(highlightedIds(workspace)).toEqual([second.id]);
  });

  it('回放时间线的箭头按钮有可读的名字，range 带 aria-valuetext', async () => {
    const { app } = await rejected();
    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const verdict = app.renderRoot.querySelector('pwn2block-verdict-panel');
    const timeline = [...buttonsOf(verdict)];
    const prev = timeline.find((button) => button.getAttribute('aria-label') === '上一帧');
    const next = timeline.find((button) => button.getAttribute('aria-label') === '下一帧');
    // 箭头只有 ◀ / ▶ 一个字符，必须另有可读的名字（05 §7）。
    expect(prev?.textContent?.trim()).toBe('◀');
    expect(next?.textContent?.trim()).toBe('▶');
    // 位置 2 是最后一帧：首尾禁箭头。
    expect(next?.disabled).toBe(true);
    expect(prev?.disabled).toBe(false);

    const range = shadowOf(verdict)?.querySelector<HTMLInputElement>('input[type="range"]');
    expect(range?.getAttribute('aria-valuetext')).toContain('已执行');
  });
});


describe('启动失败的两种布局与重试（D5 观察）', () => {
  it('题目列表不可用：显示失败页，重试后进入工作台', async () => {
    const api = createFakeApi();
    api.failNext(new ApiClientError('internal', '无法连接服务器', { network: true }));
    const app = startApp(api);
    await until(() => app.renderRoot.querySelector('.notice button') !== null, '重试出口');
    await settle(app);
    expect(app.renderRoot.querySelector('.boot')?.textContent).toContain('暂时开不了新会话');
    expect(app.renderRoot.querySelector('pwn2block-payload-panel')).toBeNull();
    const retry = app.renderRoot.querySelector<HTMLButtonElement>('.notice button');
    expect(retry?.textContent).toContain('重试');
    retry?.click();
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '重试进入工作台');
    await settle(app);
    expect(app.renderRoot.querySelector('.notice')).toBeNull();
    expect(api.calls.map((call) => call.method)).toEqual([
      'listChallenges', 'listChallenges', 'getChallenge', 'createSession',
    ]);
  });

  it('建会话限流：保留已恢复的画布，运行按钮禁用，重试后原画布继续使用', async () => {
    localStorage.setItem(canvasStorageKey('ret2win'), JSON.stringify(archiveWithStep()));
    const api = createFakeApi();
    const create = api.client.createSession;
    let attempts = 0;
    api.client.createSession = (id) => {
      if (attempts++ === 0) {
        api.failNext(new ApiClientError('rate_limited', '同一来源的会话数已达上限', { status: 429 }));
      }
      return create(id);
    };
    const app = startApp(api);
    await until(() => app.renderRoot.querySelector('.notice button') !== null, '限流后的重试出口');
    await settle(app);
    const panel = panelOf(app);
    const workspace = panel.workspace;
    expect(workspace).toBeDefined();
    expect(app.renderRoot.querySelector('.boot')).toBeNull();
    expect(app.renderRoot.querySelector('.left')?.textContent).toContain('暂时开不了新会话');
    expect(app.renderRoot.querySelector('.notice')?.textContent).toContain('请求过于频繁');
    const buttons = runButtons(app);
    // 顶栏菜单六个按钮：编译与试运行已删除，「运行 / 终止」由 payloadControls 单独给出。
    expect(buttons).toHaveLength(6);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(workspace?.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.actionStep);
    const ids = workspace?.getAllBlocks(false).map((block) => block.id);
    app.renderRoot.querySelector<HTMLButtonElement>('.notice button')?.click();
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '重试恢复会话');
    await settle(app);
    expect(panelOf(app)).toBe(panel);
    expect(panelOf(app).workspace).toBe(workspace);
    expect(workspace?.getAllBlocks(false).map((block) => block.id)).toEqual(ids);
    expect(app.renderRoot.querySelector('.notice')).toBeNull();
    expect(runButtons(app).find((button) => button.textContent?.trim() === '重置')?.disabled).toBe(false);
    expect(api.calls.map((call) => call.method)).toEqual([
      'listChallenges', 'getChallenge', 'createSession', 'getChallenge', 'createSession',
    ]);
  });
});
