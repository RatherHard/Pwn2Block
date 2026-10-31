import { canvas } from '@pwn2block/shared';
import { logicBox, logicAttachmentHost } from './logic-geometry';
import { createLogicEdge, connectLogic, attachLogic, admissible } from './logic-connections';
import type { LogicSnap, LogicSnapOptions } from './logic-snap';
import { returningToAttachment } from './logic-attachment-drag';

export function nearestOtherSnap(
  graph: canvas.LogicGraph,
  movingId: string,
  methods: readonly canvas.CanvasMethodDecl[],
  options: LogicSnapOptions = {},
): LogicSnap | undefined {
  const moving = graph.nodes.find((n) => n.id === movingId);
  if (!moving || logicAttachmentHost(moving)) return undefined;
  const own = canvas.logicMembers(graph, movingId);
  for (const node of graph.nodes) {
    const host = logicAttachmentHost(node);
    if (host && own.has(host)) own.add(node.id);
  }
  // 跨边界连接阻止普通接线候选；附件的次数引用保留，附着合法性交给共享校验。
  const connectedOutside = graph.edges.some((edge) => own.has(edge.from) !== own.has(edge.to));
  const box = logicBox(graph, movingId);
  const preview = canvas.previewLogicGraph(graph);
  const candidates: LogicSnap[] = [];
  for (const target of graph.nodes) {
    if ((logicAttachmentHost(target) && target.kind !== 'loop') || own.has(target.id) || canvas.logicMembers(graph, target.id).has(movingId)) continue;
    const other = logicBox(graph, target.id);
    const distance = Math.hypot(
      Math.max(0, box.x - other.x - other.width, other.x - box.x - box.width),
      Math.max(0, box.y - other.y - other.height, other.y - box.y - box.height),
    );
    if (distance > 64) continue;
    if (
      target.kind === 'envelope' &&
      ((moving.kind === 'loop' && canvas.logicIsFlow(graph, target)) ||
        (moving.kind === 'convert' && target.category === 'data'))
    ) {
      if (!returningToAttachment(options.original, moving.id, target.id, options.pointer)) continue;
      const attached = attachLogic(graph, moving.id, target.id);
      if (attached.ok)
        candidates.push({ graph: attached.graph, target: target.id, attachment: moving.id, distance });
      continue;
    }
    if (connectedOutside) continue;
    const a = box.x + box.width / 2 <= other.x + other.width / 2 ? moving : target;
    const b = a === moving ? target : moving;
    const edge = createLogicEdge(graph, a, b, methods);
    if (!edge || edge.kind === 'data') continue;
    if (edge.kind === 'reference') {
      const value = preview.get(edge.from);
      const flow = graph.nodes.find((n) => n.id === edge.to);
      const required =
        flow?.kind === 'branch'
          ? 'bool'
          : flow?.kind === 'loop'
            ? 'int'
            : methods
                .find((m) => flow?.kind === 'method' && m.id === flow.method)
                ?.params.find((p) => p.name === edge.port)?.type;
      if (
        value &&
        typeof value !== 'string' &&
        required &&
        value.kind !== (required === 'bytes' ? 'byte' : required === 'addr' ? 'int' : required)
      )
        continue;
    }
    try {
      const next = connectLogic(graph, edge, true, target.id);
      if (admissible(graph, next)) candidates.push({ graph: next, edge, target: target.id, distance });
    } catch {
      // An occupied data side cannot accept another fixed row.
    }
  }
  return candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    // 相同距离时优先内部落点，不能让包络的面积遮住其成员。
    if (!a.attachment && !b.attachment) {
      if (canvas.logicMembers(graph, a.target).has(b.target)) return 1;
      if (canvas.logicMembers(graph, b.target).has(a.target)) return -1;
    }
    return a.target.localeCompare(b.target);
  })[0];
}
