import { css } from 'lit';
import { PORT_SIZE, ROW_HEIGHT } from '../graph/geometry';

/**
 * 画布自身的 TUI 样式（10 §7）：只引用主题变量，不用阴影、圆角、渐变与半透明。
 *
 * 单独成文件是为了让手势与渲染代码留在可读长度内；端口形状用 clip-path 区分类型，
 * 画布标签不可拖选，输入控件保留原生文字选择；手势期间统一禁止拖选。
 */
export const canvasStyles = css`
      :host {
        display: block;
        position: relative;
        height: 100%;
        min-height: 0;
        outline: none;
        border: var(--p2b-border) solid var(--p2b-line);
        background: var(--p2b-bg);
        overflow: hidden;
      }
      :host(:focus-visible) {
        border-color: var(--p2b-focus);
      }
      /* 标题、参数标签与连线文字不可拖选，输入控件仍可编辑（10 §3.2）。 */
      .viewport {
        -webkit-user-select: none;
        user-select: none;
      }
      input,
      textarea,
      [contenteditable="true"] {
        -webkit-user-select: text;
        user-select: text;
      }
      :host([data-gesture]) .viewport,
      :host([data-gesture]) .viewport * {
        -webkit-user-select: none;
        user-select: none;
      }
      :host([data-gesture]) {
        user-select: none;
        cursor: grabbing;
      }
      .viewport {
        position: absolute;
        inset: 0;
        overflow: hidden;
        touch-action: pan-y;
        cursor: grab;
      }
      .viewport.panning {
        cursor: grabbing;
      }
      svg.edges {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
      }
      .surface {
        position: absolute;
        left: 0;
        top: 0;
        transform-origin: 0 0;
        width: 0;
        height: 0;
      }
      .node {
        position: absolute;
        z-index: 2;
      }
      .node.selected {
        z-index: 3;
      }
      .node-head {
        height: ${26}px;
        box-sizing: border-box;
        /* 行容器盖住整个节点用来放端口与参数，标题栏要单独浮在上面才拖得动。 */
        position: relative;
        z-index: 1;
      }
      .node-body {
        position: absolute;
        inset: 0;
      }
      .node-row {
        position: absolute;
        left: 0;
        right: 0;
        height: ${ROW_HEIGHT}px;
        display: flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0 0.35rem;
        border: 0;
      }
      .node-row + .node-row {
        border-top: 1px dotted var(--p2b-line);
      }
      .node-subtitle,
      .node-footer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        margin: 0;
        padding: 0 0.35rem;
        border-top: 1px dotted var(--p2b-line);
        color: var(--p2b-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .node.error .node-subtitle {
        color: var(--p2b-error);
      }
      .node-config {
        flex: none;
        min-height: 1.1rem;
        padding: 0 0.2rem;
        border-width: 1px;
        color: var(--p2b-dim);
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
        max-width: 8rem;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: var(--p2b-data);
      }
      .row-value[data-invalid='true'] {
        color: var(--p2b-error);
        text-decoration: underline dotted;
      }
      .row-value[data-mode='port'] {
        color: var(--p2b-ip);
      }
      /* 端口热区比形状大，方便点中；形状本身用 clip-path 区分类型（10 §3.4）。 */
      .port-hit {
        position: absolute;
        width: ${PORT_SIZE + 6}px;
        height: ${PORT_SIZE + 6}px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: crosshair;
        z-index: 4;
      }
      .port-hit::before {
        content: '';
        content: '' / '';
        position: absolute;
        inset: 0;
      }
      .port-hit[data-kind='in']:not([data-flow='exec']) {
        left: -7px;
      }
      .port-hit[data-kind='out']:not([data-flow='exec']) {
        right: -7px;
      }
      .port-hit[data-flow='exec'] {
        left: calc(50% - ${(PORT_SIZE + 6) / 2}px);
      }
      .port-hit.exec.in {
        top: -7px;
      }
      .port-hit.exec.out {
        bottom: -7px;
      }
      .port-shape {
        width: ${PORT_SIZE}px;
        height: ${PORT_SIZE}px;
        background: var(--p2b-data);
      }
      .port-hit[data-type='int'] .port-shape {
        background: var(--p2b-code);
      }
      .port-hit[data-type='bool'] .port-shape {
        background: var(--p2b-hidden);
      }
      .port-hit[data-type='text'] .port-shape {
        background: var(--p2b-ip);
      }
      .exec-in {
        clip-path: polygon(50% 0, 100% 100%, 0 100%);
      }
      .exec-out {
        clip-path: polygon(0 0, 100% 0, 50% 100%);
      }
      .port-hit.compatible .port-shape {
        outline: 2px solid var(--p2b-focus);
        outline-offset: 1px;
      }
      .port-hit.hover .port-shape,
      .port-hit.active .port-shape,
      .port-hit.focused .port-shape {
        outline: 2px solid var(--p2b-changed);
        outline-offset: 2px;
      }
      .group {
        fill: none;
        stroke: var(--p2b-line);
        stroke-dasharray: 6 4;
      }
      .grouplabel {
        fill: var(--p2b-dim);
      }
      .region {
        fill: none;
        stroke: var(--p2b-line);
        stroke-dasharray: 4 3;
      }
      .region-label {
        fill: var(--p2b-dim);
      }
      .marquee {
        position: absolute;
        border: 1px dashed var(--p2b-focus);
        background: var(--p2b-bg);
        opacity: 0.55;
        pointer-events: none;
        z-index: 5;
      }
      .drop-hint {
        position: absolute;
        border: 2px dashed var(--p2b-changed);
        color: var(--p2b-changed);
        padding: 0.2rem 0.35rem;
        pointer-events: none;
        z-index: 5;
      }
      .empty-hint {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 1rem;
        color: var(--p2b-dim);
        pointer-events: none;
      }
      .status-line {
        position: absolute;
        left: 0.6rem;
        bottom: 0.4rem;
        right: 0.6rem;
        color: var(--p2b-dim);
        pointer-events: none;
      }
      .edge-line {
        fill: none;
        stroke-width: 2;
        pointer-events: none;
      }
      /* 接线中的临时折线：与正式连线同一套路由，虚线提示「还没落下」。 */
      .edge-line.pending {
        stroke: var(--p2b-focus);
        stroke-dasharray: 4 4;
        stroke-width: 2;
      }
      .edge-hit {
        fill: none;
        stroke: transparent;
        stroke-width: 14;
        pointer-events: stroke;
        cursor: pointer;
      }
      .edge.related .edge-line {
        stroke-width: 3;
      }
      .edge.selected .edge-line {
        stroke-dasharray: 6 3;
        stroke-width: 3;
      }
      .edge-end {
        fill: var(--p2b-bg);
        stroke: var(--p2b-focus);
        stroke-width: 1.5;
        opacity: 0;
        pointer-events: none;
        cursor: crosshair;
      }
      .edge:hover .edge-end,
      .edge.selected .edge-end {
        opacity: 1;
        pointer-events: all;
      }
      .edge:hover .edge-line {
        stroke-width: 3;
      }
`;