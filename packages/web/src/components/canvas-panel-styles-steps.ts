import { css } from 'lit';

/**
 * 「步骤与轮次」区的样式（`canvas-panel-steps.ts` 用）。
 *
 * 与 `canvas-panel-styles.ts` 同一套口径：只用主题 token、直角、不调字号（字号继承 `--p2b-size`）。
 * 这一块是一张**真表格**：五列固定含义，行数与列宽由内容决定，所以横向溢出交给滚动而不是压缩文字
 * （需求 §7 要「当时的值」原样可读，截断会把值看错）。
 *
 * 单独成文件的理由与侧栏那份一样：改「画布几何」和改「步骤表」的理由不同，放一起会越长越难读。
 */

export const canvasPanelStepsStyles = css`
  .steps {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: var(--p2b-border) solid var(--p2b-line);
    background: var(--p2b-bg);
  }

  .steps-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.35rem;
  }

  .steps-head h3 {
    margin: 0;
  }

  /* 「还没有可执行的步骤」：与顶栏提示同一口径，用 dim 表示「非错误、只是没有」。 */
  .steps-empty {
    margin: 0;
    padding: 0.2rem 0.45rem 0.35rem;
    color: var(--p2b-dim);
  }

  /* 窄屏允许横向滚动：值不换行、不省略号，滚出来才看得全。 */
  .steps-body {
    max-height: 11rem;
    overflow-x: auto;
    overflow-y: auto;
  }

  .steps-table {
    width: 100%;
    border: 1px solid var(--p2b-line);
    border-collapse: collapse;
    border-radius: 0;
    background: var(--p2b-bg);
  }

  .steps-table th,
  .steps-table td {
    padding: 0.1rem 0.45rem;
    border-bottom: 1px solid var(--p2b-line);
    text-align: left;
    white-space: nowrap;
  }

  .steps-table thead th {
    color: var(--p2b-dim);
    font-weight: 700;
  }

  .steps-table tbody tr {
    cursor: pointer;
  }

  .steps-table tbody tr:last-child td {
    border-bottom: 0;
  }

  /* 选中态：与画布上节点盒子的选中同一手法——整行反显，而不是只加个色条。 */
  .steps-table tbody tr.is-selected td {
    color: var(--p2b-bg);
    background: var(--p2b-fg);
  }

  .step-index {
    color: var(--p2b-addr);
  }

  /* 轮次是「为什么这一步值不同」的关键，用 changed 色；读入与之后是数据，用 dim。 */
  .step-rounds {
    color: var(--p2b-changed);
  }

  .step-inputs,
  .step-variables {
    color: var(--p2b-dim);
  }

  .steps-table tbody tr.is-selected .step-index,
  .steps-table tbody tr.is-selected .step-rounds,
  .steps-table tbody tr.is-selected .step-inputs,
  .steps-table tbody tr.is-selected .step-variables {
    color: var(--p2b-bg);
  }
`;
