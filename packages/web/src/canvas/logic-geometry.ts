import { canvas } from '@pwn2block/shared';
export interface LogicBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function logicId(graph: canvas.LogicGraph, prefix: string): string {
  let i = 1;
  const used = new Set([...graph.nodes, ...graph.edges].map((n) => n.id));
  while (used.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}
export function logicAttachmentHost(node: canvas.LogicNode): string | undefined {
  return node.kind === 'loop' ? node.body : node.kind === 'convert' ? node.input : undefined;
}
export function logicOwnerChain(graph: canvas.LogicGraph, id: string): string[] {
  const owners: string[] = [];
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const owner = canvas.logicOwner(graph, current);
    if (!owner) break;
    owners.push(owner.id);
    current = owner.id;
  }
  return owners;
}

export function logicEnvelopeDepth(graph: canvas.LogicGraph, id: string): number {
  return logicOwnerChain(graph, id).length;
}
export function logicBox(graph: canvas.LogicGraph, id: string, seen = new Set<string>()): LogicBox {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || seen.has(id)) return { x: 0, y: 0, width: 180, height: 76 };
  seen.add(id);
  const host = logicAttachmentHost(node);
  if (host) {
    const box = logicBox(graph, host, seen);
    const attachments = graph.nodes.filter((n) => logicAttachmentHost(n) === host);
    const hostNode = graph.nodes.find((candidate) => candidate.id === host);
    const attachmentTop = hostNode?.kind === 'envelope' && hostNode.category === 'data' ? 52 : 32;
    return { x: box.x + 8, y: box.y + attachmentTop + attachments.findIndex((n) => n.id === id) * 26,
      width: box.width - 16, height: 24 };
  }
  if (node.kind !== 'envelope' || !node.members.length)
    return { x: node.x, y: node.y, width: 180, height: 76 };
  const boxes = node.members.map((member) => logicBox(graph, member, new Set(seen)));
  // 为标题和表达式预览预留独立区域，避免文字压到包络成员。
  const header = 60 + graph.nodes.filter((n) => logicAttachmentHost(n) === id).length * 26;
  const x = Math.min(...boxes.map((b) => b.x)) - 24,
    y = Math.min(...boxes.map((b) => b.y)) - header;
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) + 24 - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) + 24 - y,
  };
}
/** 从可见区域开始寻找空位，连续添加节点时不覆盖已有表达式。 */
export function nextLogicPosition(
  graph: canvas.LogicGraph,
  left: number,
  top: number,
  width: number,
): { x: number; y: number } {
  const boxes = graph.nodes.map((n) => logicBox(graph, n.id));
  const columns = Math.max(1, Math.floor((width - 60) / 248));
  for (let slot = 0; slot < 2048; slot++) {
    const x = left + 40 + (slot % columns) * 248;
    const y = top + 50 + Math.floor(slot / columns) * 140;
    if (
      boxes.every((b) => x + 204 < b.x || x > b.x + b.width + 24 || y + 100 < b.y || y > b.y + b.height + 24)
    )
      return { x, y };
  }
  return { x: left + 40, y: Math.max(0, ...boxes.map((b) => b.y + b.height)) + 60 };
}
export function moveLogicNodes(
  graph: canvas.LogicGraph,
  ids: readonly string[],
  dx: number,
  dy: number,
): canvas.LogicGraph {
  const all = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  for (const node of graph.nodes)
    if (
      (node.kind === 'loop' && node.body && all.has(node.body)) ||
      (node.kind === 'convert' && node.input && all.has(node.input))
    )
      all.add(node.id);
  const x = dx, y = dy;
  return { ...graph, nodes: graph.nodes.map((n) => (all.has(n.id) ? { ...n, x: n.x + x, y: n.y + y } : n)),
    edges: graph.edges.map((e) => e.kind === 'flow' && e.points && all.has(e.from) && all.has(e.to)
      ? { ...e, points: e.points.map((p) => ({ x: p.x + x, y: p.y + y })) } : e) };
}
export const LOGIC_RELATION_WIDTH = 64;
export const LOGIC_RELATION_GAP = 12;
const dataSpacing = LOGIC_RELATION_WIDTH + LOGIC_RELATION_GAP * 2;
export function dataSides(edge: Extract<canvas.LogicEdge, { kind: 'data' }>): [string, string] {
  return canvas.logicDataSides(edge);
}
export function dataComponent(graph: canvas.LogicGraph, anchor: string): Set<string> {
  const component = new Set([anchor]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of graph.edges) {
      if (edge.kind !== 'data' || (!component.has(edge.from) && !component.has(edge.to))) continue;
      const size = component.size;
      component.add(edge.from);
      component.add(edge.to);
      expanded ||= component.size !== size;
    }
  }
  return component;
}
/** Fixed data rows have one neighbour on each side. Reject overlapping branches. */
function dataNeighbours(graph: canvas.LogicGraph, anchor: string): Map<string, { left?: string; right?: string }> {
  const component = dataComponent(graph, anchor);
  const neighbours = new Map<string, { left?: string; right?: string }>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'data' || !component.has(edge.from)) continue;
    const [left, right] = dataSides(edge);
    const a = neighbours.get(left) ?? {}, b = neighbours.get(right) ?? {};
    if (a.right || b.left) throw new LogicLayoutError('数据节点的这一侧已有连接，请连接结构的空闲端点');
    a.right = right;
    b.left = left;
    neighbours.set(left, a);
    neighbours.set(right, b);
  }
  return neighbours;
}
/** Keep the anchor stationary and place its entire data row at fixed horizontal intervals. */
export class LogicLayoutError extends Error {}
export function layoutLogicData(graph: canvas.LogicGraph, anchor: string): canvas.LogicGraph {
  const neighbours = dataNeighbours(graph, anchor);
  let next = graph;
  const visited = new Set<string>();
  const pending = [anchor];
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const box = logicBox(next, id);
    const adjacent = neighbours.get(id);
    for (const side of ['left', 'right'] as const) {
      const other = adjacent?.[side];
      if (!other || visited.has(other)) continue;
      const target = logicBox(next, other);
      const x = side === 'left' ? box.x - dataSpacing - target.width : box.x + box.width + dataSpacing;
      next = moveLogicNodes(next, [other], x - target.x, box.y + box.height / 2 - target.height / 2 - target.y);
      pending.push(other);
    }
  }
  return next;
}
function stableDataAnchor(graph: canvas.LogicGraph, component: Set<string>): string {
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  return [...component].sort((a, b) => {
    const left = logicBox(graph, a), right = logicBox(graph, b);
    return left.x - right.x || left.y - right.y || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  })[0]!;
}
/** Rebuild every data row after a structural edit, while keeping one stable node per row fixed. */
export function layoutLogicDataComponents(graph: canvas.LogicGraph, preferredAnchor?: string): canvas.LogicGraph {
  let next = graph;
  const visited = new Set<string>();
  const nodes = [...graph.nodes].sort((a, b) => logicEnvelopeDepth(graph, b.id) - logicEnvelopeDepth(graph, a.id));
  for (const node of nodes) {
    if (visited.has(node.id) || !graph.edges.some((edge) => edge.kind === 'data' && (edge.from === node.id || edge.to === node.id))) continue;
    const component = dataComponent(graph, node.id);
    for (const id of component) visited.add(id);
    const anchor = preferredAnchor && component.has(preferredAnchor) ? preferredAnchor : stableDataAnchor(graph, component);
    next = layoutLogicData(next, anchor);
  }
  return next;
}
