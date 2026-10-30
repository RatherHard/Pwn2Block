import { canvas } from '@pwn2block/shared';
export interface LogicBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LogicSnap {
  graph: canvas.LogicGraph;
  edge?: canvas.LogicEdge;
  target: string;
  distance: number;
  attachment?: string;
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
export function logicBox(graph: canvas.LogicGraph, id: string, seen = new Set<string>()): LogicBox {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || seen.has(id)) return { x: 0, y: 0, width: 180, height: 76 };
  seen.add(id);
  const host = logicAttachmentHost(node);
  if (host) {
    const box = logicBox(graph, host, seen);
    const attachments = graph.nodes.filter((n) => logicAttachmentHost(n) === host);
    return { x: box.x + 8, y: box.y + 32 + attachments.findIndex((n) => n.id === id) * 26,
      width: box.width - 16, height: 24 };
  }
  if (node.kind !== 'envelope' || !node.members.length)
    return { x: node.x, y: node.y, width: 180, height: 76 };
  const boxes = node.members.map((member) => logicBox(graph, member, new Set(seen)));
  const header = 44 + graph.nodes.filter((n) => logicAttachmentHost(n) === id).length * 26;
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
function dataSides(edge: Extract<canvas.LogicEdge, { kind: 'data' }>): [string, string] {
  return edge.op === 'assign' ? [edge.to, edge.from] : [edge.from, edge.to];
}
/** Fixed data rows have one neighbour on each side. Reject overlapping branches. */
function dataNeighbours(graph: canvas.LogicGraph, anchor: string): Map<string, { left?: string; right?: string }> {
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
  const neighbours = new Map<string, { left?: string; right?: string }>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'data' || !component.has(edge.from)) continue;
    const [left, right] = dataSides(edge);
    const a = neighbours.get(left) ?? {}, b = neighbours.get(right) ?? {};
    if (a.right || b.left) throw new Error('数据节点的这一侧已有连接，请连接结构的空闲端点');
    a.right = right;
    b.left = left;
    neighbours.set(left, a);
    neighbours.set(right, b);
  }
  return neighbours;
}
/** Keep the anchor stationary and place its entire data row at fixed horizontal intervals. */
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
/** 拖动赋值目标时，携带完整的数据表达式及其嵌套包络。 */
export function logicDragIds(graph: canvas.LogicGraph, ids: readonly string[]): string[] {
  const moving = new Set(ids);
  for (const id of ids) {
    if (!graph.edges.some((edge) => edge.kind === 'data' && edge.op === 'assign' && edge.to === id)) continue;
    const pending = [id], visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      moving.add(current);
      for (const edge of graph.edges) {
        if (edge.kind !== 'data') continue;
        if (edge.from === current) pending.push(edge.to);
        if (edge.to === current) pending.push(edge.from);
      }
    }
  }
  return [...moving];
}
/** Detachment is a draft: the original graph remains available for cancel/undo. */
export function detachLogicData(graph: canvas.LogicGraph, ids: readonly string[]): canvas.LogicGraph {
  const moving = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  return { ...graph, edges: graph.edges.filter((edge) => edge.kind !== 'data' || moving.has(edge.from) === moving.has(edge.to)) };
}

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
        next = {
          ...next,
          nodes: next.nodes.map((n) =>
            n.id === owner.id && n.kind === 'envelope' ? { ...n, members: [...n.members, outsider] } : n,
          ),
        };
    }
  }
  return edge.kind === 'data' ? layoutLogicData(next, anchor) : next;
}
function admissible(before: canvas.LogicGraph, after: canvas.LogicGraph): boolean {
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
export function nearestLogicSnap(
  graph: canvas.LogicGraph,
  movingId: string,
  methods: readonly canvas.CanvasMethodDecl[],
): LogicSnap | undefined {
  const moving = graph.nodes.find((n) => n.id === movingId);
  if (!moving || logicAttachmentHost(moving)) return undefined;
  const own = canvas.logicMembers(graph, movingId);
  for (const node of graph.nodes) {
    const host = logicAttachmentHost(node);
    if (host && own.has(host)) own.add(node.id);
  }
  // 内部连接属于包络表达式；只有跨边界的连接阻止整体重新吸附（包括附件）。
  if (graph.edges.some((edge) => own.has(edge.from) !== own.has(edge.to))) return undefined;
  const box = logicBox(graph, movingId);
  const preview = canvas.previewLogicGraph(graph);
  const candidates: LogicSnap[] = [];
  for (const target of graph.nodes) {
    if (logicAttachmentHost(target) || own.has(target.id) || canvas.logicMembers(graph, target.id).has(movingId)) continue;
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
      const attached = attachLogic(graph, moving.id, target.id);
      if (attached.ok)
        candidates.push({ graph: attached.graph, target: target.id, attachment: moving.id, distance });
      continue;
    }
    const a = box.x + box.width / 2 <= other.x + other.width / 2 ? moving : target;
    const b = a === moving ? target : moving;
    const edge = createLogicEdge(graph, a, b, methods);
    if (!edge) continue;
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
export function wrapLogic(graph: canvas.LogicGraph, selected: readonly string[]): canvas.LogicGraph {
  const ids = selected.filter(
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
  return next;
}
export function removeLogic(graph: canvas.LogicGraph, ids: readonly string[]): canvas.LogicGraph {
  const gone = new Set(ids.flatMap((id) => [...canvas.logicMembers(graph, id)]));
  for (const n of graph.nodes)
    if (
      (n.kind === 'loop' && n.body && gone.has(n.body)) ||
      (n.kind === 'convert' && n.input && gone.has(n.input))
    )
      gone.add(n.id);
  for (const n of graph.nodes) if (n.kind === 'start') gone.delete(n.id);
  let nodes = graph.nodes
    .filter((n) => !gone.has(n.id))
    .map((n) => (n.kind === 'envelope' ? { ...n, members: n.members.filter((id) => !gone.has(id)) } : n));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    const empty = nodes
      .filter((n) => n.kind === 'envelope' && n.members.every((id) => gone.has(id)))
      .map((n) => n.id);
    if (!empty.length) break;
    for (const id of empty) gone.add(id);
    for (const n of nodes)
      if (
        (n.kind === 'loop' && n.body && gone.has(n.body)) ||
        (n.kind === 'convert' && n.input && gone.has(n.input))
      )
        gone.add(n.id);
    nodes = nodes
      .filter((n) => !gone.has(n.id))
      .map((n) => (n.kind === 'envelope' ? { ...n, members: n.members.filter((id) => !gone.has(id)) } : n));
  }
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((e) => !ids.includes(e.id) && !gone.has(e.from) && !gone.has(e.to)),
  };
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
  return {
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
  };
}
