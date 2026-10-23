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
    padding-left: 0.35rem;
    border: 1px solid var(--p2b-line);
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

  /* 左上角分类色条：白的底子上只留一条 3px 竖条，颜色说明节点属于哪一类。 */
  .tone-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--p2b-data);
  }

  .tone-variable .tone-bar {
    background: var(--p2b-code);
  }

  .tone-flow .tone-bar {
    background: var(--p2b-ip);
  }

  .tone-convert .tone-bar {
    background: var(--p2b-stack);
  }

  .tone-method .tone-bar {
    background: var(--p2b-hidden);
  }

  .title {
    padding: 0.1rem 0.35rem;
    border-bottom: 1px solid var(--p2b-line);
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

  /* 端口坐标是端口中心：用 translate 把 10px 的小方框对到中心点上。 */
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
    background: var(--p2b-fg);
  }

  .port.hollow {
    background: var(--p2b-bg);
  }

  .port.port-error {
    border-color: var(--p2b-error);
    background: var(--p2b-error);
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

