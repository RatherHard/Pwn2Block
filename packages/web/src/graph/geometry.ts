import { nodeInputs, nodeOutput, nodeSpec, nodeParams } from '@pwn2block/shared';
import type {
  GraphNode,
  InputPortSpec,
  NodeKindSpec,
  NodeLayout,
  ParamSpec,
  ParamValue,
  ParamValues,
  PortContext,
  PortType,
} from '@pwn2block/shared';
import { orthogonalRoute, type RouteEnd } from './routing';

/**
 * 画布几何（06 §3；10 §3）：节点尺寸、端口位置、连线走法、视口变换与命中测试。
 *
 * 全部是纯函数，不碰 DOM：组件只负责把这里算出的矩形与折线画出来。这样「点击端口接线」
 * 这类交互可以在测试里用坐标断言，而不必截图或模拟浏览器布局。
 *
 * 本轮的模型变化（10 §2.2）：**每个参数占一行**，可接线的参数在同一行左侧同时是输入端口。
 * 因此节点高度由「行数」决定，行序决定端口 y 坐标——画布、命中测试和连线都读这一份。
 */

export const NODE_WIDTH = 232;
export const HEADER_HEIGHT = 26;
/** 一行（参数或纯端口）的高度。 */
export const PORT_ROW = 24;
/** 兼容旧名字：行高就是端口的纵向步距。 */
export const ROW_HEIGHT = PORT_ROW;
export const FOOTER_HEIGHT = 18;
export const PORT_SIZE = 10;
export const BODY_PADDING = 2;

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

/** 节点内的一行：参数行、纯端口行或输出行。 */
export interface NodeRowModel {
  /** 唯一键：参数名或端口名。 */
  readonly key: string;
  readonly label: string;
  readonly param?: ParamSpec;
  readonly input?: { readonly name: string; readonly type: PortType; readonly required: boolean };
  readonly output?: { readonly name: string; readonly type: PortType };
  /** 参数当前值的摘要（没有参数时为空串）。 */
  readonly value: string;
  /** 参数错误原因（节点内只标红 + 提示，完整文案在属性面板）。 */
  readonly error?: string;
}

export interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly header: string;
  readonly subtitle: string;
  readonly rows: readonly NodeRowModel[];
  readonly inputs: readonly PortAnchor[];
  readonly outputs: readonly PortAnchor[];
  readonly execIn?: PortAnchor;
  readonly execOut?: PortAnchor;
  readonly error: boolean;
  readonly selected: boolean;
  /** 行在节点内的纵向偏移（相对节点顶部）。 */
  readonly rowTops: readonly number[];
}

export interface GeometryOptions {
  readonly context: PortContext;
  readonly selection?: readonly string[];
  readonly errorNodes?: readonly string[];
}

/** 节点内行模型：参数行在前（保持目录顺序），纯端口行在后，输出行最后。 */
export function nodeRows(
  node: GraphNode,
  spec: NodeKindSpec,
  context: PortContext,
): readonly NodeRowModel[] {
  const declared = nodeParams(spec, node.params);
  const ports: readonly InputPortSpec[] = nodeInputs(spec, node.params, context);
  const byName = new Map(ports.map((port) => [port.name, port]));
  const rows: NodeRowModel[] = [];
  const used = new Set<string>();
  for (const param of declared) {
    const input = byName.get(param.name);
    if (input !== undefined) used.add(param.name);
    rows.push({
      key: param.name,
      label: param.label,
      param,
      ...(input === undefined
        ? {}
        : { input: { name: input.name, type: input.type, required: input.required } }),
      value: summarizeParam(param, node.params[param.name]),
    });
  }
  for (const input of ports) {
    if (used.has(input.name)) continue;
    rows.push({
      key: input.name,
      label: input.label,
      input: { name: input.name, type: input.type, required: input.required },
      value: '',
    });
  }
  const output = nodeOutput(spec, node.params);
  if (output !== undefined) {
    rows.push({ key: output.name, label: '结果', output: { name: output.name, type: output.type }, value: '' });
  }
  return rows;
}

/** 参数值的一行摘要：太长就截断，完整值在属性面板里。 */
export function summarizeParam(param: ParamSpec, value: ParamValue | undefined): string {
  if (param.kind === 'portList') {
    const list = Array.isArray(value) ? value : [];
    return list.length === 0 ? '没有命名输入' : list.join(', ');
  }
  if (Array.isArray(value)) return value.join(', ');
  const text = value === undefined ? '' : String(value);
  return text.length <= 28 ? text : `${text.slice(0, 27)}…`;
}

