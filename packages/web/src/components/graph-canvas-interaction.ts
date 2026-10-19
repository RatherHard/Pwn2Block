import type { GraphConnection, ParamValue } from '@pwn2block/shared';
import { isContainer } from '../graph/collapse';
import type { GraphEditorState, PortRef } from '../graph/editor';
import {
  allPorts,
  portHitTest,
  rectsIntersect,
  regionAt,
  zoomAt,
  type NodeBox,
  type Point,
  type PortAnchor,
  type RegionFrame,
  type Viewport,
} from '../graph/geometry';
import { PORT_LABELS } from '../graph/port-style';
import { orthogonalRoute, previewRoute, type RouteEnd } from '../graph/routing';

/** 画布手势 → 编辑命令（外壳用 `applyEdit` 落到编辑器状态机）。 */
export type GraphEdit =
  | { readonly type: 'select'; readonly ids: readonly string[] }
  | { readonly type: 'move'; readonly moves: Readonly<Record<string, Point>> }
  | { readonly type: 'connect'; readonly from: PortRef; readonly to: PortRef }
  | {
      readonly type: 'rewire';
      readonly edge: GraphConnection;
      readonly end: 'from' | 'to';
      readonly to: PortRef;
    }
  | { readonly type: 'disconnect'; readonly edge: GraphConnection }
  | { readonly type: 'delete'; readonly ids: readonly string[] }
  | { readonly type: 'param'; readonly nodeId: string; readonly name: string; readonly value: ParamValue }
  | {
      readonly type: 'portMode';
      readonly nodeId: string;
      readonly port: string;
      readonly mode: 'inline' | 'port';
    }
  | { readonly type: 'reorder'; readonly nodeId: string; readonly after: string }
  | {
      readonly type: 'moveInto';
      readonly nodeIds: readonly string[];
      readonly container: string;
      readonly region: string;
    }
  | { readonly type: 'collapse'; readonly nodeId: string; readonly collapsed: boolean };

/**
 * 画布的指针与键盘手势（10 §3）：平移、框选、拖动节点、接线、改接、调整顺序、快捷键。
 *
 * 这里是**唯一的交互状态机**：手势进度、点击接线的待定端点、选中的连线、消息都放在
 * `InteractionState` 里，由画布组件持有并读取渲染结果。函数本身不碰 DOM 结构，只通过
 * `GestureHost` 发编辑命令、报消息、改视口，所以逻辑可以在测试里直接驱动。
 */

/** 进行中的手势：每种手势只关心自己需要的起点数据。 */
export type Gesture =
  | { readonly kind: 'pan'; readonly startClient: Point; readonly origin: Point }
  | { readonly kind: 'marquee'; readonly startWorld: Point; readonly base: readonly string[] }
  | { readonly kind: 'node'; readonly startWorld: Point; readonly origins: Readonly<Record<string, Point>>; moved: boolean }
  | {
      readonly kind: 'connect';
      readonly anchor: PortAnchor;
      readonly candidates: ReadonlySet<string>;
      readonly startWorld: Point;
      moved: boolean;
    }
  | {
      readonly kind: 'rewire';
      readonly edge: GraphConnection;
      readonly end: 'from' | 'to';
      readonly anchor: PortAnchor;
      readonly startWorld: Point;
      moved: boolean;
    }
  | { readonly kind: 'reorder'; readonly from: PortAnchor; moved: boolean };

/** 点击接线：第一次点击后等待第二次点击，Tab 可切换候选端口。 */
export interface PendingConnect {
  readonly from: PortAnchor;
  readonly candidates: readonly PortRef[];
  index: number;
}

