import {
  MAX_SUBMIT_ACTIONS,
  NODE,
  nodeRegions,
  nodeSpec,
  WORKFLOW_MAX_LOOP_ITERATIONS,
  WORKFLOW_MAX_TOTAL_ITERATIONS,
} from '@pwn2block/shared';
import type { GraphNode, NodeKindSpec, PortType } from '@pwn2block/shared';
import { childScope, findVar, report, type EvalContext } from './context';
import { makePreview, resolveInput } from './evaluate';
import { inlineValue } from './params';
import type { CompiledAction, CompileTraceEntry, WorkflowOrigin, WorkflowValue } from './types';

/**
 * 控制流与变量的执行（06 §5；07 §P4）。
 *
 * 编译期就把分支、循环和模块展开成一条线性动作序列，所以这里是一个小型解释器：
 * - **结构化**：只有 `if` / `repeat` / `while` 三种容器，子序列在 `regions` 里，没有回边；
 *   非法回边在模型层就不存在，不需要运行时防跳转。
 * - **作用域**：分支和每一轮循环各开一层；`break` / `continue` 只结束最近一层循环，
 *   校验器已经把循环外的用法拦掉了，运行时再报一次以防脏存档。
 * - **预算共享**：每一轮都计一次总轮次、每次动作都受提交上限约束；超限报错并停止，
 *   不发布部分产物（06 §5.3、07 §P1）。
 * - **来源带轮次**：动作来源记录当时所有循环的轮次，便于从 VM 记录定位回画布（06 §8）。
 */

/** 动作出口：编译期把动作、来源、轨迹追加到这三个数组。 */
export interface ExecSink {
  readonly actions: CompiledAction[];
  readonly origins: WorkflowOrigin[];
  readonly trace: CompileTraceEntry[];
}

/** 循环控制信号：由 `break` / `continue` 产生，逐层冒泡到最近的循环。 */
export type FlowSignal = 'break' | 'continue' | undefined;

/** 执行一层序列所需的回调：`compile.ts` 把递归交回来，避免模块互相 import。 */
export interface ControlDeps {
  readonly sink: ExecSink;
  execSequence(ids: readonly string[], path: readonly string[]): Promise<FlowSignal>;
}

const CONTROL_KINDS: ReadonlySet<string> = new Set([
  NODE.if,
  NODE.repeat,
  NODE.while,
  NODE.break,
  NODE.continue,
  NODE.result,
  NODE.varDeclare,
  NODE.varSet,
]);

/** 这个节点是否由本模块执行（而不是走动作生成）。 */
export function isControlKind(kind: string): boolean {
  return CONTROL_KINDS.has(kind);
}

