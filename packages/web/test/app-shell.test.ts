// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import type { CompiledAction } from '../src/compiler/types';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/app-shell';
import type { Pwn2BlockApp } from '../src/components/app-shell';
import type { CanvasPanelElement } from '../src/components/canvas-panel';
import { canvasStoreOf } from '../src/components/legacy-archive-bar';
import { ApiClientError } from '../src/api';
import { legacyArchiveNotice, scanLegacyArchives } from '../src/canvas/archive';
import { WORKFLOW_ORIGIN_VERSION, type WorkflowArtifact, type WorkflowIssue } from '../src/canvas/artifact';
import { canvasV2StorageKey, saveCanvas } from '../src/canvas/save';
import { MESSAGE_REPLAY_DISASM_STALE } from '../src/viewmodel/replay';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { sessionStorageKey } from '../src/viewmodel/storage';
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
 * 单页骨架的端到端接线：真实控制器 + 假后端 + 真实新版画布面板。
 *
 * 这个文件答的是「首屏有没有真的走接口」「画布事件 → 控制器 → 按钮门禁」这条主链在装配层面
 * 是否真的通，以及旧档提示条的两个出口；纯逻辑的单测在 `controller*.test.ts` / `toolbar.test.ts`。
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

/** 画布面板（新版）：`<pwn2block-canvas-panel>` 由页面壳渲染并传入题目对象。 */
function canvasPanelOf(app: Pwn2BlockApp): CanvasPanelElement {
  const panel = app.renderRoot.querySelector<CanvasPanelElement>('pwn2block-canvas-panel');
  if (panel === null) throw new Error('画布面板没渲染');
  return panel;
}

function legacyBarOf(app: Pwn2BlockApp): Element | null {
  return app.renderRoot.querySelector('pwn2block-legacy-archive-bar');
}

/** 提示条本体在子组件的影子根里：`[role="status"]` 就是那条可访问名称的来源。 */
function legacyStatusOf(app: Pwn2BlockApp): Element | null {
  return shadowOf(legacyBarOf(app))?.querySelector('[role="status"]') ?? null;
}

/** 输出区已经移到页面壳自己的影子根里（本批任务第 6 条），不再嵌在 payload 面板下面。 */
function outputOf(app: Pwn2BlockApp): Element | null {
  return app.renderRoot.querySelector('pwn2block-output-view');
}

/** 「运行」菜单只剩顶栏那一份，payload 窗口的新画布面板自带「运行」按钮。 */
function runMenuOf(app: Pwn2BlockApp): Element {
  const topBar = app.renderRoot.querySelector('pwn2block-top-bar');
  const menu = shadowOf(topBar)?.querySelector('pwn2block-run-menu') ?? null;
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

// ---------------------------------------------------------------------------
// 画布夹具：面板自己读档、自己编译，测试只伪造它对外的事件
// ---------------------------------------------------------------------------

/** 开始节点 + 一个值节点：能存档、能读回、编译也不失败（没有动作）。 */
function savedDocument(): canvas.CanvasDocument {
  return {
    ...canvas.emptyCanvasDocument(),
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'v1', kind: 'value', value: { kind: 'int', value: '7' } },
    ],
    main: ['start'],
    layout: { v1: { x: 40, y: 40 } },
  };
}

/** 把一份文档写进新版存档键（`pwn2block.canvas.v2.<题目>`），模拟「上次留下的程序」。 */
function seedCanvas(challengeId = 'ret2win', doc: canvas.CanvasDocument = savedDocument()): void {
  if (!saveCanvas(canvasStoreOf(localStorage), challengeId, doc)) throw new Error('画布存档没写进去');
}

/** 面板产物的最小形状：动作 + 与之一一对应的来源表（`nodeId` 就是画布节点 id）。 */
function artifactOf(actions: readonly CompiledAction[]): WorkflowArtifact {
  return {
    actions,
    origins: actions.map((_, index) => ({ index, nodeId: `node-${index}`, path: ['main'] })),
    originsVersion: WORKFLOW_ORIGIN_VERSION,
    previews: [],
    trace: [],
    documentRevision: 1,
  };
}

