import { defaultParams, nodeInputs, nodeOutput, nodeRegions, nodeSpec } from '@pwn2block/shared';
import type {
  GraphConnection,
  GraphDocument,
  GraphNode,
  GraphGroup,
  NodeLayout,
  ParamValue,
  ParamValues,
  PortContext,
} from '@pwn2block/shared';
import { edgeKeyOf, lookupGraph } from '../workflow/document';

/**
 * 画布编辑器的状态机（06 §3；07 §P2）。
 *
 * 所有命令都是纯函数：`(状态, 参数) => 新状态`，文档、选择、撤销栈一起放进状态里，
 * 组件只负责收集手势再调用命令。这样编辑行为（接线、删除、撤销、复制）可以在测试里
 * 直接断言文档内容，不必模拟浏览器事件。
 *
 * 三条约束：
 * - **不可变**：命令返回新对象，不原地改文档（CLAUDE.md）。
 * - **语义与布局分开计数**：拖动只涨 `layoutRevision`，改参数/接线才涨 `semanticRevision`。
 * - **语义校验只做局部**：这里只拦「接不上」的边（类型不符、成环、端口不存在）；
 *   全图问题留给 `validateGraph` 在编译前一次性报出。
 */

export const MAX_HISTORY = 50;

export interface GraphEditorState {
  readonly document: GraphDocument;
  readonly selection: readonly string[];
  readonly semanticRevision: number;
  readonly layoutRevision: number;
  readonly past: readonly GraphDocument[];
  readonly future: readonly GraphDocument[];
  readonly clipboard: readonly GraphNode[];
}

export interface GraphEditorOptions {
  readonly context: PortContext;
}

/** 命令结果：要么新状态，要么一句能显示给用户的原因（不是异常）。 */
export type EditResult =
  | { readonly ok: true; readonly state: GraphEditorState }
  | { readonly ok: false; readonly message: string };

export function createEditor(document: GraphDocument): GraphEditorState {
  // 开始节点也要有布局：否则新节点会自动摆到它上面，看起来像压在一起。
  const needsStartLayout =
    document.nodes.some((node) => node.id === 'start') && document.layout.start === undefined;
  return {
    document: needsStartLayout
      ? { ...document, layout: { start: { x: 40, y: 40 }, ...document.layout } }
      : document,
    selection: [],
    semanticRevision: 0,
    layoutRevision: 0,
    past: [],
    future: [],
    clipboard: [],
  };
}

/** 用给定命令修改文档；自动记撤销栈、清空重做栈、递增对应修订号。 */
/** 分组只引用存在的节点：删节点、提取模块后自动裁掉空分组与悬空成员。 */
function pruneGroups(document: GraphDocument): GraphDocument {
  if (document.groups === undefined || document.groups.length === 0) return document;
  const ids = new Set(document.nodes.map((node) => node.id));
  const groups = document.groups
    .map((group) => ({ ...group, members: group.members.filter((id) => ids.has(id)) }))
    .filter((group) => group.members.length > 0);
  return { ...document, groups };
}

function apply(
  state: GraphEditorState,
  document: GraphDocument,
  kind: 'semantic' | 'layout' | 'reset',
  selection: readonly string[] = state.selection,
): GraphEditorState {
  const historyKind = kind === 'layout' ? 'layout' : 'semantic';
  const pruned = pruneGroups(document);
  return {
    ...state,
    document: pruned,
    selection: selection.filter((id) => pruned.nodes.some((node) => node.id === id)),
    semanticRevision: historyKind === 'semantic' ? state.semanticRevision + 1 : state.semanticRevision,
    layoutRevision: historyKind === 'layout' ? state.layoutRevision + 1 : state.layoutRevision,
    past: kind === 'reset' ? state.past : [...state.past, state.document].slice(-MAX_HISTORY),
    future: kind === 'reset' ? state.future : [],
  };
}

export function select(state: GraphEditorState, ids: readonly string[]): GraphEditorState {
  return { ...state, selection: [...ids] };
}

export function toggleSelection(state: GraphEditorState, id: string): GraphEditorState {
  return state.selection.includes(id)
    ? { ...state, selection: state.selection.filter((candidate) => candidate !== id) }
    : { ...state, selection: [...state.selection, id] };
}

