/**
 * 程序区（05 §3）：编译得到的原子动作序列，每行一个动作，当前执行位置高亮。
 *
 * - 行数据来自 `viewmodel/program.ts`（只读 H 的 `ArtifactTracker` 产物）；
 * - 点一行 → 派发 `p2b-program-select` 带上该动作的 `blockId`，由 payload 面板调
 *   `bridge.highlight(blockId)` 跳回画布（09 §3.4 的来源表）；
 * - 颜色不是唯一信息载体（05 §7）：当前行带 `▶` 与「当前执行位置」文字，已提交行带 `✓` 与「已提交」。
 */
import { LitElement, css, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { ProgramRow } from '../viewmodel/program';
import { sharedStyles, terminalTheme } from '../theme';

export interface ProgramSelectDetail {
  readonly index: number;
  readonly blockId?: string;
}

export class Pwn2BlockProgramView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
      }
      ol {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        border-bottom: 1px solid #1a231f;
      }
      li:last-child {
        border-bottom: none;
      }
      button.row {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        width: 100%;
        text-align: left;
        background: none;
        border: 1px solid transparent;
        border-radius: 2px;
        padding: 0.05rem 0.3rem;
      }
      button.row:hover:not(:disabled) {
        border-color: var(--p2b-line);
      }
      li.current button.row {
        background: #1d2a22;
        border-color: var(--p2b-accent);
      }
      li.done button.row {
        color: var(--p2b-dim);
      }
      .mark {
        width: 0.9rem;
      }
      .no {
        color: var(--p2b-dim);
        min-width: 2.2rem;
      }
      .type {
        color: var(--p2b-accent);
        min-width: 7.5rem;
      }
      li.done .type {
        color: var(--p2b-dim);
      }
      .label {
        white-space: pre-wrap;
      }
      .tag {
        margin-left: auto;
        color: var(--p2b-dim);
      }
      li.current .tag {
        color: var(--p2b-accent);
      }
      .empty {
        margin: 0;
        color: var(--p2b-dim);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .stale {
        color: var(--p2b-warn);
      }
    `,
  ];

  static override properties = {
    rows: { attribute: false },
    stale: { type: Boolean },
    cursor: { type: Number },
    emptyMessage: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare rows: readonly ProgramRow[];
  declare stale: boolean;
  declare cursor: number;
  declare emptyMessage: string;

  constructor() {
    super();
    this.rows = [];
    this.stale = false;
    this.cursor = 0;
    this.emptyMessage = '程序区还没有内容。';
  }

  override render() {
    const total = this.rows.length;
    return html`
      <div class="head">
        <h3>程序区</h3>
        <span class="note">${total} 个动作${total === 0 ? '' : ` · 当前执行位置 ${Math.min(this.cursor + 1, total)}`}</span>
        ${this.stale ? html`<span class="stale">已过期：积木已改动，请重新编译</span>` : ''}
      </div>
      ${total === 0
        ? html`<p class="empty">${this.emptyMessage}</p>`
        : html`
            <ol>
              ${repeat(
                this.rows,
                (row) => row.index,
                (row) => this.renderRow(row),
              )}
            </ol>
          `}
    `;
  }

  private renderRow(row: ProgramRow) {
    const mark = row.current ? '▶' : row.done ? '✓' : '·';
    const tag = row.current ? '当前执行位置' : row.done ? '已提交' : '';
    const title =
      row.blockId === undefined
        ? '来源表里没有对应积木：无法跳回画布定位'
        : `点这一行可在画布上高亮产生它的积木（${row.blockId}）`;
    return html`
      <li class=${[row.current ? 'current' : '', row.done ? 'done' : ''].filter((c) => c !== '').join(' ')}>
        <button
          type="button"
          class="row"
          title=${title}
          aria-current=${row.current ? 'step' : 'false'}
          @click=${() => this.select(row)}
        >
          <span class="mark" aria-hidden="true">${mark}</span>
          <span class="no">${row.index + 1}</span>
          <span class="type">${row.type}</span>
          <span class="label">${row.label}</span>
          ${tag === '' ? '' : html`<span class="tag">${tag}</span>`}
        </button>
      </li>
    `;
  }

  private select(row: ProgramRow): void {
    const detail: ProgramSelectDetail =
      row.blockId === undefined ? { index: row.index } : { index: row.index, blockId: row.blockId };
    this.dispatchEvent(
      new CustomEvent<ProgramSelectDetail>('p2b-program-select', { detail, bubbles: true, composed: true }),
    );
  }
}

customElements.define('pwn2block-program-view', Pwn2BlockProgramView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-program-view': Pwn2BlockProgramView;
  }
}
