import type { AuthorBlock } from '../challenge';
import { expandBlock, type Action, type BlockAction } from '../actions';
import { MAX_UINT64, bytesToHex, formatHex } from '../hex';
import {
  CANVAS_MAX_ACTIONS,
  CANVAS_MAX_LOOP_ITERATIONS,
  CANVAS_MAX_STEP_SNAPSHOTS,
  CANVAS_MAX_TOTAL_ITERATIONS,
} from '../limits';
import {
  nodeMapOf,
  type AssignNode,
  type CanvasDocument,
  type CanvasNode,
  type IfNode,
  type LoopNode,
  type MethodNode,
  type VarDeclNode,
} from './document';
import { evaluateCanvasNode, type CanvasEvalScope } from './evaluate';
import { dedupeIssues, errorIssue, type CanvasIssue } from './issues';
import {
  METHOD_PARAM_LABELS,
  canvasMethodById,
  canvasMethodsOf,
  type CanvasMethodDecl,
  type CanvasMethodParam,
  type CanvasMethodSource,
} from './methods';
import { fail, ok, type CanvasResult } from './result';
import { VALUE_KIND_LABELS, intValue, valueTypeName, type Value } from './value';
import {
  initializationOrder,
  resolveVariable,
  variableTableOf,
  type VariableTable,
} from './variables';
import { validateCanvasDocument } from './validate';

/**
 * 先求值、再生成动作序列（需求 §5.1、§7）。
 *
 * 执行模型是**解释一遍画布**，不是「VM 跑一步、回头问画布下一步」：
 * - 初始值按依赖顺序求一次；派生变量在每次读取时按当前状态重算（需求 §3.2）。
 * - 流程按 `main` 与各区域的**数组顺序**走；循环把索引压进作用域，跑完即弹出（需求 §5.3）。
 * - 方法节点在求值到它时把参数值**固定**成动作参数，之后变量再变也不改已生成动作（需求 §5.4）。
 * - 任何一步失败就整体失败，**不发布部分动作**（需求 §7）；失败原因定位到具体节点。
 *
 * 生成结果里除了动作，还留一份步骤快照：每一步之后各普通变量的值、这一步读到的数据值、
 * 以及所在循环的轮次。它只在前端内存里用（「按步骤和循环轮次查看当时的值」，需求 §7），
 * 不上行到服务端。
 */

/** 一个变量在某一步的值（快照用）。 */
export interface CanvasVariableView {
  readonly name: string;
  readonly value: Value;
}

/** 这一步读到的数据值（方法参数或赋值右值），用于「当时的值」展示。 */
export interface CanvasInputView {
  readonly name: string;
  readonly value: Value;
}

export interface CanvasStep {
  /** 步骤序号：赋值与方法都算一步，从 0 开始。 */
  readonly step: number;
  /** 产生这一步的节点 id（赋值或方法节点）。 */
  readonly nodeId: string;
  readonly kind: 'assign' | 'action';
  /** `kind === 'action'` 时是动作在 `actions` 里的下标。 */
  readonly actionIndex: number | null;
  /** 当时各循环的轮次（循环节点 id → 从 0 开始）。 */
  readonly rounds: Readonly<Record<string, number>>;
  /** 这一步读到的数据值。 */
  readonly inputs: readonly CanvasInputView[];
  /** 这一步执行后，各已初始化普通变量的值。 */
  readonly variables: readonly CanvasVariableView[];
}

export interface CanvasActionSequence {
  /** 交给服务端的动作。阶段二只产出 `block`（方法）；展开仍由服务端完成。 */
  readonly actions: readonly Action[];
  readonly steps: readonly CanvasStep[];
}

export interface CanvasGenerateOptions {
  /** 题目声明：方法目录与本地展开预检都来自这里（需求 §5.4）。 */
  readonly challenge?: CanvasMethodSource;
  /** 显式方法目录（测试用）；给了就不看 `challenge`。 */
  readonly methods?: readonly CanvasMethodDecl[];
  readonly maxActions?: number;
}

export type CanvasGenerateResult =
  | { readonly ok: true; readonly sequence: CanvasActionSequence }
  | { readonly ok: false; readonly issues: readonly CanvasIssue[] };

