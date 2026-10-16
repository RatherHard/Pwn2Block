/**
 * Pwn2Block 的基础主题。
 *
 * 页面用深色工作台承载题面、状态和调试数据；正文使用无衬线字体，地址、指令和
 * 二进制数据保留等宽字体，减少视觉噪声，也让真正需要对齐的内容更容易扫读。
 */
import { css } from 'lit';

export const terminalTheme = css`
  :host {
    --p2b-bg: #08111f;
    --p2b-bg-alt: #0d1829;
    --p2b-panel: #111f33;
    --p2b-panel-raised: #162840;
    --p2b-line: #263b56;
    --p2b-line-soft: #1b2d45;
    --p2b-fg: #e8eef7;
    --p2b-dim: #91a4bd;
    --p2b-accent: #5ee1c2;
    --p2b-accent-strong: #23c9a6;
    --p2b-changed: #ffd166;
    --p2b-warn: #f4b860;
    --p2b-error: #ff7f95;
    --p2b-hidden: #c7a7ff;
    --p2b-focus: #70a7ff;
    --p2b-shadow: 0 18px 45px rgb(0 0 0 / 24%);
    color-scheme: dark;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.55;
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
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  h2::before {
    width: 0.42rem;
    height: 0.42rem;
    border-radius: 999px;
    background: var(--p2b-accent);
    box-shadow: 0 0 0 4px rgb(94 225 194 / 10%);
    content: "";
  }

  h3 {
    color: var(--p2b-dim);
    font-size: 0.7rem;
  }

  button,
  input,
  summary {
    font: inherit;
  }

  button {
    min-height: 2rem;
    padding: 0.34rem 0.7rem;
    border: 1px solid var(--p2b-line);
    border-radius: 0.55rem;
    color: var(--p2b-fg);
    background: linear-gradient(180deg, rgb(28 48 75 / 92%), rgb(19 35 56 / 92%));
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background 140ms ease,
      color 140ms ease,
      transform 140ms ease;
  }

  button:hover:not(:disabled) {
    border-color: var(--p2b-accent);
    color: var(--p2b-accent);
    background: linear-gradient(180deg, rgb(31 67 87 / 96%), rgb(22 49 69 / 96%));
    transform: translateY(-1px);
  }

  button:active:not(:disabled) {
    transform: translateY(0);
  }

  button:disabled {
    color: var(--p2b-dim);
    background: rgb(18 31 49 / 70%);
    cursor: not-allowed;
    opacity: 0.62;
  }

  button[aria-pressed='true'],
  button.on {
    border-color: var(--p2b-accent);
    color: #06151a;
    background: var(--p2b-accent);
    box-shadow: 0 0 0 3px rgb(94 225 194 / 10%);
  }

  input[type='text'],
  input[type='number'] {
    width: 11rem;
    min-height: 2rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--p2b-line);
    border-radius: 0.5rem;
    color: var(--p2b-fg);
    background: #091525;
    outline: none;
  }

  input[type='text']:focus,
  input[type='number']:focus {
    border-color: var(--p2b-focus);
    box-shadow: 0 0 0 3px rgb(112 167 255 / 13%);
  }

  input[type='checkbox'] {
    accent-color: var(--p2b-accent);
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
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  }

  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    border: 1px solid var(--p2b-line-soft);
    border-radius: 0.55rem;
    background: rgb(7 17 31 / 42%);
  }

  th,
  td {
    padding: 0.42rem 0.55rem;
    text-align: left;
    white-space: nowrap;
  }

  thead th {
    color: var(--p2b-dim);
    background: rgb(24 42 66 / 70%);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  tbody tr:not(:last-child) td,
  tbody tr:not(:last-child) th {
    border-bottom: 1px solid var(--p2b-line-soft);
  }

  tbody tr:hover td,
  tbody tr:hover th {
    background: rgb(50 83 111 / 18%);
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
    border: 1px solid var(--p2b-line);
    border-radius: 0.75rem;
    background: var(--p2b-panel);
    box-shadow: var(--p2b-shadow);
  }

  .note {
    color: var(--p2b-dim);
  }
`;
