import { CANVAS_MAX_NODES } from '../limits';
import {
  CANVAS_NODE_ID_RE,
  CANVAS_NODE_KINDS,
  groupMembers,
  inputIdsOf,
  nodeMapOf,
  type CanvasDocument,
  type CanvasNode,
} from './document';
import { analyzeFlow } from './flow';
import { dedupeIssues, errorIssue, type CanvasIssue } from './issues';
import type { CanvasMethodDecl } from './methods';
import { binaryOperatorSpec, conversionInputKind, unaryOperatorSpec } from './operators';
import { VALUE_KIND_LABELS, keyIdentity, keyLabel, type ValueKind } from './value';
import { decodeKey, decodeScalarValue } from './value-codec';
import {
  checkAssignTargets,
  checkVariableDeclarations,
  initializationOrder,
  resolveVariable,
  variableTableOf,
} from './variables';
import {
  createTypeChecker,
  staticTypeIn,
  type StaticType,
  type TypeChecker,
} from './types';

/**
 * 结构与类型校验（需求 §7「结构错误与类型错误阻止生成」）。
 *
 * 校验只做**不依赖具体值**的判断：未知节点、重复 id、归属冲突、数据环、类型不匹配、
 * 合并模式冲突、字典重复键、转换适用性、变量声明与依赖、流程序列与作用域、方法签名。
 * 除零、越界这类要看具体值的错误留给求值阶段，这样编辑一张还没连完的图不会满屏红色。
 *
 * 类型推导只到**值种类**这一层，实现放在 `./types`（流程分析也要问类型，放这里会成环）。
 */

export interface CanvasValidation {
  readonly ok: boolean;
  readonly issues: readonly CanvasIssue[];
}

export interface CanvasValidationOptions {
  /** 题目声明的方法目录；给了才校验方法节点的名字与参数。 */
  readonly methods?: readonly CanvasMethodDecl[];
}

export function validateCanvasDocument(
  document: CanvasDocument,
  options?: CanvasValidationOptions,
): CanvasValidation {
  const issues: CanvasIssue[] = [];
  const nodes = nodeMapOf(document);
  const table = variableTableOf(document);

  checkDocumentShape(document, issues);
  checkReferences(document, nodes, issues);
  checkOwnership(document, nodes, issues);
  checkCycles(document, nodes, issues);
  checkNodes(nodes, table, issues);

  // 变量层：声明、引用视图、依赖顺序、赋值目标。这类问题与具体值无关，属于「结构」。
  issues.push(...checkVariableDeclarations(table));
  issues.push(...checkAssignTargets(document, table));
  issues.push(...initializationOrder(document, table).issues);

  // 流程层：序列、开始节点、嵌套、循环索引作用域、方法签名。
  issues.push(...analyzeFlow(document, { methods: options?.methods }).issues);

  const deduped = dedupeIssues(issues);
  return { ok: deduped.every((issue) => issue.severity !== 'error'), issues: deduped };
}

function checkDocumentShape(document: CanvasDocument, issues: CanvasIssue[]): void {
  if (document.nodes.length > CANVAS_MAX_NODES) {
    issues.push(
      errorIssue('limit_exceeded', '', `节点数 ${document.nodes.length} 超过上限 ${CANVAS_MAX_NODES}`),
    );
  }

  const seen = new Set<string>();
  for (const node of document.nodes) {
    if (!CANVAS_NODE_ID_RE.test(node.id)) {
      issues.push(errorIssue('invalid_id', node.id, `节点 id「${node.id}」只能是字母、数字、下划线和连字符`));
    }
    if (seen.has(node.id)) {
      issues.push(errorIssue('duplicate_id', node.id, `节点 id「${node.id}」重复`));
    }
    seen.add(node.id);
    if (!(CANVAS_NODE_KINDS as readonly string[]).includes(node.kind)) {
      issues.push(errorIssue('unknown_kind', node.id, `未知节点类型：${String(node.kind)}`));
    }
  }
}

