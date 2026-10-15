/**
 * 主题（05 §1）：只做一套终端风格深色 + 等宽字体，不做多主题。
 *
 * 所有组件都把自己的配色收敛到这里的 CSS 变量，避免各写一份色值。
 */
import { css } from 'lit';

export const terminalTheme = css`
  :host {
    --p2b-bg: #0b0e0d;
    --p2b-bg-alt: #0e1311;
    --p2b-panel: #121917;
    --p2b-line: #22302b;
    --p2b-fg: #d7e0d8;
    --p2b-dim: #7d8f86;
    --p2b-accent: #7ee787;
    --p2b-changed: #ffd866;
    --p2b-warn: #e3b341;
    --p2b-error: #ff7b72;
    --p2b-hidden: #d2a8ff;
    --p2b-focus: #58a6ff;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', monospace;
    font-size: 13px;
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
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--p2b-accent);
    margin: 0 0 0.4rem;
    text-transform: uppercase;
  }
  h3 {
    color: var(--p2b-dim);
    margin-top: 0.8rem;
  }
  button {
    font: inherit;
    color: var(--p2b-fg);
    background: #16201d;
    border: 1px solid var(--p2b-line);
    border-radius: 2px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--p2b-accent);
  }
  button:disabled {
    color: var(--p2b-dim);
    cursor: not-allowed;
  }
  button[aria-pressed='true'],
  button.on {
    border-color: var(--p2b-accent);
    color: var(--p2b-accent);
  }
  input[type='text'],
  input[type='number'] {
    font: inherit;
    color: var(--p2b-fg);
    background: #0f1513;
    border: 1px solid var(--p2b-line);
    border-radius: 2px;
    padding: 0.1rem 0.35rem;
    width: 11rem;
  }
  a,
  summary {
    color: var(--p2b-fg);
  }
  :focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--p2b-focus);
    outline-offset: 1px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 0 0.4rem;
    white-space: nowrap;
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
    font-style: normal;
  }
  .panel {
    border: 1px solid var(--p2b-line);
    background: var(--p2b-panel);
    border-radius: 3px;
  }
  .note {
    color: var(--p2b-dim);
  }
`;
