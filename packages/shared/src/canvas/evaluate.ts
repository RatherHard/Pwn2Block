import { CANVAS_MAX_BYTES, CANVAS_MAX_EVAL_STEPS, CANVAS_MAX_EXPR_DEPTH, CANVAS_MAX_TEXT_CHARS } from '../limits';
import { indexOf, lookupOf, repeatOf } from './collection';
import { applyConversion } from './convert';
import { CANVAS_NODE_KIND_LABELS, groupMembers, inputIdsOf, isValueNode, nodeMapOf, type CanvasDocument, type CanvasNode } from './document';
import { dedupeIssues, errorIssue, warningIssue, type CanvasIssue, type CanvasIssueCode } from './issues';
import { applyBinary, applyUnary, decidedByLeft } from './ops';
import { binaryOperatorSpec } from './operators';
import { fail, ok, type CanvasResult } from './result';
import { sliceOf } from './slice';
import {
  byteValue,
  checkValue,
  codePointLength,
  dictValue,
  listValue,
  stringValue,
  valueTypeName,
  type DictEntry,
  type Value,
} from './value';
import { decodeKey, decodeScalarValue } from './value-codec';

/**
 * 纯数据表达式求值（需求 §7）。
 *
 * 三条规则：
 * - **按需求值**：只有被用到（是某个根节点的一部分）才计算。布尔「与/或」短路时右侧不求值，
 *   所以右侧里的错误不会冒出来（需求 §2.3、§7「短路跳过的求值不额外触发错误」）。
 * - **记忆化**：同一个节点在被多处引用时只算一次；键是节点 id——阶段一没有作用域与轮次，
 *   等阶段二引入变量与循环再补缓存键。
 * - **错误不抛异常**：每个失败都变成一条带节点 id 的 `CanvasIssue`，失败会沿引用链向上传播，
 *   但不阻止其它根节点继续求值，便于一次报出多处问题。
 *
 * 「根」是没被任何节点引用的节点：用户单独摆一个数据节点时它就是根，拿得到预览；
 * 被别的节点引用的节点会随消费者一起算出来。
 */

/** 一次求值的可选覆盖项（测试用，生产走 `limits.ts` 的默认预算）。 */
export interface CanvasEvalOptions {
  readonly maxSteps?: number;
  /** 执行状态：变量值与循环索引。不传时读到变量就变成「待执行」。 */
  readonly scope?: CanvasEvalScope;
}

/**
 * 执行状态的外部供给（阶段二）：变量值与循环索引。
 *
 * 编辑期（预览）只给初始值、不给流程态，读不到就变成 `pending` 警告而不是错误；
 * 执行期由流程解释器提供完整状态，读不到就是真错误（未初始化、越出作用域）。
 */
export interface CanvasEvalScope {
  readonly mode: 'preview' | 'execute';
  /** 读一个变量声明当前的值。 */
  readonly readVariable: (declId: string) => CanvasResult<Value>;
  /** 读某个循环当前的只读索引；不在该循环体内时返回失败。 */
  readonly readLoopIndex: (loopId: string) => CanvasResult<Value>;
}

export interface EvaluateOutcome {
  /** 是否全部求值成功；有 error 级问题即为假。 */
  readonly ok: boolean;
  /** 求值成功的节点 → 值（供预览与后续流程使用）。 */
  readonly values: ReadonlyMap<string, Value>;
  readonly issues: readonly CanvasIssue[];
}

type NodeResult =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly code: CanvasIssueCode;
      readonly message: string;
      /** 真正出问题的节点：沿引用链传播时保持不变，界面据此高亮。 */
      readonly originId: string;
    };

interface EvalState {
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly values: Map<string, Value>;
  readonly visiting: Set<string>;
  readonly issues: CanvasIssue[];
  steps: number;
  depth: number;
  readonly maxSteps: number;
  readonly scope: CanvasEvalScope | undefined;
}

function nodeOk(value: Value): NodeResult {
  return { ok: true, value };
}

function nodeFail(originId: string, code: CanvasIssueCode, message: string): NodeResult {
  return { ok: false, code, message, originId };
}

/** 把语义模块的 `CanvasResult` 失败折成 `eval_failed`：求值阶段的失败都归到这一类。 */
function fromResult(originId: string, result: CanvasResult<Value>): NodeResult {
  if (result.ok) return nodeOk(result.value);
  return nodeFail(originId, 'eval_failed', result.message);
}

