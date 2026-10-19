import { LitElement, html } from 'lit';
import type { PortContext, WorkflowIssue } from '@pwn2block/shared';
import { nodeRegions, nodeSpec } from '@pwn2block/shared';
import { collapsedContainers, hiddenByCollapse } from '../graph/collapse';
import type { GraphEditorState } from '../graph/editor';
import {
  NODE_WIDTH,
  clampZoom,
  fitViewport,
  nodeBox,
  portHitTest,
  regionFrames,
  screenToWorld,
  type NodeBox,
  type Point,
  type PortAnchor,
  type RegionFrame,
  type Viewport,
} from '../graph/geometry';
import type { NodePreview } from '../workflow/types';
import { sharedStyles, terminalTheme } from '../theme';
import { nodeSkin } from './node-skin';
import {
  activeAnchor,
  clearGesture,
  compatibilitySet,
  initialInteraction,
  keyDown,
  pointerDown,
  pointerMove,
  pointerUp,
  portKeyDown,
  previewPath,
  startPortGestureAt,
  wheel,
  doubleClick,
  type GestureHost,
  type GraphEdit,
  type InteractionState,
} from './graph-canvas-interaction';
import { renderCanvasView } from './graph-canvas-view';
import { canvasStyles } from './graph-canvas-styles';

export type { GraphEdit } from './graph-canvas-interaction';

/**
 * 节点画布（06 §3；07 §P2；10 §3）：画节点、接线、拖动、框选、平移缩放。
 *
 * 边界：
 * - **只画与收手势**：编辑结果通过 `p2b-graph-edit` 交给外壳的编辑器命令，组件自己不维护文档。
 * - **坐标来自 geometry**：命中、走线、缩放都用同一份坐标，测试里可以用坐标断言。
 * - **滚轮只负责页面滚动**：画布内 `Ctrl + 滚轮` 才缩放（10 §3.1），不劫持普通滚轮。
 * - **拖动只从标题区开始**：节点内的输入框、下拉框、按钮不会触发节点移动，也不会选中文字。
 * - **手势状态机在 `graph-canvas-interaction`**：这里只负责把 DOM 事件与状态接起来。
 */
export class Pwn2BlockGraphCanvas extends LitElement {
  static override styles = [terminalTheme, sharedStyles, nodeSkin, canvasStyles];

  static override properties = {
    state: { attribute: false },
    context: { attribute: false },
    previews: { attribute: false },
    issues: { attribute: false },
    highlightNodeId: { attribute: false },
    focusPort: { attribute: false },
    editingNodeId: { attribute: false },
  };

  declare state: GraphEditorState | undefined;
  declare context: PortContext | undefined;
  declare previews: readonly NodePreview[] | undefined;
  declare issues: readonly WorkflowIssue[] | undefined;
  /** 执行结果驱动的节点高亮；由页面壳按**当前产物**的节点 id 传入，不猜。 */
  declare highlightNodeId: string | undefined;
  /** 组装预览里选中的分段：高亮该输入端口。 */
  declare focusPort: { readonly nodeId: string; readonly port: string } | undefined;
  /** 属性面板正在编辑的节点：标题高亮，提示两处编辑的是同一份数据。 */
  declare editingNodeId: string | undefined;

  private viewport: Viewport = { x: 24, y: 24, zoom: 1 };
  private interaction: InteractionState = initialInteraction();
  private dropHint?: { readonly x: number; readonly y: number; readonly label: string };
  private readonly onKeyDownListener = (event: KeyboardEvent): void => this.handleKeyDown(event);

  override connectedCallback(): void {
    super.connectedCallback();
    this.tabIndex = 0;
    this.setAttribute('role', 'application');
    this.setAttribute('aria-label', '节点画布');
    this.addEventListener('keydown', this.onKeyDownListener);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('keydown', this.onKeyDownListener);
    this.endGesture();
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.fit();
  }

  // ------------------------------------------------------------ 对外接口

