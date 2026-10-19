import { html, nothing } from 'lit';
import type { GraphConnection, PortContext } from '@pwn2block/shared';
import { nodeSpec } from '@pwn2block/shared';
import { SIMPLIFY_ZOOM, collapsedSummary } from '../graph/collapse';
import type { GraphEditorState } from '../graph/editor';
import {
  NODE_WIDTH,
  portHitTest,
  viewportTransform,
  type NodeBox,
  type PortAnchor,
  type RegionFrame,
  type Viewport,
} from '../graph/geometry';
import { renderEdgeLayer } from './graph-canvas-edges';
import { renderNodeView } from './graph-node-view';

/**
 * 画布 DOM 的纯渲染（10 §2、§3）：视口、SVG 连线层、分组与区域框、节点、空画布提示、状态行。
 *
 * 组件只负责手势与编辑命令，模板整体从这里生成——渲染是状态的函数，方便测试直接比对。
 */

/** 空画布提示：第一次进来什么都没放时说明下一步做什么（10 §5）。 */
const EMPTY_HINT =
  '画布是空的：从左侧节点库拖一个节点进来，或点击节点条目添加。流程开始前需要放一个「开始」节点。';

export interface CanvasHandlers {
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onWheel: (event: WheelEvent) => void;
  readonly onDoubleClick: (event: MouseEvent) => void;
  readonly onPortDown: (event: PointerEvent, port: PortAnchor) => void;
  readonly onPortKey: (event: KeyboardEvent, port: PortAnchor) => void;
}

export interface CanvasViewOptions {
  readonly state: GraphEditorState;
  readonly context: PortContext | undefined;
  readonly viewport: Viewport;
  readonly boxes: readonly NodeBox[];
  readonly frames: readonly RegionFrame[];
  readonly handlers: CanvasHandlers;
  readonly marquee?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly gestureKind?: string;
  readonly message?: string;
  readonly dropHint?: { readonly x: number; readonly y: number; readonly label: string };
  /** 接线中的临时折线（已算好的 `d`）。 */
  readonly dragLine?: string;
  readonly selectedEdge?: GraphConnection;
  readonly compatible?: ReadonlySet<string>;
  readonly activeKey?: string;
  readonly hoverPort?: PortAnchor;
  readonly highlightNodeId?: string;
  readonly focusPort?: { readonly nodeId: string; readonly port: string };
  readonly editingNodeId?: string;
  readonly previewOf: (nodeId: string) => NodePreview | undefined;
  readonly issueOf: (nodeId: string) => string | undefined;
}

/** 节点渲染要用到的预览摘要类型，只取 `summary` 一个字段。 */
type NodePreview = { readonly summary: string };

