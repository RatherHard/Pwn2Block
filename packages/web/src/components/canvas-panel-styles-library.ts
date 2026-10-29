import { css } from 'lit';

/**
 * 左侧节点库：搜索、分类标签页、分级列表、翻页与预览。
 *
 * 同一套 TUI 口径：层级靠边框、粗细与反显，不调字号；分类标签页的选中态沿用全局
 * `button[aria-pressed='true']` 的反显。分级用缩进 + 左侧细线表示（分类 → 小类 → 条目），
 * 不靠颜色单独传达。
 */

export const canvasPanelLibraryStyles = css`
  .library-tabs { flex-direction: column; }
  .library-tab { display: flex; justify-content: space-between; padding: 0.5rem; }
  .library-back { text-align: left; }
  .tool, .tool-block { display: block; width: 100%; text-align: left; padding: 0.5rem; white-space: normal; }
  .library-preview { display: block; text-align: left; }
  .preview-desc, .preview-usage { margin: 0.3rem 0 0; white-space: normal; }

  /* 分组本身是 flex：不显式写 hidden，浏览器默认的 display: none 会被盖掉。 */
  .toolbox [hidden] {
    display: none !important;
  }

  .library-query {
    width: 100%;
  }

  .library-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
  }

  /* 标签页去掉「[ ]」装饰：一排九个按钮带括号会挤成两三行，靠边框已经看得出是按钮。 */
  .library-tab {
    min-height: 1.6rem;
    padding: 0 0.3rem;
    border-width: 1px;
  }

  .library-tab::before,
  .library-tab::after {
    content: none;
  }

  .tab-count {
    margin-left: 0.25rem;
    color: var(--p2b-dim);
  }

  .library-tab[aria-pressed='true'] .tab-count,
  .library-tab:hover .tab-count {
    color: var(--p2b-bg);
  }

  /*
   * 列表自己滚动：只写 min-height: 0 会让它缩到内容以下，溢出的条目压在预览底下点不到。
   * 预览位于各自选项内部，与选项一起滚动。
   */
  .library-list {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    overflow-y: auto;
  }

  .group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: 0.15rem;
    border-bottom: 1px solid var(--p2b-line);
  }

  .group-count {
    color: var(--p2b-dim);
  }

  /* 第二级：小类名 + 左侧细线，条目缩进挂在线下。 */
  .library-tier {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-left: 0.2rem;
    padding-left: 0.45rem;
    border-left: 1px solid var(--p2b-line);
  }

  .tier-label {
    color: var(--p2b-dim);
  }

  .tool,
  .tool-block {
    width: 100%;
    min-height: 1.7rem;
    text-align: left;
    cursor: grab;
  }

  /* 题目方法与目录节点区分：虚线边框 + 前缀「本题」由小类名说明，不只靠颜色。 */
  .tool-block {
    border-style: dashed;
  }


  .library-empty {
    padding: 0.3rem 0;
  }

  .library-pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
  }

  .library-pager button {
    min-height: 1.6rem;
    padding: 0 0.3rem;
  }

  .page-of {
    color: var(--p2b-dim);
    white-space: nowrap;
  }

  /* ------------------------------ 预览 ------------------------------ */

  .library-preview {
    flex: 0 0 auto;
    margin-top: auto;
    padding: 0.35rem;
    border: 1px solid var(--p2b-line);
  }

  .library-preview p {
    margin: 0.3rem 0 0;
  }

  .preview-head {
    color: var(--p2b-dim);
  }

  .preview-figure {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    margin-top: 0.3rem;
  }

  .preview-node {
    flex: 1 1 auto;
    min-width: 0;
    border: 1px solid var(--p2b-fg);
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }

  .preview-title {
    padding: 0 0.3rem;
    border-bottom: 1px solid var(--p2b-line);
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .preview-row {
    display: flex;
    justify-content: space-between;
    gap: 0.3rem;
    padding: 0 0.3rem;
  }

  .preview-row + .preview-row {
    border-top: 1px dotted var(--p2b-line);
  }

  .preview-row .row-label {
    opacity: 0.72;
    white-space: nowrap;
  }

  .preview-row .row-value {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .preview-relation {
    min-width: 3rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--p2b-line);
    color: var(--p2b-fg);
    font-weight: 700;
    text-align: center;
  }

  .preview-desc {
    color: var(--p2b-fg);
  }

  .preview-usage {
    color: var(--p2b-addr);
  }
`;
