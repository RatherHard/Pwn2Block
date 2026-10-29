import { css } from 'lit';
import { NODE_ROW_HEIGHT } from '../canvas/view-model';

/** 白框节点、彩色关系框、包络与外置流程连接点。 */

export const canvasPanelNodeStyles = css`
/* ---------------------------- 白框节点 ---------------------------- */

  .node-box {
    position: absolute;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--p2b-fg);
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    overflow: hidden;
    cursor: grab;
    -webkit-user-select: none;
    user-select: none;
  }

  .node-box.selected {
    outline: 2px solid var(--p2b-changed);
  }


  /*
   * 标题栏：左边是分类标签（色块 + 类别名，颜色不单独传达），右边是节点名。
   * 高度与旧标题行一致，端口的纵向位置（盒顶 + 24 起）仍然对着第一行。
   */
  .title-bar {
    display: flex;
    align-items: stretch;
    min-width: 0;
    border-bottom: 2px solid var(--p2b-bg);
  }

  .tone-tag {
    flex: 0 0 auto;
    padding: 0.1rem 0.3rem;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    white-space: nowrap;
  }

  .tone-variable .tone-tag {
    color: var(--p2b-code);
  }

  .tone-flow .tone-tag {
    color: var(--p2b-ip);
  }

  .tone-convert .tone-tag {
    color: var(--p2b-stack);
  }

  .tone-method .tone-tag {
    color: var(--p2b-hidden);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.1rem 0.35rem;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subtitle {
    padding: 0 0.35rem;
    color: var(--p2b-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    height: ${NODE_ROW_HEIGHT}px;
    padding: 0 0.35rem;
  }

  .row + .row {
    border-top: 1px dotted var(--p2b-line);
  }

  .row-label {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--p2b-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-value {
    flex: 0 1 auto;
    max-width: 9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-error .row-value { color: var(--p2b-error); }

  /* ---------------------------- 关系方框 ---------------------------- */

  .relation-box {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--p2b-line);
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    font-weight: 700;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }

  .cat-arith {
    border-color: var(--p2b-code);
  }

  .cat-compare {
    border-color: var(--p2b-stack);
  }

  .cat-logic {
    border-color: var(--p2b-hidden);
  }

  .cat-bitwise {
    border-color: var(--p2b-ip);
  }

  .cat-unary {
    border-color: var(--p2b-addr);
  }

  .cat-convert {
    border-color: var(--p2b-changed);
  }

  .relation-box.selected {
    outline: 2px solid var(--p2b-focus);
  }


  /* --------------------------- 包络与端口 --------------------------- */

  .group-box {
    position: absolute;
    border: 1px solid var(--p2b-line);
  }

  .group-title {
    position: absolute;
    left: 0.3rem;
    top: -0.75em;
    padding: 0 0.3rem;
    color: var(--p2b-dim);
    background: var(--p2b-bg);
    white-space: nowrap;
    cursor: grab;
    -webkit-user-select: none;
    user-select: none;
  }

  .envelope-box {
    position: absolute;
    border: 1px solid var(--p2b-line);
  }

  .envelope-title {
    position: absolute;
    left: 0.3rem;
    top: -0.75em;
    padding: 0 0.3rem;
    color: var(--p2b-addr);
    background: var(--p2b-bg);
    white-space: nowrap;
  }

  /*
   * 流程连接点（需求 §6.1「外置流程连接点」）：盒子外侧的实心小方块，坐标同样是方框中心。
   * 它只是装饰——没有 data-port，不参与拉线；只有已接线的那一端才画（由渲染层过滤）。
   * 颜色沿用流程线的 --p2b-stack（与 .edge-flow 同源），不新造 token。
   */
  .flow-port {
    position: absolute;
    width: 8px;
    height: 8px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--p2b-fg);
    background: var(--p2b-fg);
    cursor: default;
    z-index: 3;
  }

  /* 入口：白块 + 流程线色描边（线从上边进来，描边把进来的那一端圈出来）。 */
  .flow-port[data-flow='in'] {
    border-color: var(--p2b-stack);
  }

  /* 出口：整块流程线色（线从这里出去，与它下方的流程边同色）。 */
  .flow-port[data-flow='out'] {
    background: var(--p2b-stack);
    border-color: var(--p2b-stack);
  }

  .marquee {
    position: absolute;
    border: 1px dashed var(--p2b-focus);
    opacity: 0.5;
    pointer-events: none;
  }
`;
