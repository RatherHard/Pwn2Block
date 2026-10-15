/**
 * 题面面板（05 §1、§5）：可折叠，显示 `briefing`。
 *
 * 用原生 `<details>`：键盘可达、屏幕阅读器可读，折叠状态交给浏览器，
 * 页面壳不必为“展开 / 收起”维护一份状态。
 * 提示逐级揭示（`hints` / `unlockAfterFailures` / `localStorage`）属于 D03。
 */
import { LitElement, css, html } from 'lit';
import { sharedStyles, terminalTheme } from '../theme';

export class Pwn2BlockBriefingPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      details {
        padding: 0.35rem 0.6rem;
      }
      summary {
        cursor: pointer;
        color: var(--p2b-accent);
      }
      .briefing {
        margin: 0.4rem 0 0;
        white-space: pre-wrap;
      }
    `,
  ];

  static override properties = {
    /** 不用 `title`：那是 HTMLElement 的固有属性，会与 tooltip 语义撞车。 */
    challengeTitle: { attribute: false },
    briefing: { attribute: false },
    hintCount: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare challengeTitle: string;
  declare briefing: string;
  declare hintCount: number;

  constructor() {
    super();
    this.challengeTitle = '';
    this.briefing = '';
    this.hintCount = 0;
  }

  override render() {    return html`
      <details open>
        <summary>题面：${this.challengeTitle}</summary>
        <p class="briefing">${this.briefing}</p>
        <p class="note">
          提示 ${this.hintCount} 条：逐级揭示与本地保存将在 D03 接入（05 §5）。调试模式满足成功条件只提示“已满足”，不发 flag。
        </p>
      </details>
    `;
  }
}

customElements.define('pwn2block-briefing-panel', Pwn2BlockBriefingPanel);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-briefing-panel': Pwn2BlockBriefingPanel;
  }
}