export async function execControl(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  deps: ControlDeps,
): Promise<FlowSignal> {
  switch (node.kind) {
    case NODE.break:
      note(deps, node, path, '跳出最近一层循环');
      return 'break';
    case NODE.continue:
      note(deps, node, path, '跳过本轮剩余语句');
      return 'continue';
    case NODE.result:
      report(ctx, 'result_outside_control', node.id, '「结果」节点只能放在分支或循环体末尾');
      return undefined;
    case NODE.varDeclare:
      await execDeclare(ctx, node, path, deps);
      return undefined;
    case NODE.varSet:
      await execAssign(ctx, node, spec);
      return undefined;
    case NODE.if:
      return execIf(ctx, node, spec, path, deps);
    case NODE.repeat:
      return execRepeat(ctx, node, path, deps);
    case NODE.while:
      return execWhile(ctx, node, path, deps);
    default:
      report(ctx, 'eval_failed', node.id, `节点 ${spec.label} 不是控制流节点`);
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 条件分支
// ---------------------------------------------------------------------------

async function execIf(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  deps: ControlDeps,
): Promise<FlowSignal> {
  const chosen = await chosenBranch(ctx, node, spec);
  if (chosen === undefined) return undefined;
  note(deps, node, path, `分支：走「${chosen.label}」`);

  const run = await runRegion(ctx, node, chosen.region, path, deps);
  if (run.value !== undefined) produce(ctx, node, run.value);
  return run.signal;
}

/** 依次判断「成立」「否则如果 1..N」，都不成立走「否则」。 */
async function chosenBranch(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
): Promise<{ readonly region: string; readonly label: string } | undefined> {
  const cond = await boolInput(ctx, node, 'cond');
  if (cond === undefined) return undefined;
  if (cond) return { region: 'then', label: '成立' };
  const regions = new Map(nodeRegions(spec, node.params).map((region) => [region.name, region.label]));
  for (const [name, label] of regions) {
    if (!name.startsWith('branch')) continue;
    const suffix = name.slice('branch'.length);
    const branchCond = await boolInput(ctx, node, `cond${suffix}`);
    if (branchCond === undefined) return undefined;
    if (branchCond) return { region: name, label };
  }
  return { region: 'else', label: regions.get('else') ?? '否则' };
}

// ---------------------------------------------------------------------------
// 循环
// ---------------------------------------------------------------------------

async function execRepeat(
  ctx: EvalContext,
  node: GraphNode,
  path: readonly string[],
  deps: ControlDeps,
): Promise<FlowSignal> {
  const count = await intInput(ctx, node, 'count');
  if (count === undefined) return undefined;
  if (count < 0n) {
    report(ctx, 'invalid_param', node.id, `重复次数不能为负，收到 ${count}`);
    return undefined;
  }
  const rounds = count > BigInt(WORKFLOW_MAX_LOOP_ITERATIONS) ? WORKFLOW_MAX_LOOP_ITERATIONS : Number(count);
  note(deps, node, path, `循环：${rounds} 轮`);
  return runLoop(ctx, node, path, deps, rounds, () => true);
}

async function execWhile(
  ctx: EvalContext,
  node: GraphNode,
  path: readonly string[],
  deps: ControlDeps,
): Promise<FlowSignal> {
  const mode = node.params.mode === 'until' ? 'until' : 'while';
  note(deps, node, path, mode === 'until' ? '循环：直到条件成立' : '循环：当条件成立');
  return runLoop(ctx, node, path, deps, WORKFLOW_MAX_LOOP_ITERATIONS, async () => {
    const cond = await boolInput(ctx, node, 'cond');
    if (cond === undefined) return undefined;
    return mode === 'until' ? !cond : cond;
  });
}

/**
 * 循环主循环：条件与轮次都先判断后执行。
 *
 * 累计值规则（06 §5.3）：每轮开始把上一轮结果放进 `ctx.accumulators`；轮末的「结果」节点
 * 给出下一轮的累计值。`break` / `continue` 会跳过本轮剩余语句，因此**不更新**累计值，
 * 循环结果停在上一轮的值——这是有意的：提前离开就不该再提交半轮的结果。
 */
async function runLoop(
  ctx: EvalContext,
  node: GraphNode,
  path: readonly string[],
  deps: ControlDeps,
  maxRounds: number,
  shouldRun: () => boolean | undefined | Promise<boolean | undefined>,
): Promise<FlowSignal> {
  const resultType = resultTypeOf(node);
  const accumulated = resultType === 'none' ? undefined : initialValue(ctx, node, resultType);
  if (resultType !== 'none' && accumulated === undefined) return undefined;
  let accumulator = accumulated;

  for (let round = 0; round < maxRounds; round += 1) {
    const run = await shouldRun();
    if (run === undefined) return undefined;
    if (!run) break;
    if (!takeBudget(ctx, node, deps, round)) break;

    const previous = accumulator;
    if (previous !== undefined) ctx.accumulators.set(node.id, previous);
    ctx.loops.set(node.id, round);
    ctx.revision += 1;
    const body = await runRegion(ctx, node, 'body', path, deps);
    if (body.value !== undefined) accumulator = body.value;
    if (body.signal === 'break') break;
    if (body.signal === 'continue') continue;
    if (ctx.issues.length > 0) break;
  }

  ctx.loops.delete(node.id);
  ctx.accumulators.delete(node.id);
  if (accumulator !== undefined) produce(ctx, node, accumulator);
  return undefined;
}

/** 预算检查：单循环轮数、整图总轮次、已生成动作数。超限报一次并停止。 */
function takeBudget(ctx: EvalContext, node: GraphNode, deps: ControlDeps, round: number): boolean {
  ctx.iterations += 1;
  if (round >= WORKFLOW_MAX_LOOP_ITERATIONS) {
    report(
      ctx,
      'limit_exceeded',
      node.id,
      `循环超过单轮上限 ${WORKFLOW_MAX_LOOP_ITERATIONS} 轮，把次数改小一些（06 §5.3）`,
    );
    return false;
  }
  if (ctx.iterations > WORKFLOW_MAX_TOTAL_ITERATIONS) {
    report(
      ctx,
      'limit_exceeded',
      node.id,
      `所有循环累计超过 ${WORKFLOW_MAX_TOTAL_ITERATIONS} 轮，把嵌套循环拆小一些`,
    );
    return false;
  }
  if (deps.sink.actions.length > MAX_SUBMIT_ACTIONS) {
    report(
      ctx,
      'limit_exceeded',
      node.id,
      `循环展开出的动作超过上限 ${MAX_SUBMIT_ACTIONS}，一次提交发不出去（04 §6）`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

async function execDeclare(
  ctx: EvalContext,
  node: GraphNode,
  path: readonly string[],
  deps: ControlDeps,
): Promise<void> {
  const name = nameOf(node);
  if (!VAR_NAME_RE.test(name)) {
    report(ctx, 'invalid_param', node.id, `变量名「${name}」不合法：字母或下划线开头，只含字母、数字、下划线`);
    return;
  }
  if (ctx.scope.vars.has(name)) {
    report(ctx, 'duplicate_variable', node.id, `变量「${name}」在这层作用域里已经声明过了`);
    return;
  }
  const type = typeParamOf(node);
  const value = initialValue(ctx, node, type);
  if (value === undefined) return;
  ctx.scope.vars.set(name, { type, value });
  ctx.revision += 1;
  note(deps, node, path, `声明变量 ${name}（${type}）`);
}

async function execAssign(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
): Promise<void> {
  const name = nameOf(node);
  const type = typeParamOf(node);
  const found = findVar(ctx.scope, name);
  if (found === undefined) {
    report(
      ctx,
      'undeclared_variable',
      node.id,
      `变量「${name || '（未命名）'}」没有声明：先在本层或外层放一个「声明变量」`,
    );
    return;
  }
  if (found.binding.type !== type) {
    report(
      ctx,
      'variable_type_mismatch',
      node.id,
      `变量「${name}」是${found.binding.type}，但这里按${type}设置`,
    );
    return;
  }
  const value = await resolveInput(ctx, node, spec, 'value');
  if (!value.ok) return;
  found.binding.value = value.value;
  ctx.revision += 1;
}

// ---------------------------------------------------------------------------
// 区域执行与结果
// ---------------------------------------------------------------------------

interface RegionRun {
  readonly signal: FlowSignal;
  readonly value?: WorkflowValue;
}

/** 执行一个区域：进新作用域、跑完序列、再读该区域末尾的「结果」（声明了结果才读）。 */
async function runRegion(
  ctx: EvalContext,
  container: GraphNode,
  region: string,
  path: readonly string[],
  deps: ControlDeps,
): Promise<RegionRun> {
  const members = container.regions?.[region] ?? [];
  const regionPath = `${container.id}/${region}`;
  const previous = ctx.scope;
  ctx.scope = childScope(previous, regionPath);
  try {
    const signal = await deps.execSequence(members, [...path, regionPath]);
    const value = resultTypeOf(container) === 'none' ? undefined : await regionResult(ctx, container, members, regionPath);
    return value === undefined ? { signal } : { signal, value };
  } finally {
    ctx.scope = previous;
  }
}

/** 读区域末尾「结果」节点的值；缺了或类型不对都要报出来。 */
async function regionResult(
  ctx: EvalContext,
  container: GraphNode,
  members: readonly string[],
  regionPath: string,
): Promise<WorkflowValue | undefined> {
  const last = members.at(-1);
  const lastNode = last === undefined ? undefined : ctx.lookup.nodes.get(last);
  if (lastNode === undefined || lastNode.kind !== NODE.result) {
    report(
      ctx,
      'missing_region_result',
      container.id,
      `${container.id} 声明了结果，但区域 ${regionPath} 末尾没有「结果」节点（06 §5.2）`,
    );
    return undefined;
  }
  const spec = nodeSpecChecked(lastNode);
  if (spec === undefined) return undefined;
  const value = await resolveInput(ctx, lastNode, spec, 'value');
  if (!value.ok) return undefined;
  const declared = resultTypeOf(container);
  if (value.value.kind !== declared) {
    report(
      ctx,
      'region_result_type_mismatch',
      lastNode.id,
      `区域 ${regionPath} 的结果是${value.value.kind}，但容器声明的是${declared}`,
    );
    return undefined;
  }
  return value.value;
}

/** 容器执行完的结果写进 `produced`：依赖它的数据节点在之后求值时读这里。 */
function produce(ctx: EvalContext, node: GraphNode, value: WorkflowValue): void {
  ctx.produced.set(node.id, value);
  ctx.previews.set(node.id, makePreview(node.id, value, undefined));
}

function note(deps: ControlDeps, node: GraphNode, path: readonly string[], message: string): void {
  if (deps.sink.trace.length >= 256) return;
  deps.sink.trace.push({ nodeId: node.id, path, message });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function boolInput(ctx: EvalContext, node: GraphNode, port: string): Promise<boolean | undefined> {
  const spec = nodeSpecChecked(node);
  if (spec === undefined) return undefined;
  const result = await resolveInput(ctx, node, spec, port);
  if (!result.ok) return undefined;
  if (result.value.kind !== 'bool') {
    report(ctx, 'eval_failed', node.id, `输入 ${port} 需要布尔，收到${result.value.kind}`);
    return undefined;
  }
  return result.value.value;
}

async function intInput(ctx: EvalContext, node: GraphNode, port: string): Promise<bigint | undefined> {
  const spec = nodeSpecChecked(node);
  if (spec === undefined) return undefined;
  const result = await resolveInput(ctx, node, spec, port);
  if (!result.ok) return undefined;
  if (result.value.kind !== 'int') {
    report(ctx, 'eval_failed', node.id, `输入 ${port} 需要整数，收到${result.value.kind}`);
    return undefined;
  }
  return result.value.value;
}

function nodeSpecChecked(node: GraphNode): NodeKindSpec | undefined {
  return nodeSpec(node.kind);
}

function nameOf(node: GraphNode): string {
  return typeof node.params.name === 'string' ? node.params.name.trim() : '';
}

function typeParamOf(node: GraphNode): PortType {
  const raw = node.params.type;
  return raw === 'bool' || raw === 'bytes' || raw === 'text' ? raw : 'int';
}

function resultTypeOf(node: GraphNode): PortType | 'none' {
  const raw = node.params.resultType;
  return raw === 'int' || raw === 'bool' || raw === 'bytes' || raw === 'text' ? raw : 'none';
}

/** 初始值按累计类型解析；字节用十六进制串。解析失败报在节点上。 */
function initialValue(ctx: EvalContext, node: GraphNode, type: PortType): WorkflowValue | undefined {
  const converted = inlineValue(node.params.initial, type);
  if (converted.ok) return converted.value;
  report(ctx, 'invalid_param', node.id, `初始值不对：${converted.message}`);
  return undefined;
}
