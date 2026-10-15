/**
 * 单页骨架（05 §1）：整页左右 1:1（无间隙、无边框），顶部两组菜单 + 模式切换，
 * 题面面板可折叠，左半是视图管理器，右半是 payload 窗口。
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
import type { Projection, PublicChallenge } from '@pwn2block/shared';
import { createApiClient, type ApiClient } from '../api';
import { createViewContext } from '../viewmodel/context';
import {
  createSessionController,
  type ControllerState,
  type SessionController,
} from '../viewmodel/controller';
import { diffProjections } from '../viewmodel/diff';
import { viewScrollDelta } from '../viewmodel/keymap';
import { frameProjection } from '../viewmodel/replay';
import { statusLine, statusMarker, statusTextOf, isExitedProjection, type PageMode } from '../viewmodel/session';
import { runMenuModel, type RunCommand } from '../viewmodel/toolbar';
import { verdictModel } from '../viewmodel/verdict';
import {
  VIEW_KINDS,
  availableViews as availableViewsOf,
  createViewManagerState,
  type ViewKind,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import './briefing-panel';
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

export class Pwn2BlockApp extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        background: var(--p2b-bg);
      }
      .briefing {
        border-bottom: 1px solid var(--p2b-line);
        background: var(--p2b-bg-alt);
      }
      .notice {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        padding: 0.3rem 0.6rem;
        border-bottom: 1px solid var(--p2b-line);
      }
      .notice.error {
        background: #2a1614;
        color: var(--p2b-error);
      }
      .notice.warn {
        background: #2a2713;
        color: var(--p2b-warn);
      }
      .notice.ok {
        background: #16261c;
        color: var(--p2b-accent);
      }
      .notice.info {
        background: #0f1513;
      }
      .status {
        margin: 0;
        padding: 0.25rem 0.6rem;
        border-bottom: 1px solid var(--p2b-line);
        background: #0f1513;
      }
      .status.ok {
        color: var(--p2b-accent);
      }
      .status.warn {
        color: var(--p2b-warn);
      }
      .status.error {
        color: var(--p2b-error);
      }
      .status.info {
        color: var(--p2b-fg);
      }
      .status .mode {
        color: var(--p2b-accent);
      }
      .status .marker {
        margin-right: 0.3rem;
      }
      main {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        /* 05 §1：左右 1:1、无间隙、无边框；右半只用底色区分，不加分隔线 */
        gap: 0;
      }
      .left {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
      .right {
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        background: var(--p2b-bg-alt);
      }
      .boot {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 1rem 1.2rem;
      }
      .boot ul {
        list-style: none;
        margin: 0.6rem 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        align-items: flex-start;
      }
      .boot .lead {
        color: var(--p2b-dim);
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
    api: { attribute: false },
  };

  /**
   * 响应式属性一律用 `declare` 声明（不产生运行时代码），默认值在构造函数里赋
   * （原因：ES2022 的类字段是 define 语义，会遮蔽 Lit 放在原型上的访问器）。
   */
  declare state?: ControllerState;

  /** 后端客户端注入点：默认用真实 `fetch`，测试传假实现（组件本身不关心谁提供它）。 */
  declare api?: ApiClient;

  private controller?: SessionController;
  /** 会话建立前的视图状态兜底：`undefined` 会覆盖子组件的默认值，所以显式给一份。 */
  private readonly fallbackViews = createViewManagerState();
  private offState?: () => void;
  private started = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
    const delta = viewScrollDelta({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      target,
    });
    if (delta === 0) return;
    event.preventDefault();
    this.controller?.scrollViews(delta);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
    const controller = this.controller ?? createSessionController({ api: this.api ?? createApiClient() });
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
        .views=${state.page?.views ?? this.fallbackViews}
        .available=${this.viewsFor(state)}
        .runModel=${this.runModel(state)}
        .busy=${state.busy}
        .pending=${state.queued}
        @p2b-mode-change=${this.onModeChange}
        @p2b-view-toggle=${this.onViewToggle}
        @p2b-view-move=${this.onViewMove}
        @p2b-run=${this.onRun}
      ></pwn2block-top-bar>
      ${challenge === undefined
        ? ''
        : html`<div class="briefing">
            <pwn2block-briefing-panel
              .challengeTitle=${challenge.title}
              .briefing=${challenge.briefing}
              .hintCount=${(challenge.hints ?? []).length}
            ></pwn2block-briefing-panel>
          </div>`}
      ${this.renderNotice(state)} ${mode === 'verdict' ? this.renderVerdict(state) : ''} ${this.renderBody(state)}
    `;
  }

  private renderBody(state: ControllerState) {
    const view = this.activeView(state);
    const challenge = state.challenge;
    const mode = state.page?.mode ?? 'debug';
    if (view === undefined || challenge === undefined) return this.renderBoot(state);
    const status = statusTextOf(view.projection, mode);
    return html`
      <p class="status ${status.tone}" role="status" aria-live="polite">
        <span class="marker" aria-hidden="true">${statusMarker(status.tone)}</span>
        <span class="mode">${statusLine(view.projection, mode)}</span>
        <span> — ${status.text}</span>
      </p>
      <main>
        <section class="left" aria-label="视图管理器">
          <pwn2block-view-manager
            .context=${this.viewContext(view, challenge)}
            .views=${state.page?.views ?? this.fallbackViews}
            .available=${availableViewsOf(view.projection, challenge)}
          ></pwn2block-view-manager>
        </section>
        <section class="right" aria-label="payload 窗口">
          <pwn2block-payload-panel
            .challenge=${challenge}
            .sessionId=${state.sessionId}
            .state=${state}
            .runModel=${this.runModel(state)}
            .highlightBlockId=${this.autoHighlight(state)}
            @p2b-run=${this.onRun}
            @p2b-compile=${this.onCompile}
            @p2b-edit=${this.onEdit}
          ></pwn2block-payload-panel>
        </section>
      </main>
    `;
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
        return html`<section class="boot" aria-label="等待重新开始">
          <h2>暂时开不了新会话</h2>
          <p class="lead">${state.notice?.text ?? '请点「重试」或「重新开始」。'}</p>
        </section>`;
    }
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

  private viewsFor(state: ControllerState): readonly ViewKind[] {
    const view = this.activeView(state);
    const challenge = state.challenge;
    if (view === undefined) return VIEW_KINDS;
    return availableViewsOf(view.projection, challenge);
  }

  private runModel(state: ControllerState) {
    const page = state.page;
    return runMenuModel({
      mode: page?.mode ?? 'debug',
      hasSession: state.sessionId !== undefined && state.challenge !== undefined,
      sessionExpired: state.sessionExpired,
      artifact: state.artifact.artifact,
      stale: state.artifact.stale,
      compileErrorCount: state.artifact.errors.length,
      history: state.history,
      cursor: state.cursor,
      allowedActions: state.challenge?.allowedActions ?? [],
      // 退出信息与控制器取同一份派生（04 §1.1）：`satisfied` + `lastStop.reason === 'exit'`
      // 也是终止态，执行类按钮必须禁用并写出原因（05 §6）。
      exited: page === undefined ? false : isExitedProjection(page.projection),
    });
  }

  /**
   * 自动高亮（05 §4、§6）：判题结果里的被拒绝动作，或第一条编译错误。
   * 点程序区 / 输出区行时由 payload 面板自己高亮，不走这里。
   */
  private autoHighlight(state: ControllerState): string | undefined {
    const verdict = state.verdict;
    if (state.page?.mode === 'verdict' && verdict !== undefined) {
      return verdictModel({ response: verdict.response, origins: verdict.origins }).rejected?.blockId;
    }
    const errors = state.artifact.errors;
    if (state.artifact.artifact !== undefined || errors.length === 0) return undefined;
    const blockId = errors[0]?.blockId ?? '';
    return blockId === '' ? undefined : blockId;
  }

  private panel(): Pwn2BlockPayloadPanel | undefined {
    return this.renderRoot.querySelector<Pwn2BlockPayloadPanel>('pwn2block-payload-panel') ?? undefined;
  }

  /** 两处「运行」菜单共用：编译走面板的画布桥，其余命令交给控制器（05 §1 两处等价）。 */
  private onRun = (event: Event): void => {
    const command = (event as CustomEvent<RunMenuCommand>).detail;
    if (command.kind === 'compile') {
      this.panel()?.recompile();
      return;
    }
    this.controller?.run(command as RunCommand);
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

  private onViewToggle = (event: Event): void => {
    const { kind, shown } = (event as CustomEvent<{ kind: ViewKind; shown: boolean }>).detail;
    this.controller?.setViewShown(kind, shown);
  };

  private onViewMove = (event: Event): void => {
    const { kind, delta } = (event as CustomEvent<{ kind: ViewKind; delta: number }>).detail;
    this.controller?.moveView(kind, delta);
  };
}

customElements.define('pwn2block-app', Pwn2BlockApp);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-app': Pwn2BlockApp;
  }
}
