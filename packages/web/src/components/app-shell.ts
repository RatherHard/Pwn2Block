/**
 * 单页骨架（05 §1）：整页左右 1:1（无间隙、无边框），顶部两组菜单 + 模式切换，
 * 题面面板可折叠，左半是视图管理器，右半是 payload 窗口（H 的开发区）。
 *
 * 数据来源在 D1 是 `fixtures/sample.ts` 的两份样例投影（页面上明确标了“样例”），
 * D4 换成 `src/api.ts` 的会话接口后删掉那个切换条即可，视图与纯逻辑都不用改。
 */
import { LitElement, css, html } from 'lit';
import {
  SAMPLE_ARCH_BITS,
  SAMPLE_PROJECTIONS,
  SAMPLE_PUBLIC_CHALLENGE,
  SAMPLE_ROLES,
} from '../fixtures/sample';
import { diffProjections } from '../viewmodel/diff';
import { viewScrollDelta } from '../viewmodel/keymap';
import {
  applyProjection,
  createPageState,
  setMode,
  statusLine,
  statusMarker,
  statusTextOf,
  type PageMode,
  type PageState,
} from '../viewmodel/session';
import {
  availableViews,
  moveView,
  scrollViews,
  setViewShown,
  type ViewKind,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import './briefing-panel';
import './payload-panel';
import './top-bar';
import './view-manager';
import type { ViewContext } from './view-context';

const SAMPLE_LABELS = ['初始状态', '执行两步后'] as const;

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
      .sample-bar {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.2rem 0.5rem;
        border-bottom: 1px solid var(--p2b-line);
        color: var(--p2b-dim);
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
    sampleIndex: { type: Number },
  };

  /**
   * 响应式属性一律用 `declare` 声明（不产生运行时代码），默认值在构造函数里赋。
   *
   * 原因：本包以 ES2022 为目标编译，类字段是 define 语义，`state = …` 这样的字段声明会
   * 在实例上定义一个自有属性，遮蔽 Lit 放在原型上的访问器——之后赋值不再触发更新
   * （开发模式下 Lit 会直接抛错）。详见 lit.dev/msg/class-field-shadowing。
   * 后续新增 Lit 组件请沿用这一写法。
   */
  declare state: PageState;
  declare sampleIndex: number;

  constructor() {
    super();
    this.state = createPageState(SAMPLE_PROJECTIONS[0]);
    this.sampleIndex = 0;
  }

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
    this.state = { ...this.state, views: scrollViews(this.state.views, delta) };
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    super.disconnectedCallback();
  }

  override render() {
    const { mode, projection, views } = this.state;
    const status = statusTextOf(projection, mode);
    const challenge = SAMPLE_PUBLIC_CHALLENGE;
    return html`
      <pwn2block-top-bar
        .mode=${mode}
        .views=${views}
        .available=${availableViews(projection)}
        @p2b-mode-change=${this.onModeChange}
        @p2b-view-toggle=${this.onViewToggle}
        @p2b-view-move=${this.onViewMove}
      ></pwn2block-top-bar>
      <div class="briefing">
        <pwn2block-briefing-panel
          .challengeTitle=${challenge.title}
          .briefing=${challenge.briefing}
          .hintCount=${(challenge.hints ?? []).length}
        ></pwn2block-briefing-panel>
      </div>
      <p class="status ${status.tone}" role="status" aria-live="polite">
        <span class="marker" aria-hidden="true">${statusMarker(status.tone)}</span>
        <span class="mode">${statusLine(projection, mode)}</span>
        <span> — ${status.text}</span>
      </p>
      <main>
        <section class="left" aria-label="视图管理器">
          <div class="sample-bar">
            <span>样例投影（D1）：</span>
            ${SAMPLE_PROJECTIONS.map(
              (_, index) => html`
                <button
                  type="button"
                  aria-pressed=${this.sampleIndex === index ? 'true' : 'false'}
                  class=${this.sampleIndex === index ? 'on' : ''}
                  @click=${() => this.useSample(index)}
                >
                  ${SAMPLE_LABELS[index] ?? `样例 ${index + 1}`}
                </button>
              `,
            )}
            <span>接入真实 API 后移除（D4）</span>
          </div>
          <pwn2block-view-manager
            .context=${this.viewContext()}
            .views=${views}
            .available=${availableViews(projection)}
          ></pwn2block-view-manager>
        </section>
        <section class="right" aria-label="payload 窗口">
          <pwn2block-payload-panel></pwn2block-payload-panel>
        </section>
      </main>
    `;
  }

  /** 所有视图共用同一份上下文；差分在这里算一次（05 §2.1、04 §4）。 */
  private viewContext(): ViewContext {
    const { projection, previous } = this.state;
    return {
      projection,
      previous,
      archBits: SAMPLE_ARCH_BITS,
      roles: SAMPLE_ROLES,
      labels: SAMPLE_PUBLIC_CHALLENGE.labels ?? [],
      diff: diffProjections(previous, projection),
    };
  }

  private useSample(index: number): void {
    const projection = SAMPLE_PROJECTIONS[index];
    if (projection === undefined) return;
    this.sampleIndex = index;
    this.state = applyProjection(this.state, projection);
  }

  private onModeChange = (event: Event): void => {
    const { mode } = (event as CustomEvent<{ mode: PageMode }>).detail;
    this.state = setMode(this.state, mode);
  };

  private onViewToggle = (event: Event): void => {
    const { kind, shown } = (event as CustomEvent<{ kind: ViewKind; shown: boolean }>).detail;
    this.state = { ...this.state, views: setViewShown(this.state.views, kind, shown) };
  };

  private onViewMove = (event: Event): void => {
    const { kind, delta } = (event as CustomEvent<{ kind: ViewKind; delta: number }>).detail;
    this.state = { ...this.state, views: moveView(this.state.views, kind, delta) };
  };
}

customElements.define('pwn2block-app', Pwn2BlockApp);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-app': Pwn2BlockApp;
  }
}
