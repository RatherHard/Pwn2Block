import { CANVAS_MAX_VARIABLES, CANVAS_MAX_VAR_NAME_CHARS } from '../limits';
import {
  inputIdsOf,
  nodeMapOf,
  variableBindingInput,
  type CanvasDocument,
  type CanvasNode,
  type VarDeclNode,
  type VarRefNode,
} from './document';
import { errorIssue, type CanvasIssue } from './issues';
import type { ValueKind } from './value';

/**
 * 全局变量表与声明层校验（需求 §3.1–3.2、§11 AT-05 / AT-06）。
 *
 * 变量有三个身份要分开看：**声明**（`var-decl`）是唯一身份，名字与类型挂在它上面；
 * **引用视图**（`var-ref`）只是指向声明的另一处显示，读出来是同一个变量；
 * **循环索引**（`loop-index`）属于流程作用域，不进这张表（需求 §5.3）。
 *
 * 这一层只做**静态**判断：名字、上限、引用目标、初始化顺序、赋值目标。
 * 值类型是否匹配留给 `validate.ts`，未初始化读取留给执行器——那两件事需要类型推导与运行状态。
 *
 * 初始化顺序（需求 §3.1「初始化依赖按依赖顺序解析」）：派生绑定 `b := a + 1` 读 `a` 时
 * `a` 必须已经算过。顺序错了不会报错、只会悄悄算错，所以有环必须报出来；同时把环上剩余的
 * 声明按文档顺序排到末尾，让预览/生成等后续步骤仍能跑，而不是死循环。
 */

/** 变量表：声明按文档顺序存一份，另建 id / 名字 / 引用视图三张索引。 */
export interface VariableTable {
  /** 文档顺序的全部声明；重复 id 也都在这里（由 `validate.ts` 报 `duplicate_id`）。 */
  readonly declarations: readonly VarDeclNode[];
  /** 声明 id → 声明；重复 id 保留第一份。 */
  readonly byId: ReadonlyMap<string, VarDeclNode>;
  /** 去空白后的名字 → 声明；重名保留文档里第一份，重名本身由声明层校验报。 */
  readonly byName: ReadonlyMap<string, VarDeclNode>;
  /** `var-ref` 节点 id → 节点。 */
  readonly refs: ReadonlyMap<string, VarRefNode>;
}

/** 建表。只读文档；重复 id 与重名取第一份，让查表结果稳定。 */
export function variableTableOf(document: CanvasDocument): VariableTable {
  const declarations: VarDeclNode[] = [];
  const byId = new Map<string, VarDeclNode>();
  const byName = new Map<string, VarDeclNode>();
  const refs = new Map<string, VarRefNode>();

  for (const node of document.nodes) {
    if (node.kind === 'var-decl') {
      declarations.push(node);
      if (!byId.has(node.id)) byId.set(node.id, node);
      const name = node.name.trim();
      if (!byName.has(name)) byName.set(name, node);
    } else if (node.kind === 'var-ref') {
      if (!refs.has(node.id)) refs.set(node.id, node);
    }
  }

  return { declarations, byId, byName, refs };
}

/** 展示名：声明用 `name`，引用视图用它所指向声明的 `name`，其他节点回退成 id。 */
export function variableNameOf(table: VariableTable, nodeId: string): string {
  const decl = resolveVariable(table, nodeId);
  return decl === undefined ? nodeId : decl.name;
}

/** 把 `var-decl` / `var-ref` 的 id 解析到声明节点；不是变量返回 `undefined`。 */
export function resolveVariable(table: VariableTable, nodeId: string): VarDeclNode | undefined {
  const own = table.byId.get(nodeId);
  if (own !== undefined) return own;
  const view = table.refs.get(nodeId);
  if (view === undefined) return undefined;
  // 只认「引用 → 声明」一层：指向另一个引用的链路是错的，由声明层校验报。
  return table.byId.get(view.decl);
}

/** 变量读出来的静态类型：声明类型；不是变量返回 `undefined`。 */
export function declaredTypeOf(table: VariableTable, nodeId: string): ValueKind | undefined {
  const decl = resolveVariable(table, nodeId);
  return decl === undefined ? undefined : decl.type;
}