  /** 适应画布：把全部节点放进可视区；空画布回到左上角。 */
  fit(): void {
    const boxes = this.boxes();
    const rect = this.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.requestUpdate();
      return;
    }
    const fitted = fitViewport(boxes, { width: rect.width, height: rect.height });
    // 只有一个节点时不放大到 2 倍：那样反而不像画布，也不方便继续加节点。
    this.viewport = boxes.length === 0 ? { x: 24, y: 24, zoom: 1 } : { ...fitted, zoom: Math.min(1, fitted.zoom) };
    this.requestUpdate();
  }

  /** 设置缩放：工具栏按钮用，围绕画布中心。 */
  setZoom(zoom: number): void {
    const rect = this.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    const next = clampZoom(zoom);
    const world = screenToWorld(center, this.viewport);
    this.viewport = { x: center.x - world.x * next, y: center.y - world.y * next, zoom: next };
    this.requestUpdate();
  }

  get zoom(): number {
    return this.viewport.zoom;
  }

  zoomBy(factor: number): void {
    this.setZoom(this.viewport.zoom * factor);
  }

  /** 屏幕坐标（client）→ 图坐标：节点库拖入时算落点用。 */
  worldFromClient(clientX: number, clientY: number): Point {
    const rect = this.getBoundingClientRect();
    return screenToWorld({ x: clientX - rect.left, y: clientY - rect.top }, this.viewport);
  }

  /** 拖入预览：显示一个虚线框提示落点；`undefined` 关闭。 */
  showDropHint(hint: { readonly x: number; readonly y: number; readonly label: string } | undefined): void {
    this.dropHint = hint;
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

  /** 聚焦某个数据端口（组装分段选中时用）；找不到端口就退化成聚焦节点。 */
  centerOnPort(nodeId: string, port: string): void {
    const box = this.boxes().find((candidate) => candidate.id === nodeId);
    if (box === undefined) return;
    const anchor = box.inputs.find((candidate) => candidate.port === port);
    if (anchor === undefined) {
      this.focusNode(nodeId);
      return;
    }
    const rect = this.getBoundingClientRect();
    const zoom = this.viewport.zoom;
    this.viewport = {
      zoom,
      x: rect.width / 2 - (box.x + NODE_WIDTH / 2) * zoom,
      y: rect.height / 2 - anchor.y * zoom,
    };
    this.requestUpdate();
  }

  // ------------------------------------------------------------ 数据派生

  private boxes(): readonly NodeBox[] {
    const state = this.state;
    const context = this.context;
    if (state === undefined || context === undefined) return [];
    const errorNodes = (this.issues ?? [])
      .filter((issue) => issue.severity === 'error' && issue.nodeId !== '')
      .map((issue) => issue.nodeId);
    const boxes: NodeBox[] = [];
    const hidden = hiddenByCollapse(state.document);
    for (const node of state.document.nodes) {
      if (hidden.has(node.id)) continue;
      const placement = state.document.layout[node.id] ?? { x: 40, y: 40 };
      const live = this.interaction.liveMoves[node.id];
      const box = nodeBox(
        node,
        live ?? placement,
        { context, selection: state.selection, errorNodes },
      );
      if (box !== undefined) boxes.push(box);
    }
    return boxes;
  }

  private frames(): readonly RegionFrame[] {
    const state = this.state;
    if (state === undefined) return [];
    const collapsed = collapsedContainers(state.document);
    const containers = state.document.nodes.flatMap((node) => {
      if (collapsed.has(node.id)) return [];
      const spec = nodeSpec(node.kind);
      if (spec === undefined) return [];
      const regions = nodeRegions(spec, node.params);
      if (regions.length === 0) return [];
      return [{ nodeId: node.id, regions, members: node.regions ?? {} }];
    });
    return regionFrames(containers, this.boxes());
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

  private emitEdit = (edit: GraphEdit): void => {
    this.dispatchEvent(new CustomEvent<GraphEdit>('p2b-graph-edit', { detail: edit, bubbles: true, composed: true }));
  };

  private report = (message: string): void => {
    this.interaction.message = message;
    this.dispatchEvent(new CustomEvent('p2b-graph-message', { detail: { message }, bubbles: true, composed: true }));
  };

  // ------------------------------------------------------------ 手势接线

  /** 把当前事件与派生数据整理成手势状态机的入参。 */
  private host(event: Event): GestureHost {
    const rect = this.getBoundingClientRect();
    const pointer = event as PointerEvent & MouseEvent;
    const point = this.worldFromClient(
      typeof pointer.clientX === 'number' ? pointer.clientX : 0,
      typeof pointer.clientY === 'number' ? pointer.clientY : 0,
    );
    return {
      state: this.state,
      boxes: this.boxes(),
      frames: this.frames(),
      viewport: this.viewport,
      rect,
      point,
      interaction: this.interaction,
      emit: this.emitEdit,
      report: this.report,
      beginGesture: (gestureEvent, kind) => this.beginGesture(gestureEvent, kind),
      setViewport: (next) => {
        this.viewport = next;
      },
      open: (nodeId) =>
        this.dispatchEvent(new CustomEvent('p2b-graph-open', { detail: { nodeId }, bubbles: true, composed: true })),
      command: (name) =>
        this.dispatchEvent(new CustomEvent(`p2b-graph-${name}`, { bubbles: true, composed: true })),
      fit: () => this.fit(),
      zoomBy: (factor) => this.zoomBy(factor),
    };
  }

  private beginGesture(event: PointerEvent, kind: string): void {
    this.setAttribute('data-gesture', kind);
    document.body.style.userSelect = 'none';
    const target = event.currentTarget as Element | null;
    if (target !== null && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom 与部分浏览器不支持指针捕获：退化为冒泡事件即可。 */
      }
    }
  }

  private endGesture(): void {
    clearGesture(this.interaction);
    this.removeAttribute('data-gesture');
    document.body.style.userSelect = '';
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1) event.preventDefault();
    this.focus({ preventScroll: true });
    pointerDown(this.host(event), event);
    this.requestUpdate();
  };

  private onPointerMove = (event: PointerEvent): void => {
    pointerMove(this.host(event), event);
    this.requestUpdate();
  };

  private onPointerUp = (event: PointerEvent): void => {
    pointerUp(this.host(event));
    this.removeAttribute('data-gesture');
    document.body.style.userSelect = '';
    this.requestUpdate();
  };

  private onWheel = (event: WheelEvent): void => {
    wheel(this.host(event), event);
    this.requestUpdate();
  };

  private onDoubleClick = (event: MouseEvent): void => {
    doubleClick(this.host(event), event);
    this.requestUpdate();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    keyDown(this.host(event), event);
    this.requestUpdate();
  };

  /** 端口上的键盘激活（Enter / 空格）与点击接线同一套状态机。 */
  private onPortKey = (event: KeyboardEvent, port: PortAnchor): void => {
    portKeyDown(this.host(event), event, port);
    this.requestUpdate();
  };

  /** 节点内端口元素按下：直接以锚点开始接线或改接。 */
  private onPortDown = (event: PointerEvent, port: PortAnchor): void => {
    startPortGestureAt(this.host(event), port, event);
    this.requestUpdate();
  };

  // ------------------------------------------------------------ 渲染

  override render() {
    const state = this.state;
    if (state === undefined) return html`<p class="status-line">还没有载入图。</p>`;
    const boxes = this.boxes();
    const host = this.host({ clientX: 0, clientY: 0 } as MouseEvent);
    const active = activeAnchor(host);
    return renderCanvasView({
      state,
      context: this.context,
      viewport: this.viewport,
      boxes,
      frames: this.frames(),
      gestureKind: this.interaction.gesture?.kind,
      marquee: this.interaction.marquee,
      message: this.interaction.message,
      dropHint: this.dropHint,
      dragLine: this.dragLinePath(),
      selectedEdge: this.interaction.selectedEdge,
      compatible: compatibilitySet(host),
      activeKey: active === undefined ? undefined : `${active.nodeId}\u0000${active.port}`,
      hoverPort: this.interaction.cursorWorld === undefined ? undefined : portHitTest(boxes, this.interaction.cursorWorld),
      highlightNodeId: this.highlightNodeId,
      focusPort: this.focusPort,
      editingNodeId: this.editingNodeId,
      previewOf: (nodeId) => this.previewOf(nodeId),
      issueOf: (nodeId) => this.issueOf(nodeId),
      handlers: {
        onPointerDown: this.onPointerDown,
        onPointerMove: this.onPointerMove,
        onPointerUp: this.onPointerUp,
        onWheel: this.onWheel,
        onDoubleClick: this.onDoubleClick,
        onPortDown: this.onPortDown,
        onPortKey: this.onPortKey,
      },
    });
  }

  /** 接线中的临时折线：与正式连线同一套路由，松手时不会突然变形。 */
  private dragLinePath(): string | undefined {
    return previewPath(this.viewHost());
  }

  /** 只读查询用的入参（渲染与命中检查不需要真实指针位置）。 */
  private viewHost(): GestureHost {
    const rect = this.getBoundingClientRect();
    return this.host({
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    } as MouseEvent);
  }
}

customElements.define('pwn2block-graph-canvas', Pwn2BlockGraphCanvas);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-graph-canvas': Pwn2BlockGraphCanvas;
  }
}
