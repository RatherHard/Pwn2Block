import type { canvas } from '@pwn2block/shared';
import { logicAttachmentHost } from './logic-editor';

/** 一个可独立升降的画布结构层。members 按绘制顺序从底到顶记录结构内节点。 */
export interface LogicLayer {
  readonly id: string;
  readonly members: readonly string[];
  readonly index: number;
}

type Parent = Map<string, string>;

function find(parent: Parent, id: string): string {
  const current = parent.get(id);
  if (current === undefined || current === id) return id;
  const root = find(parent, current);
  parent.set(id, root);
  return root;
}

function union(parent: Parent, a: string, b: string): void {
  const left = find(parent, a);
  const right = find(parent, b);
  if (left !== right) parent.set(right, left);
}

/**
 * 根据逻辑图计算结构层。
 *
 * 数据连接、包络成员和转换/循环附件属于同一结构；流程连接、引用连接
 * 只负责语义，不会把两个独立结构合并。
 */
function structureGroups(graph: canvas.LogicGraph): Map<string, string[]> {
  const parent: Parent = new Map(graph.nodes.map((node) => [node.id, node.id]));
  for (const node of graph.nodes) {
    if (node.kind === 'envelope') {
      for (const member of node.members) if (parent.has(member)) union(parent, node.id, member);
    }
    const host = logicAttachmentHost(node);
    if (host !== undefined && parent.has(host)) union(parent, node.id, host);
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'data' && parent.has(edge.from) && parent.has(edge.to)) union(parent, edge.from, edge.to);
  }
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const root = find(parent, node.id);
    const members = groups.get(root) ?? [];
    members.push(node.id);
    groups.set(root, members);
  }
  return groups;
}

function structureGroupById(graph: canvas.LogicGraph): Map<string, string> {
  const groupById = new Map<string, string>();
  for (const [root, members] of structureGroups(graph)) for (const id of members) groupById.set(id, root);
  return groupById;
}

/**
 * 清理并补全从底到顶的节点顺序，使同一结构的成员连续。
 * 无效、重复 ID 会被丢弃；新节点按 graph.nodes 顺序追加到最上层。
 */
export function normalizeLogicLayerOrder(
  graph: canvas.LogicGraph,
  order?: readonly string[],
): string[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const base: string[] = [];
  const seen = new Set<string>();
  for (const id of order ?? []) {
    if (nodeIds.has(id) && !seen.has(id)) {
      seen.add(id);
      base.push(id);
    }
  }
  for (const node of graph.nodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      base.push(node.id);
    }
  }
  const groups = structureGroups(graph);
  const groupById = structureGroupById(graph);
  const positions = new Map(base.map((id, index) => [id, index]));
  const grouped = [...groups.entries()].map(([root, members]) => ({
    root,
    members: [...members].sort((a, b) => positions.get(a)! - positions.get(b)!),
    rank: Math.max(...members.map((id) => positions.get(id)!)),
    first: Math.min(...members.map((id) => positions.get(id)!)),
  }));
  grouped.sort((a, b) => a.rank - b.rank || a.first - b.first || a.root.localeCompare(b.root));
  const result: string[] = [];
  for (const group of grouped) result.push(...group.members);
  // This guard also protects future changes to grouping from dropping a node.
  for (const id of base) if (!groupById.has(id)) result.push(id);
  return result;
}

export function logicLayers(
  graph: canvas.LogicGraph,
  order?: readonly string[],
): LogicLayer[] {
  const normalized = normalizeLogicLayerOrder(graph, order);
  const groupById = structureGroupById(graph);
  const layers: LogicLayer[] = [];
  for (const id of normalized) {
    const root = groupById.get(id);
    if (root === undefined || layers.some((layer) => layer.members.includes(id))) continue;
    const members = normalized.filter((member) => groupById.get(member) === root);
    layers.push({ id: members[0] ?? id, members, index: layers.length });
  }
  return layers;
}

/** 移动选中节点所属的完整结构层，不改变 graph。 */
export function moveLogicLayer(
  graph: canvas.LogicGraph,
  order: readonly string[],
  selectedIds: readonly string[],
  action: 'up' | 'down' | 'top' | 'bottom',
): string[] {
  const layers = logicLayers(graph, order);
  const selected = new Set(selectedIds);
  const selectedIndexes = layers.reduce<number[]>((indexes, layer, index) => {
    if (layer.members.some((id) => selected.has(id))) indexes.push(index);
    return indexes;
  }, []);
  if (!selectedIndexes.length) return normalizeLogicLayerOrder(graph, order);

  // Move selected structures as one stable sequence without changing their relative order.
  const selectedLayers = new Set(selectedIndexes);
  if (action === 'top' || action === 'bottom') {
    const rest = layers.filter((_, index) => !selectedLayers.has(index));
    const moved = layers.filter((_, index) => selectedLayers.has(index));
    return (action === 'top' ? [...rest, ...moved] : [...moved, ...rest]).flatMap((layer) => layer.members);
  }

  const next = [...layers];
  if (action === 'up') {
    for (let index = 1; index < next.length; index++) {
      if (selectedLayers.has(index) && !selectedLayers.has(index - 1)) {
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
      }
    }
  } else {
    for (let index = next.length - 2; index >= 0; index--) {
      if (selectedLayers.has(index) && !selectedLayers.has(index + 1)) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
    }
  }
  return next.flatMap((layer) => layer.members);
}