// ---------------------------------------------------------------------------
// 声明层校验（需求 §3.1）
// ---------------------------------------------------------------------------

/**
 * 声明层问题：名字为空/过长/重复、声明数超上限，以及引用视图的指向是否合法。
 *
 * 名字按**去空白后**判空与判重：界面上 `a` 与 ` a ` 看着像两个名字、读起来却是同一个，
 * 所以重复时**两条声明都报**，让两处都能定位。
 */
export function checkVariableDeclarations(table: VariableTable): readonly CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  checkVariableNames(table.declarations, issues);
  checkVariableCount(table.declarations, issues);
  for (const view of table.refs.values()) checkRefTarget(table, view, issues);
  return issues;
}

function checkVariableNames(declarations: readonly VarDeclNode[], issues: CanvasIssue[]): void {
  const groups = new Map<string, VarDeclNode[]>();

  for (const decl of declarations) {
    const name = decl.name.trim();
    if (name.length === 0) {
      issues.push(errorIssue('variable_error', decl.id, '变量名不能为空'));
      continue;
    }
    if (name.length > CANVAS_MAX_VAR_NAME_CHARS) {
      issues.push(
        errorIssue(
          'variable_error',
          decl.id,
          `变量名「${name}」有 ${name.length} 个字符，超过上限 ${CANVAS_MAX_VAR_NAME_CHARS}`,
        ),
      );
    }
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [decl]);
    else group.push(decl);
  }

  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    for (const decl of group) {
      issues.push(
        errorIssue('variable_error', decl.id, `变量名「${name}」重复（共 ${group.length} 份声明），变量名必须唯一`),
      );
    }
  }
}

function checkVariableCount(declarations: readonly VarDeclNode[], issues: CanvasIssue[]): void {
  if (declarations.length <= CANVAS_MAX_VARIABLES) return;
  const firstOver = declarations.at(CANVAS_MAX_VARIABLES);
  if (firstOver === undefined) return;
  issues.push(
    errorIssue(
      'variable_error',
      firstOver.id,
      `变量声明数 ${declarations.length} 超过上限 ${CANVAS_MAX_VARIABLES}`,
    ),
  );
}

/** 引用视图必须指向声明节点，且不能指向自己（需求 §3.1「可创建指向同一声明的引用视图」）。 */
function checkRefTarget(table: VariableTable, view: VarRefNode, issues: CanvasIssue[]): void {
  if (view.decl === view.id) {
    issues.push(errorIssue('variable_error', view.id, `变量引用「${view.id}」指向自己；引用必须指向变量声明`));
    return;
  }
  if (table.byId.has(view.decl)) return;
  issues.push(
    errorIssue('variable_error', view.id, `变量引用「${view.id}」必须指向变量声明，「${view.decl}」不是变量声明`),
  );
}

// ---------------------------------------------------------------------------
// 依赖收集（需求 §3.1）
// ---------------------------------------------------------------------------

/**
 * 从 `startId` 出发沿数据引用做传递闭包，收集途中 `var-ref` 指向的声明 id。
 *
 * 闭包只在**表达式内部**展开：`var-ref` 是叶子，不会进到另一个声明的绑定里，
 * 所以拿到的是「这条表达式直接读了哪些变量」；间接依赖由初始化顺序的拓扑排序连起来。
 * 节点会被标记访问过：数据引用成环（由校验器报 `input_cycle`）时这里只停下，不会死循环。
 */
function referencedDeclIds(
  nodes: ReadonlyMap<string, CanvasNode>,
  table: VariableTable,
  startId: string,
): readonly string[] {
  const found: string[] = [];
  const foundIds = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [startId];

  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    if (node.kind === 'var-ref') {
      const decl = table.byId.get(node.decl);
      if (decl !== undefined && !foundIds.has(decl.id)) {
        foundIds.add(decl.id);
        found.push(decl.id);
      }
      continue;
    }
    for (const input of inputIdsOf(node)) queue.push(input);
  }

  return found;
}

