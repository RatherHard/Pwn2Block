import { html, nothing } from 'lit';
import type {
  GraphDocument,
  GraphNode,
  NodeKindSpec,
  PortContext,
  PortType,
} from '@pwn2block/shared';
import { portModeOf } from '../graph/editor';
import { HEADER_HEIGHT, PORT_SIZE, ROW_HEIGHT, type NodeBox, type PortAnchor } from '../graph/geometry';
import { PORT_LABELS } from '../graph/port-style';
import { portShapeClass } from './node-skin';
import { checkParam } from '../workflow/params';

/**
 * 单个节点的 DOM（10 §2.2、§7）。
 *
 * 画布内只展示属性值和连接来源；参数编辑统一在属性面板中进行。
 * 拖动从标题区（`data-drag-handle`）开始，端口保留接线操作。
 */

export interface NodeViewOptions {
  readonly box: NodeBox;
  readonly node: GraphNode;
  readonly spec: NodeKindSpec;
  readonly context: PortContext;
  readonly document: GraphDocument;
  readonly status: 'normal' | 'selected' | 'error' | 'running';
  /** 选中独立于运行/错误状态：执行高亮时仍然看得出「当前选中的是它」。 */
  readonly selected?: boolean;
  readonly simplified: boolean;
  /** 折叠容器：只显示外壳与条数摘要。 */
  readonly collapsed?: boolean;
  readonly preview?: string;
  readonly issue?: string;
  /** 兼容的端口键（`node\u0000port`），接线时高亮。 */
  readonly compatible?: ReadonlySet<string>;
  /** 正在接线的起点端口键。 */
  readonly activePort?: string;
  /** 鼠标落点命中的端口键。 */
  readonly hoverPort?: string;
  /** 属性面板里选中的端口（组装分段），也高亮。 */
  readonly focusPort?: string;
  readonly onPortDown: (event: PointerEvent, port: PortAnchor) => void;
  /** 键盘激活端口（Enter / 空格）：与点击接线同一套状态机。 */
  readonly onPortKey: (event: KeyboardEvent, port: PortAnchor) => void;
}

function portKey(nodeId: string, port: string): string {
  return `${nodeId}\u0000${port}`;
}

export function renderNodeView(options: NodeViewOptions): unknown {
  const { box, node, spec } = options;
  const statusLabel = options.status === 'normal' ? '' : statusText(options.status);
  const subtitle = options.collapsed === true
    ? options.preview ?? ''
    : options.issue ?? options.preview ?? box.subtitle;
  const classes = ['node', options.status];
  if (options.selected === true && options.status !== 'selected') classes.push('selected');
  if (options.collapsed === true) classes.push('collapsed');
  return html`<div
    class=${classes.join(' ')}
    data-node=${box.id}
    data-kind=${node.kind}
    style=${`left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`}
  >
    ${renderExecPort(options, 'in')}
    <div class="node-head" data-drag-handle="true" title="拖动这里移动节点">
      <span class="node-title" title=${spec.label}>${box.header}</span>
      ${statusLabel === '' ? nothing : html`<span class="node-status">${statusLabel}</span>`}
    </div>
    ${options.simplified
      ? nothing
      : html`<div class="node-body">${box.rows.map((row, index) => renderRow(options, row, index))}</div>`}
    ${options.simplified || subtitle === '' ? nothing : html`<p class="node-subtitle subtitle">${subtitle}</p>`}
    ${renderExecPort(options, 'out')}
  </div>`;
}

function statusText(status: 'selected' | 'error' | 'running'): string {
  if (status === 'selected') return '';
  if (status === 'error') return '错误';
  return '执行中';
}

type Row = NodeBox['rows'][number];

