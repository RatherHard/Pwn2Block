import { logicOwner, type LogicEdge, type LogicGraph } from './logic-model';

/** 赋值边的语义方向与画面左右方向相反。 */
export function logicDataSides(edge: Extract<LogicEdge, { kind: 'data' }>): [string, string] {
  return edge.op === 'assign' ? [edge.to, edge.from] : [edge.from, edge.to];
}

/** 赋值框紧邻首项时取右侧整条表达式的结果，也兼容旧的末项赋值边。 */
export function logicAssignmentSource(graph: LogicGraph, from: string): string {
  let current = from;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const edge = graph.edges.find((item) => item.kind === 'data' && item.op !== 'assign' && item.from === current &&
      logicOwner(graph, item.from)?.id === logicOwner(graph, item.to)?.id);
    if (!edge) return current;
    current = edge.to;
  }
  return current;
}

/** 同层连通分量；包络在父层作为单个节点，引用不参与连通。 */
export function logicComponents(graph: LogicGraph, ids: readonly string[], kind: 'data' | 'flow'): string[][] {
  const remaining = new Set(ids);
  const neighbours = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.kind !== kind || !remaining.has(edge.from) || !remaining.has(edge.to)) continue;
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
  }
  const groups: string[][] = [];
  for (const id of ids) {
    if (!remaining.has(id)) continue;
    const group: string[] = [], pending = [id];
    while (pending.length) {
      const current = pending.shift()!;
      if (!remaining.delete(current)) continue;
      group.push(current);
      pending.push(...neighbours.get(current)!);
    }
    groups.push(group);
  }
  return groups;
}

export function logicDataRow(graph: LogicGraph, id: string): string[] {
  const owner = logicOwner(graph, id)?.id;
  const peers = graph.nodes.filter((node) => logicOwner(graph, node.id)?.id === owner).map((node) => node.id);
  const members = logicComponents(graph, peers, 'data').find((group) => group.includes(id)) ?? [id];
  const right = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'data') continue;
    const [left, next] = logicDataSides(edge);
    if (!members.includes(left) || !members.includes(next)) continue;
    right.set(left, next);
    incoming.add(next);
  }
  const ordered: string[] = [];
  let current = members.find((member) => !incoming.has(member));
  while (current && !ordered.includes(current)) {
    ordered.push(current);
    current = right.get(current);
  }
  return ordered.length === members.length ? ordered : members;
}