/** 新节点 id：从种类短名派生，重名时加序号；节点 id 只允许 `[A-Za-z0-9_-]`。 */
export function nextNodeId(document: GraphDocument, kind: string): string {
  const base = (kind.split('.').pop() ?? kind).replace(/[^A-Za-z0-9_-]/g, '');
  const taken = new Set(document.nodes.map((node) => node.id));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 画布上找一个不压住已有节点的位置（右侧优先，其次下方）。 */
export function freePosition(document: GraphDocument, width = 208): NodeLayout {
  const placements = Object.values(document.layout);
  if (placements.length === 0) return { x: 40, y: 40 };
  const right = Math.max(...placements.map((placement) => placement.x)) + width + 60;
  const top = Math.min(...placements.map((placement) => placement.y));
  return { x: right, y: top };
}

export interface AddNodeOptions {
  readonly kind: string;
  readonly at?: NodeLayout;
  readonly params?: ParamValues;
}

/** 加节点：默认参数来自目录；语句节点追加到执行序列末尾，数据节点浮在画布上等接线。 */
export function addNode(
  state: GraphEditorState,
  options: AddNodeOptions,
): EditResult {
  const spec = nodeSpec(options.kind);
  if (spec === undefined) return { ok: false, message: `未知节点类型：${options.kind}` };
  const id = nextNodeId(state.document, options.kind);
  const declared = nodeRegions(spec, { ...defaultParams(spec), ...(options.params ?? {}) });
  const regions = declared.length === 0
    ? {}
    : { regions: Object.fromEntries(declared.map((region) => [region.name, []])) };
  const node: GraphNode = {
    id,
    kind: options.kind,
    params: { ...defaultParams(spec), ...(options.params ?? {}) },
    ...regions,
  };
  const placement = options.at ?? freePosition(state.document);
  const document: GraphDocument = {
    ...state.document,
    nodes: [...state.document.nodes, node],
    layout: { ...state.document.layout, [id]: placement },
    main: spec.exec ? [...state.document.main, id] : state.document.main,
  };
  return { ok: true, state: apply(state, document, 'semantic', [id]) };
}

export function removeNodes(state: GraphEditorState, ids: readonly string[]): GraphEditorState {
  const doomed = new Set(ids);
  if (doomed.has('start')) doomed.delete('start');
  if (doomed.size === 0) return state;
  const document: GraphDocument = {
    ...state.document,
    nodes: state.document.nodes
      .filter((node) => !doomed.has(node.id))
      .map((node) => stripRegionMembers(node, doomed)),
    connections: state.document.connections.filter(
      (connection) => !doomed.has(connection.from.node) && !doomed.has(connection.to.node),
    ),
    main: state.document.main.filter((id) => !doomed.has(id)),
    layout: Object.fromEntries(
      Object.entries(state.document.layout).filter(([id]) => !doomed.has(id)),
    ),
  };
  return apply(state, document, 'semantic', []);
}

/** 拖动：只改布局，不算语义变更（07 §P1）。 */
export function moveNodes(
  state: GraphEditorState,
  moves: Readonly<Record<string, NodeLayout>>,
): GraphEditorState {
  const layout = { ...state.document.layout };
  let moved = false;
  for (const [id, placement] of Object.entries(moves)) {
    if (layout[id] === undefined) continue;
    layout[id] = { x: Math.round(placement.x), y: Math.round(placement.y) };
    moved = true;
  }
  if (!moved) return state;
  return apply(state, { ...state.document, layout }, 'layout');
}

/** 参数变了以后，已经不存在的端口上的连线要一起删掉，避免留下指向空气的边。 */
export function pruneConnections(
  document: GraphDocument,
  context: PortContext,
): GraphDocument {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const connections = document.connections.filter((connection) => {
    const from = nodes.get(connection.from.node);
    const to = nodes.get(connection.to.node);
    if (from === undefined || to === undefined) return false;
    const fromSpec = nodeSpec(from.kind);
    const toSpec = nodeSpec(to.kind);
    if (fromSpec === undefined || toSpec === undefined) return false;
    const output = nodeOutput(fromSpec, from.params);
    const input = nodeInputs(toSpec, to.params, context).find(
      (candidate) => candidate.name === connection.to.port,
    );
    return output?.name === connection.from.port && input !== undefined;
  });
  return connections.length === document.connections.length
    ? document
    : { ...document, connections };
}

export function setParam(
  state: GraphEditorState,
  nodeId: string,
  name: string,
  value: ParamValue,
  context: PortContext,
): GraphEditorState {
  const nodes = state.document.nodes.map((node) =>
    node.id === nodeId ? withDeclaredRegions({ ...node, params: { ...node.params, [name]: value } }) : node,
  );
  const document = pruneConnections({ ...state.document, nodes }, context);
  return apply(state, document, 'semantic');
}

export interface PortRef {
  readonly node: string;
  readonly port: string;
}

/**
 * 接数据线：类型必须一致、不能成环、同一个输入口重复接线时**替换**旧边。
 * 返回失败原因而不是抛错，调用方把它显示在状态栏。
 */
export function connect(
  state: GraphEditorState,
  context: PortContext,
  from: PortRef,
  to: PortRef,
): EditResult {
  const nodes = new Map(state.document.nodes.map((node) => [node.id, node]));
  const fromNode = nodes.get(from.node);
  const toNode = nodes.get(to.node);
  if (fromNode === undefined || toNode === undefined) {
    return { ok: false, message: '连线引用了不存在的节点' };
  }
  const fromSpec = nodeSpec(fromNode.kind);
  const toSpec = nodeSpec(toNode.kind);
  if (fromSpec === undefined || toSpec === undefined) {
    return { ok: false, message: '连线引用了未知节点类型' };
  }
  const output = nodeOutput(fromSpec, fromNode.params);
  if (output === undefined || output.name !== from.port) {
    return { ok: false, message: `${fromSpec.label} 没有输出端口 ${from.port}` };
  }
  const input = nodeInputs(toSpec, toNode.params, context).find((candidate) => candidate.name === to.port);
  if (input === undefined) return { ok: false, message: `${toSpec.label} 没有输入端口 ${to.port}` };
  if (input.type !== output.type) {
    return {
      ok: false,
      message: `${fromSpec.label} 输出${output.type}，${toSpec.label} 的「${input.label}」要${input.type}`,
    };
  }
  if (from.node === to.node) return { ok: false, message: '数据线不能指向自己' };
  if (wouldCycle(state.document, from.node, to.node)) {
    return { ok: false, message: '这条线会让数据依赖成环：先拆掉反向的那条' };
  }

  const existing = state.document.connections.filter(
    (connection) => connection.to.node === to.node && connection.to.port === to.port,
  );
  if (
    existing.some(
      (connection) => connection.from.node === from.node && connection.from.port === from.port,
    )
  ) {
    return { ok: false, message: '这条线已经接好了' };
  }
  // 同一个输入口只允许一条入边：接线即替换（06 §4「输入口唯一」）。
  const connections = state.document.connections.filter(
    (connection) => !(connection.to.node === to.node && connection.to.port === to.port),
  );
  const document: GraphDocument = {
    ...state.document,
    connections: [
      ...connections,
      { from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } },
    ],
  };
  return { ok: true, state: apply(state, document, 'semantic') };
}

