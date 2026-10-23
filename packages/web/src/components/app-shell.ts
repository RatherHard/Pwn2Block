/**
 * 单页骨架（05 §1）：顶部运行菜单 + 模式切换，题面面板可折叠，左半标签式视图，
 * 右半 payload 窗口（**新版画布** `<pwn2block-canvas-panel>`）+ 旧档提示条，下方输出区。
 *
 * 数据来源是真实后端：首屏走 `GET /api/challenges`，选定题目后创建会话，之后每个响应
 * 都把完整投影交给 `applyProjection`。**生产代码不再 import `fixtures/sample`**。
 *
 * 两种模式共用同一套视图，只是数据源不同（05 §1）：调试模式读 `page.projection`，
 * 判题结果读 `frameProjection(replay, position)`（录像里选中的那一帧）。
 *
 * 这个组件只做装配：状态在控制器里，纯逻辑在 `viewmodel/**`，渲染在各自的小组件里。
 * 画布面板自己读档、防抖存档、编译；外壳只把它的四类事件接到控制器上，并负责旧档提示。
 */
import { LitElement, css, html } from 'lit';
import type { Hint, Projection, PublicChallenge, WorkflowIssue } from '@pwn2block/shared';
import { createApiClient, type ApiClient } from '../api';
import type { CanvasStore } from '../canvas/save';
import type { ActionOrigin, CompileError } from '../compiler/types';
import { createViewContext } from '../viewmodel/context';
import {
  createSessionController,
  type ControllerState,
  type SessionController,
} from '../viewmodel/controller';
import { diffProjections } from '../viewmodel/diff';
import { highlightBlockId } from '../viewmodel/highlight';
import { viewTabDelta } from '../viewmodel/keymap';
import { displayedView, type FrameProjection } from '../viewmodel/replay';
import { roleValue } from '../viewmodel/roles';
import { parseRoute, routeOfState, routePath, sameRoute, type Route } from '../viewmodel/route';
import {
  preSessionStatusBar,
  statusBar,
  statusMarker,
  terminalReasonOf,
  type PageMode,
  type StatusBarInput,
} from '../viewmodel/session';
import { cachedStore, defaultStore, type KeyValueStore } from '../viewmodel/storage';
import { outputEntries } from '../viewmodel/output';
import { runMenuModel, type RunMenuInput } from '../viewmodel/toolbar';
import {
  availableViews as availableViewsOf,
  createViewManagerState,
  type ViewKind,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import type { WorkflowArtifact } from '../workflow/types';
import './briefing-panel';
import './canvas-panel';
import './output-view';
import './top-bar';
import './verdict-panel';
import './view-manager';
import type { CanvasPanelElement } from './canvas-panel';
import { canvasStoreOf } from './legacy-archive-bar';
import type { RunMenuCommand } from './run-menu';
import type { ViewContext } from './view-context';
/** 当前要渲染的投影：调试模式读调试实例，判题结果读录像帧（05 §1）。 */
type ActiveView = FrameProjection;

/** 题目没声明提示时的稳定空表：避免每次渲染都新建数组，让子组件的属性判定不抖动。 */
const EMPTY_HINTS: readonly Hint[] = [];

/** `p2b-canvas-*` 里带产物的两类事件（`p2b-canvas-compiled` / `-run`）的 detail。 */
type CanvasArtifactDetail = CustomEvent<{ readonly artifact: WorkflowArtifact }>;
/** `p2b-canvas-compile-failed` 的 detail：问题列表，`nodeId` 是画布节点 id。 */
type CanvasIssuesDetail = CustomEvent<{ readonly errors: readonly WorkflowIssue[] }>;
/** `p2b-canvas-legacy` 的 detail：v2 键里读到的是旧档原文（不迁移、不改写）。 */
type CanvasLegacyDetail = CustomEvent<{
  readonly legacy: { readonly reason: string; readonly message: string; readonly raw: string };
}>;

export class Pwn2BlockApp extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--p2b-bg);
      }
      /* 题面、提示、两栏和输出区左右都缩进 0.8rem，边框上下对齐。 */
      .briefing {
        flex: none;
        margin: 0 0.8rem;
        border: var(--p2b-border) solid var(--p2b-line);
        border-top: 0;
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .notice {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin: 0.7rem 0.8rem 0;
        padding: 0.65rem 0.85rem;
        border: var(--p2b-border) solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .notice.error { border-color: var(--p2b-error); color: var(--p2b-error); }
      .notice.warn { border-color: var(--p2b-changed); color: var(--p2b-changed); }
      .notice.ok { border-color: var(--p2b-ip); color: var(--p2b-ip); }
      .notice.info { color: var(--p2b-dim); }
      /* 旧档提示条：纯色底 + 1px 边框，压在 payload 窗口顶部；本体在 legacy-archive-bar.ts。 */
      .right > pwn2block-legacy-archive-bar { margin: 0 0 0.6rem; }
      .status {
        flex: none;
        display: block;
        margin: 0;
        padding: 0.5rem 1rem;
        border: 0;
        border-radius: 0;
        color: var(--p2b-bg);
        background: var(--p2b-fg);
      }
      /*
       * 上下工作区（10 §2.1）：视图在上、画布工作区在下，两栏都用页面可用宽度。
       * 不设可拖动分隔条，也不要求两块同时塞进一屏：页面保持正常纵向滚动。
       */
      main {
        flex: none;
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
        padding: 0.8rem;
        overflow: visible;
      }
      .left,
      .right { min-width: 0; overflow: hidden; }
      .left {
        display: flex;
        flex-direction: column;
        height: max(32rem, 72dvh);
        min-height: 32rem;
        background: var(--p2b-bg);
      }
      .right {
        display: flex;
        flex-direction: column;
        height: max(44rem, 96dvh);
        min-height: 44rem;
        background: var(--p2b-bg);
      }
      .right > pwn2block-canvas-panel { flex: 1 1 auto; min-height: 0; }
      .output {
        flex: none;
        margin: 0 0.8rem 0.8rem;
        padding: 0.9rem 0.75rem 0.75rem;
      }
      .mode-hint {
        margin: 0 0 0.65rem;
        padding: 0.5rem 0.65rem;
        border-left: 3px solid var(--p2b-changed);
        border-radius: 0;
        color: var(--p2b-changed);
        background: var(--p2b-bg);
      }
      .boot {
        flex: 1;
        min-height: 0;
        margin: 0;
        padding: 2rem;
        overflow: auto;
      }
      .boot ul {
        display: grid;
        gap: 0.6rem;
        max-width: 42rem;
        margin: 1.2rem 0 0;
        padding: 0;
        list-style: none;
      }
      .boot li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.9rem 1rem;
        border: var(--p2b-border) solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .boot .lead { color: var(--p2b-dim); }
      /* 宽而矮的窗口优先给工作区完整的一屏；窄高屏仍保持明确高度。 */
      @media (min-aspect-ratio: 2/1) {
        .left { height: max(32rem, 85dvh); }
        .right { height: max(44rem, 108dvh); }
      }
      @media (max-aspect-ratio: 1/1) {
        .left { height: max(32rem, 62dvh); }
        .right { height: max(48rem, 88dvh); }
      }
      @media (max-width: 620px) {
        .briefing,
        .notice,
        .output {
          margin-left: 0.6rem;
          margin-right: 0.6rem;
        }
        main {
          gap: 0.7rem;
          padding: 0.7rem 0.6rem;
        }
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
    api: { attribute: false },
    store: { attribute: false },
    legacyAlert: { attribute: false },
  };

  /**
   * 响应式属性一律用 `declare` 声明（不产生运行时代码），默认值在构造函数里赋
   * （原因：ES2022 的类字段是 define 语义，会遮蔽 Lit 放在原型上的访问器）。
   */
  declare state?: ControllerState;

  /** 后端客户端注入点：默认用真实 `fetch`，测试传假实现（组件本身不关心谁提供它）。 */
  declare api?: ApiClient;

  /** 本地保存注入点（05 §3.1）：默认 `localStorage`，没有就退化成「不保存」。 */
  declare store?: KeyValueStore;

  /** 画布面板从 v2 键里读到旧档时贴给提示条的一句说明（面板已经把原文交出去）。 */
  declare legacyAlert?: string;

  private controller?: SessionController;
  /** 真实存储：带按键枚举能力时旧档扫描才走得通。 */
  private rawStore?: KeyValueStore;
  /** 页面会话用的存储：再包一层缓存，存储被禁 / 换题时也不丢当前内容。 */
  private activeStore?: KeyValueStore;
  /** 画布面板的存档口（`KeyValueStore` → `CanvasStore` 的薄包装）。 */
  private panelStore?: CanvasStore;
  /** 旧档探测与丢弃用的存储：同一层包装，但要保留 `length` / `key`。 */
  private legacyStore?: CanvasStore;
  /** 已经重算过自动高亮的题目 id：换题时放开一次，让新画布重新定位。 */
  private highlightFor?: string;
  /** 最近一次推给画布的自动高亮 id：只在变化时调 `locate()`，不每次渲染都抢滚动条。 */
  private pushedHighlight?: string;
  /** 会话建立前的视图状态兜底：`undefined` 会覆盖子组件的默认值，所以显式给一份。 */
  private readonly fallbackViews = createViewManagerState();
  private offState?: () => void;
  private started = false;
  /** 地址栏最近一次对齐到的页面；`undefined` 表示页面还没定下来过（见 `syncLocation`）。 */
  private settledRoute?: Route;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 嵌套影子根会把 event.target 重定向为组件宿主，真实输入框在 composedPath 首项。
    const target = event.composedPath()[0] as { tagName?: string; isContentEditable?: boolean } | undefined;
    const delta = viewTabDelta({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      target: target ?? null,
    });
    if (delta === 0) return;
    event.preventDefault();
    this.controller?.cycleView(delta);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
    const raw = (this.rawStore ??= this.store ?? defaultStore());
    const active = (this.activeStore ??= cachedStore(raw));
    this.panelStore ??= canvasStoreOf(active);
    this.legacyStore ??= raw === undefined ? undefined : canvasStoreOf(raw);
    const controller =
      this.controller ??
      createSessionController({
        api: this.api ?? createApiClient(),
        store: this.activeStore,
        canvas: { restore: () => this.restoreCanvas() },
      });
    this.controller = controller;
    this.applyState(controller.state);
    this.offState = controller.subscribe((state) => {
      this.applyState(state);
    });
    window.addEventListener('popstate', this.onPopState);
    if (!this.started) {
      this.started = true;
      const route = parseRoute(window.location.pathname);
      controller.start(route.kind === 'challenge' ? route.id : undefined);
    }
  }

  override updated(): void {
    this.syncLocation();
    this.syncHighlight();
  }

  /**
   * 控制器每次发布：记下状态；换题时放开自动高亮，让新画布重新定位一次。
   * 旧档扫描由提示条自己做（`legacy-archive-bar.ts`），外壳不重复实现。
   */
  private applyState(state: ControllerState): void {
    this.state = state;
    const challengeId = state.challenge?.id;
    if (challengeId === this.highlightFor) return;
    this.highlightFor = challengeId;
    this.pushedHighlight = undefined;
    this.legacyAlert = undefined;
  }

  /**
   * 页面切换后把地址栏对齐到当前页面（history 路由，见 viewmodel/route.ts）。
   * 页面第一次定下来时用 replaceState，之后用 pushState：浏览器后退就能回到上一页。
   */
  private syncLocation(): void {
    const state = this.state;
    if (state === undefined) return;
    const route = routeOfState(state);
    if (route === undefined) return;
    const path = routePath(route);
    if (path !== window.location.pathname) {
      if (this.settledRoute === undefined) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    this.settledRoute = route;
  }

  /** 浏览器前进 / 后退：按新地址切页；请求在飞时不切，把地址改回当前页面。 */
  private readonly onPopState = (): void => {
    const controller = this.controller;
    const state = this.state;
    if (controller === undefined || state === undefined) return;
    const target = parseRoute(window.location.pathname);
    const current = routeOfState(state);
    if (current !== undefined && sameRoute(target, current)) return;
    // 题目列表都没拿到（启动失败）：按新地址从头再来一次。
    if (state.phase === 'unavailable' && state.challenge === undefined && !state.busy && state.queued === 0) {
      controller.start(target.kind === 'challenge' ? target.id : undefined);
      return;
    }
    if (!this.leaveChallenge()) {
      if (current !== undefined) window.history.pushState(null, '', routePath(current));
      return;
    }
    if (target.kind === 'challenge') controller.choose(target.id);
  };

  /**
   * 离开当前题目回到列表：先让控制器暂存会话，再切页。请求在飞或排队时返回 false。
   * 画布存档由面板自己防抖写入、卸载时立刻补写，外壳不再写第二遍。
   */
  private leaveChallenge(): boolean {
    const state = this.state;
    if (state === undefined || state.busy || state.queued > 0) return false;
    return this.controller?.browseChallenges() ?? false;
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('popstate', this.onPopState);
    this.offState?.();
    this.offState = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const state = this.state;
    if (state === undefined) {
      return html`<p class="boot" role="status" aria-live="polite">正在连接后端…</p>`;
    }
    const mode: PageMode = state.page?.mode ?? 'debug';
    const challenge = state.challenge;
    return html`
      <pwn2block-top-bar
        .mode=${mode}
        .canChoose=${challenge !== undefined}
        @p2b-choose-challenge=${this.onChooseChallenge}
        .runModel=${this.runModel(state)}
        .busy=${state.busy}
        .pending=${state.queued}
        @p2b-mode-change=${this.onModeChange}
        @p2b-run=${this.onRun}
      ></pwn2block-top-bar>
      ${challenge === undefined
        ? ''
        : html`<div class="briefing">
            <pwn2block-briefing-panel
              .challengeId=${challenge.id}
              .challengeTitle=${challenge.title}
              .briefing=${challenge.briefing}
              .hints=${challenge.hints ?? EMPTY_HINTS}
              .storage=${this.activeStore}
              .failures=${state.page?.projection.failures ?? 0}
            ></pwn2block-briefing-panel>
          </div>`}
      ${this.renderNotice(state)} ${mode === 'verdict' ? this.renderVerdict(state) : ''} ${this.renderBody(state)}
    `;
  }

  private renderBody(state: ControllerState) {
    const view = this.activeView(state);
    const challenge = state.challenge;
    // 相位只决定无题面时的启动页；已有题面时即使 unavailable 也保留工作台与画布：
    // 失败原因和重试出口来自 notice，避免建会话失败时销毁已恢复的程序。
    if (challenge === undefined) return this.renderBoot(state);
    const mode = state.page?.mode ?? 'debug';
    if (view === undefined) {
      // 第一相位（只有题面、还没有投影，05 §3.1）：画布必须在这一相位就挂上，所以左侧
      // 说明原因、右侧照常渲染 payload 窗口。这一相位没有 `Projection`，`ip`/「动作 n/m」
      // 都没意义，但播报区必须从首次渲染就常驻（09 §2），否则屏幕阅读器在这一相位结束、
      // 第一份投影到达时听不到任何播报。**两个相位必须走同一个模板**：Lit 按模板缓存复用
      // DOM，换成另一个模板会把 payload 窗口整个重建——画布跟着被销毁。
      const failure = state.notice;
      const known = failure !== undefined && failure.action !== undefined;
      return this.renderLayout(
        state,
        challenge,
        known
          ? html`<h2>暂时开不了新会话</h2>
              <p class="lead">${failure.text}</p>`
          : html`<p class="lead">左侧视图读的是服务端投影：调试实例接回来之后才显示。</p>`,
        preSessionStatusBar(mode, failure?.text ?? '正在准备会话…'),
      );
    }
    return this.renderLayout(
      state,
      challenge,
      html`<pwn2block-view-manager
        .context=${this.viewContext(view, challenge)}
        .views=${state.page?.views ?? this.fallbackViews}
        .available=${availableViewsOf(view.projection, challenge)}
        @p2b-view-select=${(event: CustomEvent<{ kind: ViewKind }>) => this.controller?.selectView(event.detail.kind)}
      ></pwn2block-view-manager>`,
      statusBar(this.statusBarInput(state, view.projection, mode)),
    );
  }

  /** 底部状态栏（09 §2）的输入：`ip` 读 `roles.ip`，`total` 是编译产物的动作数。 */
  private statusBarInput(state: ControllerState, projection: Projection, mode: PageMode): StatusBarInput {
    return {
      mode,
      projection,
      ip: roleValue(projection, projection.roles, 'ip'),
      cursor: state.cursor,
      total: state.artifact.artifact?.actions.length ?? 0,
      ...(state.aborted === undefined ? {} : { aborted: state.aborted }),
    };
  }

  /** 三区骨架：左（视图管理器）+ 右（payload 窗口）+ 输出区 + 底部状态栏。两种相位共用同一份模板。 */
  private renderLayout(state: ControllerState, challenge: PublicChallenge, left: unknown, statusText: string) {
    return html`
      <main>
        <section class="left" aria-label="视图管理器">${left}</section>
        <section class="right" aria-label="payload 窗口">
          ${this.renderLegacyBar()} ${this.renderCanvasPanel(challenge)}
        </section>
      </main>
      ${this.renderOutput(state)}
      <p class="status" role="status" aria-live="polite">${statusText}</p>
    `;
  }

  /**
   * payload 窗口的正文：新版画布面板。外壳只接它的事件（契约见 `canvas-panel.ts`）：
   * 改动 → 产物过期；编译成功 → 采用产物；编译失败 → 输出区错误；运行 → 走运行路径。
   */
  private renderCanvasPanel(challenge: PublicChallenge) {
    return html`<pwn2block-canvas-panel
      .challenge=${challenge}
      .store=${this.panelStore}
      @p2b-canvas-changed=${() => this.controller?.noteEdit()}
      @p2b-canvas-compiled=${this.onCanvasCompiled}
      @p2b-canvas-compile-failed=${this.onCanvasCompileFailed}
      @p2b-canvas-run=${this.onCanvasRun}
      @p2b-canvas-legacy=${this.onCanvasLegacy}
    ></pwn2block-canvas-panel>`;
  }

  /**
   * 旧档提示条（《节点画布大型修改》§8）：非模态，标题 / 正文 / 两个出口都在
   * `legacy-archive-bar.ts` 里（它自己扫描、导出、二次确认后丢弃），外壳只交存储与题目 id。
   */
  private renderLegacyBar() {
    return html`<pwn2block-legacy-archive-bar
      .store=${this.legacyStore}
      .challengeId=${this.state?.challenge?.id}
      .alert=${this.legacyAlert}
    ></pwn2block-legacy-archive-bar>`;
  }

  /**
   * 输出区（05 §6）：挂在页面壳里，位于工作区下方、横跨整行（§5.1）。数据来自
   * `outputEntries`（纯函数）。判题结果模式下顶部加一行说明：下面列的是调试实例的历史结果。
   */
  private renderOutput(state: ControllerState) {
    const { artifact, errors, stale } = state.artifact;
    const mode = state.page?.mode ?? 'debug';
    return html`
      <section class="output box" aria-label="输出区">
        <h2 class="box-title">输出</h2>
        ${mode === 'verdict'
          ? html`<p class="mode-hint">下面是调试实例的历史结果；这一轮判题的结论见上方横幅。</p>`
          : ''}
        <pwn2block-output-view
          .entries=${outputEntries({
            artifact,
            errors,
            stale,
            results: state.results,
            cursor: state.cursor,
            ...(state.page === undefined ? {} : { projection: state.page.projection }),
          })}
          @p2b-block-select=${this.onBlockSelect}
        ></pwn2block-output-view>
      </section>
    `;
  }

  /**
   * 画布存档的还原出口（05 §3.1 的「先画布、再会话」靠它保证）。
   *
   * 面板挂上（`challenge` 到位）时自己读档并立刻编译一次、发 `p2b-canvas-compiled`
   * （→ `controller.publish`），所以这里只等页面壳与面板各自渲染完。
   */
  private async restoreCanvas(): Promise<string | undefined> {
    await this.updateComplete;
    const panel = this.canvasPanel();
    if (panel === undefined) return '画布还没挂上：本地保存的程序没有恢复';
    await panel.updateComplete;
    return undefined;
  }

  /** 首屏：题目列表来自 `GET /api/challenges`，`/` 总是停在列表；`/challenges/<id>` 由控制器直接开局。 */
  private renderBoot(state: ControllerState) {
    switch (state.phase) {
      case 'loading':
        return html`<section class="boot" aria-label="加载题目列表">
          <h2>正在读取题目列表</h2>
          <p class="lead" role="status" aria-live="polite">GET /api/challenges …</p>
        </section>`;
      case 'opening':
        return html`<section class="boot" aria-label="创建会话">
          <h2>正在创建会话</h2>
          <p class="lead" role="status" aria-live="polite">正在加载题目并创建调试实例…</p>
        </section>`;
      case 'choosing':
        return html`<section class="boot" aria-label="选择题目">
          <h2>选择题目</h2>
          <p class="lead">题目列表来自服务器（GET /api/challenges）。</p>
          <ul>
            ${state.challenges.map(
              (item) => html`<li>
                <button type="button" @click=${() => this.controller?.choose(item.id)}>${item.title}</button>
                <span class="lead"> ${item.id}</span>
              </li>`,
            )}
          </ul>
        </section>`;
      case 'missing':
        return html`<section class="boot" aria-label="题目不存在">
          <h2>题目不存在</h2>
          <p class="lead">服务器上没有这道题，链接可能写错了，或者题目已经下线。</p>
          <ul>
            <li><button type="button" @click=${this.onChooseChallenge}>返回题目列表</button></li>
          </ul>
        </section>`;
      case 'unavailable':
      case 'ready':
      default:
        return this.renderUnavailable(state);
    }
  }

  /** 「现在开不了会话」：说明卡在哪一步，出口是上面那条 notice 里的按钮（重试 / 重新开始）。 */
  private renderUnavailable(state: ControllerState) {
    return html`<section class="boot" aria-label="等待重新开始">
      <h2>暂时开不了新会话</h2>
      <p class="lead">${state.notice?.text ?? '请点「重试」或「重新开始」。'}</p>
    </section>`;
  }

  private renderNotice(state: ControllerState) {
    const notice = state.notice;
    if (notice === undefined) return '';
    return html`
      <p
        class="notice ${notice.tone}"
        role=${notice.tone === 'error' ? 'alert' : 'status'}
        aria-live=${notice.tone === 'error' ? 'assertive' : 'polite'}
      >
        <span aria-hidden="true">${statusMarker(notice.tone)}</span>
        <span>${notice.text}</span>
        ${notice.action === 'restart'
          ? html`<button type="button" @click=${() => this.controller?.restart()}>重新开始</button>`
          : ''}
        ${notice.action === 'retry'
          ? html`<button type="button" @click=${() => this.controller?.retry()}>重试</button>`
          : ''}
      </p>
    `;
  }

  private renderVerdict(state: ControllerState) {
    return html`
      <pwn2block-verdict-panel
        .state=${state}
        @p2b-back-to-debug=${this.onBackToDebug}
        @p2b-position=${this.onPosition}
        @p2b-block-select=${this.onBlockSelect}
      ></pwn2block-verdict-panel>
    `;
  }

  /** 视图数据源（05 §1）：与控制器计算可用标签共用 `displayedView`，见 viewmodel/replay.ts。 */
  private activeView(state: ControllerState): ActiveView | undefined {
    return state.page === undefined ? undefined : displayedView(state.page, state.verdict);
  }

  private viewContext(view: ActiveView, challenge: PublicChallenge): ViewContext {
    return createViewContext({
      projection: view.projection,
      ...(view.previous === undefined ? {} : { previous: view.previous }),
      archBits: challenge.archBits,
      challenge,
      diff: diffProjections(view.previous, view.projection),
      ...(view.disasmNotice === undefined ? {} : { disasmNotice: view.disasmNotice }),
    });
  }

  /** `runMenuModel` 的输入：只在这一处拼，不让菜单模型与控制器的判定漂移。 */
  private menuInputOf(state: ControllerState): RunMenuInput {
    const page = state.page;
    return {
      mode: page?.mode ?? 'debug',
      hasSession: state.sessionId !== undefined && state.challenge !== undefined,
      sessionExpired: state.sessionExpired,
      artifact: state.artifact.artifact,
      stale: state.artifact.stale,
      compileErrorCount: state.artifact.errors.length,
      history: state.history,
      cursor: state.cursor,
      allowedActions: state.challenge?.allowedActions ?? [],
      // 终止态与控制器取同一份派生（04 §1.1）：判负与「已退出」的禁用原因不同，
      // 所以传原因而不是布尔（05 §6）。
      terminal: page === undefined ? undefined : terminalReasonOf(page.projection),
    };
  }

  private runModel(state: ControllerState) {
    return runMenuModel(this.menuInputOf(state));
  }

  /**
   * 自动高亮（05 §4、§6）：判题里被拒绝的动作、调试里被拒绝的动作，或第一条编译错误。
   * 判定收口在 `viewmodel/highlight.ts`，输出区的「定位积木」读的也是同一个 id。
   * 新画布没有「高亮属性」，所以只在 id 变化时推一次 `locate()`。
   */
  private autoHighlight(state: ControllerState): string | undefined {
    const verdict = state.verdict;
    return highlightBlockId({
      mode: state.page?.mode ?? 'debug',
      ...(verdict === undefined
        ? {}
        : {
            verdict: {
              results: verdict.response.results,
              origins: verdict.origins,
              originsVersion: verdict.originsVersion,
            },
          }),
      artifact: state.artifact.artifact,
      errors: state.artifact.errors,
      results: state.results,
      cursor: state.cursor,
    });
  }

  private syncHighlight(): void {
    const state = this.state;
    if (state === undefined) return;
    const next = this.autoHighlight(state);
    if (next === this.pushedHighlight) return;
    this.pushedHighlight = next;
    if (next !== undefined) this.canvasPanel()?.locate(next);
  }

  private readonly onChooseChallenge = (): void => {
    if (!this.leaveChallenge()) return;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.boot button')?.focus());
  };

  private canvasPanel(): CanvasPanelElement | undefined {
    return this.renderRoot.querySelector<CanvasPanelElement>('pwn2block-canvas-panel') ?? undefined;
  }

  /** 顶栏「运行」菜单：命令原样交给控制器，门禁由控制器复查（05 §1 两处等价）。 */
  private onRun = (event: CustomEvent<RunMenuCommand>): void => {
    this.controller?.run(event.detail);
  };

  /** 画布编译成功：产物与来源交给控制器（与旧 `p2b-graph-compiled` 同一入口）。 */
  private onCanvasCompiled = (event: CanvasArtifactDetail): void => {
    this.publishArtifact(event.detail.artifact);
  };

  /** 画布编译失败：错误列表进输出区，运行与提交被门禁拦住（05 §3）。 */
  private onCanvasCompileFailed = (event: CanvasIssuesDetail): void => {
    this.controller?.publishErrors(compileErrorsOf(event.detail.errors));
  };

  /** 画布上的「运行」：先采用这份产物（它比控制器手里那份新），再走既有运行路径。 */
  private onCanvasRun = (event: CanvasArtifactDetail): void => {
    this.publishArtifact(event.detail.artifact);
    this.controller?.run({ kind: 'run-all' });
  };

  /** v2 键里存的是旧档原文：不迁移、不覆盖，把原因放进提示条（导出走面板的存档入口）。 */
  private onCanvasLegacy = (event: CanvasLegacyDetail): void => {
    this.legacyAlert = event.detail.legacy.message;
  };

  private publishArtifact(artifact: WorkflowArtifact): void {
    this.controller?.publish(artifact.actions, originsOf(artifact));
  }

  private onBlockSelect = (event: CustomEvent<{ readonly blockId: string }>): void => {
    this.canvasPanel()?.locate(event.detail.blockId);
  };

  private onBackToDebug = (): void => {
    this.controller?.backToDebug();
  };

  private onPosition = (event: CustomEvent<{ readonly position: number }>): void => {
    this.controller?.selectPosition(event.detail.position);
  };

  private onModeChange = (event: CustomEvent<{ mode: PageMode }>): void => {
    this.controller?.setMode(event.detail.mode);
  };
}

// ---------------------------------------------------------------------------
// 面板契约 → 控制器形状
// ---------------------------------------------------------------------------

/** 产物来源表：画布用节点 id（`nodeId`），控制器的旧口径叫 `blockId`。 */
function originsOf(artifact: WorkflowArtifact): readonly ActionOrigin[] {
  return artifact.origins.map((origin) => ({ index: origin.index, blockId: origin.nodeId }));
}

/** 画布问题 → 输出区错误：只留错误级，`nodeId` 改叫 `blockId`（空串表示没有具体位置）。 */
function compileErrorsOf(issues: readonly WorkflowIssue[]): readonly CompileError[] {
  return issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ blockId: issue.nodeId, message: issue.message }));
}

customElements.define('pwn2block-app', Pwn2BlockApp);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-app': Pwn2BlockApp;
  }
}
