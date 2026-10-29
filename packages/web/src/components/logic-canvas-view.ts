import type { canvas } from '@pwn2block/shared';
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
      return node.title;
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
    const mid = x2 >= x1 ? (x1 + x2) / 2 : Math.max(x1, b.x + b.width) + 32;
    const path =
      x2 >= x1
        ? `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`
        : `M ${x1} ${y1} H ${mid} V ${Math.max(a.y + a.height, b.y + b.height) + 24} H ${x2 - 24} V ${y2} H ${x2}`;
    return { paths: [path], x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const nx = (-(to.y - from.y) / length) * 3,
    ny = ((to.x - from.x) / length) * 3;
  return {
    paths:
      edge.kind === 'reference'
        ? [-1, 0, 1].map(
            (offset) =>
              `M ${from.x + nx * offset} ${from.y + ny * offset} L ${to.x + nx * offset} ${to.y + ny * offset}`,
          )
        : [],
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
}
