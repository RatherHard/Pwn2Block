import { css } from 'lit';

/** 三栏 TUI 画布：白边节点、彩边关系、常驻侧栏与右键菜单。颜色沿用主题变量。 */

export const canvasPanelStyles = css`
  .canvas-context-menu { position: absolute; z-index: 20; width: 210px; border: 1px solid var(--p2b-fg); background: var(--p2b-bg); padding: 0.25rem; }
  .canvas-context-menu button { display: flex; justify-content: space-between; width: 100%; min-height: 1.9rem; text-align: left; border-color: transparent; }
  .canvas-context-menu hr { border: 0; border-top: 1px solid var(--p2b-line); margin: 0.25rem 0; }

  button::before, button::after { content: none; }

  :host {
    display: block;
    height: 100%;
    min-height: 0;
    border: var(--p2b-border) solid var(--p2b-line);
    background: var(--p2b-bg);
    outline: none;
  }

  :host(:focus-visible) {
    border-color: var(--p2b-focus);
  }

  /*
   * 三段：顶栏 / 三栏主体 / 步骤与轮次。
   * 「步骤与轮次」单独占最后一行（整宽），而不是塞进中间一列：三栏的列宽由工具箱与检查器
   * 决定，把它放进中间列会让表格的可读宽度跟着侧栏变，窄屏上几乎没法看。
   */
  .panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
    min-height: 0;
  }

  /* ------------------------------ 顶栏 ------------------------------ */

  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.35rem;
    border-bottom: var(--p2b-border) solid var(--p2b-line);
  }

  .top button {
    min-height: 1.7rem;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .status {
    display: flex;
    gap: 0.6rem;
    color: var(--p2b-dim);
    white-space: nowrap;
  }

  /* 未接线单列：它是编辑期的正常状态，不该和红色错误挤在一起。 */
  .status-error {
    color: var(--p2b-error);
  }

  .status-warn {
    color: var(--p2b-changed);
  }

  .status-unconnected {
    color: var(--p2b-addr);
  }

  .status-revision {
    color: var(--p2b-dim);
  }

  .message {
    flex-basis: 100%;
    color: var(--p2b-changed);
  }

  .hint {
    margin: 0;
    color: var(--p2b-dim);
  }

  /* ------------------------------ 三栏 ------------------------------ */

  .body {
    display: grid;
    grid-template-columns: 20rem minmax(0, 1fr) 18rem;
    min-height: 0;
  }

  /* 窄窗口收紧侧栏，为画布保留可操作宽度；宽屏保持加宽的节点库。 */
  @media (max-width: 1000px) {
    .body { grid-template-columns: 15rem minmax(0, 1fr) 13rem; }
  }

  .toolbox {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.4rem;
    border-right: var(--p2b-border) solid var(--p2b-line);
    overflow-y: auto;
  }

  .toolbox-actions {
    display: flex;
    gap: 0.3rem;
  }

  /* 操作按钮并排，文字保持单行。 */
  .toolbox-actions button {
    flex: 1 1 0;
    min-height: 1.7rem;
    padding: 0 0.3rem;
    white-space: nowrap;
  }

  .toolbox-actions button::before,
  .toolbox-actions button::after {
    content: none;
  }

  .toolbox-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* ------------------------------ 画布 ------------------------------ */

  .stage {
    position: relative;
    touch-action: none;
    min-height: 0;
    overflow: auto;
    background: var(--p2b-bg);
  }

  .stage > .hint {
    padding: 0.6rem;
  }

  .surface {
    position: absolute;
    left: 0;
    top: 0;
  }

  .edges {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
  }

  .edge {
    fill: none;
    stroke-width: 2;
  }

  /* 数据边（地址灰）与流程边（栈青）分色，箭头由渲染层的 marker 负责。 */
  .edge-data {
    stroke: var(--p2b-addr);
  }

  .edge-flow {
    stroke: var(--p2b-stack);
  }


`;