/** 一个声明直接依赖的其它声明（沿绑定表达式里的 `var-ref` 收集；去重、不含自己）。 */
export function declarationDependencies(
  document: CanvasDocument,
  table: VariableTable,
  declId: string,
): readonly string[] {
  const decl = table.byId.get(declId);
  if (decl === undefined) return [];
  const input = variableBindingInput(decl.binding);
  if (input === undefined) return [];
  return referencedDeclIds(nodeMapOf(document), table, input).filter((id) => id !== declId);
}

// ---------------------------------------------------------------------------
// 初始化顺序（需求 §3.1、§11 AT-06）
// ---------------------------------------------------------------------------

/**
 * 初始化顺序（依赖在前）与自引用 / 循环依赖问题。
 *
 * - 边是「依赖 → 依赖者」；同时可排时按**文档顺序**，让顺序可预测、和用户摆放一致；
 * - 未初始化（`binding.mode === 'none'`）的声明不参与排序，统一按文档顺序排在最后；
 * - 自引用单独报「初始值引用了自己」，不进图（否则会被误报成环）；
 * - 成环时报 `variable_error` 并点明环上的名字，**环上剩余声明按文档顺序追加到末尾**，
 *   顺序表仍然覆盖全部声明，后续步骤能继续跑。
 */
export function initializationOrder(
  document: CanvasDocument,
  table: VariableTable,
): { readonly order: readonly VarDeclNode[]; readonly issues: readonly CanvasIssue[] } {
  const nodes = nodeMapOf(document);
  const declarations = uniqueDeclarations(table.declarations);
  const initialized = declarations.filter((decl) => decl.binding.mode !== 'none');
  const uninitialized = declarations.filter((decl) => decl.binding.mode === 'none');

  const issues: CanvasIssue[] = [];
  const dependencies = new Map<string, ReadonlySet<string>>();

  for (const decl of initialized) {
    const input = variableBindingInput(decl.binding);
    const referenced = input === undefined ? [] : referencedDeclIds(nodes, table, input);
    if (referenced.includes(decl.id)) {
      issues.push(errorIssue('variable_error', decl.id, `变量 ${decl.name} 的初始值引用了自己`));
    }
    dependencies.set(decl.id, new Set(referenced.filter((id) => id !== decl.id)));
  }

  return { order: [...topologicalOrder(initialized, dependencies, issues), ...uninitialized], issues };
}

/** 重复 id 只保留第一份；重复 id 本身由 `validate.ts` 报 `duplicate_id`，这里不为它造二义顺序。 */
function uniqueDeclarations(declarations: readonly VarDeclNode[]): readonly VarDeclNode[] {
  const seen = new Set<string>();
  const unique: VarDeclNode[] = [];
  for (const decl of declarations) {
    if (seen.has(decl.id)) continue;
    seen.add(decl.id);
    unique.push(decl);
  }
  return unique;
}

/** 反复按文档顺序扫：每轮发出所有依赖已就位的声明，排不动时剩下的必定在环上。 */
function topologicalOrder(
  declarations: readonly VarDeclNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  issues: CanvasIssue[],
): readonly VarDeclNode[] {
  const pending = new Map<string, VarDeclNode>();
  for (const decl of declarations) pending.set(decl.id, decl);

  const order: VarDeclNode[] = [];
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const decl of declarations) {
      if (!pending.has(decl.id)) continue;
      if (hasPendingDependency(dependencies.get(decl.id), pending)) continue;
      pending.delete(decl.id);
      order.push(decl);
      progressed = true;
    }
  }

  if (pending.size === 0) return order;

  reportCycles(declarations, dependencies, pending, issues);
  for (const decl of declarations) {
    if (pending.has(decl.id)) order.push(decl);
  }
  return order;
}

function hasPendingDependency(
  dependencies: ReadonlySet<string> | undefined,
  pending: ReadonlyMap<string, VarDeclNode>,
): boolean {
  if (dependencies === undefined) return false;
  for (const id of dependencies) {
    if (pending.has(id)) return true;
  }
  return false;
}

