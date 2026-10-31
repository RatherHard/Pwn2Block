import { canvas } from '@pwn2block/shared';
import { layoutLogicDataComponents, logicAttachmentHost, logicBox, logicId } from './logic-editor';

const FORMAT = 'pwn2block.logic-selection';
export function copyLogicSelection(graph: canvas.LogicGraph, selected: readonly string[]): canvas.LogicGraph | undefined {
  const ids = new Set(selected.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  for (const node of graph.nodes) {
    const host = logicAttachmentHost(node);
    if (host && ids.has(host)) ids.add(node.id);
    if (node.kind === 'start') ids.delete(node.id);
  }
  const nodes = graph.nodes.filter((node) => ids.has(node.id)).map((node) => {
    if (node.kind === 'envelope') return { ...node, members: node.members.filter((id) => ids.has(id)) };
    if (node.kind === 'loop' && node.body && !ids.has(node.body)) {
      const { body: _body, ...rest } = node;
      return rest;
    }
    if (node.kind === 'convert' && node.input && !ids.has(node.input)) {
      const { input: _input, ...rest } = node;
      return rest;
    }
    return node;
  });
  if (!nodes.length) return undefined;
  return structuredClone({ version: 1, nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) });
}
export function serializeLogicSelection(graph: canvas.LogicGraph): string {
  return JSON.stringify({ format: FORMAT, graph });
}
export function parseLogicSelection(text: string): canvas.LogicGraph | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !('format' in raw) || raw.format !== FORMAT || !('graph' in raw)) return undefined;
    const parsed = canvas.LogicGraphSchema.safeParse(raw.graph);
    if (!parsed.success) return undefined;
    const graph = parsed.data;
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (new Set([...graph.nodes, ...graph.edges].map((n) => n.id)).size !== graph.nodes.length + graph.edges.length ||
      graph.edges.some((e) => !ids.has(e.from) || !ids.has(e.to)) ||
      graph.nodes.some((n) => (n.kind === 'envelope' && n.members.some((id) => !ids.has(id))) ||
        (logicAttachmentHost(n) !== undefined && !ids.has(logicAttachmentHost(n)!)))) return undefined;
    return copyLogicSelection(graph, graph.nodes.map((n) => n.id));
  } catch { return undefined; }
}
export function pasteLogicSelection(
  graph: canvas.LogicGraph, fragment: canvas.LogicGraph, at: { x: number; y: number },
): { graph: canvas.LogicGraph; selected: string[] } {
  fragment = structuredClone(fragment);
  if (fragment.nodes.some((node) => node.kind === 'envelope' && canvas.logicComponents(fragment, node.members, node.category).length > 1))
    throw new Error('剪贴板中的包络包含多个独立结构，请先整理包络再复制');
  const boxes = fragment.nodes.filter((n) => !logicAttachmentHost(n)).map((n) => logicBox(fragment, n.id));
  const dx = at.x - Math.min(...boxes.map((b) => b.x)), dy = at.y - Math.min(...boxes.map((b) => b.y));
  const next: canvas.LogicGraph = { ...graph, nodes: [...graph.nodes], edges: [...graph.edges] };
  const ids = new Map<string, string>();
  for (const node of fragment.nodes) {
    const id = logicId(next, node.kind);
    ids.set(node.id, id);
    next.nodes.push({ ...node, id, x: node.x + dx, y: node.y + dy });
  }
  const pastedIds = new Set(ids.values());
  next.nodes = next.nodes.map((node) => {
    if (!pastedIds.has(node.id)) return node;
    if (node.kind === 'envelope') return { ...node, members: node.members.map((id) => ids.get(id)!) };
    if (node.kind === 'loop' && node.body) return { ...node, body: ids.get(node.body)! };
    if (node.kind === 'convert' && node.input) return { ...node, input: ids.get(node.input)! };
    return node;
  });
  for (const edge of fragment.edges) {
    const copied = { ...edge, id: logicId(next, 'edge'), from: ids.get(edge.from)!, to: ids.get(edge.to)! };
    next.edges.push(copied.kind === 'flow' && copied.points
      ? { ...copied, points: copied.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : copied);
  }
  if (!canvas.LogicGraphSchema.safeParse(next).success) throw new Error('粘贴超出画布容量：最多 512 节点、2048 连接');
  const members = new Set(fragment.nodes.flatMap((n) => n.kind === 'envelope' ? n.members : []));
  return { graph: layoutLogicDataComponents(next), selected: fragment.nodes.filter((n) => !members.has(n.id) && !logicAttachmentHost(n)).map((n) => ids.get(n.id)!) };
}