/** 伪造面板事件：detail 的形状由 `canvas-panel.ts` 的契约决定。 */
async function canvasEvent(app: Pwn2BlockApp, name: string, detail: unknown): Promise<void> {
  canvasPanelOf(app).dispatchEvent(new CustomEvent(name, { detail }));
  await settle(app);
}

/** 编译成功：面板编好了产物（外壳应当采用它，与旧 `p2b-graph-compiled` 同一入口）。 */
async function published(app: Pwn2BlockApp, actions: readonly CompiledAction[]): Promise<void> {
  await canvasEvent(app, 'p2b-canvas-compiled', { artifact: artifactOf(actions) });
}

/** 编译失败：错误列表进输出区。 */
async function compileFailed(app: Pwn2BlockApp, errors: readonly WorkflowIssue[]): Promise<void> {
  await canvasEvent(app, 'p2b-canvas-compile-failed', { errors });
}

function issueOf(message: string, nodeId: string): WorkflowIssue {
  return { code: 'invalid_param', severity: 'error', message, nodeId };
}

const STEP: readonly CompiledAction[] = [{ type: 'step', count: 1 }];

beforeEach(() => {
  window.history.replaceState(null, '', '/challenges/ret2win');
});

afterEach(() => {
  for (const app of apps.splice(0)) app.remove();
  // 本地保存走的是 jsdom 的真实 `localStorage`：用例之间必须清干净，
  // 否则上一条用例存的画布存档 / 会话记录会被下一条当成「上次的程序」恢复起来。
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('单页骨架：首屏与装配（05 §1）', () => {
  it('首屏走真实接口：题目列表 → 题目 → 会话，然后渲染视图管理器与 payload 窗口', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);

    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(app.renderRoot.querySelector('pwn2block-canvas-panel')).not.toBeNull();
    // 样例切换条已经删除：生产路径不再使用 fixtures/sample。
    expect(app.renderRoot.querySelector('.sample-bar')).toBeNull();
    expect(app.renderRoot.querySelector('.sample')).toBeNull();
    // 状态栏移到页面最底部、整行反显，带 role=status 与 aria-live=polite（09 §2）。
    const status = app.renderRoot.querySelector('p.status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    const text = status?.textContent?.trim() ?? '';
    expect(text.startsWith('DEBUG │')).toBe(true);
    // 第二段（状态文案）不能是空的——它才是播报的主要内容。
    const segments = text.split('│').map((segment) => segment.trim());
    expect(segments[1]?.length ?? 0).toBeGreaterThan(0);
  });

  it('画布元素换成 pwn2block-canvas-panel，题目对象传了进去，旧画布不再出现', async () => {
    const { app } = await mountApp(createFakeApi());
    // 旧画布（`graph-panel`）已经不在渲染树里：它只是下一步统一删除的遗留文件。
    expect(app.renderRoot.querySelector('pwn2block-graph-panel')).toBeNull();
    expect(app.renderRoot.querySelector('pwn2block-graph-canvas')).toBeNull();
    const panel = canvasPanelOf(app);
    expect(panel.challenge?.id).toBe('ret2win');
    // 面板自己从存档里读出的默认文档（只有开始节点），外壳不替它造文档。
    expect(panel.document?.nodes.map((node) => node.kind)).toEqual(['start']);
  });

  it('第一相位（题面已到、会话还没建好）就渲染状态栏，播报区从首次渲染起常驻（09 §2）', async () => {
    // 第一相位没有 Projection：`ip`/「动作 n/m」都没有意义，但状态栏必须已经在 DOM 里，
    // 否则屏幕阅读器在这一相位结束、第一份投影到达时听不到任何播报。用扣住 `createSession`
    // 的方式把应用冻在第一相位上观察。
    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCreate = api.client.createSession;
    api.client.createSession = (challengeId) => gate.then(() => originalCreate(challengeId));
    document.body.append(app);
    apps.push(app);

    await until(() => app.renderRoot.querySelector('p.status') !== null, '第一相位状态栏出现');
    await settle(app);

    // 此刻还没建会话，视图管理器不应该出现——确认真的停在第一相位，不是提前跑完了。
    expect(app.renderRoot.querySelector('pwn2block-view-manager')).toBeNull();
    // 画布必须在这一相位就挂上（05 §3.1 的「先画布、再会话」）。
    expect(app.renderRoot.querySelector('pwn2block-canvas-panel')).not.toBeNull();

    const status = app.renderRoot.querySelector('p.status');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    const text = status?.textContent?.trim() ?? '';
    expect(text.startsWith('DEBUG │')).toBe(true);
    expect(text.endsWith('动作 0/0')).toBe(true);

    release();
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);
  });

  it('区块按顺序排列：顶栏 → 题面 → main → 输出区 → 状态栏；状态栏在最底部', async () => {
    const { app } = await mountApp(createFakeApi());
    // Lit 把 static styles 注入的 <style> 标签排在最前面，不属于页面骨架本身。
    const children = [...app.renderRoot.children].filter((child) => child.tagName.toLowerCase() !== 'style');
    const tagNames = children.map((child) => child.tagName.toLowerCase());
    expect(tagNames).toEqual([
      'pwn2block-top-bar',
      'div', // .briefing
      'main',
      'section', // .output
      'p', // .status
    ]);
    const status = children[children.length - 1];
    expect(status?.classList.contains('status')).toBe(true);
  });

  it('没有产物时状态栏以「动作 0/0」结尾', async () => {
    const { app } = await mountApp(createFakeApi());
    const status = app.renderRoot.querySelector('p.status');
    expect(status?.textContent?.trim().endsWith('动作 0/0')).toBe(true);
  });

  it('多道题时停在选题界面，点题目才创建会话', async () => {
    window.history.replaceState(null, '', '/');
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
    // 等「会话建好了」而不是「payload 窗口出现了」：第一相位（题面 + 画布）就会渲染它。
    await until(() => api.calls.some((call) => call.method === 'createSession'), '会话就绪');
    await settle(app);
    expect(app.renderRoot.querySelector('pwn2block-canvas-panel')).not.toBeNull();
    expect(api.calls.find((call) => call.method === 'createSession')?.challengeId).toBe('b');
  });
});