/** 容量检查：越界归到 `limit_exceeded`，让界面能与语法错误分开提示。 */
function limitChecked(originId: string, value: Value): NodeResult {
  const reason = checkValue(value);
  return reason === undefined ? nodeOk(value) : nodeFail(originId, 'limit_exceeded', reason);
}

function createState(document: CanvasDocument, options: CanvasEvalOptions | undefined): EvalState {
  return {
    nodes: nodeMapOf(document),
    values: new Map(),
    visiting: new Set(),
    issues: [],
    steps: 0,
    depth: 0,
    maxSteps: options?.maxSteps ?? CANVAS_MAX_EVAL_STEPS,
    scope: options?.scope,
  };
}

/**
 * 求一个节点。返回值里的 `originId` 指向真正失败的那一层：
 * 组合的某个成员失败时，报错定位到成员而不是整个组。
 */
function evalById(state: EvalState, id: string): NodeResult {
  const cached = state.values.get(id);
  if (cached !== undefined) return nodeOk(cached);

  if (state.visiting.has(id)) {
    return nodeFail(id, 'input_cycle', `数据引用成环：${id} 又绕回了自己`);
  }

  const node = state.nodes.get(id);
  if (node === undefined) {
    return nodeFail(id, 'unknown_node', `引用的节点 ${id} 不存在`);
  }

  state.steps += 1;
  if (state.steps > state.maxSteps) {
    return nodeFail(
      id,
      'limit_exceeded',
      `求值超过上限 ${state.maxSteps} 步，把表达式拆小一些`,
    );
  }

  state.visiting.add(id);
  state.depth += 1;
  // 深度与步数分开限：一条又深又窄的链先撞深度上限，而一串并排的根先撞步数上限。
  const result =
    state.depth > CANVAS_MAX_EXPR_DEPTH
      ? nodeFail(id, 'limit_exceeded', `表达式嵌套超过 ${CANVAS_MAX_EXPR_DEPTH} 层，把表达式拆小一些`)
      : computeNode(state, node);
  state.depth -= 1;
  state.visiting.delete(id);

  if (result.ok) {
    state.values.set(id, result.value);
    return result;
  }
  // 「待执行」是编辑期的状态提示，不是错误：它不影响其他根继续求值，也不阻止生成。
  const issue =
    result.code === 'pending'
      ? warningIssue('pending', result.originId, result.message)
      : errorIssue(result.code, result.originId, result.message);
  state.issues.push(issue);
  return result;
}

function computeNode(state: EvalState, node: CanvasNode): NodeResult {
  switch (node.kind) {
    case 'value':
      return computeValue(node);
    case 'group':
      return computeGroup(state, node);
    case 'dict':
      return computeDict(state, node);
    case 'relation':
      return computeRelation(state, node);
    case 'unary':
      return computeUnary(state, node);
    case 'index':
      return computeIndex(state, node);
    case 'lookup':
      return computeLookup(state, node);
    case 'slice':
      return computeSlice(state, node);
    case 'repeat':
      return computeRepeat(state, node);
    case 'convert':
      return computeConvert(state, node);
    case 'var-ref':
      return computeVarRef(state, node);
    case 'loop-index':
      return computeLoopIndex(state, node);
    case 'var-decl':
    case 'start':
    case 'if':
    case 'loop':
    case 'method':
    case 'assign':
      return nodeFail(node.id, 'type_mismatch', `「${CANVAS_NODE_KIND_LABELS[node.kind]}」没有数据结果，不能接到数据输入`);
  }
}

/** 变量读取：值来自执行状态；编辑期没有流程态时变成「待执行」。 */
function computeVarRef(state: EvalState, node: Extract<CanvasNode, { kind: 'var-ref' }>): NodeResult {
  const scope = state.scope;
  if (scope === undefined) {
    return nodeFail(node.id, 'pending', '依赖执行状态，待执行');
  }
  const read = scope.readVariable(node.decl);
  if (!read.ok) {
    return nodeFail(node.id, scope.mode === 'preview' ? 'pending' : 'variable_error', read.message);
  }
  return limitChecked(node.id, read.value);
}

/** 循环索引：只在所属循环体内有值，越界就是错误（需求 §5.3）。 */
function computeLoopIndex(state: EvalState, node: Extract<CanvasNode, { kind: 'loop-index' }>): NodeResult {
  const scope = state.scope;
  if (scope === undefined) {
    return nodeFail(node.id, 'pending', '循环索引只能在循环体内使用，待执行');
  }
  const read = scope.readLoopIndex(node.loop);
  if (!read.ok) {
    return nodeFail(node.id, scope.mode === 'preview' ? 'pending' : 'variable_error', read.message);
  }
  return limitChecked(node.id, read.value);
}

