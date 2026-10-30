/**
 * Pwn2Block 的严格 TUI 主题（设计 §1）。
 *
 * 只用一个背景色，不用渐变、阴影、半透明和圆角；面板之间靠边框分隔，层级靠颜色、
 * 粗体和反显区分，不调字号。每种颜色只表示一种语义（见下方 token 表）。
 */
import { css } from 'lit';

export const terminalTheme = css`
  :host {
    --p2b-bg: #0c0c0c;
    --p2b-fg: #ffffff;
    --p2b-dim: #c3c3c3;
    --p2b-line: #6a6a6a;
    /* 面板与控件的边框宽度；表格、列表的行分隔线保持 1px，避免密集行显得太重。 */
    --p2b-border: 2px;
    --p2b-addr: #8fa1b3;
    --p2b-changed: #e5c07b;
    --p2b-error: #e06c75;
    --p2b-hidden: #c678dd;
    --p2b-ip: #98c379;
    --p2b-code: #d19a66;
    --p2b-stack: #56b6c2;
    --p2b-data: #61afef;
    --p2b-focus: #ffffff;
    /*
     * 伪代码语法着色（视图「伪代码」）。它与上面的「值区域」色分属两条轴：值区域的颜色
     * 说明这块数据落在哪个 VMA，这里的颜色只说明这是代码里的哪类词，同一屏里不会混用。
     * 因此另起一套 token 名，调其中一侧不会波及另一侧。
     */
    --p2b-syn-comment: #7f848e;
    --p2b-syn-preprocessor: #56b6c2;
    --p2b-syn-string: #98c379;
    --p2b-syn-number: #d19a66;
    --p2b-syn-keyword: #c678dd;
    --p2b-syn-type: #e5c07b;
    --p2b-syn-function: #61afef;
    --p2b-font: ui-monospace, "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace;
    --p2b-size: 14px;
    --p2b-topbar-h: 2.5rem;
    color-scheme: dark;
    font-family: var(--p2b-font);
    font-size: var(--p2b-size);
    line-height: 1.5;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }
`;

export const sharedStyles = css`
  * {
    box-sizing: border-box;
  }

  h2,
  h3 {
    margin: 0;
    color: var(--p2b-fg);
    font-size: inherit;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  h3 {
    color: var(--p2b-dim);
  }

  button,
  input,
  summary {
    font: inherit;
  }

  button {
    min-height: 2rem;
    padding: 0.34rem 0.4rem;
    border: var(--p2b-border) solid var(--p2b-line);
    border-radius: 0;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    font-family: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled):not([aria-disabled='true']),
  button[aria-selected='true'],
  button[aria-pressed='true'],
  button.on,
  button:active:not(:disabled):not([aria-disabled='true']) {
    color: var(--p2b-bg);
    background: var(--p2b-fg);
  }

  /* aria-disabled 的按钮保持可聚焦（禁用原因要能被键盘和读屏拿到），外观与 :disabled 一致。 */
  button:disabled,
  button[aria-disabled='true'] {
    color: var(--p2b-dim);
    background: var(--p2b-bg);
    cursor: not-allowed;
  }

  input[type='text'],
  input[type='number'] {
    width: 11rem;
    min-height: 2rem;
    padding: 0.3rem 0.55rem;
    border: var(--p2b-border) solid var(--p2b-line);
    border-radius: 0;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    outline: none;
  }

  input[type='text']:focus,
  input[type='number']:focus {
    border-color: var(--p2b-focus);
  }

  input[type='checkbox'] {
    accent-color: var(--p2b-fg);
  }

  a,
  summary {
    color: var(--p2b-fg);
  }

  :focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--p2b-focus);
    outline-offset: 2px;
  }

  code,
  table,
  kbd,
  .mono,
  .bytes,
  .text {
    font-family: var(--p2b-font);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    border: var(--p2b-border) solid var(--p2b-line);
    background: var(--p2b-bg);
  }

  th,
  td {
    padding: 0.3rem 0.55rem;
    text-align: left;
    white-space: nowrap;
  }

  thead th {
    color: var(--p2b-dim);
    font-weight: 700;
  }

  tbody tr:not(:last-child) td,
  tbody tr:not(:last-child) th {
    border-bottom: 1px solid var(--p2b-line);
  }

  tbody tr:hover td,
  tbody tr:hover th {
    color: var(--p2b-bg);
    background: var(--p2b-fg);
  }

  .mono-dim {
    color: var(--p2b-dim);
  }

  .changed {
    color: var(--p2b-changed);
  }

  .hidden-tag {
    color: var(--p2b-hidden);
  }

  .empty {
    color: var(--p2b-dim);
  }

  .panel {
    border: var(--p2b-border) solid var(--p2b-line);
    border-radius: 0;
    background: var(--p2b-bg);
  }

  .note {
    color: var(--p2b-dim);
  }

  /* .box 容器：实线边框，标题嵌在上边框里（┌─ 标题 ──┐）。 */
  .box {
    position: relative;
    border: var(--p2b-border) solid var(--p2b-line);
    border-radius: 0;
    background: var(--p2b-bg);
  }

  .box > .box-title {
    position: absolute;
    top: -0.7em;
    left: 0.6rem;
    padding: 0 0.3rem;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }

  .box > .box-title::before {
    content: '─ ';
    content: '─ ' / '';
  }

  .box > .box-title::after {
    content: ' ─';
    content: ' ─' / '';
  }
`;
