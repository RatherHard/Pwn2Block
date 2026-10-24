import { CANVAS_MAX_FLOW_DEPTH, CANVAS_MAX_FLOW_NODES } from '../limits';
import {
  UNCONNECTED,
  flowChildrenOf,
  inputIdsOf,
  isFlowNode,
  nodeMapOf,
  type CanvasDocument,
  type CanvasNode,
  type LoopIndexNode,
  type MethodNode,
  type StartNode,
} from './document';
import { dedupeIssues, errorIssue, type CanvasIssue } from './issues';
import {
  canvasMethodById,
  METHOD_PARAM_LABELS,
  type CanvasMethodDecl,
  type CanvasMethodParam,
} from './methods';
import { staticTypeOf } from './types';
import { VALUE_KIND_LABELS, type ValueKind } from './value';

/**
 * 流程结构与作用域分析（需求 §5.1–5.4、§11 AT-08 / AT-09）。
 *
 * 流程用**数组**表达顺序：`main` 是顶层序列，分支的 `then`/`else` 与循环的 `body` 是区域。
 * 一个流程节点只能出现在一条序列里，所以回边与跨区域接线在结构上就表达不出来，不需要追环
 * （需求 §5.2）。这一层只判断结构与作用域，不生成动作、也不求值：数据引用的存在性与静态
 * 类型复用 `validate.ts`，不另造一套推导。
 *
 * 两条建模决定：
 * - `regionOf` 记「这个流程节点在哪条序列里」，`depthOf` 记嵌套深度（main 上的节点为 0）；
 *   重复出现的节点保留第一次的位置与深度，重复本身单独报错。
 * - 数据节点（含 `loop-index`）在序列里没有位置，它的位置由**使用它的语句**定义。因此
 *   「循环索引自己是否在循环体内」按「它的使用点是否全在循环体外」判断：只要有一个使用点
 *   落在所属循环体内，索引节点本身就不报错，越界的那个使用点由语句级检查单独定位。
 */

export type FlowRegionKind = 'main' | 'then' | 'else' | 'body';

/** 一条序列的归属：`ownerId` 是所属容器 id，顶层 `main` 用 ``''`` 表示。 */
export interface FlowRegionRef {
  readonly ownerId: string; // 所属容器 id；main 用 '' 表示顶层
  readonly kind: FlowRegionKind;
}

export interface FlowLayout {
  readonly start: StartNode | undefined;
  readonly main: readonly string[];
  /** 流程节点 id → 它所在的那条序列。 */
  readonly regionOf: ReadonlyMap<string, FlowRegionRef>;
  /** 流程节点 id → 嵌套深度（main 上的节点为 0）。 */
  readonly depthOf: ReadonlyMap<string, number>;
  readonly issues: readonly CanvasIssue[];
}

export interface FlowAnalysisOptions {
  /** 题目声明的方法目录；给了就校验方法节点的名字与参数。 */
  readonly methods?: readonly CanvasMethodDecl[];
}

const MAIN_REGION: FlowRegionRef = { ownerId: '', kind: 'main' };

/** 可以承载流程的节点：所有流程节点（不看是否已接进序列），重复 id 只算一次。 */
export function flowNodeIdsOf(document: CanvasDocument): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const node of document.nodes) {
    if (!isFlowNode(node) || seen.has(node.id)) continue;
    seen.add(node.id);
    ids.push(node.id);
  }
  return ids;
}

/** 该流程节点是否位于 loopId 的循环体子树内（含嵌套的分支/循环）。 */
export function isInsideLoop(layout: FlowLayout, nodeId: string, loopId: string): boolean {
  return insideLoopOf(layout.regionOf, nodeId, loopId);
}

/** 从 `regionOf` 向上走容器链；`visited` 防脏存档把两个容器互相记为区域而死循环。 */
function insideLoopOf(
  regionOf: ReadonlyMap<string, FlowRegionRef>,
  nodeId: string,
  loopId: string,
): boolean {
  const visited = new Set<string>();
  let current = nodeId;
  while (!visited.has(current)) {
    visited.add(current);
    const region = regionOf.get(current);
    if (region === undefined) return false;
    if (region.kind === 'body' && region.ownerId === loopId) return true;
    if (region.ownerId === '') return false;
    current = region.ownerId;
  }
  return false;
}