function computeValue(node: Extract<CanvasNode, { kind: 'value' }>): NodeResult {
  const decoded = decodeScalarValue(node.value);
  if (!decoded.ok) return nodeFail(node.id, 'invalid_value', decoded.message);
  return nodeOk(decoded.value);
}

function computeGroup(state: EvalState, node: Extract<CanvasNode, { kind: 'group' }>): NodeResult {
  const members = groupMembers(node);
  if (members.length === 0) {
    return nodeFail(node.id, 'group_empty', '组合没有任何成员，给不出整体结果');
  }

  const values: Value[] = [];
  for (const member of members) {
    const result = evalById(state, member);
    if (!result.ok) return result;
    values.push(result.value);
  }

  if (node.mode === 'list') {
    return limitChecked(node.id, listValue(values));
  }
  return mergeValues(node.id, values);
}

/**
 * 合并为串（需求 §2.2）：全字节串合并为字节串、全文本合并为文本，其余一律报错，
 * **不自动改成列表**、也不插入任何分隔符或换行 —— 折行只是排版。
 */
function mergeValues(originId: string, values: readonly Value[]): NodeResult {
  const first = values[0] as Value;
  const mismatchIndex = values.findIndex((value) => value.kind !== first.kind);
  if (mismatchIndex >= 0) return mergeConflict(originId, values, mismatchIndex, first);

  if (first.kind === 'byte') {
    const parts: Uint8Array[] = [];
    for (const value of values) {
      if (value.kind !== 'byte') return mergeConflict(originId, values, 0, first);
      parts.push(value.bytes);
    }
    return concatBytes(originId, parts);
  }

  if (first.kind === 'string') {
    const parts: string[] = [];
    for (const value of values) {
      if (value.kind !== 'string') return mergeConflict(originId, values, 0, first);
      parts.push(value.value);
    }
    return concatText(originId, parts);
  }

  // 整数、浮点、布尔可以组成列表，但「合并为串」只定义了字节串与文本。
  return nodeFail(
    originId,
    'group_mode_conflict',
    `合并为串只支持全字节串或全文本，这一组的成员是${valueTypeName(first)}；改成「组成列表」`,
  );
}

function mergeConflict(originId: string, values: readonly Value[], index: number, first: Value): NodeResult {
  const mismatched = values[index] as Value;
  return nodeFail(
    originId,
    'group_mode_conflict',
    `合并为串要求成员类型一致：第 ${index + 1} 项是${valueTypeName(mismatched)}，第 1 项是${valueTypeName(first)}；改成「组成列表」或先逐项转换`,
  );
}

