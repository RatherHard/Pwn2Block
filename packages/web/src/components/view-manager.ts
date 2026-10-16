/**
 * View manager (P2B 2.1).
 *
 * 同时显示 2 个槽位（上下排列），勾选显示的视图按顺序纵向排列，
 * Vertical smooth scrolling switches windows; Ctrl+Up / Ctrl+Down is managed by the page shell.
 * All views consume the same latest snapshot (ViewContext).
 */
import { LitElement, css, html } from 'lit';
import type { PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  SLOT_COUNT,
  VIEW_TITLES,
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
        padding: 0.6rem 0.8rem;
        border-bottom: 1px solid var(--p2b-line);
        background: var(--p2b-bg);
      }
      .head-title {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin-right: auto;
      }
      .head h2 {
        margin: 0;
      }
      .window-title {
        color: var(--p2b-fg);
      }
      .pager {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .pager button {
        min-width: 1.8rem;
        min-height: 1.8rem;
        padding: 0.15rem 0.35rem;
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
        overflow: hidden;
        border-bottom: 1px solid var(--p2b-line);
        background: var(--p2b-bg);
      }
      .terminal-window {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
      }
      .window-bar {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        flex: none;
        min-height: 2rem;
        padding: 0.35rem 0.65rem;
        border-bottom: 1px solid var(--p2b-line);
        color: var(--p2b-dim);
        background: var(--p2b-bg);
        font-size: inherit;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .window-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        scrollbar-color: var(--p2b-line) transparent;
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

  /** Responsive properties use `declare`; see app-shell.ts for the project convention. */
  declare context: ViewContext;
  declare views: ViewManagerState;
  declare available: readonly ViewKind[];

  private observedOffset = 0;
  private scrollTarget?: number;

  constructor() {
    super();
    this.available = [];
  }

  override render() {
    const shown = this.views?.shown ?? [];
    if (shown.length === 0) {
      return html`
        <div class="head"><h2>视图</h2></div>
        <p class="slot-empty">\u6240\u6709\u89c6\u56fe\u90fd\u88ab\u9690\u85cf\u4e86\u3002\u5728\u9876\u90e8\u300c\u89c6\u56fe\u300d\u83dc\u5355\u91cc\u52fe\u9009\u8981\u663e\u793a\u7684\u89c6\u56fe\u3002</p>
      `;
    }
    const slots = slotKinds(this.views);
    return html`
      <div class="head">
        <div class="head-title"><h2>\u89c6\u56fe</h2></div>
        <span class="note">${this.views.offset + 1}\u2013${Math.min(this.views.offset + SLOT_COUNT, shown.length)} / ${shown.length}</span>
        <span class="note">Ctrl+\u2191 / Ctrl+\u2193</span>
        <div class="pager" aria-label="view pager">
          <button type="button" aria-label="previous view group" ?disabled=${!hasMoreAbove(this.views)} @click=${() => this.moveOffset(-1)}>\u2191</button>
          <button type="button" aria-label="next view group" ?disabled=${!hasMoreBelow(this.views)} @click=${() => this.moveOffset(1)}>\u2193</button>
        </div>
        <span class="spacer"></span>
        <span class="note">
          ${hasMoreAbove(this.views) ? '\u25b2 \u4e0a\u65b9\u8fd8\u6709\u89c6\u56fe ' : ''}${hasMoreBelow(this.views) ? '\u25bc \u4e0b\u65b9\u8fd8\u6709\u89c6\u56fe' : ''}
        </span>
      </div>
      <div
        class="viewport"
        @scroll=${this.onScroll}
        @scrollend=${this.onScrollEnd}
        @wheel=${this.onManualScroll}
        @pointerdown=${this.onManualScroll}
        @touchstart=${this.onManualScroll}
      >
        ${repeat(
          shown,
          (kind) => kind,
          (kind, index) => html`
            <div class="slot" data-slot=${slots.indexOf(kind)} data-index=${index}>
              ${this.renderViewWindow(kind)}
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderViewWindow(kind: ViewKind) {
    return html`
      <div class="terminal-window" aria-label=${`${VIEW_TITLES[kind]}\u7ec8\u7aef\u7a97\u53e3`}>
        <div class="window-bar">
          <span class="window-title">${VIEW_TITLES[kind]}</span>
        </div>
        <div class="window-body">${this.renderView(kind)}</div>
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

  override updated(changed: PropertyValues): void {
    if (!changed.has('views')) return;
    const previous = changed.get('views') as ViewManagerState | undefined;
    const retargeting = this.scrollTarget !== undefined && previous?.offset !== this.views?.offset;
    if (previous?.shown !== this.views?.shown || this.views?.offset !== this.observedOffset || retargeting) this.syncScroll();
  }

  private moveOffset(delta: number): void {
    const shown = this.views?.shown ?? [];
    const max = Math.max(0, shown.length - SLOT_COUNT);
    const offset = Math.min(max, Math.max(0, (this.views?.offset ?? 0) + delta));
    if (offset === this.views?.offset) return;
    this.dispatchEvent(new CustomEvent('p2b-view-scroll', {
      detail: { offset }, bubbles: true, composed: true,
    }));
  }

  private readonly onManualScroll = (): void => {
    if (this.scrollTarget === undefined) return;
    const viewport = this.renderRoot.querySelector<HTMLElement>('.viewport');
    this.scrollTarget = undefined;
    viewport?.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });
    this.onScroll();
  };

  private readonly onScrollEnd = (): void => {
    this.scrollTarget = undefined;
    this.onScroll();
  };

  private readonly onScroll = (): void => {
    const viewport = this.renderRoot.querySelector<HTMLElement>('.viewport');
    if (viewport === null || this.views === undefined) return;
    // Ignore intermediate smooth-scroll frames so they cannot override a keyboard target.
    if (this.scrollTarget !== undefined && Math.abs(viewport.scrollTop - this.scrollTarget) > 1) return;
    this.scrollTarget = undefined;
    const top = viewport.getBoundingClientRect().top;
    const slots = [...viewport.querySelectorAll<HTMLElement>('.slot')];
    let closest = 0;
    for (let index = 1; index < slots.length; index++) {
      if (Math.abs(slots[index]!.getBoundingClientRect().top - top) < Math.abs(slots[closest]!.getBoundingClientRect().top - top)) closest = index;
    }
    this.observedOffset = Math.min(closest, Math.max(0, slots.length - SLOT_COUNT));
    if (this.observedOffset === this.views.offset) return;
    this.dispatchEvent(new CustomEvent('p2b-view-scroll', {
      detail: { offset: this.observedOffset }, bubbles: true, composed: true,
    }));
  };

  /** Scroll to the actual slot position; responsive layout can change the half-screen height. */
  private syncScroll(): void {
    const element = this.renderRoot.querySelector<HTMLElement>('.viewport');
    const slot = this.renderRoot.querySelector<HTMLElement>(`[data-index="${this.views?.offset}"]`);
    if (element === null || slot === null || typeof element.scrollTo !== 'function') return;
    const target = slot.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const clamped = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight));
    if (Math.abs(element.scrollTop - clamped) > 1 || this.scrollTarget !== undefined) {
      this.scrollTarget = clamped;
      element.scrollTo({ top: clamped, behavior: 'smooth' });
    } else {
      this.onScrollEnd();
    }
  }
}

customElements.define('pwn2block-view-manager', Pwn2BlockViewManager);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-view-manager': Pwn2BlockViewManager;
  }
}
