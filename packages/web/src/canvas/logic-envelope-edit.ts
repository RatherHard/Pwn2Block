import { canvas } from '@pwn2block/shared';
import { logicAttachmentHost, logicOwnerChain, logicEnvelopeDepth, logicBox, moveLogicNodes, layoutLogicDataComponents } from './logic-geometry';

export function pruneLogic(graph: canvas.LogicGraph, removed: Set<string>): canvas.LogicGraph {
  const gone = new Set(removed);
  for (const node of graph.nodes) if (node.kind === 'start') gone.delete(node.id);
  let previous = -1;
  while (previous !== gone.size) {
    previous = gone.size;
    for (const node of graph.nodes) {
      const host = logicAttachmentHost(node);
      if (host && gone.has(host))
        gone.add(node.id);
    }
  }
  return { ...graph, nodes: graph.nodes.filter((node) => !gone.has(node.id)).map((node) =>
    node.kind === 'envelope' ? { ...node, members: node.members.filter((id) => !gone.has(id)) } : node),
  edges: graph.edges.filter((edge) => !gone.has(edge.id) && !gone.has(edge.from) && !gone.has(edge.to)) };
}

/** 已退出的尾段不能仍被原祖先包络圈住；拖动草稿可先跳过，释放预览再定位。 */
export function placeLogicOutsideEnvelopes(
  before: canvas.LogicGraph, graph: canvas.LogicGraph, ids: readonly string[],
): canvas.LogicGraph {
  let next = graph;
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id) || canvas.logicOwner(next, id) || !next.nodes.some((node) => node.id === id)) continue;
    const original = before.nodes.find((node) => node.id === id);
    const host = original && logicAttachmentHost(original);
    const owners = host ? [host, ...logicOwnerChain(before, host)] : logicOwnerChain(before, id);
    const ownerId = owners.reverse().find((owner) => next.nodes.some((node) => node.id === owner));
    if (!ownerId || !next.nodes.some((node) => node.id === ownerId)) continue;
    const category = canvas.logicOwner(before, id);
    const peers = next.nodes.filter((node) => !canvas.logicOwner(next, node.id)).map((node) => node.id);
    const row = category?.kind === 'envelope' && category.category === 'flow'
      ? canvas.logicComponents(next, peers, 'flow').find((group) => group.includes(id)) ?? [id]
      : canvas.logicDataRow(next, id);
    row.forEach((member) => done.add(member));
    const boxes = row.map((member) => logicBox(next, member));
    const owner = logicBox(next, ownerId);
    const x = Math.min(...boxes.map((box) => box.x)), y = Math.min(...boxes.map((box) => box.y));
    const width = Math.max(...boxes.map((box) => box.x + box.width)) - x;
    const height = Math.max(...boxes.map((box) => box.y + box.height)) - y;
    if (x >= owner.x + owner.width + 32 || x + width <= owner.x - 32 ||
      y >= owner.y + owner.height + 32 || y + height <= owner.y - 32) continue;
    const members = new Set(row.flatMap((member) => [...canvas.logicMembers(next, member)]));
    const obstacles = next.nodes.filter((node) => !members.has(node.id) && !logicAttachmentHost(node) && !canvas.logicOwner(next, node.id))
      .map((node) => logicBox(next, node.id));
    const targetX = owner.x + owner.width + 32;
    let targetY = y;
    for (let pass = 0; pass <= obstacles.length; pass++) {
      const collisions = obstacles.filter((box) => targetX < box.x + box.width + 24 && targetX + width + 24 > box.x &&
        targetY < box.y + box.height + 24 && targetY + height + 24 > box.y);
      if (!collisions.length) break;
      targetY = Math.max(...collisions.map((box) => box.y + box.height + 32));
    }
    next = moveLogicNodes(next, row, targetX - x, targetY - y);
  }
  return next;
}

/** 保留原最左剩余段，其他分量直接退出祖先；旧坏包络仅由显式修复整理。 */
export function normalizeLogicEnvelopes(
  before: canvas.LogicGraph, graph: canvas.LogicGraph, moving: readonly string[] = [], repair?: string,
): canvas.LogicGraph {
  let next = pruneLogic(graph, new Set());
  next = { ...next, nodes: next.nodes.map((node) => {
    const original = before.nodes.find((item) => item.id === node.id);
    if (node.kind !== 'envelope' || node.members.length || original?.kind !== 'envelope' || !original.members.length) return node;
    const box = logicBox(before, node.id);
    return { ...node, x: box.x, y: box.y };
  }) };
  const expelled: string[] = [];
  const envelopes = before.nodes.filter((node) => node.kind === 'envelope')
    .sort((a, b) => logicEnvelopeDepth(before, b.id) - logicEnvelopeDepth(before, a.id));
  for (const original of envelopes) {
    if (original.kind !== 'envelope') continue;
    const envelope = next.nodes.find((node) => node.id === original.id);
    if (envelope?.kind !== 'envelope') continue;
    if (repair !== original.id && canvas.logicComponents(before, original.members, original.category).length > 1) continue;
    const groups = canvas.logicComponents(next, envelope.members, envelope.category);
    if (groups.length < 2) continue;
    const leftmost = [...original.members].sort((a, b) => logicBox(before, a).x - logicBox(before, b).x)[0]!;
    const order = original.category === 'data'
      ? canvas.logicDataRow(before, leftmost) : original.members;
    const first = order.find((id) => envelope.members.includes(id));
    const keep = groups.find((group) => group.includes(first!)) ?? groups[0]!;
    expelled.push(...envelope.members.filter((id) => !keep.includes(id)));
    next = { ...next, nodes: next.nodes.map((node) => node.id === envelope.id ? { ...envelope, members: keep } : node) };
  }
  next = layoutLogicDataComponents(next);
  return placeLogicOutsideEnvelopes(before, next, expelled.filter((id) => !moving.includes(id)));
}