describe('单页骨架：画布事件 → 控制器（阶段三）', () => {
  it('p2b-canvas-compiled：产物与来源表进控制器，提交时发的就是这份动作', async () => {
    const api = createFakeApi({
      submit: makeSubmitResponse('won', { flag: 'flag{demo}', results: [{ ok: true, action: 'step' }] }),
    });
    const { app } = await mountApp(api);
    await published(app, STEP);

    const artifact = app.state?.artifact.artifact;
    expect(artifact?.actions).toEqual([{ type: 'step', count: 1 }]);
    // 画布的 `nodeId` 在控制器口径里叫 `blockId`：定位与高亮都靠它。
    expect(artifact?.origins).toEqual([{ index: 0, blockId: 'node-0' }]);
    expect(app.state?.artifact.stale).toBe(false);
    // 状态栏的「动作 n/m」跟着产物走。
    expect(app.renderRoot.querySelector('.status')?.textContent).toContain('动作 0/1');

    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    expect(api.calls.find((call) => call.method === 'submit')?.actions).toEqual([{ type: 'step', count: 1 }]);
  });

  it('p2b-canvas-compile-failed：错误进输出区，产物被清空，运行与提交都被门禁拦住', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);
    await compileFailed(app, [issueOf('这个节点少了必填输入', 'r1')]);

    expect(app.state?.artifact.artifact).toBeUndefined();
    expect(app.state?.artifact.errors).toHaveLength(1);
    expect(textOf(outputOf(app))).toContain('这个节点少了必填输入');
    expect(textOf(runMenuOf(app))).toContain('编译失败');

    clickRun(app, '提交判题');
    await settle(app);
    expect(api.calls.some((call) => call.method === 'submit')).toBe(false);
  });

  it('p2b-canvas-changed：产物标记过期，运行被拒并说明「正在重新编译」', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);
    await published(app, STEP);
    expect(app.state?.artifact.stale).toBe(false);

    await canvasEvent(app, 'p2b-canvas-changed', { document: savedDocument(), revision: 2 });

    expect(app.state?.artifact.stale).toBe(true);
    const step = runButtons(app).find((button) => button.textContent?.trim() === '单步');
    expect(step?.disabled).toBe(true);
    expect(textOf(runMenuOf(app))).toContain(MESSAGE_STALE);

    // 过期产物不许运行：门禁在控制器里，按钮置灰只是它的镜像（05 §1 两处等价）。
    clickRun(app, '单步');
    await settle(app);
    expect(api.calls.some((call) => call.method === 'actions')).toBe(false);
  });

  it('p2b-canvas-run：先采用面板这份产物，再走既有的「运行」路径', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);
    // 面板挂上就编过默认文档：产物在，但一个动作都没有（所以「单步」不可用）。
    expect(app.state?.artifact.artifact?.actions).toEqual([]);

    await canvasEvent(app, 'p2b-canvas-run', { artifact: artifactOf(STEP) });
    await until(() => api.calls.some((call) => call.method === 'actions'), '运行请求发出');
    await until(() => app.state?.busy === false, '运行结束');

    // 采用的是面板刚编出来的那份（不是控制器手里那份旧的）。
    expect(app.state?.artifact.artifact?.actions).toEqual([{ type: 'step', count: 1 }]);
    const actionsCalls = api.calls.filter((call) => call.method === 'actions');
    expect(actionsCalls[0]?.actions).toEqual([{ type: 'reset' }]);
    expect(actionsCalls[1]?.actions).toEqual([{ type: 'step', count: 1 }]);
  });

  it('面板上的「运行」按钮走同一条路径（真实点击，不伪造事件）', async () => {
    const api = createFakeApi();
    const { app } = await mountApp(api);
    const runButton = shadowOf(canvasPanelOf(app))?.querySelector<HTMLButtonElement>('.btn-run');
    if (runButton === null || runButton === undefined) throw new Error('画布面板没有「运行」按钮');
    runButton.click();
    await until(() => api.calls.some((call) => call.method === 'actions'), '运行请求发出');
    await settle(app);
    expect(app.state?.artifact.artifact).toBeDefined();
  });

  it('locate() 转发给画布面板：编译错误自动定位到出错节点', async () => {
    const { app } = await mountApp(createFakeApi());
    const panel = canvasPanelOf(app);
    const locate = vi.spyOn(panel, 'locate');

    await compileFailed(app, [issueOf('不允许动作 push', 'push')]);
    expect(locate).toHaveBeenCalledWith('push');

    // 输出区的「定位积木」读的是同一个 id：点它仍然回跳画布。
    locate.mockClear();
    buttonsOf(outputOf(app))
      .find((button) => button.textContent?.trim() === '定位积木')
      ?.click();
    await settle(app);
    expect(locate).toHaveBeenCalledWith('push');
  });

  it('没有具体位置的编译错误（空节点 id）不给定位出口，也不把空串当节点 id', async () => {
    const { app } = await mountApp(createFakeApi());
    const locate = vi.spyOn(canvasPanelOf(app), 'locate');

    await compileFailed(app, [issueOf('画布上需要一个开始节点', '')]);
    expect(textOf(outputOf(app))).toContain('画布上需要一个开始节点');
    expect(buttonLabels(outputOf(app))).toEqual([]);
    expect(locate).not.toHaveBeenCalled();
  });
});

