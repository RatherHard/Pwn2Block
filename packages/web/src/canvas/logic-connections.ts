import { canvas } from '@pwn2block/shared';
import { logicId, logicAttachmentHost, layoutLogicDataComponents } from './logic-geometry';

export function createLogicEdge(
  graph: canvas.LogicGraph,
  a: canvas.LogicNode,
  b: canvas.LogicNode,
  methods: readonly canvas.CanvasMethodDecl[],
): canvas.LogicEdge | undefined {
  if (a.id === b.id || logicAttachmentHost(a) || logicAttachmentHost(b)) return undefined;
  const id = logicId(graph, 'edge');
  if (canvas.logicCategory(a) === 'data' && canvas.logicCategory(b) === 'data')
    return a.kind === 'variable'
      ? { id, kind: 'data', from: b.id, to: a.id, op: 'assign' }
      : { id, kind: 'data', from: a.id, to: b.id, op: b.kind === 'variable' ? 'assign' : '+' };
  const data = canvas.logicCategory(a) === 'data' ? a : b;
  const flow = data === a ? b : a;
  let port: string | undefined;
  if (canvas.logicCategory(data) === 'data' && flow.kind === 'branch') port = 'condition';
  if (canvas.logicCategory(data) === 'data' && flow.kind === 'loop') port = 'count';
  if (canvas.logicCategory(data) === 'data' && flow.kind === 'method')
    port = methods
      .find((m) => m.id === flow.method)
      ?.params.find(
        (p) => !graph.edges.some((e) => e.kind === 'reference' && e.to === flow.id && e.port === p.name),
      )?.name;
  if (port !== undefined) return { id, kind: 'reference', from: data.id, to: flow.id, port };
  if (canvas.logicIsFlow(graph, a) && canvas.logicIsFlow(graph, b)) {
    const outlet =
      a.kind === 'branch'
        ? graph.edges.some((e) => e.kind === 'flow' && e.from === a.id && e.outlet === 'then')
          ? 'else'
          : 'then'
        : 'next';
    return { id, kind: 'flow', from: a.id, to: b.id, outlet };
  }
  return undefined;
}
export function connectLogic(
  graph: canvas.LogicGraph,
  edge: canvas.LogicEdge,
  absorb = false,
  anchor = edge.from,
): canvas.LogicGraph {
  let next = { ...graph, edges: [...graph.edges, edge] };
  if (absorb && edge.kind !== 'reference') {
    const ownerFrom = canvas.logicOwner(graph, edge.from),
      ownerTo = canvas.logicOwner(graph, edge.to);
    const owner = ownerFrom ?? ownerTo;
    const outsider = ownerFrom ? edge.to : edge.from;
    if (owner?.kind === 'envelope' && !(ownerFrom && ownerTo) && !canvas.logicOwner(graph, outsider)) {
      const child = graph.nodes.find((n) => n.id === outsider);
      if (
        child &&
        (owner.category === 'flow'
          ? canvas.logicIsFlow(graph, child)
          : canvas.logicCategory(child) === 'data') &&
        !canvas.logicMembers(graph, outsider).has(owner.id)
      )
      {
        const members = edge.kind === 'data' ? canvas.logicDataRow(graph, outsider) : [outsider];
        next = {
          ...next,
          nodes: next.nodes.map((n) =>
            n.id === owner.id && n.kind === 'envelope' ? { ...n, members: [...new Set([...n.members, ...members])] } : n,
          ),
        };
      }
    }
  }
  return edge.kind === 'data' ? layoutLogicDataComponents(next, anchor) : next;
}
export function admissible(before: canvas.LogicGraph, after: canvas.LogicGraph): boolean {
  const old = new Set(canvas.validateLogicGraph(before).map((i) => `${i.nodeId}:${i.message}`));
  return !canvas.validateLogicGraph(after).some((i) => !old.has(`${i.nodeId}:${i.message}`));
}
/** 属性栏和吸附使用同一附着规则：允许保留已有错误，拒绝新增结构错误。 */
export function attachLogic(
  graph: canvas.LogicGraph,
  nodeId: string,
  envelopeId?: string,
): { ok: true; graph: canvas.LogicGraph } | { ok: false; message: string } {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || (node.kind !== 'loop' && node.kind !== 'convert'))
    return { ok: false, message: '只有次数循环和类型转换可以附着包络' };
  let updated: canvas.LogicNode;
  if (node.kind === 'loop') {
    const { body: _body, ...rest } = node;
    updated = envelopeId === undefined ? rest : { ...rest, body: envelopeId };
  } else {
    const { input: _input, ...rest } = node;
    updated = envelopeId === undefined ? rest : { ...rest, input: envelopeId };
  }
  const next = { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? updated : n)) };
  if (!admissible(graph, next))
    return { ok: false, message: '附着修改会产生新的结构错误，请检查包络类别、嵌套和已有附件' };
  return { ok: true, graph: next };
}