function renderRow(options: NodeViewOptions, row: Row, index: number): unknown {
  const { box, node, document } = options;
  const top = HEADER_HEIGHT + index * ROW_HEIGHT;
  const input = row.input;
  const output = row.output;
  const inputKey = input === undefined ? undefined : portKey(box.id, input.name);
  const active = inputKey !== undefined && options.activePort === inputKey;
  const hover = inputKey !== undefined && options.hoverPort === inputKey;
  const compatible = inputKey !== undefined && options.compatible?.has(inputKey) === true;
  const focused = inputKey !== undefined && options.focusPort === inputKey;
  const param = row.param;
  const source = input === undefined ? undefined : document.connections.find((edge) => edge.to.node === box.id && edge.to.port === input.name)?.from;
  const mode = param?.port === undefined ? undefined : portModeOf(document, box.id, param.name);
  const current = param === undefined ? undefined : node.params[param.name] ?? param.default;
  const reason = param === undefined || mode?.mode === 'port' ? undefined : checkParam(param, current);
  const value = mode?.mode === 'port'
    ? mode.source === undefined ? '未连接' : `← ${mode.source}`
    : Array.isArray(current) ? current.join(', ') || '（空）'
    : param?.options?.find((option) => option.value === String(current))?.label ?? String(current ?? '');
  const rowClass = [
    'node-row',
    input === undefined ? '' : 'has-in',
    output === undefined ? '' : 'has-out',
    param === undefined ? '' : 'has-param',
  ]
    .filter((name) => name !== '')
    .join(' ');
  return html`<div class=${rowClass} style=${`top:${top}px`}>
    ${input === undefined
      ? nothing
      : html`<span
          class="port-hit in${compatible ? ' compatible' : ''}${hover ? ' hover' : ''}${active ? ' active' : ''}${focused ? ' focused' : ''}"
          role="button"
          tabindex="0"
          data-node=${box.id}
          data-port=${input.name}
          data-kind="in"
          data-flow="data"
          data-type=${input.type}
          title=${`输入端口「${row.label}」（${PORT_LABELS[input.type]}）`}
          aria-label=${`${box.header} 的输入端口 ${row.label}（${PORT_LABELS[input.type]}）`}
          style=${`top:${ROW_HEIGHT / 2 - PORT_SIZE / 2}px`}
          @pointerdown=${(event: PointerEvent) => options.onPortDown(event, anchorOf(box, input, 'in'))}
          @keydown=${(event: KeyboardEvent) => options.onPortKey(event, anchorOf(box, input, 'in'))}
        ><span class="port-shape ${portShapeClass(input.type)}"></span></span>`}
    <span class="row-label">${row.label}</span>
    ${param === undefined
      ? html`<span class="row-value" title=${source === undefined ? '' : `接线自 ${source.node}.${source.port}`}>
          ${source === undefined ? PORT_LABELS[output?.type ?? input?.type ?? 'int'] : `← ${source.node}.${source.port}`}
        </span>`
      : html`<span class="row-value" data-param-value=${param.name}
          data-mode=${mode?.mode ?? 'inline'} data-invalid=${String(reason !== undefined)}
          title=${reason === undefined ? value : `${value} · ${reason}`}
        >${value === '' ? '（空）' : value}</span>`}
    ${output === undefined
      ? nothing
      : html`<span
          class="port-hit out"
          role="button"
          tabindex="0"
          data-node=${box.id}
          data-port=${output.name}
          data-kind="out"
          data-flow="data"
          data-type=${output.type}
          title=${`输出端口（${PORT_LABELS[output.type]}）`}
          aria-label=${`${box.header} 的输出端口（${PORT_LABELS[output.type]}）`}
          style=${`top:${ROW_HEIGHT / 2 - PORT_SIZE / 2}px`}
          @pointerdown=${(event: PointerEvent) => options.onPortDown(event, anchorOf(box, output, 'out'))}
          @keydown=${(event: KeyboardEvent) => options.onPortKey(event, anchorOf(box, output, 'out'))}
        ><span class="port-shape ${portShapeClass(output.type)}"></span></span>`}
  </div>`;
}

function anchorOf(
  box: NodeBox,
  port: { readonly name: string; readonly type: PortType },
  kind: 'in' | 'out',
): PortAnchor {
  const existing = kind === 'in'
    ? box.inputs.find((candidate) => candidate.port === port.name)
    : box.outputs.find((candidate) => candidate.port === port.name);
  if (existing !== undefined) return existing;
  return {
    nodeId: box.id,
    port: port.name,
    type: port.type,
    kind,
    flow: 'data',
    x: kind === 'in' ? box.x : box.x + box.width,
    y: box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
  };
}

/** 执行端口在节点上下边框中间：形状用三角形区分方向。 */
function renderExecPort(options: NodeViewOptions, kind: 'in' | 'out'): unknown {
  const box = options.box;
  const port = kind === 'in' ? box.execIn : box.execOut;
  if (port === undefined) return nothing;
  return html`<span
    class="port-hit exec ${kind}"
    role="button"
    tabindex="0"
    data-node=${box.id}
    data-port=${port.port}
    data-kind=${kind}
    data-flow="exec"
    title=${kind === 'in' ? '执行入口：从上一个语句接进来' : '执行出口：拖到别的语句上可调整顺序'}
    aria-label=${kind === 'in' ? '执行入口' : '执行出口'}
    @pointerdown=${(event: PointerEvent) => options.onPortDown(event, port)}
  ><span class="port-shape exec-${kind}"></span></span>`;
}