/** 引用必须指向存在的节点；节点不能直接引用自己。 */
function checkReferences(
  document: CanvasDocument,
  nodes: ReadonlyMap<string, CanvasNode>,
  issues: CanvasIssue[],
): void {
  for (const node of document.nodes) {
    for (const id of inputIdsOf(node)) {
      if (id === node.id) {
        issues.push(errorIssue('self_reference', node.id, `节点「${node.id}」引用了自己`));
        continue;
      }
      if (!nodes.has(id)) {
        issues.push(errorIssue('unknown_node', node.id, `节点「${node.id}」引用的 ${id} 不存在`));
      }
    }
  }
}

/** 一个节点最多属于一个组合：包络/组合不能交叉占有（需求 §4.1）。 */
function checkOwnership(
  document: CanvasDocument,
  nodes: ReadonlyMap<string, CanvasNode>,
  issues: CanvasIssue[],
): void {
  const owner = new Map<string, string>();
  for (const node of document.nodes) {
    if (node.kind !== 'group') continue;
    for (const member of groupMembers(node)) {
      if (member === node.id) {
        issues.push(errorIssue('self_reference', node.id, `组合「${node.id}」把自己当成了成员`));
        continue;
      }
      if (!nodes.has(member)) {
        issues.push(errorIssue('unknown_node', node.id, `组合「${node.id}」的成员 ${member} 不存在`));
        continue;
      }
      const previous = owner.get(member);
      if (previous !== undefined && previous !== node.id) {
        issues.push(
          errorIssue(
            'ownership_conflict',
            member,
            `节点「${member}」同时属于组合「${previous}」和「${node.id}」；一个节点只能归属一个容器`,
          ),
        );
        continue;
      }
      owner.set(member, node.id);
    }
  }
}

function checkCycles(
  document: CanvasDocument,
  nodes: ReadonlyMap<string, CanvasNode>,
  issues: CanvasIssue[],
): void {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      issues.push(errorIssue('input_cycle', id, `数据引用成环：${id} 又绕回了自己`));
      return;
    }
    const node = nodes.get(id);
    if (node === undefined) return;
    visiting.add(id);
    for (const next of inputIdsOf(node)) {
      if (nodes.has(next)) visit(next);
    }
    visiting.delete(id);
    done.add(id);
  };

  for (const node of document.nodes) visit(node.id);
}

// 类型推导在 `./types`：流程分析也要问静态类型，放在这里会和流程校验互相 import 成环。
export { staticTypeOf } from './types';
export type { StaticType } from './types';

// ---------------------------------------------------------------------------
// 类型校验
// ---------------------------------------------------------------------------

function checkNodes(
  nodes: ReadonlyMap<string, CanvasNode>,
  table: ReturnType<typeof variableTableOf>,
  issues: CanvasIssue[],
): void {
  const state = createTypeChecker(nodes);
  for (const node of nodes.values()) {
    checkNode(state, table, node, issues);
  }
}

function checkNode(
  state: TypeChecker,
  table: ReturnType<typeof variableTableOf>,
  node: CanvasNode,
  issues: CanvasIssue[],
): void {
  switch (node.kind) {
    case 'value':
      checkLiteral(node, issues);
      return;
    case 'group':
      checkGroup(state, node, issues);
      return;
    case 'dict':
      checkDictEntries(node, issues);
      return;
    case 'relation':
      checkRelation(state, node, issues);
      return;
    case 'unary':
      checkUnary(state, node, issues);
      return;
    case 'index':
      checkIndex(state, node, issues);
      return;
    case 'lookup':
      checkLookup(state, node, issues);
      return;
    case 'slice':
      checkSlice(state, node, issues);
      return;
    case 'repeat':
      checkRepeat(state, node, issues);
      return;
    case 'convert':
      checkConvert(state, node, issues);
      return;
    case 'var-decl':
      checkVarDecl(state, node, issues);
      return;
    case 'assign':
      checkAssign(state, table, node, issues);
      return;
    case 'method':
      // 方法签名由流程分析按题目声明校验（`analyzeFlow`）。
      return;
    case 'loop':
      expectType(state, node, issues, node.count, 'int', '循环次数');
      return;
    case 'if':
      expectType(state, node, issues, node.cond, 'bool', '条件');
      return;
    case 'var-ref':
    case 'loop-index':
    case 'start':
      // 引用指向、作用域与序列归属分别由变量层与流程层负责。
      return;
  }
}

