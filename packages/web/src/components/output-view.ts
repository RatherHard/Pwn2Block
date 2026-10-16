/**
 * 输出区（05 §3、§5、§6）：编译错误、逐步动作结果、错误解释与状态引导。
 *
 * 条目由 `viewmodel/output.ts` 算好（纯函数，可单测），这里只负责排版与事件：
 * 点带积木的条目 → `p2b-block-select`，由 payload 面板高亮那块积木。
 * 整块是一个 `aria-live` 区域：满足条件、失败、错误与判题结论都会播报（05 §7）。
 */
import { LitElement, css, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { OutputEntry } from '../viewmodel/output';
import { statusMarker } from '../viewmodel/session';
import { sharedStyles, terminalTheme } from '../theme';

export class Pwn2BlockOutputView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: grid;
        grid-template-columns: 1.1rem 6.5rem 1fr auto;
        gap: 0.4rem;
        align-items: baseline;
        padding: 0.1rem 0.3rem;
        border-bottom: 1px solid var(--p2b-line);
      }
      li:last-child {
        border-bottom: none;
      }
      li.ok .mark,
      li.ok .label {
        color: var(--p2b-ip);
      }
      li.warn .mark,
      li.warn .label {
        color: var(--p2b-changed);
      }
      li.error .mark,
      li.error .label {
        color: var(--p2b-error);
      }
      li.info .mark,
      li.info .label {
        color: var(--p2b-dim);
      }
      .detail {
        grid-column: 3 / span 2;
        color: var(--p2b-dim);
        white-space: pre-wrap;
      }
      .text {
        white-space: pre-wrap;
      }
      button.locate {
        padding: 0 0.3rem;
      }
    `,
  ];

  static override properties = {
    entries: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare entries: readonly OutputEntry[];

  constructor() {
    super();
    this.entries = [];
  }

  override render() {
    return html`
      <h3>输出区</h3>
      <ul role="status" aria-live="polite">
        ${repeat(
          this.entries,
          (entry) => entry.key,
          (entry) => this.renderEntry(entry),
        )}
      </ul>
    `;
  }

  private renderEntry(entry: OutputEntry) {
    const blockId = entry.blockId;
    return html`
      <li class=${entry.tone}>
        <span class="mark" aria-hidden="true">${statusMarker(entry.tone)}</span>
        <span class="label">${entry.label}</span>
        <span class="text">${entry.text}</span>
        ${blockId === undefined
          ? ''
          : html`<button
              type="button"
              class="locate"
              title="在画布上高亮这块积木"
              @click=${() => this.locate(blockId)}
            >
              定位积木
            </button>`}
        ${entry.detail === undefined ? '' : html`<span class="detail">${entry.detail}</span>`}
      </li>
    `;
  }

  private locate(blockId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ readonly blockId: string }>('p2b-block-select', {
        detail: { blockId },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define('pwn2block-output-view', Pwn2BlockOutputView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-output-view': Pwn2BlockOutputView;
  }
}
