/**
 * 视图面板（设计 §3.2）：一个 `.box`，顶部一行标签，同一时刻只显示一个视图。
 *
 * 五个视图常驻 DOM，非当前标签用 `hidden` 隐藏，切换时保留各视图的内部状态（跳转、对齐、搜索）。
 * 标签栏遵循 WAI-ARIA tablist：← → Home End 切换并移动焦点；Ctrl+↑ / Ctrl+↓ 由页面壳处理。
 * 切换只派发 `p2b-view-select`，当前标签由控制器写进 PageState 并持久化。
 */
import { LitElement, css, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  VIEW_KINDS,
  VIEW_TAB_LABELS,
  VIEW_TITLES,
  createViewManagerState,
  cycleView,
  normalizeActive,
  type ViewKind,
  type ViewManagerState,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import './disasm-view';
import './io-view';
import './memory-view';
import './pseudocode-view';
import './registers-view';
import './stack-view';
import type { ViewContext } from './view-context';

/** 图例：各区域颜色与栈、指令、内存视图里的着色一致。 */
const LEGEND: readonly { readonly word: string; readonly tone: string }[] = [
  { word: '代码', tone: 'code' },
  { word: '栈', tone: 'stack' },
  { word: '数据', tone: 'data' },
  { word: '隐藏', tone: 'hidden' },
  { word: '未映射', tone: 'unmapped' },
];

export class Pwn2BlockViewManager extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        /* 左右下不留白，框直接贴齐所在一栏；上方只留出嵌在边框上的标题。 */
        padding: 0.85rem 0 0;
      }
      .box {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        padding: 0.9rem 0.75rem 0.5rem;
      }
      [role='tablist'] {
        display: flex;
        flex-wrap: wrap;
        flex: none;
        gap: 0.4rem;
        padding-bottom: 0.5rem;
        border-bottom: var(--p2b-border) solid var(--p2b-line);
      }
      [role='tab'] {
        min-height: 1.8rem;
        padding: 0.1rem 0.4rem;
        border-color: transparent;
      }
      /* 标签自带方括号（只给当前标签），不用共享按钮样式里的 [ ] 伪元素。 */
      [role='tab']::before,
      [role='tab']::after {
        content: none;
      }
      .body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .body[hidden] {
        display: none;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        flex: none;
        gap: 1rem;
        margin: 0;
        padding-top: 0.4rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
        color: var(--p2b-dim);
      }
      .legend .code {
        color: var(--p2b-code);
      }
      .legend .stack {
        color: var(--p2b-stack);
      }
      .legend .data {
        color: var(--p2b-data);
      }
      .legend .hidden {
        color: var(--p2b-hidden);
      }
      .legend .unmapped {
        color: var(--p2b-fg);
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
    views: { attribute: false },
    available: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;
  declare views: ViewManagerState;
  declare available: readonly ViewKind[];

  constructor() {
    super();
    this.views = createViewManagerState();
    this.available = VIEW_KINDS;
  }

  override render() {
    const tabs = this.tabs();
    const active = this.activeKind();
    return html`
      <div class="box">
        <h2 class="box-title">视图</h2>
        <div role="tablist" aria-label="视图" @keydown=${this.onTabKey}>
          ${tabs.map((kind) => this.renderTab(kind, kind === active))}
        </div>
        ${repeat(tabs, (kind) => kind, (kind) => html`
          <div
            role="tabpanel"
            class="body"
            id=${`panel-${kind}`}
            aria-labelledby=${`tab-${kind}`}
            ?hidden=${kind !== active}
          >${this.renderView(kind, kind === active)}</div>
        `)}
        <p class="legend">
          ${LEGEND.map(({ word, tone }) => html`<span class=${tone}>${word}</span>`)}
        </p>
      </div>
    `;
  }

  private renderTab(kind: ViewKind, selected: boolean) {
    const text = VIEW_TAB_LABELS[kind];
    return html`
      <button
        type="button"
        role="tab"
        id=${`tab-${kind}`}
        title=${VIEW_TITLES[kind]}
        aria-selected=${selected ? 'true' : 'false'}
        aria-controls=${`panel-${kind}`}
        tabindex=${selected ? 0 : -1}
        @click=${() => this.select(kind)}
      >${selected ? `[${text}]` : text}</button>
    `;
  }

  private renderView(kind: ViewKind, active: boolean) {
    switch (kind) {
      case 'stack':
        return html`<pwn2block-stack-view .context=${this.context} .active=${active}></pwn2block-stack-view>`;
      case 'disasm':
        return html`<pwn2block-disasm-view .context=${this.context} .active=${active}></pwn2block-disasm-view>`;
      case 'registers':
        return html`<pwn2block-registers-view .context=${this.context}></pwn2block-registers-view>`;
      case 'memory':
        return html`<pwn2block-memory-view .context=${this.context}></pwn2block-memory-view>`;
      case 'io':
        return html`<pwn2block-io-view .context=${this.context}></pwn2block-io-view>`;
      case 'pseudocode':
        return html`<pwn2block-pseudocode-view .context=${this.context}></pwn2block-pseudocode-view>`;
    }
  }

  /** 按固定顺序列出本题可用的视图；I/O、伪代码不可用时不出现。 */
  private tabs(): readonly ViewKind[] {
    return VIEW_KINDS.filter((kind) => this.available.includes(kind));
  }

  /** 存的标签本题不可用（例如 io）时退回栈，不报错。 */
  private activeKind(): ViewKind {
    return normalizeActive(this.views, this.available).active;
  }

  private select(kind: ViewKind): void {
    this.dispatchEvent(new CustomEvent('p2b-view-select', {
      detail: { kind }, bubbles: true, composed: true,
    }));
  }

  private readonly onTabKey = (event: KeyboardEvent): void => {
    // 带修饰键的组合不归标签栏：Alt+← 是浏览器后退，Ctrl+↑/↓ 由页面壳处理。
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = this.keyTarget(event.key);
    if (target === undefined) return;
    event.preventDefault();
    if (target !== this.activeKind()) this.select(target);
    this.renderRoot.querySelector<HTMLButtonElement>(`#tab-${target}`)?.focus();
  };

  private keyTarget(key: string): ViewKind | undefined {
    const tabs = this.tabs();
    const state = { active: this.activeKind() };
    switch (key) {
      case 'ArrowLeft':
        return cycleView(state, -1, this.available).active;
      case 'ArrowRight':
        return cycleView(state, 1, this.available).active;
      case 'Home':
        return tabs[0];
      case 'End':
        return tabs[tabs.length - 1];
      default:
        return undefined;
    }
  }
}

customElements.define('pwn2block-view-manager', Pwn2BlockViewManager);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-view-manager': Pwn2BlockViewManager;
  }
}
