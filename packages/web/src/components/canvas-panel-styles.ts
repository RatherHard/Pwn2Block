import { css } from 'lit';

/**
 * 画布面板的 TUI 样式（设计 §1、需求 §6.1）。
 *
 * 与仓库其他组件同一套口径：**只引用主题 token，不用渐变、阴影、圆角和半透明色**，
 * 层级靠边框、粗细与反显区分，字号统一继承 `--p2b-size`（`tui-style.test.ts` 会逐条断言）。
 *
 * 需求里「白底、圆角、轻阴影的白方框」在这里落成**反显**：`背景 = --p2b-fg`、`文字 = --p2b-bg`，
 * 和顶栏 `.modes button.on` 是同一个手法——深色画布上一块白色仍然是最醒目的「节点」，
 * 而圆角与阴影被终端风格换成了 1px 灰边与虚线选中框。关系方框的「配色区分」也改成用
 * 语义 token（运算=code、比较=stack、逻辑=hidden…），并且框里始终有标号，不靠颜色单独传达。
 */

export const canvasPanelStyles = css`
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
    grid-template-columns: 13rem minmax(0, 1fr) 17rem;
    min-height: 0;
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

  .toolbox-actions button {
    flex: 1 1 auto;
    min-height: 1.7rem;
  }

  .toolbox-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* ------------------------------ 画布 ------------------------------ */

  .stage {
    position: relative;
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

  .edge-wire {
    stroke: var(--p2b-focus);
    stroke-dasharray: 4 4;
  }

`;