interface ExecutionState {
  readonly document: CanvasDocument;
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly table: VariableTable;
  readonly methods: readonly CanvasMethodDecl[];
  readonly authorBlocks: readonly AuthorBlock[] | undefined;
  /** 普通变量当前值。派生变量不进这张表，每次读取重算。 */
  readonly values: Map<string, Value>;
  /** 派生变量的本轮缓存：同一轮里多次读取结果一致，赋值后失效。 */
  readonly derived: Map<string, { readonly epoch: number; readonly value: Value }>;
  /** 正在求值的派生变量：防绑定表达式绕回自己。 */
  readonly reading: Set<string>;
  readonly loops: Map<string, number>;
  readonly actions: Action[];
  readonly steps: CanvasStep[];
  readonly issues: CanvasIssue[];
  epoch: number;
  iterations: number;
  failed: boolean;
  readonly maxActions: number;
}

export function generateCanvasActions(
  document: CanvasDocument,
  options?: CanvasGenerateOptions,
): CanvasGenerateResult {
  const methods = options?.methods ?? canvasMethodsOf(options?.challenge ?? {});
  const authorBlocks = options?.methods === undefined ? options?.challenge?.authorBlocks : undefined;

  // 静态问题（结构、类型、变量、流程、方法签名）先拦：校验不过就不进入执行，
  // 免得把「本来就不该生成」的图跑一半再报错。
  const validation = validateCanvasDocument(document, { methods });
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const state: ExecutionState = {
    document,
    nodes: nodeMapOf(document),
    table: variableTableOf(document),
    methods,
    authorBlocks,
    values: new Map(),
    derived: new Map(),
    reading: new Set(),
    loops: new Map(),
    actions: [],
    steps: [],
    issues: [],
    epoch: 0,
    iterations: 0,
    failed: false,
    maxActions: options?.maxActions ?? CANVAS_MAX_ACTIONS,
  };

  initializeVariables(state);
  if (!state.failed) runSequence(state, document.main);

  if (state.failed) {
    return { ok: false, issues: dedupeIssues(state.issues) };
  }
  return { ok: true, sequence: { actions: state.actions, steps: state.steps } };
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function failAt(state: ExecutionState, nodeId: string, message: string): void {
  state.failed = true;
  state.issues.push(errorIssue('eval_failed', nodeId, message));
}

/** 初始值按依赖顺序求一遍；派生变量保持惰性，未初始化的声明留空（需求 §3.1）。 */
function initializeVariables(state: ExecutionState): void {
  const { order, issues } = initializationOrder(state.document, state.table);
  for (const issue of issues) state.issues.push(issue);
  if (issues.length > 0) {
    state.failed = true;
    return;
  }

  for (const decl of order) {
    if (decl.binding.mode !== 'initial') continue;
    const evaluated = evaluateData(state, decl.binding.input);
    if (!evaluated.ok) {
      failAt(state, decl.id, `变量「${decl.name}」的初始值求值失败：${evaluated.message}`);
      return;
    }
    const mismatch = typeMismatch(decl, evaluated.value);
    if (mismatch !== undefined) {
      failAt(state, decl.id, mismatch);
      return;
    }
    state.values.set(decl.id, evaluated.value);
  }
  state.epoch += 1;
}

/** 一条序列（`main` 或某个区域）按数组顺序执行到底。 */
function runSequence(state: ExecutionState, ids: readonly string[]): void {
  for (const id of ids) {
    if (state.failed) return;
    const node = state.nodes.get(id);
    if (node === undefined) {
      failAt(state, id, `流程引用的节点 ${id} 不存在`);
      return;
    }
    runStatement(state, node);
  }
}

function runStatement(state: ExecutionState, node: CanvasNode): void {
  switch (node.kind) {
    case 'start':
      return;
    case 'assign':
      runAssign(state, node);
      return;
    case 'if':
      runIf(state, node);
      return;
    case 'loop':
      runLoop(state, node);
      return;
    case 'method':
      runMethod(state, node);
      return;
    default:
      failAt(state, node.id, `「${node.kind}」是数据节点，不能出现在流程序列里`);
  }
}

function runAssign(state: ExecutionState, node: AssignNode): void {
  const decl = resolveVariable(state.table, node.target);
  if (decl === undefined) {
    failAt(state, node.id, '设置变量的目标不是一个变量');
    return;
  }
  if (decl.binding.mode === 'derived') {
    failAt(state, node.id, `派生变量「${decl.name}」只读，不能由流程赋值覆盖`);
    return;
  }

  const evaluated = evaluateData(state, node.value);
  if (!evaluated.ok) {
    failAt(state, node.id, `设置「${decl.name}」时求值失败：${evaluated.message}`);
    return;
  }
  const mismatch = typeMismatch(decl, evaluated.value);
  if (mismatch !== undefined) {
    failAt(state, node.id, mismatch);
    return;
  }

  state.values.set(decl.id, evaluated.value);
  state.epoch += 1;
  recordStep(state, node.id, 'assign', null, [{ name: decl.name, value: evaluated.value }]);
}

function runIf(state: ExecutionState, node: IfNode): void {
  const cond = evaluateData(state, node.cond);
  if (!cond.ok) {
    failAt(state, node.id, `条件求值失败：${cond.message}`);
    return;
  }
  if (cond.value.kind !== 'bool') {
    failAt(state, node.id, `条件必须是布尔，收到${valueTypeName(cond.value)}`);
    return;
  }
  runSequence(state, cond.value.value ? node.then : node.else);
}

function runLoop(state: ExecutionState, node: LoopNode): void {
  const count = evaluateData(state, node.count);
  if (!count.ok) {
    failAt(state, node.id, `循环次数求值失败：${count.message}`);
    return;
  }
  if (count.value.kind !== 'int') {
    failAt(state, node.id, `循环次数必须是整数，收到${valueTypeName(count.value)}`);
    return;
  }

  const rounds = count.value.value;
  if (rounds < 0n) {
    failAt(state, node.id, `循环次数不能为负，收到 ${rounds}`);
    return;
  }
  // 超过单循环上限就报错，不悄悄截断（需求 §5.3、limits 的注释）。
  if (rounds > BigInt(CANVAS_MAX_LOOP_ITERATIONS)) {
    failAt(state, node.id, `循环次数 ${rounds} 超过单次上限 ${CANVAS_MAX_LOOP_ITERATIONS}`);
    return;
  }

  const total = Number(rounds);
  for (let round = 0; round < total; round += 1) {
    if (state.failed) return;
    state.iterations += 1;
    if (state.iterations > CANVAS_MAX_TOTAL_ITERATIONS) {
      failAt(state, node.id, `所有循环累计超过 ${CANVAS_MAX_TOTAL_ITERATIONS} 轮，拆小一些`);
      return;
    }
    state.loops.set(node.id, round);
    state.epoch += 1;
    runSequence(state, node.body);
    state.loops.delete(node.id);
  }
}

function runMethod(state: ExecutionState, node: MethodNode): void {
  const method = canvasMethodById(state.methods, node.block);
  if (method === undefined) {
    failAt(state, node.id, `题目没有声明方法 ${node.block}`);
    return;
  }

  const args: Record<string, string> = {};
  const inputs: CanvasInputView[] = [];
  for (const param of method.params) {
    const argumentId = node.args[param.name];
    if (argumentId === undefined) {
      failAt(state, node.id, `方法 ${method.id} 缺少参数 ${param.name}`);
      return;
    }
    const evaluated = evaluateData(state, argumentId);
    if (!evaluated.ok) {
      failAt(state, node.id, `参数 ${param.name} 求值失败：${evaluated.message}`);
      return;
    }
    const encoded = encodeArgument(param, evaluated.value);
    if (!encoded.ok) {
      failAt(state, node.id, encoded.message);
      return;
    }
    args[param.name] = encoded.value;
    inputs.push({ name: param.name, value: evaluated.value });
  }

  const action: BlockAction = { type: 'block', id: method.id, args };
  const rejection = precheckExpansion(state, action);
  if (rejection !== undefined) {
    failAt(state, node.id, rejection);
    return;
  }
  if (state.actions.length >= state.maxActions) {
    failAt(state, node.id, `动作数超过上限 ${state.maxActions}，把流程拆小一些`);
    return;
  }

  state.actions.push(action);
  recordStep(state, node.id, 'action', state.actions.length - 1, inputs);
}

/** 本地先跑一次服务端的展开器：参数形式对、但模板展开必被拒的图在生成期就报出来。 */
function precheckExpansion(state: ExecutionState, action: BlockAction): string | undefined {
  if (state.authorBlocks === undefined) return undefined;
  const expansion = expandBlock({ authorBlocks: state.authorBlocks }, action);
  return expansion.ok ? undefined : `方法参数无法展开：${expansion.detail}`;
}

/** 把画布值按方法参数类型编码成动作参数（口径与旧编译一致：地址/整数用 `0x…`）。 */
function encodeArgument(param: CanvasMethodParam, value: Value): CanvasResult<string> {
  if (param.type === 'bytes') {
    if (value.kind !== 'byte') {
      return fail(`参数 ${param.name} 需要字节串，收到${valueTypeName(value)}`);
    }
    return ok(bytesToHex(value.bytes));
  }
  if (value.kind !== 'int') {
    return fail(`参数 ${param.name} 需要${METHOD_PARAM_LABELS[param.type]}，收到${valueTypeName(value)}`);
  }
  if (value.value < 0n) {
    return fail(`参数 ${param.name} 不能为负，收到 ${value.value}`);
  }
  if (param.type === 'addr' && value.value > MAX_UINT64) {
    return fail(`参数 ${param.name} 是地址，超出 64 位范围：0x${value.value.toString(16)}`);
  }
  return ok(formatHex(value.value));
}

// ---------------------------------------------------------------------------
// 变量读取与步骤快照
// ---------------------------------------------------------------------------

function typeMismatch(decl: VarDeclNode, value: Value): string | undefined {
  if (value.kind === decl.type) return undefined;
  return `变量「${decl.name}」声明为${VALUE_KIND_LABELS[decl.type]}，这里是${valueTypeName(value)}`;
}

function evaluateData(state: ExecutionState, nodeId: string): CanvasResult<Value> {
  return evaluateCanvasNode(state.document, nodeId, { scope: scopeOf(state) });
}

function scopeOf(state: ExecutionState): CanvasEvalScope {
  return {
    mode: 'execute',
    readVariable: (declId) => readVariable(state, declId),
    readLoopIndex: (loopId) => {
      const round = state.loops.get(loopId);
      if (round === undefined) {
        return fail('循环索引只能在所属循环体内取值');
      }
      return ok(intValue(BigInt(round)));
    },
  };
}

function readVariable(state: ExecutionState, declId: string): CanvasResult<Value> {
  const decl = state.table.byId.get(declId);
  if (decl === undefined) return fail(`变量声明 ${declId} 不存在`);
  if (decl.binding.mode !== 'derived') {
    const current = state.values.get(declId);
    return current === undefined
      ? fail(`变量「${decl.name}」还没初始化就读取了；给它初始值，或在读取前先赋值`)
      : ok(current);
  }
  return derivedValue(state, decl);
}

/** 派生绑定：同一轮里缓存，赋值或进入新一轮后重算（需求 §3.2「每次读取使用最新源值」）。 */
function derivedValue(state: ExecutionState, decl: VarDeclNode): CanvasResult<Value> {
  const cached = state.derived.get(decl.id);
  if (cached !== undefined && cached.epoch === state.epoch) return ok(cached.value);
  if (state.reading.has(decl.id)) {
    return fail(`派生变量「${decl.name}」的绑定绕回了自己`);
  }
  if (decl.binding.mode !== 'derived') return fail(`变量「${decl.name}」没有派生绑定`);

  state.reading.add(decl.id);
  const evaluated = evaluateData(state, decl.binding.input);
  state.reading.delete(decl.id);
  if (!evaluated.ok) return evaluated;

  const mismatch = typeMismatch(decl, evaluated.value);
  if (mismatch !== undefined) return fail(mismatch);

  state.derived.set(decl.id, { epoch: state.epoch, value: evaluated.value });
  return ok(evaluated.value);
}

function recordStep(
  state: ExecutionState,
  nodeId: string,
  kind: 'assign' | 'action',
  actionIndex: number | null,
  inputs: readonly CanvasInputView[],
): void {
  if (state.steps.length >= CANVAS_MAX_STEP_SNAPSHOTS) return;
  const rounds: Record<string, number> = {};
  for (const [loopId, round] of state.loops) rounds[loopId] = round;
  state.steps.push({
    step: state.steps.length,
    nodeId,
    kind,
    actionIndex,
    rounds,
    inputs,
    variables: variableViews(state),
  });
}

/** 已初始化普通变量的快照，按声明顺序；派生变量每次读都不一样，不写进快照。 */
function variableViews(state: ExecutionState): readonly CanvasVariableView[] {
  const views: CanvasVariableView[] = [];
  for (const decl of state.table.declarations) {
    const value = state.values.get(decl.id);
    if (value !== undefined) views.push({ name: decl.name, value });
  }
  return views;
}