/** 从 `source` 顺着数据线向上游走，能走到 `target` 就说明新边会成环。 */
function wouldCycle(document: GraphDocument, source: string, target: string): boolean {
  const upstream = new Map<string, string[]>();
  for (const connection of document.connections) {
    const list = upstream.get(connection.to.node) ?? [];
    list.push(connection.from.node);
    upstream.set(connection.to.node, list);
  }
  const stack = [source];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(upstream.get(current) ?? []));
  }
  return false;
}

export function disconnect(state: GraphEditorState, edge: GraphConnection): GraphEditorState {
  const document: GraphDocument = {
    ...state.document,
    connections: state.document.connections.filter(
      (connection) =>
        edgeKeyOf(connection.from.node, connection.from.port) !== edgeKeyOf(edge.from.node, edge.from.port) ||
        edgeKeyOf(connection.to.node, connection.to.port) !== edgeKeyOf(edge.to.node, edge.to.port),
    ),
  };
  return document.connections.length === state.document.connections.length
    ? state
    : apply(state, document, 'semantic');
}

/** 在所属序列里前后移动一条：`delta=-1` 前移，`delta=1` 后移（06 §5.1 顺序即执行顺序）。 */
export function reorder(state: GraphEditorState, nodeId: string, delta: number): GraphEditorState {
  const lookup = lookupGraph(state.document);
  const placement = lookup.placements.get(nodeId);
  if (placement === undefined) return state;
  const region = regionOf(state.document, placement.path);
  if (region === undefined) return state;
  const index = region.findIndex((id) => id === nodeId);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= region.length) return state;
  const items = [...region];
  const [item] = items.splice(index, 1);
  if (item === undefined) return state;
  items.splice(next, 0, item);
  return apply(state, withRegion(state.document, placement.path, items), 'semantic');
}