/** 字面值必须能解码：存档里的 hex / 整数 / 浮点都可能被手工改坏。 */
function checkLiteral(node: Extract<CanvasNode, { kind: 'value' }>, issues: CanvasIssue[]): void {
  const decoded = decodeScalarValue(node.value);
  if (!decoded.ok) issues.push(errorIssue('invalid_value', node.id, decoded.message));
}

function checkGroup(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'group' }>,
  issues: CanvasIssue[],
): void {
  const members = groupMembers(node);
  if (members.length === 0) {
    issues.push(errorIssue('group_empty', node.id, '组合没有任何成员，给不出整体结果'));
    return;
  }
  if (node.mode !== 'merge') return;

  const types = members.map((member) => staticTypeIn(state, member));
  const known = types.filter((type): type is StaticType => type !== undefined);
  if (known.length !== types.length) return;

  const first = known[0] as StaticType;
  const mismatch = known.findIndex((type) => type !== first && type !== 'any' && first !== 'any');
  if (mismatch >= 0) {
    issues.push(
      errorIssue(
        'group_mode_conflict',
        node.id,
        `合并为串要求成员类型一致：第 ${mismatch + 1} 项是${typeLabel(known[mismatch] as StaticType)}，第 1 项是${typeLabel(first)}；改成「组成列表」或先逐项转换`,
      ),
    );
    return;
  }
  if (first !== 'any' && first !== 'byte' && first !== 'string') {
    issues.push(
      errorIssue(
        'group_mode_conflict',
        node.id,
        `合并为串只支持全字节串或全文本，这一组的成员是${typeLabel(first)}；改成「组成列表」`,
      ),
    );
  }
}

function checkDictEntries(node: Extract<CanvasNode, { kind: 'dict' }>, issues: CanvasIssue[]): void {
  const seen = new Set<string>();
  for (const entry of node.entries) {
    const key = decodeKey(entry.key);
    if (!key.ok) {
      issues.push(errorIssue('invalid_value', node.id, key.message));
      continue;
    }
    const identity = keyIdentity(key.value);
    if (seen.has(identity)) {
      issues.push(errorIssue('dict_duplicate_key', node.id, `字典键 ${keyLabel(key.value)} 重复，必须唯一`));
    }
    seen.add(identity);
  }
}

function checkRelation(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'relation' }>,
  issues: CanvasIssue[],
): void {
  const spec = binaryOperatorSpec(node.op);
  expectType(state, node, issues, node.left, spec.left, `${spec.label}的左边`);
  expectType(state, node, issues, node.right, spec.right, `${spec.label}的右边`);
}

function checkUnary(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'unary' }>,
  issues: CanvasIssue[],
): void {
  const spec = unaryOperatorSpec(node.op);
  const actual = staticTypeIn(state, node.operand);
  if (actual === undefined || actual === 'any' || spec.accepts.includes(actual)) return;
  issues.push(
    errorIssue(
      'type_mismatch',
      node.id,
      `「${spec.label}」只接受${spec.accepts.map(typeLabel).join('、')}，收到${typeLabel(actual)}`,
    ),
  );
}

function checkIndex(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'index' }>,
  issues: CanvasIssue[],
): void {
  const target = staticTypeIn(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'list' && target !== 'byte' && target !== 'string') {
    issues.push(
      errorIssue('type_mismatch', node.id, `按索引取元素只接受列表、字节串和文本，收到${typeLabel(target)}`),
    );
  }
  expectType(state, node, issues, node.index, 'int', '索引');
}

