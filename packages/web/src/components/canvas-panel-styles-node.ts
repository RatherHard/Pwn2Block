import { css } from 'lit';
import { NODE_ROW_HEIGHT } from '../canvas/view-model';
import { PORT_SIZE } from './canvas-panel-geometry';

/**
 * 画布上的「方块」：白框节点、关系方框、组合与转换包络、端口、吸附预览。
 *
 * 与 `canvas-panel-styles.ts`（面板骨架与连线）拆开的理由：这半边改的是「一个节点长什么样」，
 * 那半边改的是「面板怎么分区」。反显（白底深字）沿用顶栏选中态的手法，不用圆角与阴影，
 * 所以「白方框」在深色画布上仍然最醒目。
 */

export const canvasPanelNodeStyles = css`
/* ---------------------------- 白框节点 ---------------------------- */

  .node-box {
    position: absolute;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--p2b-fg);
    color: var(--p2b-bg);
    background: var(--p2b-fg);
    overflow: hidden;
    cursor: grab;
    -webkit-user-select: none;
    user-select: none;
  }

  .node-box.selected {
    outline: 2px solid var(--p2b-changed);
  }

  .node-box.highlight {
    outline: 2px dashed var(--p2b-focus);
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
    color: var(--p2b-bg);
    background: var(--p2b-data);
    white-space: nowrap;
  }

  .tone-variable .tone-tag {
    background: var(--p2b-code);
  }

  .tone-flow .tone-tag {
    background: var(--p2b-ip);
  }

  .tone-convert .tone-tag {
    background: var(--p2b-stack);
  }

  .tone-method .tone-tag {
    background: var(--p2b-hidden);
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
    opacity: 0.72;
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
    opacity: 0.72;
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

  /* 可就地改的值带虚下划线，悬停时整行反显：一看就知道「点这里能改」。 */
  .row.editable {
    cursor: text;
  }

  .row.editable .row-value {
    text-decoration: underline dotted;
  }

  .node-box.selected .row.editable:hover {
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }

  .row-error .row-value {
    color: var(--p2b-error);
    text-decoration: underline dotted;
  }

  /* 就地编辑：输入框也走反显，避免白框里突然出现一块深色。 */
  .row-input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 1.2rem;
    padding: 0 0.2rem;
    border: 1px solid var(--p2b-bg);
    color: var(--p2b-bg);
    background: var(--p2b-fg);
    font: inherit;
    outline: none;
  }

  /* ---------------------------- 关系方框 ---------------------------- */

  .relation-box {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--p2b-line);
    color: var(--p2b-bg);
    background: var(--p2b-data);
    font-weight: 700;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }

  .cat-arith {
    background: var(--p2b-code);
  }

  .cat-compare {
    background: var(--p2b-stack);
  }

  .cat-logic {
    background: var(--p2b-hidden);
  }

  .cat-bitwise {
    background: var(--p2b-ip);
  }

  .cat-unary {
    background: var(--p2b-addr);
  }

  .cat-convert {
    background: var(--p2b-changed);
  }

  /* 悬停反显：方框是按钮式的「点一下换运算」，要有按下前的反馈。 */
  .relation-box:hover {
    border-color: var(--p2b-fg);
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }

  .relation-box.selected {
    outline: 2px solid var(--p2b-focus);
  }

  .relation-box.highlight {
    outline: 2px dashed var(--p2b-changed);
  }

  /* --------------------------- 包络与端口 --------------------------- */

  .group-box {
    position: absolute;
    border: 1px dashed var(--p2b-line);
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
    border: 1px dotted var(--p2b-line);
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
   * 端口坐标是端口中心：用 translate 把 10px 的小方框对到中心点上。
   * 平时是不抢眼的灰框（不在节点上放突兀的连接点）；所在节点选中或指针悬停时提亮放大，
   * 拉线时一眼就能找到。已接线的实心色与数据线同为 --p2b-addr。
   */
  .port {
    position: absolute;
    width: ${PORT_SIZE}px;
    height: ${PORT_SIZE}px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--p2b-line);
    background: var(--p2b-bg);
    cursor: crosshair;
    z-index: 3;
  }

  .port.connected {
    border-color: var(--p2b-addr);
    background: var(--p2b-addr);
  }

  .port.hollow {
    background: var(--p2b-bg);
  }

  .port.active:not(.flow-port),
  .port:hover:not(.flow-port) {
    border-color: var(--p2b-fg);
    transform: translate(-50%, -50%) scale(1.3);
  }

  .port.port-error {
    border-color: var(--p2b-error);
    background: var(--p2b-error);
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

  /* ---------------------------- 预览层 ----------------------------- */

  .snap-slot {
    position: absolute;
    border: 2px dashed var(--p2b-changed);
    pointer-events: none;
  }

  .snap-hint {
    position: absolute;
    padding: 0.1rem 0.3rem;
    color: var(--p2b-bg);
    background: var(--p2b-changed);
    white-space: nowrap;
    pointer-events: none;
    z-index: 6;
  }

  .marquee {
    position: absolute;
    border: 1px dashed var(--p2b-focus);
    opacity: 0.5;
    pointer-events: none;
  }
`;

