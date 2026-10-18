import {
  nodeInputs,
  nodeOutput,
  nodeSpec,
  WORKFLOW_MAX_CONNECTIONS,
  WORKFLOW_MAX_NESTING,
  WORKFLOW_MAX_NODES,
  WORKFLOW_MAX_REGION_ITEMS,
} from '@pwn2block/shared';
import type {
  GraphDocument,
  GraphNode,
  InputPortSpec,
  NodeKindSpec,
  PortContext,
  PortType,
  WorkflowIssue,
  WorkflowIssueCode,
} from '@pwn2block/shared';
import { lookupGraph, paramsOf, paramSpecsOf, pathContains, type GraphLookup } from './document';
import { checkParams } from './params';
import type { WorkflowContext } from './types';

/**
 * 全图校验（06 §2、§4、§5；07 §P1）。
 *
 * 校验器回答的是「这张图能不能编译」：唯一入口、唯一 id、未知节点、参数、端口与类型、
 * 结构化区域、数据环、跨区域引用、题目动作权限（07 §P1 的清单）。它**不求值**、不产生动作，
 * 所以可以在每次编辑后跑，而不会推进 VM（06 §2）。
 *
 * 未使用的节点只给 `warning`：结构仍然校验，但不算失败——学习者把节点拖上画布还没接好时，
 * 不该先挨一串红字。
 */

/** 校验结果：错误阻止编译；警告只提示。 */
export interface GraphValidation {
  readonly issues: readonly WorkflowIssue[];
  readonly errors: readonly WorkflowIssue[];
  readonly warnings: readonly WorkflowIssue[];
  readonly lookup: GraphLookup;
  /** 执行顺序（展平后的语句序列），供 UI 显示与来源定位。 */
  readonly executionOrder: readonly ExecutionStep[];
  /** 有错误就不能编译，产物门禁读它。 */
  readonly ok: boolean;
}

export interface ExecutionStep {
  readonly nodeId: string;
  readonly path: readonly string[];
}

export function validateGraph(document: GraphDocument, context: WorkflowContext): GraphValidation {
  const issues: WorkflowIssue[] = [];
  const portContext: PortContext = { archBits: context.archBits, authorBlocks: context.authorBlocks };
  const lookup = lookupGraph(document);

  const report = (
    code: WorkflowIssueCode,
    nodeId: string,
    message: string,
    extra?: { readonly port?: string; readonly severity?: 'error' | 'warning'; readonly path?: readonly string[] },
  ): void => {
    issues.push({
      code,
      severity: extra?.severity ?? 'error',
      message,
      nodeId,
      ...(extra?.port === undefined ? {} : { port: extra.port }),
      ...(extra?.path === undefined ? {} : { path: extra.path }),
    });
  };

  checkTotals(document, report);
  const starts = checkNodes(document, context, lookup, report);
  checkEntry(document, starts, lookup, report);
  checkPlacement(document, lookup, report);
  checkRegions(document, lookup, report);
  checkConnections(document, portContext, lookup, report);
  checkCycles(document, report);
  checkMissingInputs(document, portContext, lookup, report);
  checkUnused(document, lookup, report);

  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    issues,
    errors,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    lookup,
    executionOrder: flattenExecutionOrder(document, lookup),
    ok: errors.length === 0,
  };
}

type Report = (
  code: WorkflowIssueCode,
  nodeId: string,
  message: string,
  extra?: { readonly port?: string; readonly severity?: 'error' | 'warning'; readonly path?: readonly string[] },
) => void;

/** 整图规模：超出上限时错误定位到「图」而不是某个节点（节点可能还没画完）。 */
function checkTotals(document: GraphDocument, report: Report): void {
  if (document.nodes.length > WORKFLOW_MAX_NODES) {
    report('limit_exceeded', '', `图里有 ${document.nodes.length} 个节点，超过上限 ${WORKFLOW_MAX_NODES}`);
  }
  if (document.connections.length > WORKFLOW_MAX_CONNECTIONS) {
    report(
      'limit_exceeded',
      '',
      `图里有 ${document.connections.length} 条连接，超过上限 ${WORKFLOW_MAX_CONNECTIONS}`,
    );
  }
  if (document.main.length > WORKFLOW_MAX_REGION_ITEMS) {
    report('limit_exceeded', '', `顶层序列有 ${document.main.length} 条语句，超过上限 ${WORKFLOW_MAX_REGION_ITEMS}`);
  }
}

