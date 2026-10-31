import { canvas } from '@pwn2block/shared';
import { logicId, dataSides, logicOwnerChain, layoutLogicDataComponents } from './logic-geometry';
import { normalizeLogicEnvelopes, pruneLogic } from './logic-envelope-edit';
export * from './logic-geometry';
export * from './logic-connections';
export * from './logic-snap';
import { admissible } from './logic-connections';
import { detachLogicAttachments } from './logic-attachment-drag';
export { normalizeLogicEnvelopes, placeLogicOutsideEnvelopes } from './logic-envelope-edit';
/** 节点拖动只带同层右侧尾段；子包络内部由移动函数递归携带。 */
export function logicDragIds(graph: canvas.LogicGraph, ids: readonly string[], single = false): string[] {
  const moving = new Set<string>();
  const pending = ids.map((id) => {
    const node = graph.nodes.find((item) => item.id === id);
    return node && node.kind !== 'envelope' && canvas.logicCategory(node) !== 'data'
      ? logicOwnerChain(graph, id).at(-1) ?? id : id;
  });
  while (pending.length) {
    const id = pending.shift()!;
    if (moving.has(id)) continue;
    moving.add(id);
    if (single) continue;
    for (const edge of graph.edges) {
      if (edge.kind !== 'data') continue;
      const [left, right] = dataSides(edge);
      if (left === id && canvas.logicOwner(graph, left)?.id === canvas.logicOwner(graph, right)?.id)
        pending.push(right);
    }
  }
  return [...moving].filter((id) => ![...moving].some((other) =>
    other !== id && canvas.logicMembers(graph, other).has(id)));
}
/** 拔出仅生成草稿，保留原图以便取消和撤销。 */
export function detachLogicData(graph: canvas.LogicGraph, ids: readonly string[], point?: { x: number; y: number }): canvas.LogicGraph {
  graph = detachLogicAttachments(graph, ids, point);
  const moving = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  const roots = new Set(ids.filter((id) => {
    const node = graph.nodes.find((item) => item.id === id);
    return node && canvas.logicCategory(node) === 'data';
  }));
  const edges = graph.edges.filter((edge) => edge.kind !== 'data' || moving.has(edge.from) === moving.has(edge.to));
  const extracting = graph.nodes.some((node) => node.kind === 'envelope' && !moving.has(node.id) && node.members.some((id) => roots.has(id)));
  if (!extracting && edges.length === graph.edges.length) return graph;
  return normalizeLogicEnvelopes(graph, {
    ...graph,
    nodes: graph.nodes.map((node) => node.kind === 'envelope' && !moving.has(node.id)
      ? { ...node, members: node.members.filter((id) => !roots.has(id)) } : node),
    edges,
  }, ids);
}

export function wrapLogic(graph: canvas.LogicGraph, selected: readonly string[]): canvas.LogicGraph {
  let ids = selected.filter(
    (id) => !selected.some((other) => other !== id && canvas.logicMembers(graph, other).has(id)),
  );
  const nodes = graph.nodes.filter((n) => ids.includes(n.id));
  if (!nodes.length || nodes.some((n) => n.kind === 'start'))
    throw new Error('请选择要包络的节点，开始节点不能被包络');
  const category = nodes.every((n) => canvas.logicCategory(n) === 'data') ? 'data' : 'flow';
  if (
    nodes.some((n) =>
      category === 'flow' ? !canvas.logicIsFlow(graph, n) : canvas.logicCategory(n) !== 'data',
    )
  )
    throw new Error('包络只能包含同类节点；引用连接可跨越包络');
  const owners = new Set(ids.map((id) => canvas.logicOwner(graph, id)?.id));
  if (owners.size !== 1) throw new Error('请选择同一包络层级的节点');
  if (category === 'data') {
    const row = canvas.logicDataRow(graph, ids[0]!);
    if (ids.some((id) => !row.includes(id))) throw new Error('请先连接为一个整体，再包络');
    ids = row;
  } else if (canvas.logicComponents(graph, ids, 'flow').length !== 1) {
    throw new Error('请先连接为一个整体，再包络');
  }
  const id = logicId(graph, 'envelope');
  const envelope: canvas.LogicNode = {
    id,
    kind: 'envelope',
    category,
    members: ids,
    title: id,
    x: Math.min(...nodes.map((n) => n.x)),
    y: Math.min(...nodes.map((n) => n.y)),
  };
  const edges = graph.edges.map((e) => {
    if (e.kind === 'reference' || ids.includes(e.from) === ids.includes(e.to)) return e;
    return { ...e, from: ids.includes(e.from) ? id : e.from, to: ids.includes(e.to) ? id : e.to };
  });
  const next = {
    ...graph,
    nodes: [
      ...graph.nodes.map((n) =>
        n.kind === 'envelope' && n.members.some((m) => ids.includes(m))
          ? { ...n, members: [...n.members.filter((m) => !ids.includes(m)), id] }
          : n,
      ),
      envelope,
    ],
    edges,
  };
  if (!admissible(graph, next))
    throw new Error('该选择会产生含糊的跨包络关系，请将完整表达式或连续流程一起包络');
  return layoutLogicDataComponents(next);
}
export function removeLogic(graph: canvas.LogicGraph, ids: readonly string[]): canvas.LogicGraph {
  const gone = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  return normalizeLogicEnvelopes(graph, pruneLogic(graph, gone));
}
export function unwrapLogic(graph: canvas.LogicGraph, id: string): canvas.LogicGraph {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.kind !== 'envelope') return graph;
  const edges = graph.edges.flatMap((e) => {
    if (e.from !== id && e.to !== id) return [e];
    const candidates = node.members.filter(
      (member) =>
        !graph.edges.some(
          (inner) =>
            inner.kind === (e.kind === 'reference' ? 'data' : e.kind) &&
            (e.from === id
              ? inner.from === member && node.members.includes(inner.to)
              : inner.to === member && node.members.includes(inner.from)),
        ),
    );
    if (candidates.length !== 1) throw new Error('无法确定解除包络后的连接端点，请先调整外部连接');
    return [{ ...e, from: e.from === id ? candidates[0]! : e.from, to: e.to === id ? candidates[0]! : e.to }];
  });
  const next = normalizeLogicEnvelopes(graph, {
    ...graph,
    edges,
    nodes: graph.nodes
      .filter((n) => n.id !== id)
      .map((n) => {
        if (n.kind === 'envelope')
          return { ...n, members: n.members.flatMap((m) => (m === id ? node.members : [m])) };
        if (n.kind === 'loop' && n.body === id) {
          const { body: _body, ...rest } = n;
          return rest;
        }
        if (n.kind === 'convert' && n.input === id) {
          const { input: _input, ...rest } = n;
          return rest;
        }
        return n;
      }),
  });
  if (!admissible(graph, next)) throw new Error('解除包络会产生无效连接，请先调整外部连接');
  return next;
}
