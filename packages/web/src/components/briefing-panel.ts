/**
 * 题面与提示面板（05 §1、§5）：可折叠，显示 `briefing` 与逐级揭示的 `hints`。
 *
 * 用原生 `<details>`：键盘可达、屏幕阅读器可读，折叠状态交给浏览器，页面壳不必为
 * “展开 / 收起”维护一份状态。
 *
 * 提示的判定全在 `viewmodel/hints.ts`（纯函数）：这里只负责
 * 「本地读出已揭示条数 → 渲染 → 点按钮写回」，进度是**便利**而不是前提，存储不可用
 * 或数据损坏都退化成当前页面内存（05 §5、handoff §4）。
 */
import { LitElement, css, html } from 'lit';
import { parseMarkdown } from '../viewmodel/briefing';
import { markdownStyles, renderMarkdown } from './markdown';
import type { Hint } from '@pwn2block/shared';
import {
  defaultStore,
  hintPanelModel,
  readRevealed,
  writeRevealed,
  type KeyValueStore,
} from '../viewmodel/hints';
import { sharedStyles, terminalTheme } from '../theme';

const EMPTY_HINTS: readonly Hint[] = [];

export class Pwn2BlockBriefingPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    markdownStyles,
    css`
      details {
        padding: 0.75rem 0.9rem 0.85rem;
      }
      summary {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        color: var(--p2b-fg);
        cursor: pointer;
        font-weight: 700;
      }
      summary::before {
        color: var(--p2b-accent);
        content: '◈';
      }
      .content {
        max-height: min(28vh, 16rem);
        overflow: auto;
        scrollbar-gutter: stable;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .briefing {
        max-width: 75rem;
        margin: 0.75rem 0 0;
        padding: 0.75rem 0.85rem;
        border: 1px solid var(--p2b-line-soft);
        border-radius: 0.55rem;
        color: var(--p2b-dim);
        background: rgb(7 17 31 / 42%);
        overflow-wrap: anywhere;
      }
      .hints {
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--p2b-line-soft);
      }
      .hints h3 {
        margin: 0 0 0.4rem;
      }
      .hints ol {
        margin: 0;
        padding-left: 1.45rem;
      }
      .hints li {
        margin: 0.35rem 0;
        padding-left: 0.25rem;
      }
      .tag {
        display: inline-block;
        margin-right: 0.45rem;
        padding: 0.1rem 0.4rem;
        border: 1px solid rgb(199 167 255 / 36%);
        border-radius: 999px;
        color: var(--p2b-hidden);
        background: rgb(199 167 255 / 9%);
        font-size: 0.75rem;
      }
      .hint-actions {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
        margin: 0.65rem 0 0;
      }
      .locked {
        color: var(--p2b-warn);
      }
    `,
  ];

  static override properties = {
    /** 不用 `title`：那是 HTMLElement 的固有属性，会与 tooltip 语义撞车。 */
    challengeId: { attribute: false },
    challengeTitle: { attribute: false },
    briefing: { attribute: false },
    hints: { attribute: false },
    failures: { type: Number },
    storage: { attribute: false },
    /** 内部状态也走响应式属性：改它就要重渲染（普通字段不会触发更新）。 */
    manualRevealed: { attribute: false, state: true },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare challengeId: string;
  declare challengeTitle: string;
  declare briefing: string;
  declare hints: readonly Hint[];
  /** 投影 `failures`（04 §4）：只增不减，喂给 `unlockAfterFailures`。 */
  declare failures: number;
  /** 注入点：默认 `localStorage`，测试传替身（node 下没有它也能跑）。 */
  declare storage?: KeyValueStore;
  /** 手动揭示的条数（本地保存的最大值）；自动解锁不写进这里。 */
  declare manualRevealed: number;

  /** 已经为哪道题读过本地进度，避免每次渲染都读。 */
  private loadedFor = '';

  constructor() {
    super();
    this.challengeId = '';
    this.challengeTitle = '';
    this.briefing = '';
    this.hints = EMPTY_HINTS;
    this.failures = 0;
    this.manualRevealed = 0;
  }

  override willUpdate(): void {
    const key = `${this.challengeId}#${this.hints.length}`;
    if (this.loadedFor === key) return;
    this.loadedFor = key;
    this.manualRevealed = readRevealed(this.store(), this.challengeId, this.hints.length);
  }

  override render() {
    const model = hintPanelModel({
      hints: this.hints,
      revealed: this.manualRevealed,
      failures: this.failures,
    });
    return html`
      <details open>
        <summary>题面：${this.challengeTitle}</summary>
        <div class="content" role="region" aria-label="题面与提示" tabindex="0">
        <div class="briefing md">${renderMarkdown(parseMarkdown(this.briefing))}</div>
        ${model.total === 0 ? html`<p class="note">${model.message}</p>` : this.renderHints(model)}
        <p class="note" role="status" aria-live="polite">${this.autoNote(model)}</p>
        <p class="note">调试模式满足成功条件只提示“已满足”，不发 flag。</p>
        </div>
      </details>
    `;
  }

  /** 自动解锁要播报（05 §5「自动揭示并提示」、§7 状态变化走 `aria-live`）。 */
  private autoNote(model: ReturnType<typeof hintPanelModel>): string {
    const indexes = model.autoUnlocked.map((item) => item.index + 1);
    return indexes.length === 0 ? '' : `失败次数已达标：自动解锁第 ${indexes.join('、')} 条提示。`;
  }

  private renderHints(model: ReturnType<typeof hintPanelModel>) {
    const next = model.next;
    const locked = model.locked;
    const title =
      next !== undefined
        ? '揭示下一条提示（进度存在本地，按题目 id 区分）'
        : locked !== undefined
          ? `下一条提示要在失败 ${locked.required} 次后自动解锁（当前 ${locked.failures} 次）`
          : '提示已全部揭示';
    return html`
      <div class="hints">
        <h3>提示 ${model.revealedCount} / ${model.total}</h3>
        <ol>
          ${model.items.map(
            (item) => html`<li>
              ${item.auto ? html`<span class="tag">按失败次数解锁</span>` : ''}<span class="text md"
                >${renderMarkdown(parseMarkdown(item.text))}</span
              >
            </li>`,
          )}
        </ol>
        <p class="hint-actions">
          <button type="button" title=${title} ?disabled=${next === undefined} @click=${this.revealNext}>
            下一条提示
          </button>
          <span class="note ${locked === undefined ? '' : 'locked'}">${model.message}</span>
        </p>
      </div>
    `;
  }

  private store(): KeyValueStore | undefined {
    return this.storage ?? defaultStore();
  }

  private readonly revealNext = (): void => {
    const model = hintPanelModel({
      hints: this.hints,
      revealed: this.manualRevealed,
      failures: this.failures,
    });
    const next = model.next;
    if (next === undefined) return;
    this.manualRevealed = next.index + 1;
    // 写入失败（配额满 / 隐私模式）只影响下次打开，不影响这一次的揭示。
    writeRevealed(this.store(), this.challengeId, this.manualRevealed);
  };
}

customElements.define('pwn2block-briefing-panel', Pwn2BlockBriefingPanel);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-briefing-panel': Pwn2BlockBriefingPanel;
  }
}