/** 分析整份文档的流程结构；不合法时照常返回 layout 与 issues，不抛异常。 */
export function analyzeFlow(document: CanvasDocument, options: FlowAnalysisOptions = {}): FlowLayout {
  const nodes = nodeMapOf(document);
  const starts = startNodesOf(nodes);
  const ctx: FlowContext = {
    document,
    nodes,
    regionOf: new Map(),
    depthOf: new Map(),
    expanded: new Set(),
    issues: [],
  };

  walkSequence(ctx, document.main, MAIN_REGION, 0);
  checkStartNodes(ctx, starts);
  checkOrphans(ctx);
  checkLoopIndexes(ctx);
  checkMethods(ctx, options.methods);
  checkLimits(ctx);

  return {
    start: starts[0],
    main: [...document.main],
    regionOf: ctx.regionOf,
    depthOf: ctx.depthOf,
    issues: dedupeIssues(ctx.issues),
  };
}

/** 一次分析的全部可变状态：走序列时写 `regionOf`/`depthOf`，各检查只往 `issues` 里追加。 */
interface FlowContext {
  readonly document: CanvasDocument;
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly regionOf: Map<string, FlowRegionRef>;
  readonly depthOf: Map<string, number>;
  /** 已经展开过子序列的容器：重复出现的容器不再展开，防环。 */
  readonly expanded: Set<string>;
  readonly issues: CanvasIssue[];
}

function walkSequence(
  ctx: FlowContext,
  ids: readonly string[],
  region: FlowRegionRef,
  depth: number,
): void {
  const issueNodeId = sequenceIssueNodeId(ctx.nodes, region, ids);
  for (const id of ids) {
    const node = ctx.nodes.get(id);
    if (node === undefined) {
      ctx.issues.push(errorIssue('flow_error', issueNodeId, `流程序列引用了不存在的节点 ${id}`));
      continue;
    }
    if (!isFlowNode(node)) {
      ctx.issues.push(errorIssue('flow_error', issueNodeId, `「${id}」是数据节点，不能放进流程序列`));
      continue;
    }
    const placed = ctx.regionOf.get(id);
    if (placed !== undefined) {
      const message = `流程节点「${id}」已经在${regionLabel(placed)}里，一个流程节点只能出现在一条序列里`;
      ctx.issues.push(errorIssue('flow_error', id, message));
      continue;
    }
    ctx.regionOf.set(id, region);
    ctx.depthOf.set(id, depth);
    expandChildren(ctx, node, depth + 1);
  }
}

/** 展开容器自己的两条（或一条）区域；同一个容器只展开一次，所以环状引用会停下来。 */
function expandChildren(ctx: FlowContext, node: CanvasNode, childDepth: number): void {
  const children = flowChildrenOf(node);
  if (children.length === 0 || ctx.expanded.has(node.id)) return;
  ctx.expanded.add(node.id);
  const kinds: readonly FlowRegionKind[] = node.kind === 'if' ? ['then', 'else'] : ['body'];
  children.forEach((ids, index) => {
    walkSequence(ctx, ids, { ownerId: node.id, kind: kinds[index] }, childDepth);
  });
}

/** 区域的中文名，用于「已经在哪条序列里」这类需要说清位置的文案。 */
function regionLabel(region: FlowRegionRef): string {
  if (region.kind === 'main') return '顶层序列';
  const branch = region.kind === 'then' ? '成立分支' : region.kind === 'else' ? '不成立分支' : '循环体';
  return `「${region.ownerId}」的${branch}`;
}

/** 序列成员出错时定位到谁：顶层没有容器节点，退而定位到第一个坏成员（可能为空串）。 */
function sequenceIssueNodeId(
  nodes: ReadonlyMap<string, CanvasNode>,
  region: FlowRegionRef,
  ids: readonly string[],
): string {
  if (region.kind !== 'main') return region.ownerId;
  for (const id of ids) {
    const node = nodes.get(id);
    if (node === undefined || !isFlowNode(node)) return id;
  }
  return '';
}

function startNodesOf(nodes: ReadonlyMap<string, CanvasNode>): readonly StartNode[] {
  return [...nodes.values()].filter((node): node is StartNode => node.kind === 'start');
}