describe('单页骨架：旧档提示条（《节点画布大型修改》§8）', () => {
  const DEMO: PublicChallenge = { ...ret2winPublic, id: 'demo', title: '演示题' };
  const LEGACY_KEY = 'pwn2block.graph.v1.demo';
  const LEGACY_RAW = JSON.stringify({ format: 'pwn2block.workflow', version: 1, challengeId: 'demo' });

  /** 旧档提示条按题目 id 过滤（`pwn2block.graph.v1.demo` 只属于 `demo`），所以进题地址也要对上。 */
  function demoApi(): FakeApi {
    window.history.replaceState(null, '', '/challenges/demo');
    return createFakeApi({ challenges: [{ id: 'demo', title: '演示题' }], challenge: DEMO });
  }

  function storeLegacy(): void {
    localStorage.setItem(LEGACY_KEY, LEGACY_RAW);
  }

  const createObjectURL = vi.fn((blob: Blob) => `blob:pwn2block-${blob.size}`);
  const revokeObjectURL = vi.fn((url: string) => void url);

  beforeEach(() => {
    createObjectURL.mockClear();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
  });

  it('发现旧档时出现非模态提示条，文案来自 legacyArchiveNotice', async () => {
    storeLegacy();
    const { app } = await mountApp(demoApi());
    await settle(app);

    const expected = legacyArchiveNotice(scanLegacyArchives(canvasStoreOf(localStorage), 'demo'));
    const status = legacyStatusOf(app);
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-label')).toBe('旧版画布存档提示');
    expect(status?.textContent).toContain(expected.title);
    expect(status?.textContent).toContain('不会被自动迁移');
    expect(status?.textContent).toContain('导出旧存档');
  });

  it('没有旧档时不出现提示条', async () => {
    const { app } = await mountApp(createFakeApi());
    await settle(app);
    expect(legacyBarOf(app)).not.toBeNull();
    expect(legacyStatusOf(app)).toBeNull();
  });

  it('p2b-canvas-legacy：面板在 v2 键里读到旧档时，把它的说明原样贴到提示条上', async () => {
    const { app } = await mountApp(createFakeApi());
    await canvasEvent(app, 'p2b-canvas-legacy', {
      legacy: {
        reason: 'unsupported_format',
        message: '存档是旧版本格式：原文保留、没有覆盖',
        raw: '{"format":"pwn2block.workflow"}',
      },
    });
    // 外壳不解释、不改写：用户看到的是面板给出的那一句（§8 的「认出来、告诉用户」）。
    expect(legacyStatusOf(app)?.textContent).toContain('存档是旧版本格式：原文保留、没有覆盖');
  });

  it('点「导出旧存档」逐份下载原文，不抛错', async () => {
    storeLegacy();
    const { app } = await mountApp(demoApi());
    await settle(app);
    buttonsOf(legacyBarOf(app))
      .find((button) => button.textContent?.trim() === '导出旧存档')
      ?.click();
    await settle(app);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // 导出的内容就是原文：一字不改，才能原样喂回旧版本画布。
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(await blob?.text()).toBe(LEGACY_RAW);
    expect(legacyStatusOf(app)).not.toBeNull();
  });

  it('点「新建新版画布」要二次确认，确认后旧键被删、提示条消失', async () => {
    storeLegacy();
    const { app } = await mountApp(demoApi());
    await settle(app);

    buttonsOf(legacyBarOf(app))
      .find((button) => button.textContent?.trim() === '新建新版画布')
      ?.click();
    await settle(app);
    // 第一次点击只是换成确认：旧档还在。
    expect(localStorage.getItem(LEGACY_KEY)).toBe(LEGACY_RAW);

    buttonsOf(legacyBarOf(app))
      .find((button) => button.textContent?.trim().startsWith('确认丢弃'))
      ?.click();
    await settle(app);

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(legacyStatusOf(app)).toBeNull();
  });

  it('丢弃旧档不碰新版存档：v2 键与画布内容都还在', async () => {
    storeLegacy();
    // 新版存档先写进去，丢弃旧档后必须原样还在（两者键名与格式互不覆盖）。
    seedCanvas('demo');
    const { app } = await mountApp(demoApi());
    await settle(app);
    expect(canvasPanelOf(app).document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);

    buttonsOf(legacyBarOf(app))
      .find((button) => button.textContent?.trim() === '新建新版画布')
      ?.click();
    await settle(app);
    buttonsOf(legacyBarOf(app))
      .find((button) => button.textContent?.trim().startsWith('确认丢弃'))
      ?.click();
    await settle(app);

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(canvasV2StorageKey('demo'))).not.toBeNull();
    expect(canvasPanelOf(app).document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);
  });
});