function portKey(anchor: PortAnchor): string {
  return `${anchor.nodeId}\u0000${anchor.port}`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** 分组框：只按当前可见节点算外框；纯显示，不参与命中测试。 */
function renderGroups(groups: readonly { readonly id: string; readonly name: string; readonly members: readonly string[] }[], place: ReadonlyMap<string, NodeBox>): unknown {
  if (groups.length === 0) return nothing;
  return groups.map((group) => {
    const members = group.members.flatMap((id) => {
      const box = place.get(id);
      return box === undefined ? [] : [box];
    });
    if (members.length === 0) return nothing;
    const left = Math.min(...members.map((box) => box.x)) - 16;
    const top = Math.min(...members.map((box) => box.y)) - 28;
    const right = Math.max(...members.map((box) => box.x + box.width)) + 16;
    const bottom = Math.max(...members.map((box) => box.y + box.height)) + 14;
    return html`<div
      class="group"
      data-group=${group.id}
      style=${`position:absolute;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;border:1px dashed var(--p2b-line);pointer-events:none`}
    >
      <span class="grouplabel" style="position:absolute;left:6px;top:2px">${truncate(group.name, 20)}</span>
    </div>`;
  });
}

/** 容器区域框：跟着子节点走，用于渲染与拖放命中提示。 */
function renderRegions(frames: readonly RegionFrame[]): unknown {
  return frames.map(
    (frame) => html`<div
      class="region"
      data-region=${frame.nodeId}
      data-region-name=${frame.region}
      style=${`position:absolute;left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px;border:1px dashed var(--p2b-line);pointer-events:none`}
    >
      <span class="region-label" style="position:absolute;left:6px;top:1px">${truncate(frame.label, 12)}</span>
    </div>`,
  );
}

function renderNode(options: CanvasViewOptions, box: NodeBox): unknown {
  const { state, context, handlers } = options;
  const node = state.document.nodes.find((candidate) => candidate.id === box.id);
  const spec = node === undefined ? undefined : nodeSpec(node.kind);
  if (node === undefined || spec === undefined || context === undefined) return nothing;
  const error = options.issueOf(box.id);
  const preview = options.previewOf(box.id);
  const collapsed = state.document.layout[box.id]?.collapsed === true;
  const selected = box.selected || options.editingNodeId === box.id;
  const status: 'normal' | 'selected' | 'error' | 'running' =
    options.highlightNodeId === box.id ? 'running' : error !== undefined ? 'error' : selected ? 'selected' : 'normal';
  return renderNodeView({
    box,
    node,
    spec,
    context,
    document: state.document,
    status,
    selected,
    simplified: options.viewport.zoom < SIMPLIFY_ZOOM,
    collapsed,
    ...(collapsed ? { preview: collapsedSummary(node) } : {}),
    ...(error === undefined ? {} : { issue: error }),
    ...(collapsed || error !== undefined || preview === undefined ? {} : { preview: preview.summary }),
    ...(options.compatible === undefined ? {} : { compatible: options.compatible }),
    ...(options.activeKey === undefined ? {} : { activePort: options.activeKey }),
    ...(options.hoverPort === undefined ? {} : { hoverPort: portKey(options.hoverPort) }),
    ...(options.focusPort === undefined ? {} : { focusPort: `${options.focusPort.nodeId}\u0000${options.focusPort.port}` }),
    onPortDown: (event, port) => handlers.onPortDown(event, port),
    onPortKey: (event, port) => handlers.onPortKey(event, port),
  });
}

export function renderCanvasView(options: CanvasViewOptions): unknown {
  const { state, boxes, viewport, marquee, message, dropHint } = options;
  const place = new Map(boxes.map((box) => [box.id, box]));
  return html`<div
    class="viewport${options.gestureKind === 'pan' ? ' panning' : ''}"
    @pointerdown=${options.handlers.onPointerDown}
    @pointermove=${options.handlers.onPointerMove}
    @pointerup=${options.handlers.onPointerUp}
    @pointercancel=${options.handlers.onPointerUp}
    @wheel=${options.handlers.onWheel}
    @dblclick=${options.handlers.onDoubleClick}
  >
    ${renderEdgeLayer({
      state,
      boxes,
      dragLine: options.dragLine,
      selectedEdge: options.selectedEdge,
      viewport,
    })}
    <div class="surface" style=${`transform:${viewportTransform(viewport)}`}>
      ${renderGroups(state.document.groups ?? [], place)} ${renderRegions(options.frames)}
      ${marquee === undefined
        ? nothing
        : html`<div
            class="marquee"
            style=${`left:${marquee.x}px;top:${marquee.y}px;width:${marquee.width}px;height:${marquee.height}px`}
          ></div>`}
      ${boxes.map((box) => renderNode(options, box))}
      ${dropHint === undefined
        ? nothing
        : html`<div
            class="drop-hint"
            style=${`left:${dropHint.x}px;top:${dropHint.y}px;width:${NODE_WIDTH}px;height:${88}px`}
          >${dropHint.label}</div>`}
    </div>
    ${boxes.length === 0 && dropHint === undefined ? html`<div class="empty-hint"><p>${EMPTY_HINT}</p></div>` : nothing}
    ${message === undefined || message === '' ? nothing : html`<p class="status-line">${message}</p>`}
  </div>`;
}

/** 画布为空时的提示文案（面板与测试都可能用到，导出避免复制）。 */
export const CANVAS_EMPTY_HINT = EMPTY_HINT;

/** 端口命中：视口坐标找最近的端口，供悬停高亮与接线落点复用。 */
export function hitPort(boxes: readonly NodeBox[], point: { readonly x: number; readonly y: number }): PortAnchor | undefined {
  return portHitTest(boxes, point);
}