/** 把节点移到目标节点之后（同一序列内）；跨区域拖放不在这里做（P4 的容器才有）。 */
export function reorderAfter(state: GraphEditorState, nodeId: string, afterId: string): GraphEditorState {
  if (nodeId === afterId) return state;
  const lookup = lookupGraph(state.document);
  const placement = lookup.placements.get(nodeId);
  const target = lookup.placements.get(afterId);
  if (placement === undefined || target === undefined) return state;
  if (placement.path.join('/') !== target.path.join('/')) return state;
  const region = regionOf(state.document, placement.path);
  if (region === undefined) return state;
  const items = region.filter((id) => id !== nodeId);
  const index = items.indexOf(afterId);
  if (index < 0) return state;
  items.splice(index + 1, 0, nodeId);
  return apply(state, withRegion(state.document, placement.path, items), 'semantic');
}

function regionOf(document: GraphDocument, path: readonly string[]): readonly string[] | undefined {
  if (path.length === 1) return document.main;
  const segment = path[path.length - 1] ?? '';
  const ownerId = segment.split('/')[0] ?? '';
  const regionName = segment.split('/')[1] ?? '';
  const owner = document.nodes.find((node) => node.id === ownerId);
  return owner?.regions?.[regionName];
}

function withRegion(
  document: GraphDocument,
  path: readonly string[],
  items: readonly string[],
): GraphDocument {
  if (path.length === 1) return { ...document, main: items };
  const segment = path[path.length - 1] ?? '';
  const ownerId = segment.split('/')[0] ?? '';
  const regionName = segment.split('/')[1] ?? '';
  const nodes = document.nodes.map((node) =>
    node.id === ownerId
      ? { ...node, regions: { ...(node.regions ?? {}), [regionName]: items } }
      : node,
  );
  return { ...document, nodes };
}

export function copySelection(state: GraphEditorState): GraphEditorState {
  const selected = new Set(state.selection);
  return { ...state, clipboard: state.document.nodes.filter((node) => selected.has(node.id)) };
}

/** 粘贴：复制节点本体与它们之间的连线，id 重新编号，位置整体偏移避免完全重合。 */
export function paste(state: GraphEditorState, context: PortContext, offset = 32): EditResult {
  if (state.clipboard.length === 0) return { ok: false, message: '剪贴板里没有节点' };
  if (state.clipboard.some((node) => node.id === 'start')) {
    return { ok: false, message: '开始节点不能复制' };
  }

  const idMap = new Map<string, string>();
  const layout: Record<string, NodeLayout> = { ...state.document.layout };
  const created: GraphNode[] = [];
  for (const node of state.clipboard) {
    const id = nextNodeId({ ...state.document, nodes: [...state.document.nodes, ...created] }, node.kind);
    idMap.set(node.id, id);
    created.push({ ...node, id, params: { ...node.params } });
    const placement = state.document.layout[node.id];
    layout[id] = placement === undefined
      ? freePosition(state.document)
      : { x: placement.x + offset, y: placement.y + offset };
  }

  const copied = new Set(state.clipboard.map((node) => node.id));
  const connections = state.document.connections
    .filter((connection) => copied.has(connection.from.node) && copied.has(connection.to.node))
    .map((connection) => ({
      from: { node: idMap.get(connection.from.node) as string, port: connection.from.port },
      to: { node: idMap.get(connection.to.node) as string, port: connection.to.port },
    }));

  // 只有语句节点进执行序列：数据节点靠依赖求值，不该被塞进流程（06 §2）。
  const copyOf = new Map(state.clipboard.map((node) => [node.id, idMap.get(node.id) as string]));
  const main: string[] = [];
  for (const id of state.document.main) {
    main.push(id);
    const copy = copyOf.get(id);
    const spec = nodeSpec(state.document.nodes.find((node) => node.id === id)?.kind ?? '');
    if (copy !== undefined && spec?.exec === true) main.push(copy);
  }

  const document: GraphDocument = {
    ...state.document,
    nodes: [...state.document.nodes, ...created],
    connections: [...state.document.connections, ...connections],
    layout,
    main,
  };
  return {
    ok: true,
    state: apply(state, pruneConnections(document, context), 'semantic', [...idMap.values()]),
  };
}