describe('单页骨架：输出区改为通栏', () => {
  it('输出区在 main 之后、横跨整行，不嵌在右侧 payload 窗口里', async () => {
    const { app } = await mountApp(createFakeApi());
    const main = app.renderRoot.querySelector('main');
    const output = app.renderRoot.querySelector('section.output');
    expect(output).not.toBeNull();
    // 横跨整行：是 main 的下一个兄弟节点，不在 .right 容器内部。
    expect(main?.nextElementSibling).toBe(output);
    expect(app.renderRoot.querySelector('section.right pwn2block-output-view')).toBeNull();
    expect(outputOf(app)).toBe(output?.querySelector('pwn2block-output-view') ?? null);
  });

  it('输出区只有一个标题：名字来自页面壳的 section，输出组件里不再重复 h3', async () => {
    const { app } = await mountApp(createFakeApi());
    const output = app.renderRoot.querySelector('section.output');
    expect(output?.getAttribute('aria-label')).toBe('输出区');
    const title = [...(output?.children ?? [])].find((child) => child.classList.contains('box-title'));
    expect(title?.textContent?.trim()).toBe('输出');
    const root = outputOf(app)?.shadowRoot;
    expect(root).toBeInstanceOf(ShadowRoot);
    expect(root?.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    const live = root?.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.getAttribute('aria-label')).toBe('输出条目');
  });

  it('判题结果模式下输出区顶部有提示：这是调试实例的历史结果', async () => {
    const replay = makeReplay([{ kind: 'action', label: 'step' }]);
    const api = createFakeApi({
      submit: makeSubmitResponse('won', { flag: 'flag{demo}', results: [{ ok: true, action: 'step' }], replay }),
    });
    const { app } = await mountApp(api);
    await published(app, STEP);

    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const output = app.renderRoot.querySelector('section.output');
    expect(output?.querySelector('.mode-hint')?.textContent).toContain(
      '下面是调试实例的历史结果；这一轮判题的结论见上方横幅。',
    );
  });
});

