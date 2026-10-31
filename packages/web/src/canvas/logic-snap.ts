import { canvas } from '@pwn2block/shared';
import { logicAttachmentHost, logicBox, logicEnvelopeDepth, logicId, layoutLogicDataComponents,
  LOGIC_RELATION_GAP, LOGIC_RELATION_WIDTH, LogicLayoutError } from './logic-geometry';
import { admissible } from './logic-connections';
import { nearestOtherSnap } from './logic-other-snap';

export interface LogicSnap {
  graph: canvas.LogicGraph;
  edge?: canvas.LogicEdge;
  edges?: canvas.LogicEdge[];
  target: string;
  distance: number;
  attachment?: string;
  kind?: 'insert' | 'connect';
  key?: string;
}
export interface LogicSnapOptions {
  movingIds?: readonly string[];
  pointer?: { x: number; y: number };
  scale?: number;
  previous?: LogicSnap;
  original?: canvas.LogicGraph;
}
type DataEdge = Extract<canvas.LogicEdge, { kind: 'data' }>;
type Context = { graph: canvas.LogicGraph; ids: string[]; own: Set<string>; options: LogicSnapOptions };
const spacing = LOGIC_RELATION_WIDTH + LOGIC_RELATION_GAP * 2;

function pointInside(box: ReturnType<typeof logicBox>, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}
function scopeAllowed(context: Context, target: string): boolean {
  const { graph, ids, options } = context;
  const owner = canvas.logicOwner(graph, target);
  if (!owner) return true;
  const first = logicBox(graph, ids[0]!);
  const point = options.pointer ?? { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  return pointInside(logicBox(graph, owner.id), point);
}
function adopt(graph: canvas.LogicGraph, ids: string[], target: string): canvas.LogicGraph {
  const owner = canvas.logicOwner(graph, target);
  return { ...graph, nodes: graph.nodes.map((node) => node.kind !== 'envelope' ? node :
    node.id === owner?.id ? { ...node, members: [...new Set([...node.members, ...ids])] } :
      { ...node, members: node.members.filter((id) => !ids.includes(id)) }) };
}
function knownValuesRemainValid(before: canvas.LogicGraph, after: canvas.LogicGraph): boolean {
  const previous = canvas.previewLogicGraph(before), next = canvas.previewLogicGraph(after);
  if (!next.size) return false;
  return [...next].every(([id, value]) => typeof value !== 'string' || typeof previous.get(id) === 'string');
}
function candidate(
  context: Context, graph: canvas.LogicGraph, edges: DataEdge[], target: string, anchor: string,
  distance: number, key: string, kind: 'insert' | 'connect',
): LogicSnap | undefined {
  const threshold = context.options.previous?.key === key ? 36 : 24;
  if (distance * (context.options.scale ?? 1) > threshold || !scopeAllowed(context, target)) return undefined;
  try {
    const next = layoutLogicDataComponents(adopt(graph, context.ids, target), anchor);
    if (!admissible(context.graph, next) || !knownValuesRemainValid(context.graph, next)) return undefined;
    return { graph: next, edges, edge: edges[0], target, distance, key, kind };
  } catch (error) {
    if (error instanceof LogicLayoutError) return undefined;
    throw error;
  }
}
function insertion(context: Context): LogicSnap[] {
  const { graph, ids, own, options } = context;
  if (ids.some((id) => canvas.logicHasAssignment(graph, id)) ||
    graph.edges.some((edge) => edge.kind === 'data' && edge.op === 'assign' && own.has(edge.to))) return [];
  const first = logicBox(graph, ids[0]!);
  const pointer = options.pointer ?? { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  const candidates: LogicSnap[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'data' || own.has(edge.from) || own.has(edge.to)) continue;
    const [left, right] = canvas.logicDataSides(edge);
    if (canvas.logicMembers(graph, left).has(ids[0]!) || canvas.logicMembers(graph, right).has(ids[0]!)) continue;
    const a = logicBox(graph, left), b = logicBox(graph, right);
    const x = (a.x + a.width + b.x) / 2, y = (a.y + a.height / 2 + b.y + b.height / 2) / 2;
    const distance = Math.hypot(Math.max(0, Math.abs(pointer.x - x) - LOGIC_RELATION_WIDTH / 2),
      Math.max(0, Math.abs(pointer.y - y) - 14));
    const firstEdge: DataEdge = { ...edge,
      from: edge.op === 'assign' ? ids[0]! : left, to: edge.op === 'assign' ? left : ids[0]! };
    const second: DataEdge = { id: logicId(graph, 'edge'), kind: 'data', from: ids.at(-1)!, to: right, op: '+' };
    const next = { ...graph, edges: [...graph.edges.map((item) => item.id === edge.id ? firstEdge : item), second] };
    const snap = candidate(context, next, [firstEdge, second], left, left, distance, `insert:${edge.id}`, 'insert');
    if (snap) candidates.push(snap);
  }
  return candidates;
}
function edgeBetween(context: Context, left: string, right: string): DataEdge | undefined {
  const { graph, options } = context;
  const original = options.original?.edges.find((edge): edge is DataEdge => edge.kind === 'data' &&
    canvas.logicDataSides(edge)[0] === left && canvas.logicDataSides(edge)[1] === right);
  if (original) return { ...original, id: graph.edges.some((edge) => edge.id === original.id) ? logicId(graph, 'edge') : original.id };
  const a = graph.nodes.find((node) => node.id === left)!;
  const op = a.kind === 'variable' ? 'assign' : '+';
  return { id: logicId(graph, 'edge'), kind: 'data', from: op === 'assign' ? right : left, to: op === 'assign' ? left : right, op };
}
function connections(context: Context): LogicSnap[] {
  const { graph, ids, own } = context;
  const candidates: LogicSnap[] = [];
  for (const node of graph.nodes) {
    if (own.has(node.id) || logicAttachmentHost(node) || canvas.logicCategory(node) !== 'data' ||
      ids.some((id) => canvas.logicMembers(graph, node.id).has(id))) continue;
    const target = logicBox(graph, node.id);
    for (const side of ['left', 'right'] as const) {
      const movingId = side === 'left' ? ids.at(-1)! : ids[0]!;
      const left = side === 'left' ? movingId : node.id, right = side === 'left' ? node.id : movingId;
      if (graph.edges.some((edge) => edge.kind === 'data' &&
        (canvas.logicDataSides(edge)[0] === left || canvas.logicDataSides(edge)[1] === right))) continue;
      const moving = logicBox(graph, movingId);
      const gap = side === 'left' ? target.x - moving.x - moving.width : moving.x - target.x - target.width;
      const point = context.options.pointer ?? { x: moving.x + moving.width / 2, y: moving.y + moving.height / 2 };
      const distance = canvas.logicOwner(graph, node.id)
        ? Math.hypot(point.x - (side === 'left' ? target.x : target.x + target.width), point.y - target.y - target.height / 2)
        : Math.hypot(gap - spacing, moving.y + moving.height / 2 - target.y - target.height / 2);
      const edge = edgeBetween(context, left, right)!;
      const next = { ...graph, edges: [...graph.edges, edge] };
      const snap = candidate(context, next, [edge], node.id, node.id, distance, `connect:${left}:${right}`, 'connect');
      if (snap) candidates.push(snap);
    }
  }
  return candidates;
}
export function nearestLogicSnap(
  graph: canvas.LogicGraph, movingId: string, methods: readonly canvas.CanvasMethodDecl[], options: LogicSnapOptions = {},
): LogicSnap | undefined {
  const ids = [...(options.movingIds ?? [movingId])];
  const row = canvas.logicDataRow(graph, movingId);
  const own = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  for (const node of graph.nodes) if (own.has(logicAttachmentHost(node) ?? '')) own.add(node.id);
  const isData = ids.every((id) => {
    const node = graph.nodes.find((item) => item.id === id);
    return node && canvas.logicCategory(node) === 'data' && !logicAttachmentHost(node);
  });
  const complete = row.length === ids.length && ids.every((id) => row.includes(id));
  const candidates: LogicSnap[] = [];
  if (isData && complete && !graph.edges.some((edge) => edge.kind === 'data' && own.has(edge.from) !== own.has(edge.to))) {
    const context = { graph, ids: row, own, options };
    candidates.push(...insertion(context), ...connections(context));
  }
  if (ids.length === 1) {
    const other = nearestOtherSnap(graph, movingId, methods);
    if (other) candidates.push(other);
  }
  return candidates.sort((a, b) => {
    const aHit = a.kind === 'insert' && a.distance === 0;
    const bHit = b.kind === 'insert' && b.distance === 0;
    if (aHit !== bHit) return aHit ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return logicEnvelopeDepth(graph, b.target) - logicEnvelopeDepth(graph, a.target) || a.target.localeCompare(b.target);
  })[0];
}
