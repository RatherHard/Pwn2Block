import { css, html } from 'lit';
import type { CSSResult } from 'lit';
import type { PortType } from '@pwn2block/shared';
import { PORT_LABELS } from '../graph/port-style';

/**
 * 节点外观（10 §7「极简 TUI 视觉方案」）。
 *
 * 画布上的节点、节点库的只读预览和面板里的结构摘要共用这一份外观：
 * 直角矩形、细边框、等宽字体，标题区与参数区用细线分隔。颜色只作辅助，
 * 选中 / 执行中 / 错误都另带文字标记，不能只靠颜色区分。
 *
 * 这里只有样式和一个静态只读预览渲染器；可交互的节点在 `graph-canvas.ts` 里，
 * 但它复用同一套类名，避免「拖入前和拖入后长得不一样」。
 */

/** 端口形状辅助区分类型：不依赖颜色也能分辨输入与类型（10 §3.4）。 */
export const PORT_SHAPES: Readonly<Record<PortType, string>> = {
  int: 'square',
  bytes: 'diamond',
  text: 'triangle',
  bool: 'circle',
};

export function portShapeClass(type: PortType): string {
  return `shape-${PORT_SHAPES[type]}`;
}

export interface StaticNodeRow {
  /** `in` / `out` 行显示端口形状，`param` 行只有文字。 */
  readonly kind: 'in' | 'out' | 'param';
  readonly label: string;
  readonly type?: PortType;
  /** 参数默认值摘要。 */
  readonly value?: string;
}

export interface StaticNodeView {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly StaticNodeRow[];
  readonly footer?: string;
  readonly status?: 'normal' | 'selected' | 'error' | 'running';
  /** 缩放很小时只留骨架：标题 + 副标题，不画端口行。 */
  readonly simplified?: boolean;
}

const STATUS_LABELS: Readonly<Record<NonNullable<StaticNodeView['status']>, string>> = {
  normal: '',
  selected: '选中',
  error: '错误',
  running: '执行中',
};

export function renderStaticNode(view: StaticNodeView): unknown {
  const status = view.status ?? 'normal';
  const statusLabel = STATUS_LABELS[status];
  return html`<div class="node static-node ${status}">
    <div class="node-head">
      <span class="node-title">${view.title}</span>
      ${statusLabel === '' ? '' : html`<span class="node-status">${statusLabel}</span>`}
    </div>
    ${view.simplified === true
      ? ''
      : html`<div class="node-body">
          ${view.rows.map(
            (row) => html`<div class="node-row ${row.kind}">
              ${row.kind === 'param'
                ? ''
                : html`<span class="port ${row.type === undefined ? '' : portShapeClass(row.type)}"></span>`}
              <span class="row-label">${row.label}</span>
              ${row.value === undefined ? '' : html`<span class="row-value">${row.value}</span>`}
              ${row.type === undefined
                ? ''
                : html`<span class="row-type">${PORT_LABELS[row.type]}</span>`}
            </div>`,
          )}
        </div>`}
    ${view.subtitle === undefined ? '' : html`<p class="node-subtitle">${view.subtitle}</p>`}
    ${view.footer === undefined ? '' : html`<p class="node-footer">${view.footer}</p>`}
  </div>`;
}

export const nodeSkin: CSSResult = css`
  .node {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--p2b-line);
    background: var(--p2b-bg);
    color: var(--p2b-fg);
    font-family: var(--p2b-font);
    font-size: var(--p2b-size);
    line-height: 1.35;
    text-align: left;
  }
  .node.selected {
    border-color: var(--p2b-fg);
    border-width: 2px;
  }
  .node.error {
    border-color: var(--p2b-error);
    border-width: 2px;
  }
  .node.running {
    border-color: var(--p2b-ip);
    border-width: 2px;
    border-style: dashed;
  }
  .node-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
    padding: 0.15rem 0.35rem;
    border-bottom: 1px solid var(--p2b-line);
    background: var(--p2b-bg);
    cursor: grab;
  }
  .node.selected .node-head {
    background: var(--p2b-changed);
    color: var(--p2b-bg);
  }
  .node-title {
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-status {
    flex: none;
    padding: 0 0.25rem;
    border: 1px solid currentColor;
    color: var(--p2b-changed);
  }
  .node.error .node-status {
    color: var(--p2b-error);
  }
  .node.running .node-status {
    color: var(--p2b-ip);
  }
  .node.selected .node-status {
    color: var(--p2b-bg);
  }
  .node-body {
    display: flex;
    flex-direction: column;
  }
  .node-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 22px;
    padding: 0 0.35rem;
    position: relative;
  }
  .node-row + .node-row {
    border-top: 1px dotted var(--p2b-line);
  }
  .row-label {
    flex: 1 1 auto;
    color: var(--p2b-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-row.out .row-label {
    text-align: right;
  }
  .row-value {
    flex: 0 1 auto;
    max-width: 8rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--p2b-data);
  }
  .row-type {
    flex: none;
    color: var(--p2b-addr);
  }
  .port {
    flex: none;
    width: 8px;
    height: 8px;
    background: var(--p2b-data);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  .node-row.in .port {
    margin-left: -0.4rem;
  }
  .node-row.out .port {
    order: 9;
    margin-right: -0.4rem;
  }
  .shape-square {
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  .shape-diamond {
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }
  .shape-triangle {
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
  }
  .shape-circle {
    clip-path: circle(50%);
  }
  .node-subtitle,
  .node-footer {
    margin: 0;
    padding: 0.1rem 0.35rem;
    border-top: 1px dotted var(--p2b-line);
    color: var(--p2b-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .static-node .node-head {
    cursor: default;
  }
`;
