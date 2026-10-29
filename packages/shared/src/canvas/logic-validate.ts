import { errorIssue, type CanvasIssue } from './issues';
import {
  LogicGraphSchema,
  logicCategory,
  logicHasAssignment,
  logicIsFlow,
  logicMembers,
  logicOwner,
  type LogicGraph,
} from './logic-model';

/** Structural validation is shared by imports, edits and execution. Incomplete graphs remain saveable. */
export function validateLogicGraph(graph: LogicGraph): CanvasIssue[] {
  const parsed = LogicGraphSchema.safeParse(graph);
  if (!parsed.success) return [errorIssue('flow_error', '', '文档结构或容量不合法（最多 512 节点、2048 连接）')];
  const issues: CanvasIssue[] = [];
  const fail = (id: string, message: string): void => {
    issues.push(errorIssue('flow_error', id, message));
  };
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const ids = new Set<string>();
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (ids.has(item.id)) fail(item.id, '节点和连接的标识必须唯一');
    ids.add(item.id);
  }
  if (graph.nodes.filter((n) => n.kind === 'start').length !== 1) fail('', '画布必须恰好有一个开始节点');
  const owned = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === 'variable' && !node.name.trim()) fail(node.id, '变量名称不能为空');
    if (node.kind === 'envelope') {
      if (!node.members.length) fail(node.id, '包络不能为空');
      for (const member of node.members) {
        const child = nodes.get(member);
        if (!child) {
          fail(node.id, '包络包含不存在的节点');
          continue;
        }
        if (child.kind === 'start') fail(node.id, '开始节点不能被包络');
        if (node.category === 'flow' ? !logicIsFlow(graph, child) : logicCategory(child) !== 'data')
          fail(node.id, '包络只能包含同类节点；跨类数据通过引用连接');
        if (owned.has(member)) fail(member, '节点只能属于一个包络');
        owned.add(member);
        if (logicMembers(graph, member).has(node.id)) fail(node.id, '包络不能循环嵌套');
      }
    }
    if (node.kind === 'loop' && node.body) {
      const body = nodes.get(node.body);
      if (body?.kind !== 'envelope' || !logicIsFlow(graph, body))
        fail(node.id, '循环必须附着到流程包络或带赋值的数据包络');
      if (graph.nodes.some((n) => n.kind === 'loop' && n.id !== node.id && n.body === node.body))
        fail(node.id, '一个包络只能附着一个循环');
      if (logicMembers(graph, node.body).has(node.id)) fail(node.id, '循环不能附着在包含自己的包络上');
    }
    if (node.kind === 'convert' && node.input) {
      const input = nodes.get(node.input);
      if (input?.kind !== 'envelope' || input.category !== 'data') fail(node.id, '转换只能附着在数据包络上');
      if (logicMembers(graph, node.input).has(node.id)) fail(node.id, '转换不能附着在包含自己的包络上');
      if (graph.nodes.some((n) => n.kind === 'convert' && n.id !== node.id && n.input === node.input))
        fail(node.id, '一个包络只能附着一个转换');
    }
  }
  const ports = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (!from || !to) {
      fail(edge.id, '连接端点不存在');
      continue;
    }
    if (from.id === to.id) fail(edge.id, '不能连接自身');
    let port: string;
    if (edge.kind === 'data') {
      if (logicCategory(from) !== 'data' || logicCategory(to) !== 'data') fail(edge.id, '数据关系需要两个数据节点');
      if (edge.op === 'assign' && to.kind !== 'variable') fail(edge.id, '赋值连接必须指向变量');
      if (edge.op !== 'assign') port = `data:${to.id}`;
      else port = `assign:${to.id}:${logicOwner(graph, edge.from)?.id ?? ''}`;
      const fromOwner = logicOwner(graph, from.id)?.id,
        toOwner = logicOwner(graph, to.id)?.id;
      if (fromOwner !== toOwner) fail(edge.id, '数据关系必须连接同一层级的节点；跨包络请连接包络整体');
    } else if (edge.kind === 'flow') {
      if (!logicIsFlow(graph, from) || !logicIsFlow(graph, to)) fail(edge.id, '流程连接需要流程节点或带赋值的数据包络');
      if (to.kind === 'start') fail(edge.id, '开始节点不能有入线');
      if ((from.kind === 'branch') === (edge.outlet === 'next'))
        fail(edge.id, '条件分支使用 true/false 出口，其他流程使用 next 出口');
      if (logicOwner(graph, from.id)?.id !== logicOwner(graph, to.id)?.id)
        fail(edge.id, '流程不能跨包络内部接线；请连接包络整体');
      if ((from.kind === 'loop' && from.body) || (to.kind === 'loop' && to.body))
        fail(edge.id, '附着循环由包络执行，请将流程连接到包络');
      port = `flow:${from.id}:${edge.outlet}`;
    } else {
      if (logicCategory(from) !== 'data' || !['branch', 'loop', 'method'].includes(to.kind))
        fail(edge.id, '引用应从数据指向条件、次数或方法参数');
      if ((to.kind === 'branch' && edge.port !== 'condition') || (to.kind === 'loop' && edge.port !== 'count'))
        fail(edge.id, '引用端口与流程节点不匹配');
      port = `ref:${to.id}:${edge.port}`;
    }
    if (ports.has(port)) fail(edge.id, '同一个输入或流程出口只能有一条连接');
    ports.add(port);
  }
  // All flow components, including disconnected components, must be acyclic.
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) {
      fail(id, '流程连接不允许成环，请使用附着循环');
      return;
    }
    if (done.has(id)) return;
    active.add(id);
    for (const edge of graph.edges) if (edge.kind === 'flow' && edge.from === id) visit(edge.to);
    active.delete(id);
    done.add(id);
  };
  for (const node of graph.nodes) visit(node.id);
  // 数据依赖也检查游离分量，防止未接流程的循环表达式被当成合法图。
  active.clear();
  done.clear();
  const visitData = (id: string): void => {
    if (active.has(id)) {
      fail(id, '数据依赖不允许成环');
      return;
    }
    if (done.has(id)) return;
    active.add(id);
    const node = nodes.get(id);
    if (node?.kind === 'envelope' && node.category === 'data') for (const member of node.members) visitData(member);
    if (node?.kind === 'convert' && node.input) visitData(node.input);
    for (const edge of graph.edges) if (edge.kind === 'data' && edge.to === id) visitData(edge.from);
    active.delete(id);
    done.add(id);
  };
  for (const node of graph.nodes) if (logicCategory(node) === 'data') visitData(node.id);
  // Assignment envelopes are dual-purpose; ordinary data envelopes are never flow steps.
  for (const node of graph.nodes)
    if (
      node.kind === 'envelope' &&
      node.category === 'data' &&
      !logicHasAssignment(graph, node.id) &&
      graph.edges.some((e) => e.kind === 'flow' && (e.from === node.id || e.to === node.id))
    )
      fail(node.id, '纯数据包络没有流程作用');
  return issues;
}
