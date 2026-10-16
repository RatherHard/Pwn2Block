/**
 * 顶部菜单与模式切换（05 §1）。
 *
 * - **视图**：勾选显示 / 隐藏各视图，可上下移动列表顺序（拖动排序见 D03）；
 * - **运行**：与 payload 工具栏**等价**——两处渲染的是同一个 `pwn2block-run-menu` 组件
 *   和同一份 `RunButtonModel[]`（`viewmodel/toolbar.ts`），所以可用性与禁用原因不会漂移；
 * - **模式切换**：调试模式（默认）/ 判题结果，对应 04 §1 的两个实例。
 *
 * 组件不持有状态：勾选、切模式与运行命令都派发事件，由页面壳改 `PageState` / 调控制器。
 * 模式切换对读屏可见（05 §7）：按钮带 `aria-pressed`，状态栏另有一行「调试模式 / 判题结果」。
 */
import { LitElement, css, html } from 'lit';
import { MODE_NAMES, type PageMode } from '../viewmodel/session';
import type { RunButtonModel } from '../viewmodel/toolbar';
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
        background: rgb(5 12 15 / 96%);
        box-shadow: 0 10px 30px rgb(0 0 0 / 24%);
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 1rem;
        min-height: 4.1rem;
        padding: 0.7rem 1rem;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.55rem;
        color: var(--p2b-fg);
        font-size: 1rem;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .brand::before {
        display: grid;
        width: 1.85rem;
        height: 1.85rem;
        place-items: center;
        border: 1px solid rgb(94 225 194 / 55%);
        border-radius: 0.55rem;
        color: #06151a;
        background: var(--p2b-accent);
        box-shadow: 0 0 22px rgb(94 225 194 / 22%);
        content: '>';
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 1.1rem;
        font-weight: 800;
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
        border-radius: 2px;
        color: var(--p2b-dim);
        cursor: pointer;
        list-style: none;
      }
      .menu > summary::after {
        margin-left: 0.45rem;
        color: var(--p2b-dim);
        content: '⌄';
      }
      .menu > summary:hover,
      .menu[open] > summary {
        border-color: var(--p2b-line);
        color: var(--p2b-fg);
        background: rgb(26 48 76 / 60%);
      }
      .menu[open] > summary::after {
        content: '⌃';
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
        border-radius: 2px;
        background: rgb(7 18 21 / 98%);
        box-shadow: 0 22px 50px rgb(0 0 0 / 42%);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: grid;
        grid-template-columns: auto 12rem minmax(12rem, 1fr) auto;
        align-items: center;
        gap: 0.65rem;
        padding: 0.45rem 0.35rem;
        border-radius: 0.45rem;
      }
      li:hover {
        background: rgb(40 69 100 / 30%);
      }
      li + li {
        margin-top: 0.2rem;
      }
      .drag-handle {
        padding: 0.25rem;
        cursor: grab;
        user-select: none;
      }
      .drag-handle:active {
        cursor: grabbing;
      }
      .desc {
        color: var(--p2b-dim);
        font-size: 0.82rem;
      }
      .order {
        display: flex;
        gap: 0.25rem;
      }
      .order button {
        min-width: 2rem;
        padding-inline: 0.35rem;
      }
      .modes {
        display: flex;
        gap: 0.35rem;
        margin-left: auto;
        padding: 0.2rem;
        border: 1px solid var(--p2b-line-soft);
        border-radius: 2px;
        background: rgb(7 18 21 / 92%);
      }
      .modes button {
        min-height: 1.9rem;
        border-color: transparent;
        background: transparent;
      }
      .modes button:hover:not(:disabled) {
        background: rgb(44 80 94 / 52%);
      }
      kbd {
        padding: 0.1rem 0.35rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0.3rem;
        color: var(--p2b-fg);
        background: rgb(7 17 31 / 55%);
        font-size: 0.75rem;
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
        li {
          grid-template-columns: auto 1fr auto;
        }
        li .desc {
          grid-column: 1 / -1;
          grid-row: 2;
        }
        li .order {
          grid-column: 3;
          grid-row: 1;
        }
      }
    `,
  ];

  static override properties = {
    mode: { attribute: false },
    views: { attribute: false },
    available: { attribute: false },
    runModel: { attribute: false },
    busy: { type: Boolean },
    pending: { type: Number },
    canChoose: { type: Boolean },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）；默认值在构造函数里赋。 */
  declare mode: PageMode;
  declare views: ViewManagerState;
  declare available: readonly ViewKind[];
  declare runModel: readonly RunButtonModel[];
  declare busy: boolean;
  declare pending: number;
  declare canChoose: boolean;

  constructor() {
    super();
    this.mode = 'debug';
    this.views = createViewManagerState();
    this.available = VIEW_KINDS;
    this.runModel = [];
    this.busy = false;
    this.pending = 0;
    this.canChoose = false;
  }

  private draggedView?: ViewKind;

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
            <summary @click=${this.onMenuClick}>视图</summary>
            <div class="menu-body">
              <ul>
                ${this.views.order.map((kind) => this.renderViewItem(kind))}
              </ul>
              <p class="note">
                同时显示 2 个槽位，用 <kbd>Ctrl</kbd>+<kbd>↑</kbd> / <kbd>Ctrl</kbd>+<kbd>↓</kbd> 或纵向滚动切换。
              </p>
            </div>
          </details>
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

  private renderViewItem(kind: ViewKind) {
    const enabled = this.available.includes(kind);
    const shown = enabled && isShown(this.views, kind);
    return html`
      <li data-kind=${kind}
        @dragover=${(event: DragEvent) => {
          if (this.draggedView !== undefined) event.preventDefault();
        }}
        @drop=${(event: DragEvent) => this.dropView(event, kind)}
      >
        <span class="drag-handle" draggable="true" title="拖动排序" aria-hidden="true"
          @dragstart=${(event: DragEvent) => {
            this.draggedView = kind;
            event.dataTransfer?.setData('text/plain', kind);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          }}
          @dragend=${() => { this.draggedView = undefined; }}
        >⠿</span>
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
          <button type="button" title="上移" aria-label=${`上移${VIEW_TITLES[kind]}`} @click=${() => this.move(kind, -1)}>
            ↑
          </button>
          <button type="button" title="下移" aria-label=${`下移${VIEW_TITLES[kind]}`} @click=${() => this.move(kind, 1)}>
            ↓
          </button>
        </span>
      </li>
    `;
  }

  private dropView(event: DragEvent, target: ViewKind): void {
    const source = this.draggedView;
    this.draggedView = undefined;
    if (source === undefined) return;
    event.preventDefault();
    this.move(source, this.views.order.indexOf(target) - this.views.order.indexOf(source));
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