interface StartInfo {
  readonly nodes: readonly GraphNode[];
}

/** 逐节点检查：种类、参数、题目动作权限、出题人积木声明。 */
function checkNodes(
  document: GraphDocument,
  context: WorkflowContext,
  lookup: GraphLookup,
  report: Report,
): StartInfo {
  const starts: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of document.nodes) {
    if (seen.has(node.id)) {
      report('duplicate_id', node.id, `节点 id 重复：${node.id}`);
      continue;
    }
    seen.add(node.id);

    const spec = nodeSpec(node.kind);
    if (spec === undefined) {
      report('unknown_kind', node.id, `未知节点类型：${node.kind}`);
      continue;
    }
    if (node.kind === 'start') starts.push(node);

    const placement = lookup.placements.get(node.id);
    const path = placement?.path ?? ['main'];
    const issue = checkParams(node, paramSpecsOf(node, spec));
    if (issue !== undefined) {
      report('invalid_param', node.id, `${spec.label}的参数「${issue.param}」不对：${issue.message}`, { path });
    }
    if (spec.action !== undefined && spec.action !== 'block' && !context.allowedActions.includes(spec.action)) {
      report('action_not_allowed', node.id, `本题不允许动作 ${spec.action}，它不在 allowedActions 里`, { path });
    }
    if (spec.authorBlock === true) {
      const id = typeof node.params.id === 'string' ? node.params.id : '';
      const declared = (context.authorBlocks ?? []).some((block) => block.id === id);
      if (!declared) {
        report('undeclared_author_block', node.id, `题目没有声明出题人积木 ${id}`, { path });
      }
    }
    if (spec.action === undefined && spec.output === undefined && spec.dynamicOutput === undefined && !spec.exec) {
      report('unknown_kind', node.id, `节点类型 ${node.kind} 既没有输出也不是语句，目录定义不完整`);
    }
  }
  return { nodes: starts };
}

/** 入口：恰好一个「开始」，而且它不能出现在执行序列里（06 §5.1）。 */
function checkEntry(document: GraphDocument, starts: StartInfo, lookup: GraphLookup, report: Report): void {
  if (starts.nodes.length === 0) {
    report('missing_start', '', '画布上需要一个「开始」节点：流程从它下面的顶层序列开始执行');
    return;
  }
  if (starts.nodes.length > 1) {
    for (const node of starts.nodes) {
      report('multiple_start', node.id, '只能有一个「开始」节点，请删掉多余的');
    }
    return;
  }
  const start = starts.nodes[0] as GraphNode;
  const placement = lookup.placements.get(start.id);
  if (placement !== undefined) {
    report('start_has_input', start.id, '「开始」不能放进执行序列或容器里：它是入口，不是一条语句');
  }
  const feeds = document.connections.some((connection) => connection.from.node === start.id);
  if (feeds) {
    report('start_has_input', start.id, '「开始」没有输出端口，不能被别的节点连线');
  }
  if (lookup.depth > WORKFLOW_MAX_NESTING) {
    report(
      'limit_exceeded',
      start.id,
      `容器嵌套 ${lookup.depth} 层，超过上限 ${WORKFLOW_MAX_NESTING}，把结构拆小一些`,
    );
  }
}

/** 放置：每个节点都要在某个区域里；数据节点没被用到时只算警告。 */
function checkPlacement(document: GraphDocument, lookup: GraphLookup, report: Report): void {
  for (const id of lookup.duplicated) {
    report('duplicate_placement', id, `节点 ${id} 被放进了多个执行区域，请只保留一处`);
  }
  const ids = new Set(document.nodes.map((node) => node.id));
  for (const [region, members] of Object.entries(collectRegionMembers(document))) {
    for (const member of members) {
      if (!ids.has(member)) report('unknown_node', member, `区域 ${region} 引用了不存在的节点 ${member}`);
    }
  }
}

