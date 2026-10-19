import { nothing, svg } from 'lit';
import type { GraphConnection } from '@pwn2block/shared';
import { hiddenByCollapse } from '../graph/collapse';
import type { GraphEditorState } from '../graph/editor';
import { PORT_COLORS } from '../graph/port-style';
import { allPorts, svgViewportTransform, type NodeBox, type Viewport } from '../graph/geometry';
import { orthogonalRoute } from '../graph/routing';

/**
 * 画布的 SVG 层：点阵网格、数据连线、执行顺序线、接线中的临时线（10 §3.4、§3.5）。
 *
 * 全是从状态算出来的纯渲染，不持手势、不改文档；画布组件只把手势结果整理成入参。
 * 这一层与 HTML 节点共用同一份视口变换，所以缩放、平移时连线永远贴着端口。
 */

export interface EdgeLayerOptions {
  readonly state: GraphEditorState;
  readonly boxes: readonly NodeBox[];
  /** 正在绘制的临时折线（已算好的 `d`）；`undefined` 表示没有。 */
  readonly dragLine?: string;
  readonly selectedEdge?: GraphConnection;
  readonly viewport: Viewport;
}

/** 箭头按端口类型配色，方向由 `orient="auto-start-reverse"` 跟着折线走。 */
function markerIdOf(type: string): string {
  return `p2b-arrow-${type}`;
}

function sameEdge(a: GraphConnection, b: GraphConnection): boolean {
  return a.from.node === b.from.node && a.from.port === b.from.port && a.to.node === b.to.node && a.to.port === b.to.port;
}

/** 点阵网格：SVG `<pattern>`（CSS 渐变被 TUI 规范禁用），随视口平移、缩放时间距跟随。 */
function renderGrid(viewport: Viewport): unknown {
  const step = 20 * Math.max(0.2, viewport.zoom);
  const offsetX = ((viewport.x % step) + step) % step;
  const offsetY = ((viewport.y % step) + step) % step;
  return svg`<pattern id="p2b-dots" width=${step} height=${step} patternUnits="userSpaceOnUse"
      x=${offsetX} y=${offsetY}>
      <rect width="1.5" height="1.5" fill="var(--p2b-line)" />
    </pattern>`;
}

/** 数据连线：直角折线 + 方向箭头；选中或与选中节点相关时加粗。 */
function renderConnections(options: EdgeLayerOptions): unknown {
  const { state, boxes, selectedEdge } = options;
  const anchors = new Map(boxes.map((box) => [box.id, allPorts(box)]));
  const placement = new Map(boxes.map((box) => [box.id, box]));
  const hidden = hiddenByCollapse(state.document);
  const related = (connection: GraphConnection): boolean =>
    (selectedEdge !== undefined && sameEdge(selectedEdge, connection)) ||
    state.selection.includes(connection.from.node) ||
    state.selection.includes(connection.to.node);
  return state.document.connections.map((connection, index) => {
    if (hidden.has(connection.from.node) || hidden.has(connection.to.node)) return nothing;
    const from = anchors.get(connection.from.node)?.find(
      (port) => port.kind === 'out' && port.port === connection.from.port,
    );
    const to = anchors.get(connection.to.node)?.find(
      (port) => port.kind === 'in' && port.port === connection.to.port,
    );
    const fromBox = placement.get(connection.from.node);
    const toBox = placement.get(connection.to.node);
    if (from === undefined || to === undefined || fromBox === undefined || toBox === undefined) return nothing;
    const path = orthogonalRoute(
      { x: from.x, y: from.y, flow: from.flow, kind: 'out' },
      { x: to.x, y: to.y, flow: to.flow, kind: 'in' },
      fromBox,
      toBox,
    ).path;
    if (path === '') return nothing;
    const isSelected = selectedEdge !== undefined && sameEdge(selectedEdge, connection);
    const classes = `edge${related(connection) ? ' related' : ''}${isSelected ? ' selected' : ''}`;
    return svg`<g class=${classes} data-edge=${index}>
      <path class="edge-line" d=${path} stroke=${PORT_COLORS[from.type]}
        marker-end=${`url(#${markerIdOf(from.type)})`} />
      <path class="edge-hit" data-edge=${index} d=${path} />
      <rect class="edge-end" data-edge=${index} data-edge-end="from"
        x=${from.x - 5} y=${from.y - 5} width="10" height="10" />
      <rect class="edge-end" data-edge=${index} data-edge-end="to"
        x=${to.x - 5} y=${to.y - 5} width="10" height="10" />
    </g>`;
  });
}

/** 执行顺序线：相邻语句之间一条虚线；顺序变了线跟着变（数据模型里没有执行边）。 */
function renderExecOrder(options: EdgeLayerOptions): unknown {
  const { state, boxes } = options;
  const placement = new Map(boxes.map((box) => [box.id, box]));
  const paths: unknown[] = [];
  for (let index = 0; index < state.document.main.length - 1; index += 1) {
    const current = placement.get(state.document.main[index] as string);
    const next = placement.get(state.document.main[index + 1] as string);
    if (current?.execOut === undefined || next?.execIn === undefined) continue;
    const path = orthogonalRoute(
      { x: current.execOut.x, y: current.execOut.y, flow: 'exec', kind: 'out' },
      { x: next.execIn.x, y: next.execIn.y, flow: 'exec', kind: 'in' },
      current,
      next,
    ).path;
    paths.push(
      svg`<path class="edge-line exec" d=${path} stroke="var(--p2b-dim)" stroke-dasharray="6 3"
        marker-end="url(#${markerIdOf('int')})" />`,
    );
  }
  return paths;
}

/** 整层 SVG：箭头定义、点阵、执行线、数据线、临时线。 */
export function renderEdgeLayer(options: EdgeLayerOptions): unknown {
  const drag = options.dragLine;
  return svg`<svg class="edges" aria-hidden="true">
    <defs>
      ${(['int', 'bool', 'bytes', 'text'] as const).map(
        (type) => svg`<marker id=${markerIdOf(type)} viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill=${PORT_COLORS[type]} />
        </marker>`,
      )}
      ${renderGrid(options.viewport)}
    </defs>
    <g transform=${svgViewportTransform(options.viewport)}>
      <rect x="-20000" y="-20000" width="40000" height="40000" fill="url(#p2b-dots)" opacity="0.5" />
      ${renderExecOrder(options)} ${renderConnections(options)}
      ${drag === undefined || drag === '' ? nothing : svg`<path class="edge-line pending" d=${drag} />`}
    </g>
  </svg>`;
}
