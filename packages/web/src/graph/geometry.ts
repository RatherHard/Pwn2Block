import { nodeInputs, nodeOutput, nodeSpec } from '@pwn2block/shared';
import type { GraphNode, NodeKindSpec, NodeLayout, ParamValues, PortContext, PortType } from '@pwn2block/shared';


/**
 * 画布几何（06 §3）：节点尺寸、端口位置、连线走法、视口变换与命中测试。
 *
 * 全部是纯函数，不碰 DOM：组件只负责把这里算出的矩形与折线画出来。这样「点击端口接线」
 * 这类交互可以在测试里用坐标断言，而不必截图或模拟浏览器布局。
 */

export const NODE_WIDTH = 208;
export const HEADER_HEIGHT = 26;
export const PORT_ROW = 20;
export const PORT_SIZE = 8;
export const BODY_PADDING = 10;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

/** 端口锚点：数据端口在左右两侧，控制流端口在上下两侧（06 §3）。 */
export interface PortAnchor extends Point {
  readonly nodeId: string;
  readonly port: string;
  readonly type: PortType;
  readonly kind: 'in' | 'out';
  /** 控制流端口（上下）与数据端口（左右）的走线方式不同。 */
  readonly flow: 'data' | 'exec';
}

export interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly header: string;
  readonly subtitle: string;
  readonly inputs: readonly PortAnchor[];
  readonly outputs: readonly PortAnchor[];
  readonly execIn?: PortAnchor;
  readonly execOut?: PortAnchor;
  readonly error: boolean;
  readonly selected: boolean;
}

export interface GeometryOptions {
  readonly context: PortContext;
  readonly selection?: readonly string[];
  readonly errorNodes?: readonly string[];
}

/** 节点框：高度按端口行数算，数据端口左右对齐，执行端口上下对齐。 */
export function nodeBox(
  node: GraphNode,
  placement: NodeLayout,
  options: GeometryOptions,
): NodeBox | undefined {
  const spec = nodeSpec(node.kind);
  if (spec === undefined) return undefined;
  const params: ParamValues = node.params;
  const inputs = nodeInputs(spec, params, options.context);
  const output = nodeOutput(spec, params);
  const rows = Math.max(inputs.length, output === undefined ? 0 : 1, 1);
  const height = HEADER_HEIGHT + rows * PORT_ROW + BODY_PADDING;
  const boxX = placement.x;
  const boxY = placement.y;
  const startY = boxY + HEADER_HEIGHT + PORT_ROW / 2;

  const inputAnchors = inputs.map((input, index) => ({
    nodeId: node.id,
    port: input.name,
    type: input.type,
    kind: 'in' as const,
    flow: 'data' as const,
    x: boxX,
    y: startY + index * PORT_ROW,
  }));
  const outputAnchors: PortAnchor[] =
    output === undefined
      ? []
      : [
          {
            nodeId: node.id,
            port: output.name,
            type: output.type,
            kind: 'out',
            flow: 'data',
            x: boxX + NODE_WIDTH,
            y: startY,
          },
        ];

  const execIn = spec.exec
    ? {
        nodeId: node.id,
        port: 'in',
        type: 'int' as PortType,
        kind: 'in' as const,
        flow: 'exec' as const,
        x: boxX + NODE_WIDTH / 2,
        y: boxY,
      }
    : undefined;
  const execOut = spec.exec
    ? {
        nodeId: node.id,
        port: 'out',
        type: 'int' as PortType,
        kind: 'out' as const,
        flow: 'exec' as const,
        x: boxX + NODE_WIDTH / 2,
        y: boxY + height,
      }
    : undefined;

  return {
    id: node.id,
    x: boxX,
    y: boxY,
    width: NODE_WIDTH,
    height,
    header: spec.label,
    subtitle: subtitleOf(spec, params),
    inputs: inputAnchors,
    outputs: outputAnchors,
    ...(execIn === undefined ? {} : { execIn }),
    ...(execOut === undefined ? {} : { execOut }),
    error: (options.errorNodes ?? []).includes(node.id),
    selected: (options.selection ?? []).includes(node.id),
  };
}

/** 副标题给一眼能看懂的关键参数，避免为了辨认节点反复点开检查器。 */
function subtitleOf(spec: NodeKindSpec, params: ParamValues): string {
  const describe = (param: string): string => {
    const value = params[param];
    return typeof value === 'string' || typeof value === 'number' ? `${param}=${String(value)}` : '';
  };
  const relevant = ['op', 'byte', 'count', 'value', 'outputType'];
  const parts = relevant.map(describe).filter((part) => part !== '');
  return parts.length === 0 ? spec.category : `${spec.category} · ${parts.slice(0, 2).join(' ')}`;
}

export function allPorts(box: NodeBox): readonly PortAnchor[] {
  return [
    ...box.inputs,
    ...box.outputs,
    ...(box.execIn === undefined ? [] : [box.execIn]),
    ...(box.execOut === undefined ? [] : [box.execOut]),
  ];
}

/** 正交折线：数据边横向走、执行边纵向走，中点错开避免线叠在一起。 */
export function edgePath(from: PortAnchor, to: PortAnchor): string {
  if (from.flow === 'exec') {
    const midY = from.y + Math.max(18, (to.y - from.y) / 2);
    return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
  }
  const midX = from.x + Math.max(28, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}

/** 背包（临时拖拽线）也用同一套走法，避免松手时线突然变形。 */
export function dragPath(from: Point, to: Point): string {
  const midX = from.x + Math.max(28, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}

export function boxContains(box: NodeBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

export interface HitTarget {
  readonly nodeId: string;
  readonly port?: PortAnchor;
}

/** 命中测试：端口优先于节点框（端口在边框上，点边框附近应该先接上端口）。 */
export function hitTest(boxes: readonly NodeBox[], point: Point): HitTarget | undefined {
  const radius = PORT_SIZE;
  for (const box of boxes) {
    for (const port of allPorts(box)) {
      if (Math.abs(port.x - point.x) <= radius && Math.abs(port.y - point.y) <= radius) {
        return { nodeId: box.id, port };
      }
    }
  }
  for (const box of boxes) {
    if (boxContains(box, point)) return { nodeId: box.id };
  }
  return undefined;
}

export function rectsIntersect(a: { x: number; y: number; width: number; height: number }, b: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 世界坐标 → 画布坐标：`g` 上的 transform 用这一份，命中测试也要用同一份的逆变换。 */
export function worldToScreen(point: Point, viewport: Viewport): Point {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

export function viewportTransform(viewport: Viewport): string {
  return `translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 滚轮缩放：以指针位置为锚点，避免缩放时内容从光标下面跑掉。 */
export function zoomAt(viewport: Viewport, screen: Point, delta: number): Viewport {
  const zoom = clampZoom(viewport.zoom * (delta > 0 ? 0.9 : 1.1));
  if (zoom === viewport.zoom) return viewport;
  const scale = zoom / viewport.zoom;
  return {
    zoom,
    x: screen.x - (screen.x - viewport.x) * scale,
    y: screen.y - (screen.y - viewport.y) * scale,
  };
}

/** 把内容放进视口：用于「适应窗口」与首次打开时的定位。 */
export function fitViewport(boxes: readonly NodeBox[], size: Size, padding = 40): Viewport {
  if (boxes.length === 0) return IDENTITY_VIEWPORT;
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const zoom = clampZoom(
    Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height),
  );
  return {
    zoom,
    x: (size.width - width * zoom) / 2 - minX * zoom,
    y: (size.height - height * zoom) / 2 - minY * zoom,
  };
}
