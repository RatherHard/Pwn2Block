/**
 * 视图管理器（05 §2.1）。
 *
 * 同时显示 2 个槽位（上下排列），勾选显示的视图按顺序纵向排列，
 * 纵向平滑滚动切换窗口；`Ctrl+↑ / Ctrl+↓` 由页面壳改 `offset`，这里只负责把窗口滚到位。
 * 数据来源对所有视图都是同一份最新投影（`ViewContext`）。
 */
import { LitElement, css, html } from 'lit';
import type { PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  SLOT_COUNT,
  hasMoreAbove,
  hasMoreBelow,
  slotKinds,
  type ViewKind,
  type ViewManagerState,
} from '../viewmodel/views';
import { sharedStyles, terminalTheme } from '../theme';
import './disasm-view';
import './io-view';
import './memory-view';
import './registers-view';
import './stack-view';
import type { ViewContext } from './view-context';

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
      }
      .head {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        min-height: 3.3rem;
        padding: 0.75rem 0.9rem;
        border-bottom: 1px solid var(--p2b-line);
        background: rgb(17 31 51 / 72%);
      }
      .head h2 {
        margin-right: auto;
      }
      .spacer {
        display: none;
      }
      .viewport {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        scroll-behavior: smooth;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .slot {
        height: calc(50% - 1px);
        min-height: 13rem;
        overflow: auto;
        border-bottom: 1px solid var(--p2b-line);
        background: rgb(8 17 31 / 28%);
      }
      .slot + .slot {
        background: rgb(17 31 51 / 20%);
      }
      .slot-empty {
        display: grid;
        height: 100%;
        place-items: center;
        margin: 0;
        padding: 1.5rem;
        color: var(--p2b-dim);
        text-align: center;
      }
      @media (max-width: 980px) {
        .slot {
          height: 28rem;
        }
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
    this.available = [];
  }

  private viewportElement?: HTMLElement;

  override render() {
    const shown = this.views?.shown ?? [];
    if (shown.length === 0) {
      return html`
        <div class="head"><h2>视图</h2></div>
        <p class="slot-empty">所有视图都被隐藏了。在顶部「视图」菜单里勾选要显示的视图。</p>
      `;
    }
    const slots = slotKinds(this.views);
    return html`
      <div class="head">
        <h2>视图</h2>
        <span class="note"
          >${this.views.offset + 1}–${Math.min(this.views.offset + SLOT_COUNT, shown.length)} / ${shown.length}</span
        >
        <span class="note">Ctrl+↑ / Ctrl+↓ 切换视图</span>
        <span class="spacer"></span>
        <span class="note">
          ${hasMoreAbove(this.views) ? '▲ 上方还有视图 ' : ''}${hasMoreBelow(this.views) ? '▼ 下方还有视图' : ''}
        </span>
      </div>
      <div class="viewport">
        ${repeat(
          shown,
          // 按视图种类做 key：列表重排 / 隐藏时复用同一个元素实例，
          // 视图自己的局部状态（栈窗口起点、选中的 VMA、点击的 target）不会被清掉。
          (kind) => kind,
          (kind, index) => html`
            <div class="slot" data-slot=${slots.indexOf(kind)} data-index=${index}>${this.renderView(kind)}</div>
          `,
        )}
      </div>
    `;
  }

  private renderView(kind: ViewKind) {
    switch (kind) {
      case 'stack':
        return html`<pwn2block-stack-view .context=${this.context}></pwn2block-stack-view>`;
      case 'disasm':
        return html`<pwn2block-disasm-view .context=${this.context}></pwn2block-disasm-view>`;
      case 'registers':
        return html`<pwn2block-registers-view .context=${this.context}></pwn2block-registers-view>`;
      case 'memory':
        return html`<pwn2block-memory-view .context=${this.context}></pwn2block-memory-view>`;
      case 'io':
        return html`<pwn2block-io-view .context=${this.context}></pwn2block-io-view>`;
    }
  }

  override firstUpdated(): void {
    this.viewportElement = this.renderRoot.querySelector<HTMLElement>('.viewport') ?? undefined;
    this.syncScroll();
  }

  override updated(changed: PropertyValues): void {
    if (changed.has('views')) this.syncScroll();
  }

  /** 一个槽位的高度是视口的一半，`offset` 即窗口起点（05 §2.1）。 */
  private syncScroll(): void {
    const element = this.viewportElement;
    if (element === undefined || this.views === undefined) return;
    const target = (this.views.offset * element.clientHeight) / SLOT_COUNT;
    if (Math.abs(element.scrollTop - target) > 1) element.scrollTo({ top: target, behavior: 'smooth' });
  }
}

customElements.define('pwn2block-view-manager', Pwn2BlockViewManager);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-view-manager': Pwn2BlockViewManager;
  }
}
