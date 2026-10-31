import { canvas } from '@pwn2block/shared';
import { admissible } from './logic-connections';
import { layoutLogicDataComponents, logicAttachmentHost, logicBox, logicEnvelopeDepth,
  logicEnvelopeHeaderHeight, moveLogicNodes } from './logic-geometry';
import type { LogicSnap, LogicSnapOptions } from './logic-snap';

/** 空框内容区直接接纳一个完整结构，不额外生成关系。 */
export function emptyEnvelopeSnap(graph: canvas.LogicGraph, ids: string[], options: LogicSnapOptions): LogicSnap | undefined {
  if (!ids.length) return undefined;
  const moving = graph.nodes.filter((node) => ids.includes(node.id));
  if (moving.length !== ids.length || moving.some((node) => node.kind === 'start' || node.kind === 'convert' || logicAttachmentHost(node)))
    return undefined;
  const own = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  if (graph.edges.some((edge) => edge.kind !== 'reference' && own.has(edge.from) !== own.has(edge.to))) return undefined;
  const first = logicBox(graph, ids[0]!);
  const point = options.pointer ?? { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  const targets = graph.nodes.filter((node) => node.kind === 'envelope' && !node.members.length && !own.has(node.id))
    .sort((a, b) => logicEnvelopeDepth(graph, b.id) - logicEnvelopeDepth(graph, a.id) || a.id.localeCompare(b.id));
  for (const target of targets) {
    if (target.kind !== 'envelope') continue;
    const box = logicBox(graph, target.id), header = logicEnvelopeHeaderHeight(graph, target.id);
    if (point.x < box.x + 8 || point.x > box.x + box.width - 8 || point.y < box.y + header || point.y > box.y + box.height - 8) continue;
    if (moving.some((node) => target.category === 'data' ? canvas.logicCategory(node) !== 'data' : !canvas.logicIsFlow(graph, node))) continue;
    if (canvas.logicComponents(graph, ids, target.category).length !== 1) continue;
    const boxes = ids.map((id) => logicBox(graph, id));
    let next = moveLogicNodes(graph, ids, box.x + 24 - Math.min(...boxes.map((item) => item.x)),
      box.y + header - Math.min(...boxes.map((item) => item.y)));
    next = { ...next, nodes: next.nodes.map((node) => node.kind !== 'envelope' ? node :
      node.id === target.id ? { ...node, members: ids } : { ...node, members: node.members.filter((id) => !ids.includes(id)) }) };
    next = layoutLogicDataComponents(next, target.id);
    if (admissible(graph, next)) return { graph: next, target: target.id, distance: 0, key: `enclose:${target.id}`, kind: 'enclose' };
  }
  return undefined;
}
