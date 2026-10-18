/**
 * 伪代码视图：出题人写的 `pseudocode.c`，随公开包下发（01 §4）。只在公开包带了伪代码时出现
 * （`availableViews`，viewmodel/views.ts）。
 *
 * 等宽、只读、不着色：文本经 Lit 插值进 `<pre>`，按纯文本渲染，伪代码里的 `<` `&` 原样显示。
 */
import { LitElement, css, html } from 'lit';
import { sharedStyles, terminalTheme } from '../theme';
import type { ViewContext } from './view-context';

export class Pwn2BlockPseudocodeView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      pre {
        margin: 0;
        font-family: inherit;
        white-space: pre;
        tab-size: 4;
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;

  override render() {
    const pseudocode = this.context?.challenge?.pseudocode;
    if (pseudocode === undefined) return html``;
    return html`<pre aria-label="题目伪代码">${pseudocode}</pre>`;
  }
}

customElements.define('pwn2block-pseudocode-view', Pwn2BlockPseudocodeView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-pseudocode-view': Pwn2BlockPseudocodeView;
  }
}
