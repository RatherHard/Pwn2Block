/**
 * 伪代码视图：出题人写的 `pseudocode.c`，随公开包下发（01 §4）。只在公开包带了伪代码时出现
 * （`availableViews`，viewmodel/views.ts）。
 *
 * 等宽、只读，按 C 语法着色（`viewmodel/c-syntax.ts`）：注释、预处理指令、字符串、数字、
 * 关键字、类型和函数名各用一种颜色。颜色只是可读性装饰，不承载额外信息——去掉颜色后
 * 文本照样完整。文本经 Lit 插值进 `<pre>`，伪代码里的 `<` `&` 原样显示，不会被当成标签解析。
 */
import { LitElement, css, html } from 'lit';
import type { CToken } from '../viewmodel/c-syntax';
import { tokenizeC } from '../viewmodel/c-syntax';
import { sharedStyles, terminalTheme } from '../theme';
import type { ViewContext } from './view-context';

/** 逐 token 渲染：`plain` 直接输出文本，其余包一层带类名的 `<span>`；拼接结果等于原文。 */
function renderTokens(tokens: readonly CToken[]): readonly unknown[] {
  return tokens.map(({ kind, text }) => (kind === 'plain' ? text : html`<span class=${`syn-${kind}`}>${text}</span>`));
}

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
      .syn-comment {
        color: var(--p2b-syn-comment);
      }
      .syn-preprocessor {
        color: var(--p2b-syn-preprocessor);
      }
      .syn-string {
        color: var(--p2b-syn-string);
      }
      .syn-number {
        color: var(--p2b-syn-number);
      }
      .syn-keyword {
        color: var(--p2b-syn-keyword);
      }
      .syn-type {
        color: var(--p2b-syn-type);
      }
      .syn-function {
        color: var(--p2b-syn-function);
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
    return html`<pre aria-label="题目伪代码">${renderTokens(tokenizeC(pseudocode))}</pre>`;
  }
}

customElements.define('pwn2block-pseudocode-view', Pwn2BlockPseudocodeView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-pseudocode-view': Pwn2BlockPseudocodeView;
  }
}