describe('单页骨架：运行按钮的门禁（05 §3）', () => {
  it('Ctrl+↓ 切到下一个标签；焦点在影子根内输入框时不切', async () => {
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
    expect(manager.views.active).toBe('stack');
    const cycle = key();
    manager.dispatchEvent(cycle);
    await settle(app);
    expect(cycle.defaultPrevented).toBe(true);
    expect(manager.views.active).toBe('disasm');
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
    // 先编译出产物，排除「没有产物」这个同样会禁用执行按钮的原因。
    await published(app, STEP);

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
      expect(textOf(outputOf(app))).toContain(`「${action}」`);
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
    await published(app, STEP);

    const buttonOf = (label: string) => runButtons(app).find((each) => each.textContent?.trim() === label);
    expect(buttonOf('单步')?.disabled).toBe(true);
    expect(buttonOf('运行 N 步')?.disabled).toBe(true);
    // 回退类与提交不受影响（04 §1.1）。
    expect(buttonOf('重置')?.disabled).toBe(false);
    expect(buttonOf('提交判题')?.disabled).toBe(false);
    // 判负的文案必须与「已退出」不同：说「已退出」会让学习者找错方向（05 §6）。
    expect(textOf(runMenuOf(app))).toContain('已被判负');
    expect(textOf(runMenuOf(app))).not.toContain('程序已退出');

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
    await published(mounted.app, STEP);
    return mounted;
  }

  it('点「提交判题」切到判题结果：通过横幅与 flag，左侧视图改用录像帧', async () => {
    const { app } = await submitted();
    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

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
    expect(status?.textContent?.trim().startsWith('DEBUG │')).toBe(true);
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

describe('单页骨架：刷新后装回本地程序并接回会话（05 §3.1）', () => {
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
    seedCanvas();
    storeSession(0, 0);

    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    // 探针：会话请求发出的那一刻，画布上必须已经有恢复出来的节点（05 §3.1 的硬顺序）。
    // 探针只是包一层，真正的请求仍走假客户端（调用记录、响应形状都保持一致）。
    let nodesAtSessionFetch: readonly string[] = [];
    const originalSessionState = api.client.sessionState;
    api.client.sessionState = (sessionId) => {
      const probe = app.renderRoot.querySelector<CanvasPanelElement>('pwn2block-canvas-panel');
      nodesAtSessionFetch = probe?.document?.nodes.map((node) => node.id) ?? [];
      return originalSessionState(sessionId);
    };
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);

    // 没有新建会话：列表 → 题目 → 接回旧会话。
    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'sessionState']);
    expect(nodesAtSessionFetch).toEqual(['start', 'v1']);
    // 画布是恢复出来的内容，产物也编出来了（输出区没有编译错误，不是半恢复）。
    expect(canvasPanelOf(app).document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);
    expect(textOf(outputOf(app))).not.toContain('编译失败');
    // 接回成功不说废话（没有 notice）。
    expect(app.renderRoot.querySelector('.notice')).toBeNull();
    // 记录被刷新成当前产物条数：下一次刷新还接着走。
    expect(JSON.parse(localStorage.getItem(sessionStorageKey('ret2win')) ?? '{}')).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      actionsLength: 0,
    });
  });

  it('没有会话记录时照常新建会话，本地画布仍然先装回去（不是半恢复）', async () => {
    seedCanvas();

    const api = createFakeApi();
    const app = document.createElement('pwn2block-app') as Pwn2BlockApp;
    app.api = api.client;
    let nodesAtCreate: readonly string[] = [];
    const originalCreate = api.client.createSession;
    api.client.createSession = (challengeId) => {
      nodesAtCreate =
        app.renderRoot
          .querySelector<CanvasPanelElement>('pwn2block-canvas-panel')
          ?.document?.nodes.map((node) => node.id) ?? [];
      return originalCreate(challengeId);
    };
    document.body.append(app);
    apps.push(app);
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '视图管理器出现');
    await settle(app);

    expect(api.calls.map((call) => call.method)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(nodesAtCreate).toEqual(['start', 'v1']);
    expect(textOf(outputOf(app))).not.toContain('编译失败');
  });

  it('旧会话已被回收（404）：提示一句并新建，程序还在画布上', async () => {
    seedCanvas();
    storeSession(0, 0);

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
    expect(canvasPanelOf(app).document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);
    expect(textOf(outputOf(app))).not.toContain('编译失败');
  });
});