export interface Marquee {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 交互状态：可变的 UI 片段状态，不属于文档，也不进撤销栈。 */
export interface InteractionState {
  gesture?: Gesture;
  marquee?: Marquee;
  pending?: PendingConnect;
  selectedEdge?: GraphConnection;
  cursorWorld?: Point;
  liveMoves: Readonly<Record<string, Point>>;
  message: string;
}

export function initialInteraction(): InteractionState {
  return { liveMoves: {}, message: '' };
}

export interface GestureHost {
  readonly state: GraphEditorState | undefined;
  readonly boxes: readonly NodeBox[];
  readonly frames: readonly RegionFrame[];
  readonly viewport: Viewport;
  readonly rect: DOMRect;
  /** 指针当前位置（图坐标）。 */
  readonly point: Point;
  readonly interaction: InteractionState;
  readonly emit: (edit: GraphEdit) => void;
  readonly report: (message: string) => void;
  readonly beginGesture: (event: PointerEvent, kind: string) => void;
  readonly setViewport: (viewport: Viewport) => void;
  readonly open: (nodeId: string) => void;
  readonly command: (name: 'undo' | 'redo' | 'copy' | 'paste') => void;
  readonly fit: () => void;
  readonly zoomBy: (factor: number) => void;
}

/** 端口的 `node\u0000port` 键：兼容集合与候选比较都用它。 */
export function portKey(node: string, port: string): string {
  return `${node}\u0000${port}`;
}

export function anchorOf(
  boxes: readonly NodeBox[],
  nodeId: string,
  port: string,
  kind: 'in' | 'out',
  flow: 'data' | 'exec',
): PortAnchor | undefined {
  for (const box of boxes) {
    if (box.id !== nodeId) continue;
    const found = allPorts(box).find(
      (candidate) => candidate.port === port && candidate.kind === kind && candidate.flow === flow,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 兼容端口（类型相同、方向相反、不同节点）：接线时高亮，点击接线用它做候选。 */
export function compatibleTargets(boxes: readonly NodeBox[], from: PortAnchor): ReadonlySet<string> {
  const keys = new Set<string>();
  if (from.flow === 'exec') return keys;
  const wantKind = from.kind === 'out' ? 'in' : 'out';
  for (const box of boxes) {
    if (box.id === from.nodeId) continue;
    for (const port of allPorts(box)) {
      if (port.flow !== 'data' || port.kind !== wantKind || port.type !== from.type) continue;
      keys.add(portKey(port.nodeId, port.port));
    }
  }
  return keys;
}

function candidateRefs(keys: Iterable<string>): readonly PortRef[] {
  return [...keys].map((key) => {
    const [node = '', port = ''] = key.split('\u0000');
    return { node, port };
  });
}

/** 当前正在接线的起点：拖动中取手势起点，点击接线等待时取待定起点。 */
export function activeAnchor(host: GestureHost): PortAnchor | undefined {
  const gesture = host.interaction.gesture;
  if (gesture?.kind === 'connect' || gesture?.kind === 'rewire') return gesture.anchor;
  return host.interaction.pending?.from;
}

/** 需要高亮的兼容端口集合：拖动用自己的候选，点击接线等待时用待定候选。 */
export function compatibilitySet(host: GestureHost): ReadonlySet<string> | undefined {
  const gesture = host.interaction.gesture;
  if (gesture?.kind === 'connect') return gesture.candidates;
  if (gesture?.kind === 'rewire') return compatibleTargets(host.boxes, gesture.anchor);
  const pending = host.interaction.pending;
  if (pending === undefined) return undefined;
  return new Set(pending.candidates.map((candidate) => portKey(candidate.node, candidate.port)));
}

/** 手势结束：清掉进度与拖动预览，保留消息。 */
export function clearGesture(interaction: InteractionState): void {
  interaction.gesture = undefined;
  interaction.marquee = undefined;
  interaction.liveMoves = {};
}

function selectNode(host: GestureHost, nodeId: string, additive: boolean): void {
  const state = host.state;
  if (state === undefined || nodeId === '') return;
  host.interaction.selectedEdge = undefined;
  if (additive) {
    const ids = state.selection.includes(nodeId)
      ? state.selection.filter((id) => id !== nodeId)
      : [...state.selection, nodeId];
    host.emit({ type: 'select', ids });
    return;
  }
  host.emit({ type: 'select', ids: [nodeId] });
}

function selectEdge(host: GestureHost, index: number): void {
  const edge = host.state?.document.connections[index];
  if (edge === undefined) return;
  host.interaction.selectedEdge = edge;
  if ((host.state?.selection.length ?? 0) > 0) host.emit({ type: 'select', ids: [] });
}

function startNodeDrag(host: GestureHost, element: Element, event: PointerEvent): void {
  const state = host.state;
  if (state === undefined) return;
  event.preventDefault();
  const nodeId = element.getAttribute('data-node') ?? '';
  host.interaction.selectedEdge = undefined;
  const nextSelection = event.shiftKey
    ? state.selection.includes(nodeId)
      ? state.selection.filter((id) => id !== nodeId)
      : [...state.selection, nodeId]
    : state.selection.includes(nodeId)
      ? state.selection
      : [nodeId];
  if (event.shiftKey) {
    host.emit({ type: 'select', ids: nextSelection });
    return;
  }
  if (!state.selection.includes(nodeId)) host.emit({ type: 'select', ids: [nodeId] });
  const origins: Record<string, Point> = {};
  for (const id of nextSelection) {
    const placement = state.document.layout[id];
    if (placement !== undefined) origins[id] = { x: placement.x, y: placement.y };
  }
  host.interaction.gesture = { kind: 'node', startWorld: host.point, origins, moved: false };
  host.beginGesture(event, 'node');
}

/** 从 DOM 端口元素开始接线：把属性翻成锚点，剩下的交给 `startPortGestureAt`。 */
function startPortGesture(host: GestureHost, element: Element, event: PointerEvent): void {
  const nodeId = element.getAttribute('data-node') ?? '';
  const portName = element.getAttribute('data-port') ?? '';
  const flow = element.getAttribute('data-flow');
  const kind = element.getAttribute('data-kind') === 'out' ? 'out' : 'in';
  const anchor = anchorOf(host.boxes, nodeId, portName, kind, flow === 'exec' ? 'exec' : 'data');
  if (anchor === undefined) return;
  startPortGestureAt(host, anchor, event);
}

/** 接线手势的共用入口：点击（第二下落到候选端口）与拖动都从这里开始。 */
export function startPortGestureAt(host: GestureHost, anchor: PortAnchor, event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const interaction = host.interaction;

  // 点击接线的第二下：落到兼容端口就完成，落到同一个端口就取消。
  const pending = interaction.pending;
  if (pending !== undefined) {
    interaction.pending = undefined;
    const fromRef: PortRef = { node: pending.from.nodeId, port: pending.from.port };
    if (pending.from.nodeId === anchor.nodeId && pending.from.port === anchor.port) {
      host.report('已取消接线');
      return;
    }
    const target = pending.candidates.find(
      (candidate) => candidate.node === anchor.nodeId && candidate.port === anchor.port,
    );
    if (target !== undefined) {
      host.emit({ type: 'connect', from: fromRef, to: target });
      interaction.message = '';
    } else {
      host.report('这两个端口接不上：类型不同或方向相同');
    }
    return;
  }

  if (anchor.flow === 'exec' && anchor.kind === 'out') {
    interaction.gesture = { kind: 'reorder', from: anchor, moved: false };
    host.beginGesture(event, 'reorder');
    host.report('拖到另一个语句节点上可调整执行顺序');
    return;
  }
  // 端口命中区盖在改接把手上，所以「拖动已选中连线的端点」按端口识别：
  // 这一拖是改接，不是从同一端口再拉一根新线。
  const rewire = selectedEdgeEnd(host, anchor);
  if (rewire !== undefined) {
    startRewireFromPort(host, rewire, event);
    return;
  }
  interaction.gesture = {
    kind: 'connect',
    anchor,
    candidates: compatibleTargets(host.boxes, anchor),
    startWorld: host.point,
    moved: false,
  };
  host.beginGesture(event, 'connect');
  interaction.cursorWorld = host.point;
}

/** 键盘激活端口：与点击接线共用同一套候选与完成逻辑。 */
export function portKeyDown(host: GestureHost, event: KeyboardEvent, port: PortAnchor): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  const interaction = host.interaction;
  const pending = interaction.pending;
  if (pending === undefined) {
    const candidates = candidateRefs(compatibleTargets(host.boxes, port));
    if (candidates.length === 0) {
      host.report('没有可接的兼容端口');
      return;
    }
    interaction.pending = { from: port, candidates, index: 0 };
    host.report(`接线：Tab 切换目标（${candidates.length} 个），Enter 接上，Esc 取消`);
    return;
  }
  interaction.pending = undefined;
  if (pending.from.nodeId === port.nodeId && pending.from.port === port.port) {
    host.report('已取消接线');
    return;
  }
  const target = pending.candidates.find(
    (candidate) => candidate.node === port.nodeId && candidate.port === port.port,
  );
  if (target !== undefined) {
    host.emit({ type: 'connect', from: { node: pending.from.nodeId, port: pending.from.port }, to: target });
  } else {
    host.report('这两个端口接不上：类型不同或方向相同');
  }
}

function startRewire(host: GestureHost, element: Element, event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const end = element.getAttribute('data-edge-end') === 'to' ? 'to' : 'from';
  const edge = host.state?.document.connections[Number(element.getAttribute('data-edge'))];
  if (edge === undefined) return;
  beginRewire(host, edge, end, event);
}

/** 这个端口是不是「已选中连线」的端点？是的话返回该端点，拖动它表示改接。 */
function selectedEdgeEnd(
  host: GestureHost,
  anchor: PortAnchor,
): { edge: GraphConnection; end: 'from' | 'to' } | undefined {
  const edge = host.interaction.selectedEdge;
  if (edge === undefined) return undefined;
  const same = (ref: PortRef): boolean => ref.node === anchor.nodeId && ref.port === anchor.port;
  if (same(edge.from)) return { edge, end: 'from' };
  if (same(edge.to)) return { edge, end: 'to' };
  return undefined;
}

function startRewireFromPort(
  host: GestureHost,
  target: { edge: GraphConnection; end: 'from' | 'to' },
  event: PointerEvent,
): void {
  event.preventDefault();
  event.stopPropagation();
  beginRewire(host, target.edge, target.end, event);
}

/** 改接的共用入口：把手和端点端口都走这里，起点取端点自己的锚点。 */
function beginRewire(
  host: GestureHost,
  edge: GraphConnection,
  end: 'from' | 'to',
  event: PointerEvent,
): void {
  const anchorPort = end === 'from' ? edge.from : edge.to;
  const anchor = anchorOf(host.boxes, anchorPort.node, anchorPort.port, end === 'from' ? 'out' : 'in', 'data');
  if (anchor === undefined) return;
  host.interaction.gesture = {
    kind: 'rewire',
    edge,
    end,
    anchor,
    startWorld: host.point,
    moved: false,
  };
  host.beginGesture(event, 'rewire');
}

export function pointerDown(host: GestureHost, event: PointerEvent): void {
  const target = event.target as Element | null;
  const portElement = target?.closest('[data-port]');
  const handleElement = target?.closest('[data-edge-end]');
  const edgeElement = target?.closest('[data-edge]');
  const nodeElement = target?.closest('[data-node]');
  const dragHandle = target?.closest('[data-drag-handle]');
  const control = target?.closest('input, select, textarea, button, [contenteditable="true"]');
  const interaction = host.interaction;
  interaction.cursorWorld = host.point;

  if (handleElement !== null && handleElement !== undefined) {
    startRewire(host, handleElement, event);
    return;
  }
  if (portElement !== null && portElement !== undefined) {
    // 端口命中区压在改接把手上面，所以「拖动已选中连线的端点」要按端口识别：
    // 端口属于当前选中的连线时，这一拖是改接而不是新接一根。
    startPortGesture(host, portElement, event);
    return;
  }
  if (edgeElement !== null && edgeElement !== undefined) {
    selectEdge(host, Number(edgeElement.getAttribute('data-edge')));
    return;
  }
  if (nodeElement !== null && nodeElement !== undefined) {
    if (control !== null && control !== undefined) return;
    if (dragHandle === null || dragHandle === undefined) {
      selectNode(host, nodeElement.getAttribute('data-node') ?? '', event.shiftKey);
      return;
    }
    startNodeDrag(host, nodeElement, event);
    return;
  }
  // 空白处：Shift 框选，否则平移（10 §3.1）。
  interaction.pending = undefined;
  interaction.selectedEdge = undefined;
  const point = host.point;
  if (event.shiftKey) {
    interaction.gesture = { kind: 'marquee', startWorld: point, base: host.state?.selection ?? [] };
    interaction.marquee = { x: point.x, y: point.y, width: 0, height: 0 };
  } else {
    interaction.gesture = {
      kind: 'pan',
      startClient: { x: event.clientX, y: event.clientY },
      origin: { x: host.viewport.x, y: host.viewport.y },
    };
    if ((host.state?.selection.length ?? 0) > 0) host.emit({ type: 'select', ids: [] });
  }
  host.beginGesture(event, event.shiftKey ? 'marquee' : 'pan');
}

export function pointerMove(host: GestureHost, event: PointerEvent): void {
  const interaction = host.interaction;
  const point = host.point;
  interaction.cursorWorld = point;
  const gesture = interaction.gesture;
  if (gesture === undefined) return;

  if (gesture.kind === 'pan') {
    host.setViewport({
      ...host.viewport,
      x: gesture.origin.x + (event.clientX - gesture.startClient.x),
      y: gesture.origin.y + (event.clientY - gesture.startClient.y),
    });
    return;
  }

  if (gesture.kind === 'marquee') {
    interaction.marquee = {
      x: Math.min(gesture.startWorld.x, point.x),
      y: Math.min(gesture.startWorld.y, point.y),
      width: Math.abs(point.x - gesture.startWorld.x),
      height: Math.abs(point.y - gesture.startWorld.y),
    };
    return;
  }

  if (gesture.kind === 'node') {
    const dx = Math.round(point.x - gesture.startWorld.x);
    const dy = Math.round(point.y - gesture.startWorld.y);
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    gesture.moved = true;
    const moves: Record<string, Point> = {};
    for (const [id, origin] of Object.entries(gesture.origins)) {
      moves[id] = { x: origin.x + dx, y: origin.y + dy };
    }
    interaction.liveMoves = moves;
    return;
  }

  if (gesture.kind === 'reorder') return;

  // 接线 / 改接：用屏幕像素判断是否真的拖动过，避免缩放后阈值失真。
  const distance = Math.hypot(point.x - gesture.startWorld.x, point.y - gesture.startWorld.y);
  if (distance * host.viewport.zoom > 4) gesture.moved = true;
}

export function pointerUp(host: GestureHost): void {
  const interaction = host.interaction;
  const gesture = interaction.gesture;
  // 先取出拖拽过程中的临时数据：clearGesture 会把它们清掉。
  const liveMoves = interaction.liveMoves;
  const marquee = interaction.marquee;
  const point = host.point;
  clearGesture(interaction);
  if (gesture === undefined) return;
  const moved = gesture.kind === 'pan' || gesture.kind === 'marquee' ? true : gesture.moved;

  if (gesture.kind === 'pan') return;

  if (gesture.kind === 'marquee') {
    if (marquee !== undefined && (marquee.width > 4 || marquee.height > 4)) {
      const hits = host.boxes.filter((box) => rectsIntersect(marquee, box)).map((box) => box.id);
      host.emit({ type: 'select', ids: [...new Set([...gesture.base, ...hits])] });
    }
    return;
  }

  if (gesture.kind === 'node') {
    if (gesture.moved && Object.keys(liveMoves).length > 0) host.emit({ type: 'move', moves: liveMoves });
    dropIntoRegion(host, gesture.origins, point);
    return;
  }

  if (gesture.kind === 'connect') {
    if (!moved) {
      // 没有拖动 = 点击接线的第一下：进入等待第二次点击的状态。
      const candidates = candidateRefs(gesture.candidates);
      interaction.pending = { from: gesture.anchor, candidates, index: 0 };
      host.report(
        candidates.length === 0
          ? '从这里出发没有兼容的端口'
          : '点击一个高亮端口完成接线（Esc 取消，Tab 依次选中）',
      );
      return;
    }
    completeConnect(host, gesture.anchor, point);
    return;
  }

  if (gesture.kind === 'rewire') {
    const target = portHitTest(host.boxes, point);
    if (!moved || target === undefined) {
      host.report('改接取消：原连接保持不变');
      return;
    }
    host.emit({
      type: 'rewire',
      edge: gesture.edge,
      end: gesture.end,
      to: { node: target.nodeId, port: target.port },
    });
    return;
  }

  // 执行顺序拖动
  const target = host.boxes.find(
    (box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height,
  );
  if (target === undefined || target.id === gesture.from.nodeId) {
    host.report('没有落到别的语句节点上，顺序不变');
  } else {
    host.emit({ type: 'reorder', nodeId: gesture.from.nodeId, after: target.id });
  }
}

/** 松手时落在某个区域框里就把选中的语句移进去（容器自己与它的子孙除外，由编辑器再判一次）。 */
function dropIntoRegion(host: GestureHost, origins: Readonly<Record<string, Point>>, point: Point): void {
  if (Object.keys(origins).length === 0) return;
  const region = regionAt(host.frames, point);
  if (region === undefined) return;
  const moved = Object.keys(origins);
  if (moved.includes(region.nodeId)) return;
  host.emit({ type: 'moveInto', nodeIds: moved, container: region.nodeId, region: region.region });
}

function completeConnect(host: GestureHost, from: PortAnchor, point: Point): void {
  const target = portHitTest(host.boxes, point);
  if (target === undefined) {
    host.report('把线拖到目标端口上才能接上');
    return;
  }
  const fromRef: PortRef = { node: from.nodeId, port: from.port };
  const targetRef: PortRef = { node: target.nodeId, port: target.port };
  if (from.kind === target.kind) {
    host.report('两个端口方向相同：接线要从输出到输入');
    return;
  }
  // 方向永远是「输出 → 输入」，从输入端发起时把两端交换。
  if (from.kind === 'out') host.emit({ type: 'connect', from: fromRef, to: targetRef });
  else host.emit({ type: 'connect', from: targetRef, to: fromRef });
  host.interaction.message = '';
}

/** 接线中的临时折线：与正式连线同一套路由，松手时不会突然变形。 */
export function previewPath(host: GestureHost): string | undefined {
  const interaction = host.interaction;
  const gesture = interaction.gesture;
  if (gesture === undefined || (gesture.kind !== 'connect' && gesture.kind !== 'rewire')) return undefined;
  if (interaction.cursorWorld === undefined) return undefined;
  const anchor = gesture.anchor;
  const sourceBox = host.boxes.find((box) => box.id === anchor.nodeId);
  if (sourceBox === undefined) return undefined;
  const target = portHitTest(host.boxes, interaction.cursorWorld);
  const end: RouteEnd = { x: anchor.x, y: anchor.y, flow: 'data', kind: anchor.kind };
  if (target === undefined) return previewRoute(end, interaction.cursorWorld, sourceBox).path;
  return orthogonalRoute(
    end,
    { x: target.x, y: target.y, flow: target.flow, kind: target.kind },
    sourceBox,
    host.boxes.find((box) => box.id === target.nodeId) ?? sourceBox,
  ).path;
}

export function wheel(host: GestureHost, event: WheelEvent): boolean {
  // 普通滚轮交给页面滚动（10 §3.1）；只有 Ctrl/⌘ + 滚轮才缩放画布，并阻止页面缩放。
  if (!event.ctrlKey && !event.metaKey) return false;
  event.preventDefault();
  const rect = host.rect;
  host.setViewport(zoomAt(host.viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top }, event.deltaY));
  return true;
}

export function doubleClick(host: GestureHost, event: MouseEvent): void {
  const target = event.target as Element | null;
  // 双击连线 = 断开这一条（10 §3.3 的快捷方式；选中后按 Delete 是主路径）。
  const edgeElement = target?.closest('[data-edge]');
  if (edgeElement !== null && edgeElement !== undefined) {
    const edge = host.state?.document.connections[Number(edgeElement.getAttribute('data-edge'))];
    if (edge !== undefined) {
      host.interaction.selectedEdge = undefined;
      host.emit({ type: 'disconnect', edge });
    }
    return;
  }
  const nodeElement = target?.closest('[data-node]');
  const nodeId = nodeElement?.getAttribute('data-node');
  if (nodeId === null || nodeId === undefined) return;
  if (target?.closest('input, select, textarea, button') != null) return;
  const node = host.state?.document.nodes.find((candidate) => candidate.id === nodeId);
  if (node !== undefined && isContainer(node)) {
    const collapsed = host.state?.document.layout[nodeId]?.collapsed === true;
    host.emit({ type: 'collapse', nodeId, collapsed: !collapsed });
    return;
  }
  host.open(nodeId);
}

function pendingKeyDown(host: GestureHost, event: KeyboardEvent): void {
  const interaction = host.interaction;
  const pending = interaction.pending;
  if (pending === undefined) return;
  if (event.key === 'Tab' && pending.candidates.length > 0) {
    event.preventDefault();
    interaction.pending = {
      ...pending,
      index: (pending.index + (event.shiftKey ? pending.candidates.length - 1 : 1)) % pending.candidates.length,
    };
    host.report(`候选端口 ${interaction.pending.index + 1}/${pending.candidates.length}`);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const candidate = pending.candidates[pending.index];
    interaction.pending = undefined;
    if (candidate === undefined) return;
    const fromRef: PortRef = { node: pending.from.nodeId, port: pending.from.port };
    if (pending.from.kind === 'out') host.emit({ type: 'connect', from: fromRef, to: candidate });
    else host.emit({ type: 'connect', from: candidate, to: fromRef });
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    interaction.pending = undefined;
    host.report('已取消接线');
  }
}

/** 键盘接线：`c` 从选中节点的输出出发，Tab 在候选输入口之间移动，Enter 接上。 */
function keyboardConnect(host: GestureHost): void {
  const state = host.state;
  const sourceId = state?.selection[0];
  if (state === undefined || sourceId === undefined) {
    host.report('先选中一个节点，再按 c 接线');
    return;
  }
  const box = host.boxes.find((candidate) => candidate.id === sourceId);
  const anchor = box?.outputs[0];
  if (anchor === undefined) {
    host.report('这个节点没有输出，接不了线');
    return;
  }
  const candidates = candidateRefs(compatibleTargets(host.boxes, anchor));
  if (candidates.length === 0) {
    host.report(`没有可接的${PORT_LABELS[anchor.type]}端口`);
    return;
  }
  host.interaction.pending = { from: anchor, candidates, index: 0 };
  host.report(`接线：Tab 切换目标（${candidates.length} 个），Enter 接上，Esc 取消`);
}

/** 焦点在输入框/代码编辑器里时不抢快捷键（10 §2.3）。 */
export function isEditingElement(event: KeyboardEvent): boolean {
  const first = event.composedPath()[0] as { tagName?: string; isContentEditable?: boolean } | undefined;
  return (
    first !== undefined &&
    (first.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(first.tagName ?? ''))
  );
}

export function keyDown(host: GestureHost, event: KeyboardEvent): void {
  const state = host.state;
  if (state === undefined) return;
  const inEditor = isEditingElement(event);
  const meta = event.ctrlKey || event.metaKey;
  const interaction = host.interaction;

  if (interaction.pending !== undefined && !inEditor) {
    pendingKeyDown(host, event);
    return;
  }
  if (event.key === 'Escape' && !inEditor) {
    event.preventDefault();
    if (interaction.gesture !== undefined) {
      clearGesture(interaction);
      host.report('已取消当前操作');
      return;
    }
    if (interaction.selectedEdge !== undefined) {
      interaction.selectedEdge = undefined;
      return;
    }
    host.emit({ type: 'select', ids: [] });
    return;
  }
  if (inEditor) return;

  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    host.command('undo');
    return;
  }
  if (meta && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    host.command('redo');
    return;
  }
  if (meta && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    host.command('copy');
    return;
  }
  if (meta && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    host.command('paste');
    return;
  }
  if (meta && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    host.emit({ type: 'select', ids: state.document.nodes.map((node) => node.id) });
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (interaction.selectedEdge !== undefined) {
      event.preventDefault();
      const edge = interaction.selectedEdge;
      interaction.selectedEdge = undefined;
      host.emit({ type: 'disconnect', edge });
      return;
    }
    if (state.selection.length === 0) return;
    event.preventDefault();
    host.emit({ type: 'delete', ids: state.selection });
    return;
  }
  if (event.key === 'f') {
    event.preventDefault();
    host.fit();
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    host.zoomBy(1.15);
    return;
  }
  if (event.key === '-') {
    event.preventDefault();
    host.zoomBy(1 / 1.15);
    return;
  }
  if (event.key === 'c') {
    event.preventDefault();
    keyboardConnect(host);
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
  host.emit({ type: 'move', moves });
}
