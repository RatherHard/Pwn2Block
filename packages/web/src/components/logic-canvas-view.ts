import { canvas } from '@pwn2block/shared';
import { logicBox, type LogicBox } from '../canvas/logic-editor';
export function logicTitle(node: canvas.LogicNode, methods: readonly canvas.CanvasMethodDecl[]): string {
  switch (node.kind) {
    case 'constant':
      return `常量 · ${node.value.type}`;
    case 'variable':
      return node.name || '未命名变量';
    case 'convert':
      return `类型转换 → ${node.target}`;
    case 'start':
      return '开始';
    case 'branch':
      return '条件分支';
    case 'loop':
      return '次数循环';
    case 'method':
      return methods.find((m) => m.id === node.method)?.label ?? node.method;
    case 'envelope':
      return node.title || node.id;
  }
}
export function logicSummary(value: canvas.Value | string | undefined): string {
  if (value === undefined) return '待连接';
  if (typeof value === 'string') return value;
  if (value.kind === 'byte')
    return `bytes ${Array.from(value.bytes)
      .map((n) => n.toString(16).padStart(2, '0'))
      .join(' ')}`;
  if ('value' in value) return `${value.kind} ${String(value.value)}`;
  return '';
}
export function logicLiteralSummary(value: canvas.LogicLiteral): string {
  try {
    return logicSummary(canvas.logicLiteral(value, ''));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}
function boundary(box: LogicBox, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const dx = toward.x - cx,
    dy = toward.y - cy;
  const scale = 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2), 0.001);
  return { x: cx + dx * scale, y: cy + dy * scale };
}
export function logicEdgeGeometry(
  graph: canvas.LogicGraph,
  edge: canvas.LogicEdge,
): { paths: string[]; x: number; y: number } {
  const a = logicBox(graph, edge.from),
    b = logicBox(graph, edge.to);
  const centerA = { x: a.x + a.width / 2, y: a.y + a.height / 2 },
    centerB = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const from = boundary(a, centerB),
    to = boundary(b, centerA);
  if (edge.kind === 'flow') {
    const x1 = a.x + a.width + 13,
      y1 = a.y + (edge.outlet === 'then' ? 24 : edge.outlet === 'else' ? 56 : 38);
    const x2 = b.x - 13,
      y2 = b.y + 38;
    const points = [{ x: x1, y: y1 }, ...(edge.points ?? []), { x: x2, y: y2 }];
    const path = points.length === 2
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} ` + curveSegments(points).map(({ c1, c2, to }) =>
        `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`).join(' ');
    return { paths: [path], x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length,
    uy = (to.y - from.y) / length;
  // 将引用线端点延长到节点边界以内，交给节点背景覆盖端点。
  const referenceExtension = 18;
  const extendedFrom = { x: from.x - ux * referenceExtension, y: from.y - uy * referenceExtension };
  const extendedTo = { x: to.x + ux * referenceExtension, y: to.y + uy * referenceExtension };
  const nx = -uy * 6,
    ny = ux * 6;
  return {
    paths:
      edge.kind === 'reference'
        ? [-1, 0, 1].map(
            (offset) =>
              `M ${extendedFrom.x + nx * offset} ${extendedFrom.y + ny * offset} L ${extendedTo.x + nx * offset} ${extendedTo.y + ny * offset}`,
          )
        : [],
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
}

/** 连线命中范围避开端口，保证已有连接的端口仍可点击。 */
export function logicFlowHitClip(graph: canvas.LogicGraph, edge: Extract<canvas.LogicEdge, { kind: 'flow' }>): string {
  const a = logicBox(graph, edge.from), b = logicBox(graph, edge.to);
  const from = { x: a.x + a.width + 13, y: a.y + (edge.outlet === 'then' ? 24 : edge.outlet === 'else' ? 56 : 38) };
  const to = { x: b.x - 13, y: b.y + 38 };
  const points = [from, ...(edge.points ?? []), to];
  const left = Math.min(...points.map((p) => p.x)), right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y)), bottom = Math.max(...points.map((p) => p.y));
  const pad = Math.max(right - left, bottom - top, 100);
  const outer = `M ${left - pad} ${top - pad} H ${right + pad} V ${bottom + pad} H ${left - pad} Z`;
  // 端口重叠时合并排除区域，避免奇偶裁剪重新开放重叠部分。
  if (Math.abs(from.x - to.x) < 24 && Math.abs(from.y - to.y) < 24)
    return `${outer} M ${Math.min(from.x, to.x) - 12} ${Math.min(from.y, to.y) - 12} H ${Math.max(from.x, to.x) + 12} V ${Math.max(from.y, to.y) + 12} H ${Math.min(from.x, to.x) - 12} Z`;
  return outer + [from, to].map((p) => ` M ${p.x - 12} ${p.y - 12} h 24 v 24 h -24 Z`).join('');
}

type Point = { x: number; y: number };
function curveSegments(points: readonly Point[]) {
  return points.slice(1).map((to, i) => {
    const from = points[i]!, previous = points[Math.max(0, i - 1)]!, next = points[Math.min(points.length - 1, i + 2)]!;
    return { from, to,
      c1: { x: from.x + (to.x - previous.x) / 6, y: from.y + (to.y - previous.y) / 6 },
      c2: { x: to.x - (next.x - from.x) / 6, y: to.y - (next.y - from.y) / 6 } };
  });
}
/** Insert in route order, including on a curve that doubles back on itself. */
export function logicPointInsertionIndex(graph: canvas.LogicGraph, edge: Extract<canvas.LogicEdge, { kind: 'flow' }>, point: Point): number {
  const a = logicBox(graph, edge.from), b = logicBox(graph, edge.to);
  const points = [{ x: a.x + a.width + 13, y: a.y + (edge.outlet === 'then' ? 24 : edge.outlet === 'else' ? 56 : 38) },
    ...(edge.points ?? []), { x: b.x - 13, y: b.y + 38 }];
  let best = Infinity, index = 0;
  curveSegments(points).forEach(({ from, to, c1, c2 }, i) => {
    for (let step = 0; step <= 64; step++) {
      const t = step / 64, u = 1 - t;
      const x = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x;
      const y = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y;
      const distance = Math.hypot(x - point.x, y - point.y);
      if (distance < best) { best = distance; index = i; }
    }
  });
  return index;
}