export function undo(state: GraphEditorState): GraphEditorState {
  const previous = state.past[state.past.length - 1];
  if (previous === undefined) return state;
  return {
    ...state,
    document: previous,
    past: state.past.slice(0, -1),
    future: [state.document, ...state.future].slice(0, MAX_HISTORY),
    selection: state.selection.filter((id) => previous.nodes.some((node) => node.id === id)),
    semanticRevision: state.semanticRevision + 1,
    layoutRevision: state.layoutRevision + 1,
  };
}

export function redo(state: GraphEditorState): GraphEditorState {
  const next = state.future[0];
  if (next === undefined) return state;
  return {
    ...state,
    document: next,
    past: [...state.past, state.document].slice(-MAX_HISTORY),
    future: state.future.slice(1),
    selection: state.selection.filter((id) => next.nodes.some((node) => node.id === id)),
    semanticRevision: state.semanticRevision + 1,
    layoutRevision: state.layoutRevision + 1,
  };
}

/** 参数变化可能带来新的区域（否则如果链）：补齐空区域，已有的成员保持不动。 */
function withDeclaredRegions(node: GraphNode): GraphNode {
  const spec = nodeSpec(node.kind);
  if (spec === undefined) return node;
  const declared = nodeRegions(spec, node.params);
  if (declared.length === 0) return node;
  const regions: Record<string, readonly string[]> = { ...(node.regions ?? {}) };
  let changed = node.regions === undefined;
  for (const region of declared) {
    if (regions[region.name] === undefined) {
      regions[region.name] = [];
      changed = true;
    }
  }
  return changed ? { ...node, regions } : node;
}

/** 删除节点时把它从所有容器的区域里摘掉，避免留下指向空气的成员。 */
function stripRegionMembers(node: GraphNode, doomed: ReadonlySet<string>): GraphNode {
  if (node.regions === undefined) return node;
  const regions: Record<string, readonly string[]> = {};
  let changed = false;
  for (const [name, members] of Object.entries(node.regions)) {
    const kept = members.filter((id) => !doomed.has(id));
    if (kept.length !== members.length) changed = true;
    regions[name] = kept;
  }
  return changed ? { ...node, regions } : node;
}

// ---------------------------------------------------------------------------
// 容器编辑（06 §5.2；07 §P4）
// ---------------------------------------------------------------------------

/** 把选中的语句移进容器的某个区域；容器不能进自己或自己的子孙。 */
export function moveInto(
  state: GraphEditorState,
  nodeIds: readonly string[],
  containerId: string,
  region: string,
): EditResult {
  const container = state.document.nodes.find((node) => node.id === containerId);
  if (container === undefined) return { ok: false, message: `找不到容器 ${containerId}` };
  const spec = nodeSpec(container.kind);
  if (spec === undefined || !nodeRegions(spec, container.params).some((candidate) => candidate.name === region)) {
    return { ok: false, message: `${spec?.label ?? container.kind} 没有区域 ${region}` };
  }
  const lookup = lookupGraph(state.document);
  const containerPath = lookup.placements.get(containerId)?.path ?? ['main'];
  const moving = nodeIds.filter((id) => id !== containerId && !containerPath.includes(id));
  if (moving.length === 0) return { ok: false, message: '只能把别的节点放进容器：不能放容器自己或它的子孙' };

  const stripped = removeFromSequences(state.document, moving);
  const current = stripped.nodes.find((node) => node.id === containerId)?.regions?.[region] ?? [];
  const next = [...current, ...moving.filter((id) => !current.includes(id))];
  const document = withRegion(stripped, [...containerPath, `${containerId}/${region}`], next);
  return { ok: true, state: apply(state, document, 'semantic', moving) };
}

/** 把区域里的语句移回容器所在的那一层，紧跟在容器之后。 */
export function moveOut(state: GraphEditorState, nodeIds: readonly string[]): GraphEditorState {
  let document = state.document;
  for (const id of nodeIds) {
    const placement = lookupGraph(document).placements.get(id);
    if (placement?.container === undefined) continue;
    const regionPath = placement.path;
    const parentPath = regionPath.slice(0, -1);
    const region = regionOf(document, regionPath);
    if (region === undefined) continue;
    const owner = regionOf(document, parentPath) ?? document.main;
    const without = region.filter((member) => member !== id);
    const ownerIndex = owner.indexOf(placement.container);
    const nextOwner = [...owner];
    nextOwner.splice(ownerIndex < 0 ? nextOwner.length : ownerIndex + 1, 0, id);
    document = withRegion(withRegion(document, regionPath, without), parentPath, nextOwner);
  }
  return document === state.document ? state : apply(state, document, 'semantic', nodeIds);
}