/** 每个强连通分量报一条：同一组名字都写进文案，节点定位到组里文档顺序的第一条。 */
function reportCycles(
  declarations: readonly VarDeclNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  pending: ReadonlyMap<string, VarDeclNode>,
  issues: CanvasIssue[],
): void {
  for (const group of cycleGroups(declarations, dependencies, pending)) {
    issues.push(errorIssue('variable_error', group[0].id, cycleMessage(group)));
  }
}

/** 待处理里真正处在环上的声明：互相可达的归为一组，组内保持文档顺序。 */
function cycleGroups(
  declarations: readonly VarDeclNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  pending: ReadonlyMap<string, VarDeclNode>,
): readonly (readonly VarDeclNode[])[] {
  const reachable = new Map<string, ReadonlySet<string>>();
  for (const id of pending.keys()) reachable.set(id, reachableFrom(id, dependencies, pending));

  const groups: (readonly VarDeclNode[])[] = [];
  const grouped = new Set<string>();
  for (const decl of declarations) {
    if (!pending.has(decl.id) || grouped.has(decl.id)) continue;
    const own = reachable.get(decl.id);
    if (own === undefined || !own.has(decl.id)) continue;
    const group = declarations.filter(
      (other) => pending.has(other.id) && own.has(other.id) && reachable.get(other.id)?.has(decl.id) === true,
    );
    for (const member of group) grouped.add(member.id);
    groups.push(group);
  }
  return groups;
}

/** 从 `startId` 的依赖出发、只走 `scope` 里的节点能到达谁（用于找同一强连通分量）。 */
function reachableFrom(
  startId: string,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  scope: ReadonlyMap<string, VarDeclNode>,
): ReadonlySet<string> {
  const reachedIds = new Set<string>();
  const queue: string[] = [];
  const push = (ids: ReadonlySet<string> | undefined): void => {
    if (ids === undefined) return;
    for (const id of ids) {
      if (scope.has(id)) queue.push(id);
    }
  };
  push(dependencies.get(startId));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (reachedIds.has(id)) continue;
    reachedIds.add(id);
    push(dependencies.get(id));
  }
  return reachedIds;
}

function cycleMessage(group: readonly VarDeclNode[]): string {
  const names = group.map((decl) => decl.name).join(' 与 ');
  return `变量 ${names} 互相依赖，无法确定初始化顺序`;
}

// ---------------------------------------------------------------------------
// 流程赋值（需求 §3.2）
// ---------------------------------------------------------------------------

/**
 * 被流程赋值写过的声明 id 集合。
 *
 * `target` 先用 `resolveVariable` 解析成声明 id：`var-ref` 作为目标时写的是同一个声明。
 * 解析不到的目标**跳过**——它不是「有人写了变量」，而是错的目标，由 `checkAssignTargets` 报。
 */
export function assignedVariables(document: CanvasDocument, table: VariableTable): ReadonlySet<string> {
  const assigned = new Set<string>();
  for (const node of document.nodes) {
    if (node.kind !== 'assign') continue;
    const decl = resolveVariable(table, node.target);
    if (decl !== undefined) assigned.add(decl.id);
  }
  return assigned;
}

/**
 * 赋值目标合法性：目标不是变量、写派生变量。
 *
 * 值类型**不在这里**查：那是 `validate.ts` 的静态类型推导与执行器的职责，
 * 这里只回答「这一步到底能不能写、写的是不是只读的派生变量」（需求 §3.2）。
 */
export function checkAssignTargets(
  document: CanvasDocument,
  table: VariableTable,
): readonly CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  for (const node of document.nodes) {
    if (node.kind !== 'assign') continue;
    const decl = resolveVariable(table, node.target);
    if (decl === undefined) {
      issues.push(errorIssue('variable_error', node.id, `设置变量的目标「${node.target}」不是变量`));
      continue;
    }
    if (decl.binding.mode === 'derived') {
      issues.push(
        errorIssue('variable_error', node.id, `派生变量 ${decl.name} 只读，不能由流程赋值覆盖；先解除绑定`),
      );
    }
  }
  return issues;
}