describe('单页骨架：判题被拒与回放时间线的可访问性（05 §6/§7）', () => {
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
    await published(mounted.app, [{ type: 'step', count: 1 }, { type: 'step', count: 1 }]);
    return mounted;
  }

  it('输出区标出被拒绝的那个动作，并定位到产生它的那个节点', async () => {
    const { app } = await rejected();
    const locate = vi.spyOn(canvasPanelOf(app), 'locate');

    clickRun(app, '提交判题');
    await until(() => app.renderRoot.querySelector('pwn2block-verdict-panel') !== null, '判题面板出现');
    await settle(app);

    const verdict = app.renderRoot.querySelector('pwn2block-verdict-panel');
    expect(textOf(verdict)).toContain('动作被拒绝');
    expect(textOf(verdict)).toContain('第 2 个动作 step 被拒绝');
    // 被拒绝的动作对应录像里那一帧：默认选中它。
    expect(shadowOf(verdict)?.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('2');

    // 判题那份来源表 index 1 → 画布节点 `node-1`：新画布没有高亮属性，定位走 `locate()`。
    expect(locate).toHaveBeenCalledWith('node-1');
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
    expect(app.renderRoot.querySelector('pwn2block-canvas-panel')).toBeNull();
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
    seedCanvas();
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
    const panel = canvasPanelOf(app);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);
    expect(app.renderRoot.querySelector('.boot')).toBeNull();
    expect(app.renderRoot.querySelector('.left')?.textContent).toContain('暂时开不了新会话');
    expect(app.renderRoot.querySelector('.notice')?.textContent).toContain('请求过于频繁');
    const buttons = runButtons(app);
    // 顶栏菜单六个按钮：「运行 / 终止」在画布面板与控制器里，不在这个菜单里。
    expect(buttons).toHaveLength(6);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    app.renderRoot.querySelector<HTMLButtonElement>('.notice button')?.click();
    await until(() => app.renderRoot.querySelector('pwn2block-view-manager') !== null, '重试恢复会话');
    await settle(app);
    expect(canvasPanelOf(app)).toBe(panel);
    expect(app.renderRoot.querySelector('.notice')).toBeNull();
    expect(runButtons(app).find((button) => button.textContent?.trim() === '重置')?.disabled).toBe(false);
    expect(api.calls.map((call) => call.method)).toEqual([
      'listChallenges', 'getChallenge', 'createSession', 'getChallenge', 'createSession',
    ]);
  });
});