/**
 * 开始节点必须恰好一个，且是 `main` 的第一步（需求 §5.2）。
 *
 * 「缺开始节点」只在**有流程**时才算错误：阶段一的数据表达式文档没有任何流程节点、`main`
 * 也是空的，它是合法的数据图，不能因为「还没搭流程」就整张图变红。
 */
function checkStartNodes(ctx: FlowContext, starts: readonly StartNode[]): void {
  if (starts.length === 0) {
    if (ctx.document.main.length > 0 || flowNodeIdsOf(ctx.document).length > 0) {
      ctx.issues.push(errorIssue('flow_error', '', '工作流缺少开始节点'));
    }
    return;
  }
  for (const extra of starts.slice(1)) {
    const message = `工作流只能有一个开始节点，「${extra.id}」是多余的`;
    ctx.issues.push(errorIssue('flow_error', extra.id, message));
  }
  const only = starts[0];
  const main = ctx.document.main;
  if (starts.length === 1 && main.length > 0 && main[0] !== only.id) {
    ctx.issues.push(errorIssue('flow_error', only.id, '开始节点必须是流程的第一步'));
  }
}

function checkOrphans(ctx: FlowContext): void {
  for (const node of ctx.nodes.values()) {
    if (!isFlowNode(node) || ctx.regionOf.has(node.id)) continue;
    ctx.issues.push(errorIssue('flow_error', node.id, `流程节点 ${node.id} 没有接进流程`));
  }
}

/** 循环索引的作用域：既查索引节点自己，也查每个使用点（需求 §5.3）。 */
function checkLoopIndexes(ctx: FlowContext): void {
  const usages = loopIndexUsagesOf(ctx);
  for (const node of ctx.nodes.values()) {
    if (node.kind !== 'loop-index') continue;
    checkLoopIndexNode(ctx, node, usages);
  }
}

function checkLoopIndexNode(
  ctx: FlowContext,
  node: LoopIndexNode,
  usages: ReadonlyMap<string, readonly string[]>,
): void {
  const loop = ctx.nodes.get(node.loop);
  if (loop === undefined || loop.kind !== 'loop') {
    ctx.issues.push(errorIssue('flow_error', node.id, '循环索引必须指向一个次数循环'));
    return;
  }
  const statementIds = usages.get(node.id) ?? [];
  const outside = statementIds.filter((id) => !insideLoopOf(ctx.regionOf, id, node.loop));
  for (const id of outside) {
    ctx.issues.push(errorIssue('flow_error', id, '循环索引只在所属循环体内可用，这条语句在循环外'));
  }
  // 使用点全在循环体外时索引节点自己也失去了合法位置；没有使用点就不下结论（只是还没接线）。
  if (statementIds.length > 0 && outside.length === statementIds.length) {
    ctx.issues.push(errorIssue('flow_error', node.id, '循环索引只在所属循环体内可用'));
  }
}

/** 每个循环索引被哪些流程语句（传递地）用到：先算一次，节点级与语句级检查共用。 */
function loopIndexUsagesOf(ctx: FlowContext): ReadonlyMap<string, readonly string[]> {
  const usages = new Map<string, string[]>();
  for (const node of ctx.nodes.values()) {
    if (!isFlowNode(node)) continue;
    for (const indexId of loopIndexClosureOf(ctx, node)) {
      const list = usages.get(indexId);
      if (list === undefined) usages.set(indexId, [node.id]);
      else list.push(node.id);
    }
  }
  return usages;
}

/**
 * 一条语句的数据引用闭包里的循环索引。
 *
 * 只沿数据引用走（`inputIdsOf`），遇到已访问节点就停；**不追 `var-ref`**：变量的当前值取决于
 * 执行到这一步时走的是哪条路径，静态判断「读到的索引属于哪一轮」需要数据流分析。
 * 首版宁可不报，也不拿一次静态猜测去误报。
 */
function loopIndexClosureOf(ctx: FlowContext, statement: CanvasNode): readonly string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  const stack = [...inputIdsOf(statement)];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = ctx.nodes.get(id);
    if (node === undefined) continue;
    if (node.kind === 'loop-index') found.add(id);
    for (const next of inputIdsOf(node)) stack.push(next);
  }
  return [...found];
}

