/**
 * 顶部菜单与模式切换（05 §1）。
 *
 * - **运行**：与 payload 工具栏**等价**——两处渲染的是同一个 `pwn2block-run-menu` 组件
 *   和同一份 `RunButtonModel[]`（`viewmodel/toolbar.ts`），所以可用性与禁用原因不会漂移；
 * - **模式切换**：调试模式（默认）/ 判题结果，对应 04 §1 的两个实例。
 *
 * 组件不持有状态：切模式与运行命令都派发事件，由页面壳改 `PageState` / 调控制器。
 * 模式切换对读屏可见（05 §7）：按钮带 `aria-pressed`，状态栏另有一行「调试模式 / 判题结果」。
 */
import { LitElement, css, html } from 'lit';
import { MODE_NAMES, type PageMode } from '../viewmodel/session';
import type { RunButtonModel } from '../viewmodel/toolbar';
import { sharedStyles, terminalTheme } from '../theme';
import './run-menu';

export class Pwn2BlockTopBar extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        flex: none;
        border-bottom: 1px solid var(--p2b-line);
        background: var(--p2b-bg);
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 1rem;
        min-height: var(--p2b-topbar-h);
        padding: 0.4rem 1rem;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.55rem;
        color: var(--p2b-fg);
        font-weight: 700;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      nav {
        display: flex;
        gap: 0.45rem;
      }
      .menu {
        position: relative;
      }
      .menu > summary {
        display: inline-flex;
        align-items: center;
        min-height: 2rem;
        padding: 0.3rem 0.75rem;
        border: 1px solid transparent;
        border-radius: 0;
        color: var(--p2b-dim);
        cursor: pointer;
        list-style: none;
      }
      .menu > summary::after {
        margin-left: 0.45rem;
        color: var(--p2b-dim);
        content: '⌄';
        content: '⌄' / '';
      }
      .menu > summary:hover,
      .menu[open] > summary {
        border-color: var(--p2b-line);
        color: var(--p2b-fg);
        background: var(--p2b-bg);
      }
      .menu[open] > summary::after {
        content: '⌃';
        content: '⌃' / '';
      }
      .menu-body {
        position: absolute;
        z-index: 10;
        left: 0;
        width: 36rem;
        min-width: 0;
        max-height: calc(100dvh - 6rem);
        overflow: auto;
        max-width: min(48rem, calc(100vw - 2rem));
        margin-top: 0.45rem;
        padding: 0.8rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .modes {
        display: flex;
        gap: 0.35rem;
        margin-left: auto;
        padding: 0.2rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0;
        background: var(--p2b-bg);
      }
      .modes button {
        min-height: 1.9rem;
        border-color: transparent;
        background: transparent;
      }
      .modes button:hover:not(:disabled) {
        color: var(--p2b-bg);
        background: var(--p2b-fg);
      }
      @media (max-width: 620px) {
        .bar {
          flex-wrap: wrap;
          gap: 0.45rem 0.75rem;
          padding: 0.65rem 0.7rem;
        }
        .modes {
          order: 3;
          width: 100%;
          margin-left: 0;
        }
        .modes button {
          flex: 1;
        }
        .menu-body {
          min-width: min(36rem, calc(100vw - 1.4rem));
        }
      }
    `,
  ];

  static override properties = {
    mode: { attribute: false },
    runModel: { attribute: false },
    busy: { type: Boolean },
    pending: { type: Number },
    canChoose: { type: Boolean },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）；默认值在构造函数里赋。 */
  declare mode: PageMode;
  declare runModel: readonly RunButtonModel[];
  declare busy: boolean;
  declare pending: number;
  declare canChoose: boolean;

  constructor() {
    super();
    this.mode = 'debug';
    this.runModel = [];
    this.busy = false;
    this.pending = 0;
    this.canChoose = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onOutsidePointer);
    document.addEventListener('keydown', this.onEscape);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    document.removeEventListener('keydown', this.onEscape);
    super.disconnectedCallback();
  }

  private readonly onOutsidePointer = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this)) this.closeMenus();
  };

  private readonly onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const open = this.renderRoot.querySelector<HTMLDetailsElement>('details[open]');
    if (open === null) return;
    event.preventDefault();
    this.closeMenus();
    open.querySelector('summary')?.focus();
  };

  private closeMenus(except?: HTMLDetailsElement): void {
    for (const menu of this.renderRoot.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) {
      if (menu !== except) menu.open = false;
    }
  }

  private onMenuClick(event: Event): void {
    const menu = (event.currentTarget as HTMLElement).parentElement as HTMLDetailsElement;
    this.closeMenus(menu);
  }

  override render() {
    return html`
      <div class="bar">
        <strong class="brand">Pwn2Block</strong>
        ${this.canChoose ? html`<button type="button" ?disabled=${this.busy || this.pending > 0}
          @click=${() => { this.closeMenus(); this.dispatchEvent(new CustomEvent('p2b-choose-challenge', { bubbles: true, composed: true })); }}>返回题目列表</button>` : ''}
        <nav aria-label="主菜单">
          <details class="menu">
            <summary @click=${this.onMenuClick}>运行</summary>
            <div class="menu-body">
              <pwn2block-run-menu
                .model=${this.runModel}
                .busy=${this.busy}
                .pending=${this.pending}
              ></pwn2block-run-menu>
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
                title=${mode === 'debug' ? '查看调试实例' : '查看提交后的判定结论与回放录像'}
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

  private switchMode(mode: PageMode): void {
    this.dispatchEvent(
      new CustomEvent<{ mode: PageMode }>('p2b-mode-change', {
        detail: { mode },
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
