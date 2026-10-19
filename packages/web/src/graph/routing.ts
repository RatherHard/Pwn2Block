/**
 * 直角折线路由（10 §3.4「输入输出与路径」）。
 *
 * 正式连线与接线中的临时连线统一用直角折线；连线不得穿过它所连接的两个节点本体。
 * 这里只做「两点两框」的局部避障——全局绕开所有其它节点不在本轮验收范围内（10 §3.4 末条），
 * 所以刻意保持纯函数、可穷举：候选折线有限，逐条验证后取弯折最少、路径最短的一条。
 *
 * 坐标是图坐标（世界坐标），与 `graph-canvas.ts` 的 `transform` 无关。
 */

export interface RoutePoint {
  readonly x: number;
  readonly y: number;
}

export interface RouteRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 一个端点：坐标 + 所在端口的方向轴 + 它是线的出发端还是进入端。 */
export interface RouteEnd {
  readonly x: number;
  readonly y: number;
  /** 数据端口在节点左/右侧，执行端口在上/下侧。 */
  readonly flow: 'data' | 'exec';
  /** `out` 表示这条线从这里出发，`in` 表示这条线在这里进入。 */
  readonly kind: 'in' | 'out';
}

export interface RouteResult {
  /** SVG path 的 `d`：只有 M / L。 */
  readonly path: string;
  /** 折点序列（含首尾）。相邻点不会重复，也不会出现零长度段。 */
  readonly points: readonly RoutePoint[];
  /** 箭头位置：最后一个折点，等于 `to`。 */
  readonly end: RoutePoint;
}

/** 折线离开端口的最小外伸距离。 */
export const ROUTE_STUB = 24;

/** 判定「穿过框内部」时的容差：端口本身落在边框上，贴着边框走不算穿过。 */
const EPSILON = 0.5;

interface Vector {
  readonly dx: number;
  readonly dy: number;
}

/** 端口朝外的方向：数据 out 向右、data in 向左、exec out 向下、exec in 向上。 */
function outward(end: RouteEnd): Vector {
  if (end.flow === 'exec') return end.kind === 'out' ? { dx: 0, dy: 1 } : { dx: 0, dy: -1 };
  return end.kind === 'out' ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
}

function offset(point: RoutePoint, vector: Vector, distance: number): RoutePoint {
  return { x: point.x + vector.dx * distance, y: point.y + vector.dy * distance };
}

function samePoint(a: RoutePoint, b: RoutePoint): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

/** 去掉重复点与三点共线的中间点：路径更短，弯数统计也更准。 */
function simplify(points: readonly RoutePoint[]): readonly RoutePoint[] {
  const kept: RoutePoint[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last !== undefined && samePoint(last, point)) continue;
    kept.push(point);
  }
  const result: RoutePoint[] = [];
  for (const point of kept) {
    const a = result[result.length - 2];
    const b = result[result.length - 1];
    if (a !== undefined && b !== undefined) {
      const collinear =
        (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - point.x) < 0.01) ||
        (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - point.y) < 0.01);
      if (collinear) result[result.length - 1] = point;
      else result.push(point);
    } else {
      result.push(point);
    }
  }
  return result;
}

/** 水平/垂直直线段是否穿过矩形内部（贴边不算）。 */
function segmentEntersRect(a: RoutePoint, b: RoutePoint, rect: RouteRect): boolean {
  const left = rect.x + EPSILON;
  const right = rect.x + rect.width - EPSILON;
  const top = rect.y + EPSILON;
  const bottom = rect.y + rect.height - EPSILON;
  if (Math.abs(a.y - b.y) < 0.01) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return a.y > top && a.y < bottom && maxX > left && minX < right;
  }
  if (Math.abs(a.x - b.x) < 0.01) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return a.x > left && a.x < right && maxY > top && minY < bottom;
  }
  return false;
}

function crosses(points: readonly RoutePoint[], rects: readonly RouteRect[]): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index] as RoutePoint;
    const b = points[index + 1] as RoutePoint;
    for (const rect of rects) {
      if (segmentEntersRect(a, b, rect)) return true;
    }
  }
  return false;
}

function lengthOf(points: readonly RoutePoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index] as RoutePoint;
    const b = points[index + 1] as RoutePoint;
    total += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  return total;
}

