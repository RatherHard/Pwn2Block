import { LitElement, css, html, nothing, svg } from 'lit';
import type { GraphConnection, PortContext, PortType, WorkflowIssue } from '@pwn2block/shared';
import { nodeInputs, nodeOutput, nodeSpec } from '@pwn2block/shared';
import type { GraphEditorState, PortRef } from '../graph/editor';
import {
  NODE_WIDTH,
  PORT_SIZE,
  allPorts,
  clampZoom,
  edgePath,
  fitViewport,
  nodeBox,
  rectsIntersect,
  screenToWorld,
  viewportTransform,
  zoomAt,
  type NodeBox,
  type Point,
  type PortAnchor,
  type Viewport,
} from '../graph/geometry';
import type { NodePreview } from '../workflow/types';
import { sharedStyles, terminalTheme } from '../theme';

/**
 * 节点画布（06 §3；07 §P2）：画节点、连数据线、拖位置、框选、删除、平移缩放。
 *
 * 边界：
 * - **只画与收手势**：编辑结果通过 `p2b-graph-edit` 交给外壳的编辑器命令，组件自己不维护文档。
 * - **端口位置来自 geometry**：命中、走线、缩放都用同一份坐标，测试里可以用坐标断言。
 * - **键盘可达**：删除、撤销/重做、复制/粘贴、方向键微调、`f` 适应窗口、`c` 进入键盘接线，
 *   不依赖鼠标（09 §2 的键盘可达要求）。
 * - 不读后端、不发请求：编译与运行在外层，画布只显示传进来的预览与问题。
 */

/** 画布手势 → 编辑命令（外壳用 `applyEdit` 落到编辑器状态机）。 */
export type GraphEdit =
  | { readonly type: 'select'; readonly ids: readonly string[] }
  | { readonly type: 'move'; readonly moves: Readonly<Record<string, Point>> }
  | { readonly type: 'connect'; readonly from: PortRef; readonly to: PortRef }
  | { readonly type: 'disconnect'; readonly edge: GraphConnection }
  | { readonly type: 'delete'; readonly ids: readonly string[] }
  | { readonly type: 'reorder'; readonly nodeId: string; readonly after: string };

const PORT_COLORS: Readonly<Record<PortType, string>> = {
  int: 'var(--p2b-code)',
  bool: 'var(--p2b-hidden)',
  bytes: 'var(--p2b-data)',
  text: 'var(--p2b-ip)',
};

const PORT_LABELS: Readonly<Record<PortType, string>> = {
  int: '整数',
  bool: '布尔',
  bytes: '字节',
  text: '文本',
};

interface DragState {
  readonly kind: 'node' | 'pan' | 'box' | 'connect' | 'reorder';
  readonly start: Point;
  readonly origin: Point;
  readonly nodes?: Readonly<Record<string, Point>>;
  readonly from?: PortRef;
  readonly anchor?: PortAnchor;
  pointerId: number;
}

interface ConnectMode {
  readonly from: PortRef;
  readonly candidates: readonly PortRef[];
  index: number;
}

