/**
 * 顶部菜单与模式切换（05 §1）。
 *
 * - **视图**：勾选显示 / 隐藏各视图，可上下移动列表顺序（拖动排序见 D03）；
 * - **运行**：与 payload 工具栏等价的一组按钮，D02 接入后启用；
 * - **模式切换**：调试模式（默认）/ 判题结果，对应 04 §1 的两个实例。
 *
 * 组件不持有状态：勾选与切模式都派发事件，由页面壳改 `PageState`。
 */
import { LitElement, css, html } from 'lit';
import { MODE_NAMES, type PageMode } from '../viewmodel/session';
import {
  VIEW_DESCRIPTIONS,
  VIEW_KINDS,
  VIEW_TITLES,
  createViewManagerState,
  isShown,
  type ViewKind,
  type ViewManagerState,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';

/** 运行菜单的按钮（05 §3）：D1 只呈现，接线在 D02。 */
const RUN_BUTTONS = [
  ['编译', '把积木编译成原子动作序列，显示在程序区，不提交'],
  ['试运行', '把程序区剩余动作提交到调试实例'],
  ['单步', '提交程序区的下一个动作'],
  ['运行 N 步', '提交 step 带 count（06 §2 断点的替代品）'],
  ['后退一步', '提交 step_back，倒回一条指令'],
  ['撤销', '提交 undo，回退上一次提交'],
  ['重置', '提交 reset，程序区高亮回到开头'],
  ['提交判题', '把完整动作序列发到 /submit，切到判题结果模式'],
] as const;

export class Pwn2BlockTopBar extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        background: var(--p2b-bg-alt);
        border-bottom: 1px solid var(--p2b-line);
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.3rem 0.6rem;
      }
      .brand {
        color: var(--p2b-accent);
        letter-spacing: 0.1em;
      }
      nav {
        display: flex;
        gap: 0.5rem;
      }
      .menu {
        position: relative;
      }
      .menu > summary {
        list-style: none;
        cursor: pointer;
        padding: 0.1rem 0.5rem;
        border: 1px solid var(--p2b-line);
        border-radius: 2px;
      }
      .menu[open] > summary {
        border-color: var(--p2b-accent);
        color: var(--p2b-accent);
      }
      .menu-body {
        position: absolute;
        z-index: 10;
        margin-top: 0.2rem;
        min-width: 34rem;
        max-width: 44rem;
        padding: 0.5rem;
        background: var(--p2b-panel);
        border: 1px solid var(--p2b-line);
        box-shadow: 0 6px 20px #0008;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: grid;
        grid-template-columns: 12rem 1fr auto;
        align-items: center;
        gap: 0.4rem;
        padding: 0.1rem 0;
      }
      .desc {
        color: var(--p2b-dim);
      }
      .order {
        display: flex;
        gap: 0.2rem;
      }
      .modes {
        margin-left: auto;
        display: flex;
        gap: 0.4rem;
      }
      .run-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
      }
      kbd {
        border: 1px solid var(--p2b-line);
        border-radius: 2px;
        padding: 0 0.2rem;
      }
    `,
  ];

  static override properties = {
    mode: { attribute: false },
    views: { attribute: false },
    available: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）；默认值在构造函数里赋。 */
  declare mode: PageMode;
  declare views: ViewManagerState;
  declare available: readonly ViewKind[];

  constructor() {
    super();
    this.mode = 'debug';
    this.views = createViewManagerState();
    this.available = VIEW_KINDS;
  }

  override render() {
    return html`
      <div class="bar">
        <strong class="brand">Pwn2Block</strong>
        <nav aria-label="主菜单">
          <details class="menu">
            <summary>视图</summary>
            <div class="menu-body">
              <ul>
                ${VIEW_KINDS.map((kind) => this.renderViewItem(kind))}
              </ul>
              <p class="note">
                同时显示 2 个槽位，用 <kbd>Ctrl</kbd>+<kbd>↑</kbd> / <kbd>Ctrl</kbd>+<kbd>↓</kbd> 或纵向滚动切换。
              </p>
            </div>
          </details>
          <details class="menu">
            <summary>运行</summary>
            <div class="menu-body">
              <div class="run-buttons">
                ${RUN_BUTTONS.map(
                  ([label, title]) =>
                    html`<button type="button" disabled title="${title}（D02 接入）">${label}</button>`,
                )}
              </div>
              <p class="note">
                前七个按钮只作用于调试实例；只有「提交判题」是那一次正式射击（05 §3）。D1 只搭骨架，接线在 D02。
              </p>
            </div>
          </details>
        </nav>
        <div class="modes" role="group" aria-label="模式切换">
          ${(['debug', 'verdict'] as const).map(
            (mode) => html`
              <button
                type="button"
                class=${this.mode === mode ? 'on' : ''}
                aria-pressed=${this.mode === mode ? 'true' : 'false'}
                @click=${() => this.switchMode(mode)}
              >
                ${MODE_NAMES[mode]}
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderViewItem(kind: ViewKind) {
    const enabled = this.available.includes(kind);
    const shown = enabled && isShown(this.views, kind);
    return html`
      <li>
        <label>
          <input
            type="checkbox"
            .checked=${shown}
            ?disabled=${!enabled}
            @change=${(event: Event) => this.toggle(kind, (event.target as HTMLInputElement).checked)}
          />
          <span class="title">${VIEW_TITLES[kind]}</span>
        </label>
        <span class="desc">${enabled ? VIEW_DESCRIPTIONS[kind] : `${VIEW_DESCRIPTIONS[kind]}（本题未声明）`}</span>
        <span class="order">
          <button type="button" title="上移" @click=${() => this.move(kind, -1)}>↑</button>
          <button type="button" title="下移" @click=${() => this.move(kind, 1)}>↓</button>
        </span>
      </li>
    `;
  }

  private switchMode(mode: PageMode): void {
    this.dispatchEvent(
      new CustomEvent<{ mode: PageMode }>('p2b-mode-change', {
        detail: { mode },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggle(kind: ViewKind, shown: boolean): void {
    this.dispatchEvent(
      new CustomEvent<{ kind: ViewKind; shown: boolean }>('p2b-view-toggle', {
        detail: { kind, shown },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private move(kind: ViewKind, delta: number): void {
    this.dispatchEvent(
      new CustomEvent<{ kind: ViewKind; delta: number }>('p2b-view-move', {
        detail: { kind, delta },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define('pwn2block-top-bar', Pwn2BlockTopBar);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-top-bar': Pwn2BlockTopBar;
  }
}