/** 切换输入端口的来源：手填时断开该端口的连线，接线时要求必须接上（07 §P3）。 */
export function setPortMode(
  state: GraphEditorState,
  nodeId: string,
  port: string,
  mode: 'inline' | 'port',
): GraphEditorState {
  const key = `${port}Mode`;
  const nodes = state.document.nodes.map((node) =>
    node.id === nodeId ? { ...node, params: { ...node.params, [key]: mode } } : node,
  );
  const connections =
    mode === 'inline'
      ? state.document.connections.filter(
          (connection) => !(connection.to.node === nodeId && connection.to.port === port),
        )
      : state.document.connections;
  return apply(state, { ...state.document, nodes, connections }, 'semantic');
}

/** 分组：把选中的节点框在一起。只改布局，不碰执行顺序与编译产物。 */
export function groupSelection(state: GraphEditorState): EditResult {
  const members = state.selection.filter(
    (id) => id !== 'start' && state.document.nodes.some((node) => node.id === id),
  );
  if (members.length < 2) return { ok: false, message: '先选至少两个节点再分组' };
  const rest = (state.document.groups ?? []).map((group) => ({
    ...group,
    members: group.members.filter((id) => !members.includes(id)),
  }));
  const kept = rest.filter((group) => group.members.length > 0);
  const groups = [...kept, { id: nextGroupId(state.document, kept), name: `组 ${kept.length + 1}`, members }];
  return { ok: true, state: apply(state, { ...state.document, groups }, 'layout', members) };
}

/** 解组：只删分组框，节点与连线原样保留。 */
export function ungroup(state: GraphEditorState, groupId: string): GraphEditorState {
  const groups = (state.document.groups ?? []).filter((group) => group.id !== groupId);
  if (groups.length === (state.document.groups ?? []).length) return state;
  return apply(state, { ...state.document, groups }, 'layout');
}

function nextGroupId(document: GraphDocument, groups: readonly GraphGroup[]): string {
  const taken = new Set(groups.map((group) => group.id));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `group${index}`;
    if (!taken.has(candidate) && !document.nodes.some((node) => node.id === candidate)) return candidate;
  }
  return `group-${Date.now().toString(36)}`;
}

/** 用一份新文档替换当前文档（提取模块、导入等整块编辑共用入口）。 */
export function withDocument(
  state: GraphEditorState,
  document: GraphDocument,
  kind: 'semantic' | 'layout' = 'semantic',
): GraphEditorState {
  return apply(state, document, kind);
}

/** 从主序列和所有区域里摘掉这些 id（移动前的清理）。 */
function removeFromSequences(document: GraphDocument, ids: readonly string[]): GraphDocument {
  const doomed = new Set(ids);
  const nodes = document.nodes.map((node) =>
    node.regions === undefined
      ? node
      : {
          ...node,
          regions: Object.fromEntries(
            Object.entries(node.regions).map(([name, members]) => [name, members.filter((id) => !doomed.has(id))]),
          ),
        },
  );
  return { ...document, nodes, main: document.main.filter((id) => !doomed.has(id)) };
}

/**
 * 折叠/展开容器：只改布局，不涨语义版本，也不作废已编译的产物（06 §3）。
 *
 * 折叠后子节点在画布上隐藏，但执行序列不变；`layout.collapsed` 是纯显示状态。
 */
export function setCollapsed(state: GraphEditorState, nodeId: string, collapsed: boolean): GraphEditorState {
  const node = state.document.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return state;
  const spec = nodeSpec(node.kind);
  if (spec === undefined || nodeRegions(spec, node.params).length === 0) return state;
  const current = state.document.layout[nodeId] ?? { x: 40, y: 40 };
  if ((current.collapsed ?? false) === collapsed) return state;
  const layout = { ...state.document.layout, [nodeId]: { ...current, collapsed } };
  return apply(state, { ...state.document, layout }, 'layout');
}