/** 区域名与成员：容器节点只允许用它声明的区域。 */
function checkRegions(document: GraphDocument, lookup: GraphLookup, report: Report): void {
  for (const node of document.nodes) {
    if (node.regions === undefined) continue;
    const spec: NodeKindSpec | undefined = nodeSpec(node.kind);
    const allowed = new Set(spec?.regions?.map((region) => region.name) ?? []);
    for (const [region, members] of Object.entries(node.regions)) {
      if (!allowed.has(region)) {
        report('unknown_region', node.id, `节点 ${node.kind} 没有区域 ${region}`);
      }
      if (members.length > WORKFLOW_MAX_REGION_ITEMS) {
        report('limit_exceeded', node.id, `区域 ${region} 有 ${members.length} 条语句，超过上限 ${WORKFLOW_MAX_REGION_ITEMS}`);
      }
      for (const member of members) {
        if (lookup.placements.get(member)?.container !== node.id) {
          report('duplicate_placement', node.id, `区域 ${region} 里的节点 ${member} 位置不唯一`);
        }
      }
    }
  }
}

/** 连线：端点存在、端口存在、类型一致、一个输入只接一条线。 */
function checkConnections(
  document: GraphDocument,
  portContext: PortContext,
  lookup: GraphLookup,
  report: Report,
): void {
  const seen = new Set<string>();
  for (const connection of document.connections) {
    const from = lookup.nodes.get(connection.from.node);
    const to = lookup.nodes.get(connection.to.node);
    if (from === undefined || to === undefined) {
      const missing = from === undefined ? connection.from.node : connection.to.node;
      report('unknown_node', missing, `连线引用了不存在的节点 ${missing}`);
      continue;
    }
    if (connection.from.node === connection.to.node) {
      report('self_edge', from.id, `节点 ${from.id} 不能连到自己`);
      continue;
    }
    const key = `${connection.from.node}\u0000${connection.from.port}\u0000${connection.to.node}\u0000${connection.to.port}`;
    if (seen.has(key)) {
      report('duplicate_edge', to.id, `重复的连线：${from.id}.${connection.from.port} → ${to.id}.${connection.to.port}`);
      continue;
    }
    seen.add(key);

    const fromSpec = nodeSpec(from.kind);
    const toSpec = nodeSpec(to.kind);
    if (fromSpec === undefined || toSpec === undefined) continue;

    const output = nodeOutput(fromSpec, paramsOf(from, fromSpec));
    if (output === undefined) {
      report('unknown_port', from.id, `节点 ${from.id}（${fromSpec.label}）没有数据输出，不能作为连线起点`);
      continue;
    }
    if (output.name !== connection.from.port) {
      report('unknown_port', from.id, `节点 ${from.id} 没有输出端口 ${connection.from.port}`, { port: connection.from.port });
      continue;
    }

    const inputs = nodeInputs(toSpec, paramsOf(to, toSpec), portContext);
    const input = inputs.find((candidate) => candidate.name === connection.to.port);
    if (input === undefined) {
      report('unknown_port', to.id, `节点 ${to.id}（${toSpec.label}）没有输入端口 ${connection.to.port}`, {
        port: connection.to.port,
      });
      continue;
    }
    checkType(from.id, to.id, output.type, input, report);
    checkCrossRegion(connection, lookup, report);
  }
}

function checkType(fromId: string, toId: string, outputType: PortType, input: InputPortSpec, report: Report): void {
  if (outputType === input.type) return;
  report(
    'type_mismatch',
    toId,
    `端口 ${input.name} 需要${input.type}，但 ${fromId} 输出的是${outputType}`,
    { port: input.name },
  );
}

/** 跨区域引用：内层可以用外层的值，不能反过来用兄弟区域的值。 */
function checkCrossRegion(
  connection: {
    readonly from: { readonly node: string; readonly port: string };
    readonly to: { readonly node: string; readonly port: string };
  },
  lookup: GraphLookup,
  report: Report,
): void {
  const source = lookup.placements.get(connection.from.node);
  const target = lookup.placements.get(connection.to.node);
  if (source === undefined || target === undefined) return;
  if (pathContains(source.path, target.path)) return;
  report(
    'cross_region_reference',
    connection.to.node,
    `节点 ${connection.to.node} 不能用 ${connection.from.node} 的值：它们不在同一层执行区域里（只能在自身或外层取数）`,
    { port: connection.to.port },
  );
}

