// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/app-shell';
import type { Pwn2BlockApp } from '../src/components/app-shell';
import { BLOCK_TYPES, MESSAGE_NO_START_BLOCK } from '../src/compiler/types';
import { MESSAGE_REPLAY_DISASM_STALE } from '../src/viewmodel/replay';
import { CHANGED_CODE_VMA, createFakeApi, makeReplay, makeSubmitResponse, type FakeApi } from './fake-api';
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

async function mountApp(api: FakeApi): Promise<Mounted> {
  const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
  app.api = api.client;
  document.body.append(app);
  apps.push(app);
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

afterEach(() => {
  for (const app of apps.splice(0)) app.remove();
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
    await until(() => app.renderRoot.querySelector('pwn2block-payload-panel') !== null, '会话就绪');
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

  it('拼出「开始 → step(1)」后点「编译」：程序区出现一行（走画布桥）', async () => {
    const { app } = await mountApp(createFakeApi());
    const workspace = panelOf(app).workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);

    // 程序化装载不会派发 Blockly 事件，所以必须走「编译」按钮自己调 recompile()（05 §3.1）。
    clickRun(app, '编译');
    await settle(app);

    expect(textOf(inPanel(app, 'pwn2block-program-view'))).toContain('step');
    expect(textOf(inPanel(app, 'pwn2block-output-view'))).not.toContain('编译失败');
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
    clickRun(app, '编译');
    await settle(app);

    const buttonOf = (label: string) => runButtons(app).find((each) => each.textContent?.trim() === label);
    expect(buttonOf('试运行')?.disabled).toBe(true);
    expect(buttonOf('单步')?.disabled).toBe(true);
    expect(buttonOf('运行 N 步')?.disabled).toBe(true);
    expect(buttonOf('重置')?.disabled).toBe(false);
    expect(buttonOf('提交判题')?.disabled).toBe(false);
    // 原因写在界面上，而不是只置灰（05 §6）。
    expect(textOf(runMenuOf(app))).toContain('程序已退出');
    expect(app.renderRoot.querySelector('.status')?.textContent).toContain('程序已经退出');

    // 点「单步」不会发请求：组件渲染与控制器门禁用的是同一张表（05 §1）。
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
    clickRun(mounted.app, '编译');
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
      projection: makeProjection({ status: 'satisfied', failures: 3, lastStop: { reason: 'step' } }),
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