function checkMethods(
  ctx: FlowContext,
  methods: readonly CanvasMethodDecl[] | undefined,
): void {
  if (methods === undefined) return;
  for (const node of ctx.nodes.values()) {
    if (node.kind === 'method') checkMethodNode(ctx, methods, node);
  }
}

/** 方法名与参数名集合必须与题目声明完全一致，之后才按声明逐个查参数类型。 */
function checkMethodNode(
  ctx: FlowContext,
  methods: readonly CanvasMethodDecl[],
  node: MethodNode,
): void {
  const declared = canvasMethodById(methods, node.block);
  if (declared === undefined) {
    ctx.issues.push(errorIssue('method_mismatch', node.id, `题目没有声明方法 ${node.block}`));
    return;
  }
  const declaredNames = declared.params.map((param) => param.name);
  const actualNames = Object.keys(node.args);
  const missing = declaredNames.filter((name) => !actualNames.includes(name));
  const extra = actualNames.filter((name) => !declaredNames.includes(name));
  if (missing.length > 0) {
    const message = `方法 ${node.block} 缺少参数：${missing.join('、')}`;
    ctx.issues.push(errorIssue('method_mismatch', node.id, message));
  }
  if (extra.length > 0) {
    const message = `方法 ${node.block} 多出参数：${extra.join('、')}`;
    ctx.issues.push(errorIssue('method_mismatch', node.id, message));
  }
  for (const param of declared.params) checkMethodArg(ctx, node, param);
}

function checkMethodArg(ctx: FlowContext, node: MethodNode, param: CanvasMethodParam): void {
  const valueId = argIdOf(node.args, param.name);
  if (valueId === undefined) return;
  // 「未接线」是一等编辑状态（`UNCONNECTED`）：接线检查自己会报 `unconnected`，
  // 这里不能再把它当成「引用了不存在的节点」，否则新建一个方法节点会同时冒出两条错误。
  if (valueId === UNCONNECTED) return;
  if (!ctx.nodes.has(valueId)) {
    const message = `方法 ${node.block} 的参数 ${param.name} 引用了不存在的节点 ${valueId}`;
    ctx.issues.push(errorIssue('flow_error', node.id, message));
    return;
  }
  const actual = staticTypeOf(ctx.document, valueId);
  if (actual === undefined || actual === 'any') return;
  // 地址在画布上就是整数，只有字节串与方法声明的 bytes 参数另属一类（需求 §5.4）。
  const expected: ValueKind = param.type === 'bytes' ? 'byte' : 'int';
  if (actual === expected) return;
  const message = `方法 ${node.block} 的参数 ${param.name} 需要${METHOD_PARAM_LABELS[param.type]}，收到${VALUE_KIND_LABELS[actual]}`;
  ctx.issues.push(errorIssue('type_mismatch', node.id, message));
}

/** `args` 是 `Record`，缺键时下标也会给出字符串，所以用 `hasOwn` 判断有没有这个参数。 */
function argIdOf(args: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(args, name) ? args[name] : undefined;
}

function checkLimits(ctx: FlowContext): void {
  const total = flowNodeIdsOf(ctx.document).length;
  if (total > CANVAS_MAX_FLOW_NODES) {
    const message = `流程节点数 ${total} 超过上限 ${CANVAS_MAX_FLOW_NODES}`;
    ctx.issues.push(errorIssue('limit_exceeded', '', message));
  }
  checkDepthLimit(ctx);
}

/** 嵌套太深时定位到越界的容器：叶子节点越界就指向它所在那条序列的容器。 */
function checkDepthLimit(ctx: FlowContext): void {
  const reported = new Set<string>();
  for (const [id, depth] of ctx.depthOf) {
    if (depth <= CANVAS_MAX_FLOW_DEPTH) continue;
    const node = ctx.nodes.get(id);
    const isContainer = node !== undefined && flowChildrenOf(node).length > 0;
    const target = isContainer ? id : (ctx.regionOf.get(id)?.ownerId ?? '');
    if (reported.has(target)) continue;
    reported.add(target);
    const message = `流程嵌套深度 ${depth} 超过上限 ${CANVAS_MAX_FLOW_DEPTH}`;
    ctx.issues.push(errorIssue('limit_exceeded', target, message));
  }
}