/** 拼接字节：先算总长再分配，超限直接报错，不先申请一大块内存。 */
function concatBytes(originId: string, parts: readonly Uint8Array[]): NodeResult {
  let total = 0;
  for (const part of parts) total += part.length;
  if (total > CANVAS_MAX_BYTES) {
    return nodeFail(originId, 'limit_exceeded', `合并后的字节串 ${total} 字节超过上限 ${CANVAS_MAX_BYTES}`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return nodeOk(byteValue(out));
}

/** 拼接文本：按码点核对长度上限，再一次性 join。 */
function concatText(originId: string, parts: readonly string[]): NodeResult {
  let total = 0;
  for (const part of parts) total += codePointLength(part);
  if (total > CANVAS_MAX_TEXT_CHARS) {
    return nodeFail(originId, 'limit_exceeded', `合并后的文本 ${total} 个码点超过上限 ${CANVAS_MAX_TEXT_CHARS}`);
  }
  return nodeOk(stringValue(parts.join('')));
}

function computeDict(state: EvalState, node: Extract<CanvasNode, { kind: 'dict' }>): NodeResult {
  const entries: DictEntry[] = [];
  for (const entry of node.entries) {
    const key = decodeKey(entry.key);
    if (!key.ok) return nodeFail(node.id, 'invalid_value', key.message);
    const value = evalById(state, entry.value);
    if (!value.ok) return value;
    entries.push({ key: key.value, value: value.value });
  }
  const dict = dictValue(entries);
  if (!dict.ok) return nodeFail(node.id, 'dict_duplicate_key', dict.message);
  return limitChecked(node.id, dict.value);
}

function computeRelation(state: EvalState, node: Extract<CanvasNode, { kind: 'relation' }>): NodeResult {
  const spec = binaryOperatorSpec(node.op);
  const left = evalById(state, node.left);
  if (!left.ok) return left;

  // 短路：左侧已经决定结果时右侧不求值，右侧里的错误不会冒出来。
  if (spec.shortCircuit === true) {
    const decided = decidedByLeft(node.op, left.value);
    if (decided !== undefined) return nodeOk(decided);
  }

  const right = evalById(state, node.right);
  if (!right.ok) return right;
  return fromResult(node.id, applyBinary(node.op, left.value, right.value));
}

function computeUnary(state: EvalState, node: Extract<CanvasNode, { kind: 'unary' }>): NodeResult {
  const operand = evalById(state, node.operand);
  if (!operand.ok) return operand;
  return fromResult(node.id, applyUnary(node.op, operand.value));
}

function computeIndex(state: EvalState, node: Extract<CanvasNode, { kind: 'index' }>): NodeResult {
  const target = evalById(state, node.target);
  if (!target.ok) return target;
  const index = evalById(state, node.index);
  if (!index.ok) return index;
  return fromResult(node.id, indexOf(target.value, index.value));
}

function computeLookup(state: EvalState, node: Extract<CanvasNode, { kind: 'lookup' }>): NodeResult {
  const target = evalById(state, node.target);
  if (!target.ok) return target;
  const key = evalById(state, node.key);
  if (!key.ok) return key;
  return fromResult(node.id, lookupOf(target.value, key.value));
}

function computeSlice(state: EvalState, node: Extract<CanvasNode, { kind: 'slice' }>): NodeResult {
  const target = evalById(state, node.target);
  if (!target.ok) return target;

  const start = evalOptional(state, node.start);
  if (!start.ok) return start.failure;
  const end = evalOptional(state, node.end);
  if (!end.ok) return end.failure;
  const step = evalOptional(state, node.step);
  if (!step.ok) return step.failure;

  return fromResult(
    node.id,
    sliceOf(target.value, { start: start.value, end: end.value, step: step.value }),
  );
}

function computeRepeat(state: EvalState, node: Extract<CanvasNode, { kind: 'repeat' }>): NodeResult {
  const target = evalById(state, node.target);
  if (!target.ok) return target;
  const count = evalById(state, node.count);
  if (!count.ok) return count;
  return fromResult(node.id, repeatOf(target.value, count.value));
}

function computeConvert(state: EvalState, node: Extract<CanvasNode, { kind: 'convert' }>): NodeResult {
  const input = evalById(state, node.input);
  if (!input.ok) return input;
  if (input.value.kind === 'dict') {
    return nodeFail(node.id, 'conversion_unsupported', '字典不参与类型转换：先把要用的值取出来再转换');
  }
  return fromResult(node.id, applyConversion(input.value, node.spec));
}

/** 可选边界：没写就是 `undefined`，写了就求值；失败时把上游失败原样交给调用方向上传播。 */
type OptionalValue =
  | { readonly ok: true; readonly value: Value | undefined }
  | { readonly ok: false; readonly failure: Extract<NodeResult, { ok: false }> };

function evalOptional(state: EvalState, id: string | undefined): OptionalValue {
  if (id === undefined) return { ok: true, value: undefined };
  const result = evalById(state, id);
  return result.ok ? { ok: true, value: result.value } : { ok: false, failure: result };
}

/**
 * 求整份文档。根节点是「没有被任何节点引用」的**数据**节点；
 * 每个根独立求值，一处失败不影响其它根。变量与流程节点没有数据结果，不当根。
 */
export function evaluateCanvasDocument(
  document: CanvasDocument,
  options?: CanvasEvalOptions,
): EvaluateOutcome {
  const state = createState(document, options);

  const referenced = new Set<string>();
  for (const node of document.nodes) {
    for (const id of inputIdsOf(node)) referenced.add(id);
  }

  for (const node of document.nodes) {
    if (!isValueNode(node)) continue;
    if (!referenced.has(node.id)) evalById(state, node.id);
  }

  const issues = dedupeIssues(state.issues);
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    values: state.values,
    issues,
  };
}

/** 单节点预览：只算这一个节点及其上游，不要求它是根，也不产出问题列表。 */
export function evaluateCanvasNode(
  document: CanvasDocument,
  nodeId: string,
  options?: CanvasEvalOptions,
): CanvasResult<Value> {
  const state = createState(document, options);
  const result = evalById(state, nodeId);
  return result.ok ? ok(result.value) : fail(result.message);
}
