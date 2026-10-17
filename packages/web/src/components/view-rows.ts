/**
 * 五个视图共用的 pwndbg 风格逐行排版（frontend-tui 设计 §3.3）。
 *
 * - `.cmd`：视图顶部的命令栏，跳转、搜索、对齐等输入压成一行（可换行）；
 * - `.rows` + `.row`：每行一个 grid 行，用 subgrid 让各行列宽对齐，同时每行仍有自己的盒子，
 *   便于 `scrollRowInBody` 取几何位置；`.cols` 是只给视觉看的列名行；
 * - `.r-*`：值指向的区域着色（`valueRegion`），未映射不加类、用默认色。
 *
 * 只用 `--p2b-*` token，列宽交给 `max-content`，不写死像素。
 */
import { css } from 'lit';
import type { ValueRegion } from '../viewmodel/region';

export const rowStyles = css`
  :host {
    display: block;
    padding: 0.3rem 0.5rem;
  }
  .cmd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 1ch;
    margin-bottom: 0.3rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--p2b-line);
  }
  .cmd button {
    min-height: 0;
    padding: 0 0.3rem;
  }
  .cmd input[type='text'],
  .cmd input[type='number'] {
    min-height: 0;
    padding: 0 0.5ch;
  }
  .cmd input[type='text'] {
    width: 20ch;
  }
  .cmd input[type='number'] {
    width: 6ch;
  }
  .rows {
    display: grid;
    column-gap: 2ch;
    font-variant-ligatures: none;
    white-space: nowrap;
  }
  .row,
  .cols {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: baseline;
  }
  .cols {
    color: var(--p2b-dim);
  }
  /*
   * 行内可点的值 / 目标：不撑高行，也不套 [ ]。
   * 用 :where() 把特异性压到 (0,0,1)：只盖过共享样式里同为 (0,0,1) 的 button 默认色，
   * 让 .changed / .r-* 这类单类名规则仍能给按钮着色，共享样式里的反显（hover / 按下 / 选中）也照旧生效。
   */
  :where(.row) button {
    min-height: 0;
    padding: 0;
    border: none;
    background: var(--p2b-bg);
    color: inherit;
    text-align: left;
    text-decoration: underline dotted;
  }
  :where(.row) button::before,
  :where(.row) button::after {
    content: none;
  }
  .addr {
    color: var(--p2b-addr);
  }
  .dim {
    color: var(--p2b-dim);
  }
  .r-code {
    color: var(--p2b-code);
  }
  .r-stack {
    color: var(--p2b-stack);
  }
  .r-data {
    color: var(--p2b-data);
  }
  .r-hidden {
    color: var(--p2b-hidden);
  }
  /* 必须排在 .r-* 之后：同一个值既变化又指向某区域时，变化色优先。 */
  .changed {
    color: var(--p2b-changed);
  }
  .error {
    color: var(--p2b-error);
  }
`;

/** 值区域对应的着色类；未映射返回空串（用默认色，不加类）。 */
export function regionClass(region: ValueRegion): string {
  return region === 'unmapped' ? '' : `r-${region}`;
}