function checkLookup(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'lookup' }>,
  issues: CanvasIssue[],
): void {
  const target = staticTypeIn(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'dict') {
    issues.push(errorIssue('type_mismatch', node.id, `按键取值只接受字典，收到${typeLabel(target)}`));
  }
  const key = staticTypeIn(state, node.key);
  if (key !== undefined && key !== 'any' && key !== 'int' && key !== 'string') {
    issues.push(errorIssue('type_mismatch', node.id, `字典键只能是整数或文本，收到${typeLabel(key)}`));
  }
}

function checkSlice(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'slice' }>,
  issues: CanvasIssue[],
): void {
  const target = staticTypeIn(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'list' && target !== 'byte' && target !== 'string') {
    issues.push(errorIssue('type_mismatch', node.id, `切片只接受列表、字节串和文本，收到${typeLabel(target)}`));
  }
  for (const [label, id] of [
    ['开始', node.start],
    ['结束', node.end],
    ['步长', node.step],
  ] as const) {
    if (id !== undefined) expectType(state, node, issues, id, 'int', `切片${label}`);
  }
}

function checkRepeat(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'repeat' }>,
  issues: CanvasIssue[],
): void {
  const target = staticTypeIn(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'list' && target !== 'byte' && target !== 'string') {
    issues.push(errorIssue('type_mismatch', node.id, `重复只接受列表、字节串和文本，收到${typeLabel(target)}`));
  }
  expectType(state, node, issues, node.count, 'int', '重复次数');
}

function checkConvert(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'convert' }>,
  issues: CanvasIssue[],
): void {
  const actual = staticTypeIn(state, node.input);
  if (actual === 'dict') {
    issues.push(errorIssue('conversion_unsupported', node.id, '字典不参与类型转换：先把要用的值取出来再转换'));
    return;
  }
  if (actual === undefined || actual === 'any') return;
  const expected = conversionInputKind(node.spec);
  if (actual === expected) return;
  issues.push(
    errorIssue(
      'type_mismatch',
      node.id,
      `「${node.spec.kind}」需要${typeLabel(expected)}，收到${typeLabel(actual)}`,
    ),
  );
}

/** 变量的初值/派生绑定：表达式静态类型必须等于声明类型（需求 §3.1「固定类型」）。 */
function checkVarDecl(
  state: TypeChecker,
  node: Extract<CanvasNode, { kind: 'var-decl' }>,
  issues: CanvasIssue[],
): void {
  if (node.binding.mode === 'none') return;
  expectType(state, node, issues, node.binding.input, node.type, `变量「${node.name}」的值`);
}

/** 流程赋值：目标变量的类型固定，右值必须对得上；派生变量只读由变量层报。 */
function checkAssign(
  state: TypeChecker,
  table: ReturnType<typeof variableTableOf>,
  node: Extract<CanvasNode, { kind: 'assign' }>,
  issues: CanvasIssue[],
): void {
  const decl = resolveVariable(table, node.target);
  if (decl === undefined) return;
  expectType(state, node, issues, node.value, decl.type, `赋值给「${decl.name}」`);
}

/** 检查某个输入引用的静态类型；`undefined`/`any` 一律放过（留给求值阶段）。 */
function expectType(
  state: TypeChecker,
  node: CanvasNode,
  issues: CanvasIssue[],
  inputId: string,
  expected: ValueKind,
  label: string,
): void {
  const actual = staticTypeIn(state, inputId);
  if (actual === undefined || actual === 'any' || actual === expected) return;
  issues.push(
    errorIssue('type_mismatch', node.id, `${label}需要${typeLabel(expected)}，收到${typeLabel(actual)}`),
  );
}

function typeLabel(type: StaticType): string {
  return type === 'any' ? '未知类型' : VALUE_KIND_LABELS[type];
}