/** 节点框：高度按行数算，数据端口左右对齐，执行端口上下对齐。 */
export function nodeBox(
  node: GraphNode,
  placement: NodeLayout,
  options: GeometryOptions,
): NodeBox | undefined {
  const spec = nodeSpec(node.kind);
  if (spec === undefined) return undefined;
  const rows = nodeRows(node, spec, options.context);
  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT + FOOTER_HEIGHT + BODY_PADDING;
  const boxX = placement.x;
  const boxY = placement.y;
  const rowTops = rows.map((_, index) => HEADER_HEIGHT + index * ROW_HEIGHT);
  const inputAnchors: PortAnchor[] = [];
  const outputAnchors: PortAnchor[] = [];
  rows.forEach((row, index) => {
    const centerY = boxY + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (row.input !== undefined) {
      inputAnchors.push({
        nodeId: node.id,
        port: row.input.name,
        type: row.input.type,
        kind: 'in',
        flow: 'data',
        x: boxX,
        y: centerY,
      });
    }
    if (row.output !== undefined) {
      outputAnchors.push({
        nodeId: node.id,
        port: row.output.name,
        type: row.output.type,
        kind: 'out',
        flow: 'data',
        x: boxX + NODE_WIDTH,
        y: centerY,
      });
    }
  });

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
    subtitle: subtitleOf(spec, node.params),
    rows,
    inputs: inputAnchors,
    outputs: outputAnchors,
    ...(execIn === undefined ? {} : { execIn }),
    ...(execOut === undefined ? {} : { execOut }),
    error: (options.errorNodes ?? []).includes(node.id),
    selected: (options.selection ?? []).includes(node.id),
    rowTops,
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

/**
 * 正交折线：数据边横向走、执行边纵向走，中点错开避免线叠在一起。
 *
 * 画布本身走 `routing.ts`（带节点框避障）；这个函数保留给纯几何断言与不关心避障的调用方。
 */
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

/** 端口锚点 → 路由端点（临时连线与预览共用）。 */
export function routeEndOf(anchor: PortAnchor): RouteEnd {
  return { x: anchor.x, y: anchor.y, flow: anchor.flow, kind: anchor.kind };
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

/** 单个端口命中：接线、改接的落点判定都用它。 */
export function portHitTest(
  boxes: readonly NodeBox[],
  point: Point,
  radius = PORT_SIZE,
): PortAnchor | undefined {
  for (const box of boxes) {
    for (const port of allPorts(box)) {
      if (Math.abs(port.x - point.x) <= radius && Math.abs(port.y - point.y) <= radius) return port;
    }
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
  // CSS 的 translate 必须带长度单位；无单位是无效声明，整条 transform 会被丢掉（画布就固定不动了）。
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
}

/**
 * 同一套视图变换的 SVG 写法：`transform` 属性按用户单位解析，**不能**带 px，
 * 否则浏览器报 "Expected ')'" 并且整条变换失效（边线会与节点错位）。
 */
export function svgViewportTransform(viewport: Viewport): string {
  return `translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`;
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

/** 把内容放进视口：用于「适应画布」与首次打开时的定位。 */
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

// ---------------------------------------------------------------------------
// 容器区域（06 §5.2；07 §P4「容器折叠、内部编辑和边界端口」）
// ---------------------------------------------------------------------------

/** 区域框内边距与标签高度：子节点被包在框里，标签条不挡拖动。 */
export const REGION_PADDING = 18;
export const REGION_LABEL_HEIGHT = 22;
/** 空区域也要有可放置面积，否则没法把第一个节点拖进去。 */
export const EMPTY_REGION_HEIGHT = 64;

export interface RegionFrame {
  readonly nodeId: string;
  readonly region: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly empty: boolean;
}

export interface ContainerShape {
  readonly nodeId: string;
  /** 该容器声明的区域（名字与标签来自目录）。 */
  readonly regions: readonly { readonly name: string; readonly label: string }[];
  /** 区域成员：容器节点自己的 `regions`。 */
  readonly members: Readonly<Record<string, readonly string[]>>;
}

/**
 * 由子节点包围盒推出区域框：区域没有自己的坐标，跟着子节点走，所以拖动子节点时框会自适应。
 * 空区域挂在容器下方给一块放置区；嵌套容器再按面积从小到大排，命中时取最内层。
 */
export function regionFrames(
  containers: readonly ContainerShape[],
  boxes: readonly NodeBox[],
): readonly RegionFrame[] {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const frames: RegionFrame[] = [];
  for (const container of containers) {
    const owner = byId.get(container.nodeId);
    for (const region of container.regions) {
      const members = (container.members[region.name] ?? [])
        .map((id) => byId.get(id))
        .filter((box): box is NodeBox => box !== undefined);
      if (members.length === 0) {
        if (owner === undefined) continue;
        frames.push({
          nodeId: container.nodeId,
          region: region.name,
          label: region.label,
          x: owner.x,
          y: owner.y + owner.height + 8,
          width: NODE_WIDTH,
          height: EMPTY_REGION_HEIGHT,
          empty: true,
        });
        continue;
      }
      const minX = Math.min(...members.map((box) => box.x));
      const minY = Math.min(...members.map((box) => box.y));
      const maxX = Math.max(...members.map((box) => box.x + box.width));
      const maxY = Math.max(...members.map((box) => box.y + box.height));
      frames.push({
        nodeId: container.nodeId,
        region: region.name,
        label: region.label,
        x: minX - REGION_PADDING,
        y: minY - REGION_PADDING - REGION_LABEL_HEIGHT,
        width: maxX - minX + REGION_PADDING * 2,
        height: maxY - minY + REGION_PADDING * 2 + REGION_LABEL_HEIGHT,
        empty: false,
      });
    }
  }
  return frames;
}

/** 命中区域框：取面积最小（最内层）的一个，嵌套时不会误放到外层。 */
export function regionAt(frames: readonly RegionFrame[], point: Point): RegionFrame | undefined {
  let best: RegionFrame | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const contains =
      point.x >= frame.x &&
      point.x <= frame.x + frame.width &&
      point.y >= frame.y &&
      point.y <= frame.y + frame.height;
    if (!contains) continue;
    const area = frame.width * frame.height;
    if (area < bestArea) {
      best = frame;
      bestArea = area;
    }
  }
  return best;
}

/** 连线避障用的矩形：节点框的显示尺寸，不带语义。 */
export function rectOfBox(box: NodeBox): { x: number; y: number; width: number; height: number } {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** 正式连线的路径（带避障）：输出端口在右侧，输入端口在左侧。 */
export function connectionPath(from: PortAnchor, to: PortAnchor, fromBox: NodeBox, toBox: NodeBox): string {
  return orthogonalRoute(routeEndOf(from), routeEndOf(to), rectOfBox(fromBox), rectOfBox(toBox)).path;
}
