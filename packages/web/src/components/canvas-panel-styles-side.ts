import { css } from 'lit';

/**
 * 画布面板右侧检查器的样式（`canvas-panel-inspector.ts` 用）。
 *
 * 与 `canvas-panel-styles.ts` 同一套口径：只用主题 token、直角、1px 边框，不调字号。
 * 单独成文件是为了让「画布」与「侧栏表单」各自留在可读长度内——两边的改动理由不同：
 * 画布跟着视图模型走，侧栏跟着目录字段走。
 */

export const canvasPanelSideStyles = css`
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.4rem;
    border-left: var(--p2b-border) solid var(--p2b-line);
    overflow-y: auto;
  }

  .inspector-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.3rem;
  }

  .inspector-id {
    color: var(--p2b-addr);
  }

  .inspector-issues {
    margin: 0;
    padding-left: 1rem;
    color: var(--p2b-error);
  }

  /* 一行一个字段：左边标签固定宽度，右边控件吃满剩余宽度。 */
  .field {
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr);
    align-items: center;
    gap: 0.3rem;
  }

  .field > label {
    color: var(--p2b-dim);
  }

  .field select,
  .field input[type='text'] {
    width: 100%;
    min-height: 1.7rem;
  }

  /* 控件下面还能挂一句说明（目前只有字面值种类选择器用）：说明跟控件同一列，不挤标签。 */
  .field-stack {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .field-stack .hint {
    margin: 0;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.3rem;
    border-top: 1px solid var(--p2b-line);
  }

  .block h4 {
    margin: 0;
    color: var(--p2b-dim);
  }

  /* 字典条目与组合行是「几个控件一行」，改成按内容伸缩的 flex。 */
  .block .field {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .block .field input[type='text'] {
    flex: 1 1 5rem;
    min-width: 0;
  }

  .block .field select {
    flex: 1 1 6rem;
    min-width: 0;
  }

  .mini {
    min-height: 1.4rem;
    padding: 0 0.3rem;
  }
`;
