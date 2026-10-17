/**
 * 单页骨架（05 §1）：整页左右 1:1（无间隙、无边框），顶部运行菜单 + 模式切换，
 * 题面面板可折叠，左半是标签式视图面板，右半是 payload 窗口。
 *
 * 数据来源是真实后端：首屏走 `GET /api/challenges` 拿题目列表（`viewmodel/controller.ts`），
 * 选定题目后创建会话，之后每个响应都把完整投影交给 `applyProjection`。
 * **生产代码不再 import `fixtures/sample`**——那份样例只留给测试。
 *
 * 两种模式共用同一套视图，只是数据源不同（05 §1）：
 * - 调试模式：`page.projection`；
 * - 判题结果：`frameProjection(replay, position)`（录像里选中的那一帧）。
 *
 * 这个组件只做装配：状态在控制器里，纯逻辑在 `viewmodel/**`，渲染在各自的小组件里，
 * 它自己负责把事件接对、把 `aria-live` 播报区放对。
 */
import { LitElement, css, html } from 'lit';
import type { Hint, Projection, PublicChallenge } from '@pwn2block/shared';
import { createApiClient, type ApiClient } from '../api';
import { createViewContext } from '../viewmodel/context';
import {
  createSessionController,
  type ControllerState,
  type SessionController,
} from '../viewmodel/controller';
import { diffProjections } from '../viewmodel/diff';
import { highlightBlockId } from '../viewmodel/highlight';
import { viewTabDelta } from '../viewmodel/keymap';
import { frameProjection } from '../viewmodel/replay';
import { statusLine, statusMarker, statusTextOf, terminalReasonOf, type PageMode, type StatusTone } from '../viewmodel/session';
import { cachedStore, defaultStore, type KeyValueStore } from '../viewmodel/storage';
import { outputEntries } from '../viewmodel/output';
import { payloadControls, runMenuModel, type RunMenuInput } from '../viewmodel/toolbar';
import {
  availableViews as availableViewsOf,
  createViewManagerState,
  type ViewKind,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import './briefing-panel';
import './output-view';
import './payload-panel';
import './top-bar';
import './verdict-panel';
import './view-manager';
import type { NormalizedWorkspace } from '../compiler/types';
import type { Pwn2BlockPayloadPanel } from './payload-panel';
import type { RunMenuCommand } from './run-menu';
import type { ViewContext } from './view-context';

/** 当前要渲染的投影：调试模式读调试实例，判题结果读录像帧（05 §1）。 */
interface ActiveView {
  readonly projection: Projection;
  readonly previous?: Projection;
  readonly disasmNotice?: string;
}

/** 题目没声明提示时的稳定空表：避免每次渲染都新建数组，让子组件的属性判定不抖动。 */
const EMPTY_HINTS: readonly Hint[] = [];

export class Pwn2BlockApp extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100dvh;
        min-height: 0;
        overflow: hidden;
        background: var(--p2b-bg);
      }
      .briefing {
        flex: none;
        margin: 0 1rem;
        border: 1px solid var(--p2b-line);
        border-top: 0;
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .notice {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin: 0.7rem 1rem 0;
        padding: 0.65rem 0.85rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .notice.error {
        border-color: var(--p2b-error);
        color: var(--p2b-error);
      }
      .notice.warn {
        border-color: var(--p2b-changed);
        color: var(--p2b-changed);
      }
      .notice.ok {
        border-color: var(--p2b-ip);
        color: var(--p2b-ip);
      }
      .notice.info {
        color: var(--p2b-dim);
      }
      .status {
        display: flex;
        align-items: center;
        min-height: 2.7rem;
        margin: 0.7rem 1rem 0;
        padding: 0.65rem 0.85rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .status.ok {
        border-color: var(--p2b-ip);
        color: var(--p2b-ip);
      }
      .status.warn {
        border-color: var(--p2b-changed);
        color: var(--p2b-changed);
      }
      .status.error {
        border-color: var(--p2b-error);
        color: var(--p2b-error);
      }
      .status.info {
        color: var(--p2b-fg);
      }
      .status .mode {
        color: var(--p2b-fg);
        font-weight: 700;
      }
      .status .marker {
        margin-right: 0.3rem;
        font-size: inherit;
      }
      main {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 0.8rem;
        padding: 0.8rem;
        overflow: hidden;
      }
      .left,
      .right {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border: 1px solid var(--p2b-line);
        border-radius: 0;
      }
      .left {
        display: flex;
        flex-direction: column;
        background: var(--p2b-bg);
      }
      .right {
        background: var(--p2b-bg);
      }
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
        border: 1px solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .boot .lead {
        color: var(--p2b-dim);
      }
      @media (max-width: 980px) {
        :host {
          overflow: auto;
        }
        main {
          grid-template-columns: 1fr;
          overflow: visible;
        }
        .left,
        .right {
          min-height: 32rem;
        }
      }
      @media (max-width: 620px) {
        .briefing,
        .notice,
        .status,
        .output {
          margin-left: 0.6rem;
          margin-right: 0.6rem;
        }
        main {
          gap: 0.7rem;
          padding: 0.7rem;
        }
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
    api: { attribute: false },
    store: { attribute: false },
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

  private controller?: SessionController;
  private activeStore?: KeyValueStore;
  /** 会话建立前的视图状态兜底：`undefined` 会覆盖子组件的默认值，所以显式给一份。 */
  private readonly fallbackViews = createViewManagerState();
  private offState?: () => void;
  private started = false;

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
    this.activeStore ??= cachedStore(this.store ?? defaultStore());
    const controller =
      this.controller ??
      createSessionController({
        api: this.api ?? createApiClient(),
        store: this.activeStore,
        canvas: { restore: () => this.restoreCanvas() },
      });
    this.controller = controller;
    this.state = controller.state;
    this.offState = controller.subscribe((state) => {
      this.state = state;
    });
    if (!this.started) {
      this.started = true;
      controller.start();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKeyDown);
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
    // 相位只决定无题面时的启动页；已有题面时即使 unavailable 也保留工作台与画布。
    // 失败原因和重试出口来自 notice，避免建会话失败时销毁已恢复的程序。
    if (challenge === undefined) return this.renderBoot(state);
    const mode = state.page?.mode ?? 'debug';
    if (view === undefined) {
      // 第一相位（只有题面、还没有投影，05 §3.1）：画布必须在这一相位就挂上，
      // 所以左侧空着说明原因、右侧照常渲染 payload 窗口。
      //
      // **两个相位必须走同一个模板**：Lit 按模板缓存复用 DOM，换成另一个模板会把
      // payload 窗口整个重建——画布跟着被销毁，「先装回画布、再接会话」就白做了。
      const failure = state.notice;
      const known = failure !== undefined && failure.action !== undefined;
      return this.renderLayout(
        state,
        challenge,
        known ? failure.tone : 'info',
        known
          ? html`<span class="marker" aria-hidden="true">${statusMarker(failure.tone)}</span>
              <span>${failure.text}</span>`
          : html`<span class="marker" aria-hidden="true">${statusMarker('info')}</span>
              <span>正在恢复本地保存的程序并接回调试实例…</span>`,
        known
          ? html`<h2>暂时开不了新会话</h2>
              <p class="lead">${failure.text}</p>`
          : html`<p class="lead">左侧视图读的是服务端投影：调试实例接回来之后才显示。</p>`,
      );
    }
    const status = statusTextOf(view.projection, mode);
    return this.renderLayout(
      state,
      challenge,
      status.tone,
      html`<span class="marker" aria-hidden="true">${statusMarker(status.tone)}</span>
        <span class="mode">${statusLine(view.projection, mode)}</span>
        <span> — ${status.text}</span>`,
      html`<pwn2block-view-manager
        .context=${this.viewContext(view, challenge)}
        .views=${state.page?.views ?? this.fallbackViews}
        .available=${availableViewsOf(view.projection, challenge)}
        @p2b-view-select=${(event: CustomEvent<{ kind: ViewKind }>) => this.controller?.selectView(event.detail.kind)}
      ></pwn2block-view-manager>`,
    );
  }

  /** 三区骨架：状态行 + 左（视图管理器）+ 右（payload 窗口）。两种相位共用同一份模板。 */
  private renderLayout(
    state: ControllerState,
    challenge: PublicChallenge,
    tone: StatusTone,
    status: unknown,
    left: unknown,
  ) {
    return html`
      <p class="status ${tone}" role="status" aria-live="polite">${status}</p>
      <main>
        <section class="left" aria-label="视图管理器">${left}</section>
        <section class="right" aria-label="payload 窗口">${this.renderPayloadPanel(state, challenge)}</section>
      </main>
      ${this.renderOutput(state)}
    `;
  }

  private renderPayloadPanel(state: ControllerState, challenge: PublicChallenge) {
    return html`<pwn2block-payload-panel
      .challenge=${challenge}
      .sessionId=${state.sessionId}
      .state=${state}
      .controls=${this.payloadModel(state)}
      .highlightBlockId=${this.autoHighlight(state)}
      .store=${this.activeStore}
      @p2b-run=${this.onRun}
      @p2b-compile=${this.onCompile}
      @p2b-edit=${this.onEdit}
    ></pwn2block-payload-panel>`;
  }

  /**
   * 输出区（05 §6）：挂在页面壳里，位于工作区下方、横跨整行（§5.1）。数据来自
   * `outputEntries`（纯函数），与原来在 payload 面板里的那一份完全一致，只是搬了地方。
   * 判题结果模式下，原来程序区上方的说明文字改放在这里顶部。
   */
  private renderOutput(state: ControllerState) {
    const artifact = state.artifact.artifact;
    const errors = state.artifact.errors;
    const stale = state.artifact.stale;
    const cursor = state.cursor;
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
            cursor,
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
   * 控制器发出第一相位状态之后调用：这里等页面壳自己渲染完（payload 窗口这时才存在）、
   * 再等窗口把 Blockly 挂上，然后把存档交给窗口去装。装不进去只是「程序没恢复」，
   * 窗口会返回原因、控制器负责提示，画布内容由桥保证逐块不变（09 §3.2）。
   */
  private async restoreCanvas(): Promise<string | undefined> {
    await this.updateComplete;
    const panel = this.renderRoot.querySelector<Pwn2BlockPayloadPanel>('pwn2block-payload-panel');
    if (panel === null) return undefined;
    await panel.updateComplete;
    return panel.restoreArchive();
  }

  /** 首屏：题目列表来自 `GET /api/challenges`（多题时在这里选，只有一题时控制器直接开局）。 */
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

  /**
   * 视图数据源（05 §1）：判题结果模式读录像里选中的那一帧，调试模式读调试实例的投影。
   * 录像帧的反汇编可用性按 09 §3.4 判定，不可用时把禁用提示交给指令视图。
   */
  private activeView(state: ControllerState): ActiveView | undefined {
    const page = state.page;
    if (page === undefined) return undefined;
    const verdict = state.verdict;
    if (page.mode === 'verdict' && verdict !== undefined) {
      const frame = frameProjection(verdict.response.replay, verdict.position);
      return {
        projection: frame.projection,
        ...(frame.previous === undefined ? {} : { previous: frame.previous }),
        ...(frame.disasmNotice === undefined ? {} : { disasmNotice: frame.disasmNotice }),
      };
    }
    return page.previous === undefined
      ? { projection: page.projection }
      : { projection: page.projection, previous: page.previous };
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

  /** `runMenuModel` 与 `payloadControls` 共用的输入：只在这一处拼，不让两份模型漂移。 */
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
      // 终止态与控制器取同一份派生（04 §1.1）：`failed` 与「已退出」都禁执行类动作，
      // 两者的禁用原因不同（判负 ≠ 已退出），所以传原因而不是布尔（05 §6）。
      terminal: page === undefined ? undefined : terminalReasonOf(page.projection),
    };
  }

  private runModel(state: ControllerState) {
    return runMenuModel(this.menuInputOf(state));
  }

  /** payload 面板的「运行 / 终止」（05 §6）：复用同一份输入，只多传 `running`。 */
  private payloadModel(state: ControllerState) {
    return payloadControls({ ...this.menuInputOf(state), running: state.running });
  }

  /**
   * 自动高亮（05 §4、§6）：判题里的被拒绝动作、调试里被拒绝的动作，或第一条编译错误。
   * 判定收口在 `viewmodel/highlight.ts`（内部走 H 的 `compiler/locate.ts`），
   * 输出区的「定位积木」按钮读的也是同一个 id，不各算一套。
   * 点输出区条目时由 payload 面板自己高亮，不走这里。
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

  private readonly onChooseChallenge = (): void => {
    if (this.state?.busy || (this.state?.queued ?? 0) > 0) return;
    this.panel()?.saveArchive();
    this.controller?.browseChallenges();
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.boot button')?.focus());
  };

  private panel(): Pwn2BlockPayloadPanel | undefined {
    return this.renderRoot.querySelector<Pwn2BlockPayloadPanel>('pwn2block-payload-panel') ?? undefined;
  }

  /** 两处「运行」菜单共用：命令原样交给控制器，门禁由控制器复查（05 §1 两处等价）。 */
  private onRun = (event: Event): void => {
    this.controller?.run((event as CustomEvent<RunMenuCommand>).detail);
  };

  private onCompile = (event: Event): void => {
    const { program } = (event as CustomEvent<{ readonly program: NormalizedWorkspace }>).detail;
    this.controller?.compile(program);
  };

  private onEdit = (): void => {
    this.controller?.noteEdit();
  };

  private onBlockSelect = (event: Event): void => {
    const { blockId } = (event as CustomEvent<{ readonly blockId: string }>).detail;
    this.panel()?.highlight(blockId);
  };

  private onBackToDebug = (): void => {
    this.controller?.backToDebug();
  };

  private onPosition = (event: Event): void => {
    const { position } = (event as CustomEvent<{ readonly position: number }>).detail;
    this.controller?.selectPosition(position);
  };

  private onModeChange = (event: Event): void => {
    const { mode } = (event as CustomEvent<{ mode: PageMode }>).detail;
    this.controller?.setMode(mode);
  };
}

customElements.define('pwn2block-app', Pwn2BlockApp);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-app': Pwn2BlockApp;
  }
}