/** 数据依赖不能成环：图是 DAG，环会在求值时变成死循环。 */
function checkCycles(document: GraphDocument, report: Report): void {
  const adjacency = new Map<string, string[]>();
  for (const connection of document.connections) {
    const list = adjacency.get(connection.from.node) ?? [];
    list.push(connection.to.node);
    adjacency.set(connection.from.node, list);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      if (!reported.has(id)) {
        reported.add(id);
        report('data_cycle', id, `数据依赖成环：${id} 最终会需要自己的结果`);
      }
      return;
    }
    state.set(id, 'visiting');
    for (const next of adjacency.get(id) ?? []) visit(next);
    state.set(id, 'done');
  };

  for (const node of document.nodes) visit(node.id);
}

/** 必填输入：接线的不用管，没接线的必须能由参数兜底。 */
function checkMissingInputs(
  document: GraphDocument,
  portContext: PortContext,
  lookup: GraphLookup,
  report: Report,
): void {
  for (const node of document.nodes) {
    const spec = nodeSpec(node.kind);
    if (spec === undefined) continue;
    const inputs = nodeInputs(spec, paramsOf(node, spec), portContext);
    for (const input of inputs) {
      if (!input.required) continue;
      const key = `${node.id}\u0000${input.name}`;
      if (lookup.incoming.has(key)) continue;
      report('missing_input', node.id, `节点 ${spec.label} 缺少输入「${input.label}」`, { port: input.name });
    }
  }
}

/**
 * 未使用：没放在执行序列里的**语句**节点、以及没有任何下游的数据节点。
 *
 * 数据节点不需要被摆进执行序列：它按依赖求值（06 §2），连线就说明它被用了；
 * 只有语句节点必须占据一个执行位置。这样把「填充字节」拖到画布上、连到写入节点上就够了，
 * 不必先摆出一个顺序。
 */
function checkUnused(document: GraphDocument, lookup: GraphLookup, report: Report): void {
  const consumed = new Set(document.connections.map((connection) => connection.from.node));
  for (const node of document.nodes) {
    if (node.kind === 'start') continue;
    const spec = nodeSpec(node.kind);
    const placement = lookup.placements.get(node.id);
    if (placement === undefined) {
      if (spec?.exec === true) {
        report(
          'unplaced_node',
          node.id,
          `语句节点 ${node.id}（${spec.label}）不在任何执行序列里，不会被执行`,
        );
      } else if (!consumed.has(node.id)) {
        report('unused_node', node.id, `节点 ${node.id} 没有被使用`, { severity: 'warning' });
      }
      continue;
    }
    if (spec !== undefined && !spec.exec && !consumed.has(node.id)) {
      report('unused_node', node.id, `数据节点 ${node.id} 的结果没有被任何动作使用`, {
        severity: 'warning',
        path: placement.path,
      });
    }
  }
}

/** 展平执行顺序：顶层序列 + 容器区域（本阶段只有顶层）。 */
function flattenExecutionOrder(document: GraphDocument, lookup: GraphLookup): readonly ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  const walk = (ids: readonly string[], path: readonly string[], level: number): void => {
    if (level > WORKFLOW_MAX_NESTING + 8) return;
    for (const id of ids) {
      const placement = lookup.placements.get(id);
      steps.push({ nodeId: id, path });
      if (placement === undefined) continue;
      const node = lookup.nodes.get(id);
      if (node?.regions === undefined) continue;
      for (const [region, members] of Object.entries(node.regions)) {
        walk(members, [...path, `${id}/${region}`], level + 1);
      }
    }
  };
  walk(document.main, ['main'], 1);
  return steps;
}

/** 所有区域里的成员（用于「引用了不存在的节点」这类整图检查）。 */
function collectRegionMembers(document: GraphDocument): Record<string, readonly string[]> {
  const members: Record<string, readonly string[]> = { main: document.main };
  for (const node of document.nodes) {
    if (node.regions === undefined) continue;
    for (const [region, ids] of Object.entries(node.regions)) {
      members[`${node.id}/${region}`] = ids;
    }
  }
  return members;
}