export class Pwn2BlockGraphCanvas extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
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
      svg {
        display: block;
        width: 100%;
        height: 100%;
        touch-action: none;
        cursor: default;
      }
      .hint {
        position: absolute;
        left: 0.75rem;
        bottom: 0.6rem;
        color: var(--p2b-dim);
        pointer-events: none;
        max-width: 90%;
      }
      .title {
        fill: var(--p2b-fg);
        font-weight: 700;
      }
      .subtitle {
        fill: var(--p2b-dim);
      }
      .label {
        fill: var(--p2b-dim);
      }
      .select rect.node {
        fill: var(--p2b-changed);
        stroke: var(--p2b-fg);
      }
      .hintline {
        stroke: var(--p2b-focus);
        stroke-dasharray: 4 4;
      }
      .box {
        fill: none;
        stroke: var(--p2b-focus);
        stroke-dasharray: 3 3;
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
    context: { attribute: false },
    previews: { attribute: false },
    issues: { attribute: false },
  };

  declare state: GraphEditorState | undefined;
  declare context: PortContext | undefined;
  declare previews: readonly NodePreview[] | undefined;
  declare issues: readonly WorkflowIssue[] | undefined;

  private viewport: Viewport = { x: 20, y: 20, zoom: 1 };
  private drag?: DragState;
  private boxRect?: { x: number; y: number; width: number; height: number };
  private cursorWorld?: Point;
  private connectMode?: ConnectMode;
  private message = '';
  /** 拖动过程中的预览偏移：不落成撤销点，松手才提交一次移动。 */
  private liveMoves: Readonly<Record<string, Point>> = {};

  override connectedCallback(): void {
    super.connectedCallback();
    this.tabIndex = 0;
    this.setAttribute('role', 'application');
    this.setAttribute('aria-label', '节点画布');
    this.addEventListener('keydown', this.onKeyDownListener);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('keydown', this.onKeyDownListener);
    super.disconnectedCallback();
  }

  private readonly onKeyDownListener = (event: KeyboardEvent): void => this.onKeyDown(event);

  override firstUpdated(): void {
    this.fit();
  }

  /** 适应窗口：首次挂载与用户按 `f` 时调用。 */
  fit(): void {
    const boxes = this.boxes();
    const rect = this.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.viewport = fitViewport(boxes, { width: rect.width, height: rect.height });
    this.requestUpdate();
  }

  /** 聚焦某个节点（检查器点「定位」时用）。 */
  focusNode(nodeId: string): void {
    const box = this.boxes().find((candidate) => candidate.id === nodeId);
    if (box === undefined) return;
    const rect = this.getBoundingClientRect();
    const zoom = this.viewport.zoom;
    this.viewport = {
      zoom,
      x: rect.width / 2 - (box.x + box.width / 2) * zoom,
      y: rect.height / 2 - (box.y + box.height / 2) * zoom,
    };
    this.requestUpdate();
  }

  private boxes(): readonly NodeBox[] {
    const state = this.state;
    const context = this.context;
    if (state === undefined || context === undefined) return [];
    const errorNodes = (this.issues ?? [])
      .filter((issue) => issue.severity === 'error' && issue.nodeId !== '')
      .map((issue) => issue.nodeId);
    const boxes: NodeBox[] = [];
    for (const node of state.document.nodes) {
      const placement = state.document.layout[node.id] ?? { x: 40, y: 40 };
      const live = this.liveMoves[node.id];
      const box = nodeBox(
        node,
        live === undefined ? placement : { x: placement.x + live.x, y: placement.y + live.y },
        { context, selection: state.selection, errorNodes },
      );
      if (box !== undefined) boxes.push(box);
    }
    return boxes;
  }

  private previewOf(nodeId: string): NodePreview | undefined {
    return (this.previews ?? []).find((preview) => preview.nodeId === nodeId);
  }

  private issueOf(nodeId: string): string | undefined {
    const issue = (this.issues ?? []).find(
      (candidate) => candidate.severity === 'error' && candidate.nodeId === nodeId,
    );
    return issue?.message;
  }

  private emitEdit(edit: GraphEdit): void {
    this.dispatchEvent(new CustomEvent<GraphEdit>('p2b-graph-edit', { detail: edit, bubbles: true, composed: true }));
  }

  private report(message: string): void {
    this.message = message;
    this.dispatchEvent(
      new CustomEvent('p2b-graph-message', { detail: { message }, bubbles: true, composed: true }),
    );
    this.requestUpdate();
  }

  // ---------------------------------------------------------------- 指针手势

  private worldPoint(event: PointerEvent | MouseEvent): Point {
    const rect = this.getBoundingClientRect();
    return screenToWorld(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      this.viewport,
    );
  }

  private onPointerDown(event: PointerEvent): void {
    this.focus();
    const point = this.worldPoint(event);
    this.cursorWorld = point;
    const element = event.target as Element | null;
    const portElement = element?.closest('[data-port]') as Element | null;
    const nodeElement = element?.closest('[data-node]') as Element | null;

    if (portElement !== null && portElement !== undefined) {
      const nodeId = portElement.getAttribute('data-node') ?? '';
      const portName = portElement.getAttribute('data-port') ?? '';
      const flow = portElement.getAttribute('data-flow');
      if (flow === 'exec' && portElement.getAttribute('data-kind') === 'out') {
        this.drag = {
          kind: 'reorder',
          start: point,
          origin: { x: this.viewport.x, y: this.viewport.y },
          from: { node: nodeId, port: portName },
          pointerId: event.pointerId,
        };
        this.report('拖到另一个语句节点上可调整执行顺序');
        return;
      }
      if (portElement.getAttribute('data-kind') === 'out') {
        this.drag = {
          kind: 'connect',
          start: point,
          origin: { x: this.viewport.x, y: this.viewport.y },
          from: { node: nodeId, port: portName },
          pointerId: event.pointerId,
        };
        this.capture(event);
        this.requestUpdate();
        return;
      }
    }

    if (nodeElement !== null && nodeElement !== undefined) {
      const nodeId = nodeElement.getAttribute('data-node') ?? '';
      const state = this.state;
      if (state === undefined) return;
      if (event.shiftKey) {
        const ids = state.selection.includes(nodeId)
          ? state.selection.filter((id) => id !== nodeId)
          : [...state.selection, nodeId];
        this.emitEdit({ type: 'select', ids });
      } else if (!state.selection.includes(nodeId)) {
        this.emitEdit({ type: 'select', ids: [nodeId] });
      }
      const origins: Record<string, Point> = {};
      for (const id of state.selection.includes(nodeId) ? state.selection : [nodeId]) {
        const placement = state.document.layout[id];
        if (placement !== undefined) origins[id] = { x: placement.x, y: placement.y };
      }
      this.drag = { kind: 'node', start: point, origin: { x: this.viewport.x, y: this.viewport.y }, nodes: origins, pointerId: event.pointerId };
      this.capture(event);
      return;
    }

    if (event.button === 1 || event.shiftKey) {
      this.drag = {
        kind: 'pan',
        start: { x: event.clientX, y: event.clientY },
        origin: { x: this.viewport.x, y: this.viewport.y },
        pointerId: event.pointerId,
      };
      this.capture(event);
      return;
    }

    this.drag = {
      kind: 'box',
      start: point,
      origin: { x: this.viewport.x, y: this.viewport.y },
      pointerId: event.pointerId,
    };
    this.boxRect = { x: point.x, y: point.y, width: 0, height: 0 };
    if (!event.shiftKey) this.emitEdit({ type: 'select', ids: [] });
    this.capture(event);
  }

  private capture(event: PointerEvent): void {
    const target = event.currentTarget as SVGSVGElement | null;
    if (target === null || typeof target.setPointerCapture !== 'function') return;
    if (event.pointerId === undefined) return;
    target.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === undefined) return;
    const point = this.worldPoint(event);
    this.cursorWorld = point;

    if (drag.kind === 'pan') {
      this.viewport = {
        ...this.viewport,
        x: drag.origin.x + (event.clientX - drag.start.x),
        y: drag.origin.y + (event.clientY - drag.start.y),
      };
      this.requestUpdate();
      return;
    }

    if (drag.kind === 'box') {
      this.boxRect = {
        x: Math.min(drag.start.x, point.x),
        y: Math.min(drag.start.y, point.y),
        width: Math.abs(point.x - drag.start.x),
        height: Math.abs(point.y - drag.start.y),
      };
      this.requestUpdate();
      return;
    }

    if (drag.kind === 'node') {
      const dx = Math.round(point.x - drag.start.x);
      const dy = Math.round(point.y - drag.start.y);
      const moves: Record<string, Point> = {};
      for (const [id, origin] of Object.entries(drag.nodes ?? {})) {
        moves[id] = { x: origin.x + dx, y: origin.y + dy };
      }
      this.liveMoves = moves;
      this.requestUpdate();
      return;
    }

    this.requestUpdate();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = undefined;
    const point = this.worldPoint(event);

    if (drag?.kind === 'box' && this.boxRect !== undefined) {
      const rect = this.boxRect;
      this.boxRect = undefined;
      if (rect.width > 4 || rect.height > 4) {
        const hits = this.boxes().filter((box) => rectsIntersect(rect, box)).map((box) => box.id);
        this.emitEdit({ type: 'select', ids: hits });
      }
      this.requestUpdate();
      return;
    }

    if (drag?.kind === 'node') {
      const moves = this.liveMoves;
      this.liveMoves = {};
      if (Object.keys(moves).length > 0) this.emitEdit({ type: 'move', moves });
      this.requestUpdate();
      return;
    }

    if (drag?.kind === 'connect' && drag.from !== undefined) {
      const target = this.portAt(point, 'in');
      if (target === undefined) {
        this.report('把线拖到目标节点的输入端口上才能接上');
      } else {
        this.emitEdit({ type: 'connect', from: drag.from, to: target });
      }
      this.requestUpdate();
      return;
    }

    if (drag !== undefined && drag.kind === 'reorder' && drag.from !== undefined) {
      const target = this.boxes().find(
        (box) =>
          point.x >= box.x &&
          point.x <= box.x + box.width &&
          point.y >= box.y &&
          point.y <= box.y + box.height,
      );
      if (target === undefined || target.id === drag.from.node) {
        this.report('没有落到别的语句节点上，顺序不变');
      } else {
        this.emitEdit({ type: 'reorder', nodeId: drag.from.node, after: target.id });
      }
      this.requestUpdate();
    }
  }

  private portAt(point: Point, kind: 'in' | 'out'): PortRef | undefined {
    for (const box of this.boxes()) {
      for (const port of allPorts(box)) {
        if (port.kind !== kind) continue;
        if (Math.abs(port.x - point.x) <= PORT_SIZE && Math.abs(port.y - point.y) <= PORT_SIZE) {
          return { node: port.nodeId, port: port.port };
        }
      }
    }
    return undefined;
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.getBoundingClientRect();
    this.viewport = zoomAt(
      this.viewport,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      event.deltaY,
    );
    this.requestUpdate();
  }

  private onDoubleClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    const edgeIndex = target?.getAttribute('data-edge');
    if (edgeIndex !== null && edgeIndex !== undefined) {
      const edge = this.state?.document.connections[Number(edgeIndex)];
      if (edge !== undefined) this.emitEdit({ type: 'disconnect', edge });
      return;
    }
    const nodeElement = target?.closest('[data-node]');
    const nodeId = nodeElement?.getAttribute('data-node');
    if (nodeId === null || nodeId === undefined) return;
    this.dispatchEvent(
      new CustomEvent('p2b-graph-open', { detail: { nodeId }, bubbles: true, composed: true }),
    );
  }

  // ---------------------------------------------------------------- 键盘

  private onKeyDown(event: KeyboardEvent): void {
    const state = this.state;
    if (state === undefined) return;
    const meta = event.ctrlKey || event.metaKey;

    if (this.connectMode !== undefined) {
      this.handleConnectKeys(event);
      return;
    }

    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.dispatchEvent(new CustomEvent('p2b-graph-undo', { bubbles: true, composed: true }));
      return;
    }
    if (meta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.dispatchEvent(new CustomEvent('p2b-graph-redo', { bubbles: true, composed: true }));
      return;
    }
    if (meta && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      this.dispatchEvent(new CustomEvent('p2b-graph-copy', { bubbles: true, composed: true }));
      return;
    }
    if (meta && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      this.dispatchEvent(new CustomEvent('p2b-graph-paste', { bubbles: true, composed: true }));
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.selection.length === 0) return;
      event.preventDefault();
      this.emitEdit({ type: 'delete', ids: state.selection });
      return;
    }
    if (event.key === 'Escape') {
      this.emitEdit({ type: 'select', ids: [] });
      return;
    }
    if (event.key === 'f') {
      this.fit();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      this.viewport = { ...this.viewport, zoom: clampZoom(this.viewport.zoom * 1.1) };
      this.requestUpdate();
      return;
    }
    if (event.key === '-') {
      this.viewport = { ...this.viewport, zoom: clampZoom(this.viewport.zoom / 1.1) };
      this.requestUpdate();
      return;
    }
    if (event.key === 'c') {
      this.startKeyboardConnect();
      return;
    }
    const step = event.shiftKey ? 32 : 8;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (delta === undefined || state.selection.length === 0) return;
    event.preventDefault();
    const moves: Record<string, Point> = {};
    for (const id of state.selection) {
      const placement = state.document.layout[id];
      if (placement !== undefined) moves[id] = { x: placement.x + delta.x, y: placement.y + delta.y };
    }
    this.emitEdit({ type: 'move', moves });
  }

  /** 键盘接线：`c` 从选中节点的输出出发，Tab 在候选输入口之间移动，Enter 接上。 */
  private startKeyboardConnect(): void {
    const state = this.state;
    const context = this.context;
    if (state === undefined || context === undefined) return;
    const sourceId = state.selection[0];
    if (sourceId === undefined) {
      this.report('先选中一个节点，再按 c 接线');
      return;
    }
    const source = state.document.nodes.find((node) => node.id === sourceId);
    if (source === undefined) return;
    const spec = nodeSpec(source.kind);
    const output = spec === undefined ? undefined : nodeOutput(spec, source.params);
    if (output === undefined) {
      this.report('这个节点没有输出，接不了线');
      return;
    }
    const candidates: PortRef[] = [];
    for (const node of state.document.nodes) {
      if (node.id === sourceId) continue;
      const targetSpec = nodeSpec(node.kind);
      if (targetSpec === undefined) continue;
      for (const input of nodeInputs(targetSpec, node.params, context)) {
        if (input.type === output.type) candidates.push({ node: node.id, port: input.name });
      }
    }
    if (candidates.length === 0) {
      this.report(`没有可接的${PORT_LABELS[output.type]}输入端口`);
      return;
    }
    this.connectMode = { from: { node: sourceId, port: output.name }, candidates, index: 0 };
    this.report(`接线：Tab 切换目标（${candidates.length} 个），Enter 接上，Esc 取消`);
    this.requestUpdate();
  }

  private handleConnectKeys(event: KeyboardEvent): void {
    const mode = this.connectMode;
    if (mode === undefined) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      this.connectMode = {
        ...mode,
        index: (mode.index + (event.shiftKey ? mode.candidates.length - 1 : 1)) % mode.candidates.length,
      };
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = mode.candidates[mode.index];
      if (target !== undefined) this.emitEdit({ type: 'connect', from: mode.from, to: target });
      this.connectMode = undefined;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.connectMode = undefined;
    }
    this.requestUpdate();
  }

  // ---------------------------------------------------------------- 渲染

  override render() {
    const state = this.state;
    if (state === undefined) return html`<p class="hint">还没有载入图。</p>`;
    const boxes = this.boxes();
    const placement = new Map(boxes.map((box) => [box.id, box]));
    const connectMode = this.connectMode;
    const highlighted = connectMode === undefined ? undefined : connectMode.candidates[connectMode.index];
    return html`
      <svg
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerUp}
        @wheel=${this.onWheel}
        @dblclick=${this.onDoubleClick}
      >
        <g transform=${viewportTransform(this.viewport)}>
          ${this.renderExecEdges(state, placement)} ${this.renderDataEdges(state, placement)}
          ${this.boxRect === undefined
            ? nothing
            : svg`<rect class="box" x=${this.boxRect.x} y=${this.boxRect.y} width=${this.boxRect.width} height=${this.boxRect.height} />`}
          ${boxes.map((box) => this.renderNode(box, highlighted))}
          ${this.renderDragLine()}
        </g>
      </svg>
      ${boxes.length === 0 ? html`<p class="hint">从左侧工具箱点一个节点开始。</p>` : nothing}
      ${this.message === '' ? nothing : html`<p class="hint">${this.message}</p>`}
    `;
  }

  private renderNode(box: NodeBox, highlighted: { node: string; port: string } | undefined) {
    const preview = this.previewOf(box.id);
    const error = this.issueOf(box.id);
    const subtitle = error ?? preview?.summary ?? box.subtitle;
    return svg`<g
      data-node=${box.id}
      transform="translate(${box.x} ${box.y})"
      class=${box.selected ? 'select' : nothing}
    >
      <rect
        class="node"
        x="0"
        y="0"
        width=${NODE_WIDTH}
        height=${box.height}
        fill=${box.selected ? 'var(--p2b-changed)' : 'var(--p2b-bg)'}
        stroke=${error === undefined ? (box.selected ? 'var(--p2b-fg)' : 'var(--p2b-line)') : 'var(--p2b-error)'}
        stroke-width=${box.selected || error !== undefined ? 2 : 1}
      />
      <text class="title" x="8" y="17">${truncate(box.header, 24)}</text>
      ${box.execIn === undefined
        ? nothing
        : svg`<rect class="port" data-node=${box.id} data-port=${box.execIn.port} data-kind="in" data-flow="exec"
            x=${NODE_WIDTH / 2 - PORT_SIZE / 2} y=${-PORT_SIZE / 2} width=${PORT_SIZE} height=${PORT_SIZE}
            fill="var(--p2b-fg)" />`}
      ${box.execOut === undefined
        ? nothing
        : svg`<rect class="port" data-node=${box.id} data-port=${box.execOut.port} data-kind="out" data-flow="exec"
            x=${NODE_WIDTH / 2 - PORT_SIZE / 2} y=${box.height - PORT_SIZE / 2} width=${PORT_SIZE} height=${PORT_SIZE}
            fill="var(--p2b-fg)" />`}
      ${box.inputs.map((port) => {
        const y = port.y - box.y;
        const active = highlighted?.node === port.nodeId && highlighted.port === port.port;
        return svg`<g>
          <rect class="port" data-node=${box.id} data-port=${port.port} data-kind="in" data-flow="data"
            x=${-PORT_SIZE / 2} y=${y - PORT_SIZE / 2} width=${PORT_SIZE} height=${PORT_SIZE}
            fill=${PORT_COLORS[port.type]} stroke=${active ? 'var(--p2b-focus)' : 'none'} stroke-width="2" />
          <text class="label" x="8" y=${y + 4}>${truncate(port.port, 14)}</text>
        </g>`;
      })}
      ${box.outputs.map((port) => {
        const y = port.y - box.y;
        return svg`<g>
          <rect class="port" data-node=${box.id} data-port=${port.port} data-kind="out" data-flow="data"
            x=${NODE_WIDTH - PORT_SIZE / 2} y=${y - PORT_SIZE / 2} width=${PORT_SIZE} height=${PORT_SIZE}
            fill=${PORT_COLORS[port.type]} />
          <text class="label" x=${NODE_WIDTH - 8} y=${y + 4} text-anchor="end">${truncate(port.port, 14)}</text>
        </g>`;
      })}
      <text class="subtitle" x="8" y=${box.height - 6}>${truncate(subtitle, 34)}</text>
    </g>`;
  }

  private renderDataEdges(
    state: GraphEditorState,
    placement: ReadonlyMap<string, NodeBox>,
  ): unknown {
    const anchors = new Map<string, PortAnchor[]>();
    for (const box of placement.values()) anchors.set(box.id, [...allPorts(box)]);
    return state.document.connections.map((connection, index) => {
      const from = anchors.get(connection.from.node)?.find(
        (port) => port.kind === 'out' && port.port === connection.from.port,
      );
      const to = anchors.get(connection.to.node)?.find(
        (port) => port.kind === 'in' && port.port === connection.to.port,
      );
      if (from === undefined || to === undefined) return nothing;
      // `data-edge` 用下标回指连线：双击线即可断开（键盘/鼠标都能删）。
      return svg`<path data-edge=${index} d=${edgePath(from, to)} fill="none" stroke=${PORT_COLORS[from.type]} stroke-width="2" />`;
    });
  }

  /** 执行边由序列派生：相邻语句之间画一条向下的线，顺序变了线跟着变。 */
  private renderExecEdges(
    state: GraphEditorState,
    placement: ReadonlyMap<string, NodeBox>,
  ): unknown {
    const paths: unknown[] = [];
    for (let index = 0; index < state.document.main.length - 1; index += 1) {
      const current = placement.get(state.document.main[index] as string);
      const next = placement.get(state.document.main[index + 1] as string);
      if (current?.execOut === undefined || next?.execIn === undefined) continue;
      paths.push(
        svg`<path d=${edgePath(current.execOut, next.execIn)} fill="none" stroke="var(--p2b-dim)" stroke-width="2" />`,
      );
    }
    return paths;
  }

  private renderDragLine(): unknown {
    const drag = this.drag;
    if (drag?.kind !== 'connect' || drag.from === undefined) return nothing;
    const anchor = this.boxes()
      .find((box) => box.id === drag.from?.node)
      ?.outputs.find((port) => port.port === drag.from?.port);
    if (anchor === undefined || this.cursorWorld === undefined) return nothing;
    return svg`<path class="hintline" d=${edgePath(anchor, { ...this.cursorWorld, nodeId: '', port: '', type: anchor.type, kind: 'in', flow: 'data' })} fill="none" stroke-width="2" />`;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

customElements.define('pwn2block-graph-canvas', Pwn2BlockGraphCanvas);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-graph-canvas': Pwn2BlockGraphCanvas;
  }
}