function toPath(points: readonly RoutePoint[]): string {
  const [first, ...rest] = points;
  if (first === undefined) return '';
  const head = `M ${round(first.x)} ${round(first.y)}`;
  return rest.reduce((path, point) => `${path} L ${round(point.x)} ${round(point.y)}`, head);
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function build(points: readonly RoutePoint[], end: RoutePoint): RouteResult {
  const simplified = simplify(points);
  return { path: toPath(simplified), points: simplified, end };
}

/** 两条线端点重合时的退化路径。 */
function single(point: RoutePoint): RouteResult {
  return { path: `M ${round(point.x)} ${round(point.y)}`, points: [point], end: point };
}

/** 可选的水平/垂直通道：两个框的外侧各留 stub，再加上两个端口本身的坐标。 */
function lanes(box: RouteRect, end: RoutePoint): { xs: number[]; ys: number[] } {
  return {
    xs: [box.x - ROUTE_STUB, box.x + box.width + ROUTE_STUB, end.x],
    ys: [box.y - ROUTE_STUB, box.y + box.height + ROUTE_STUB, end.y],
  };
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 10) / 10))].sort((a, b) => a - b);
}

/**
 * 两个端口之间的直角折线。
 *
 * 先试「Z 字」直达（端口外伸后横竖各一段），不行再穷举几条位于两框外侧的通道，
 * 逐条验证不穿过两框内部，最后取弯折最少、长度最短的一条。这样在任意相对位置
 * （包括目标在左侧、上下空间不足）都能得到一条不穿过自身节点的线。
 */
export function orthogonalRoute(
  from: RouteEnd,
  to: RouteEnd,
  fromBox: RouteRect,
  toBox: RouteRect,
  stub: number = ROUTE_STUB,
): RouteResult {
  if (samePoint(from, to)) return single({ x: from.x, y: from.y });
  const start = offset(from, outward(from), stub);
  const finish = offset(to, outward(to), stub);
  const rects = [fromBox, toBox];
  const candidates: (readonly RoutePoint[])[] = [
    // Z 字：先沿出发方向外伸，再横竖各一段，最后进入目标端口。
    [{ x: from.x, y: from.y }, start, { x: finish.x, y: start.y }, finish, { x: to.x, y: to.y }],
    [{ x: from.x, y: from.y }, start, { x: start.x, y: finish.y }, finish, { x: to.x, y: to.y }],
  ];

  const lanesX = uniqueSorted([
    ...lanes(fromBox, from).xs,
    ...lanes(toBox, to).xs,
    start.x,
    finish.x,
  ]);
  const lanesY = uniqueSorted([
    ...lanes(fromBox, from).ys,
    ...lanes(toBox, to).ys,
    start.y,
    finish.y,
  ]);
  for (const laneX of lanesX) {
    for (const laneY of lanesY) {
      candidates.push([
        { x: from.x, y: from.y },
        start,
        { x: laneX, y: start.y },
        { x: laneX, y: laneY },
        { x: finish.x, y: laneY },
        finish,
        { x: to.x, y: to.y },
      ]);
      candidates.push([
        { x: from.x, y: from.y },
        start,
        { x: start.x, y: laneY },
        { x: laneX, y: laneY },
        { x: laneX, y: finish.y },
        finish,
        { x: to.x, y: to.y },
      ]);
    }
  }

  let best: readonly RoutePoint[] | undefined;
  let bestBends = Number.POSITIVE_INFINITY;
  let bestLength = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const simplified = simplify(candidate);
    if (crosses(simplified, rects)) continue;
    const bends = simplified.length;
    const length = lengthOf(simplified);
    if (bends < bestBends || (bends === bestBends && length < bestLength)) {
      best = simplified;
      bestBends = bends;
      bestLength = length;
    }
  }
  // 没有任何候选通过验证（理论上不会发生）：退回最朴素的 Z 字，至少保持直角。
  const points = best ?? simplify(candidates[0] as readonly RoutePoint[]);
  return build(points, { x: to.x, y: to.y });
}

/** 拖拽中的临时连线：终点是鼠标位置，没有目标节点框。 */
export function previewRoute(
  from: RouteEnd,
  to: RoutePoint,
  fromBox: RouteRect,
  stub: number = ROUTE_STUB,
): RouteResult {
  if (samePoint(from, to)) return single({ x: from.x, y: from.y });
  const start = offset(from, outward(from), stub);
  const tail = [start, { x: to.x, y: start.y }, to];
  const horizontalFirst = [{ x: from.x, y: from.y }, ...tail];
  const verticalFirst = [{ x: from.x, y: from.y }, start, { x: start.x, y: to.y }, to];
  const first = simplify(horizontalFirst);
  const points = crosses(first, [fromBox]) ? simplify(verticalFirst) : first;
  return build(points, to);
}
