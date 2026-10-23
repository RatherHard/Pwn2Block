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
import { dedupeIssues, errorIssue, type CanvasIssue } from './issues';
import { binaryOperatorSpec, conversionInputKind, conversionOutputKind, unaryOperatorSpec } from './operators';
import { VALUE_KIND_LABELS, keyIdentity, keyLabel, type ValueKind } from './value';
import { decodeKey, decodeScalarValue } from './value-codec';

/**
 * 结构与类型校验（需求 §7「结构错误与类型错误阻止生成」）。
 *
 * 校验只做**不依赖具体值**的判断：未知节点、重复 id、归属冲突、数据环、类型不匹配、
 * 合并模式冲突、字典重复键、转换适用性。除零、越界这类要看具体值的错误留给求值阶段，
 * 这样编辑一张还没连完的图不会满屏红色。
 *
 * 类型推导只到**值种类**这一层：列表元素类型、字典取出的值都算「未知（any）」，
 * 具体元素类型在求值时检查。这样异构列表与嵌套集合不需要类型推导入门门槛。
 */

export interface CanvasValidation {
  readonly ok: boolean;
  readonly issues: readonly CanvasIssue[];
}

/** 静态类型：`'any'` 表示元素级未知。 */
export type StaticType = ValueKind | 'any';

export function validateCanvasDocument(document: CanvasDocument): CanvasValidation {
  const issues: CanvasIssue[] = [];
  const nodes = nodeMapOf(document);

  checkDocumentShape(document, issues);
  checkReferences(document, nodes, issues);
  checkOwnership(document, nodes, issues);
  checkCycles(document, nodes, issues);
  checkNodes(nodes, issues);

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

// ---------------------------------------------------------------------------
// 类型推导
// ---------------------------------------------------------------------------

interface TypeState {
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly memo: Map<string, StaticType>;
  readonly visiting: Set<string>;
}

function createTypeState(nodes: ReadonlyMap<string, CanvasNode>): TypeState {
  return { nodes, memo: new Map(), visiting: new Set() };
}

/** 一个节点的静态类型；`undefined` 表示因为更早的错误推不出来。 */
export function staticTypeOf(document: CanvasDocument, nodeId: string): StaticType | undefined {
  return inferType(createTypeState(nodeMapOf(document)), nodeId);
}

function inferType(state: TypeState, nodeId: string): StaticType | undefined {
  const cached = state.memo.get(nodeId);
  if (cached !== undefined) return cached;
  const node = state.nodes.get(nodeId);
  if (node === undefined || state.visiting.has(nodeId)) return undefined;

  state.visiting.add(nodeId);
  const type = inferNodeType(state, node);
  state.visiting.delete(nodeId);
  if (type !== undefined) state.memo.set(nodeId, type);
  return type;
}

function inferNodeType(state: TypeState, node: CanvasNode): StaticType | undefined {
  switch (node.kind) {
    case 'value':
      return node.value.kind;
    case 'group':
      return inferGroupType(state, node);
    case 'dict':
      return 'dict';
    case 'relation':
      return binaryOperatorSpec(node.op).result;
    case 'unary':
      return unaryOperatorSpec(node.op).result;
    case 'index': {
      const target = inferType(state, node.target);
      if (target === 'byte') return 'int';
      if (target === 'string') return 'string';
      if (target === 'list') return 'any';
      return target === 'any' ? 'any' : undefined;
    }
    case 'lookup':
      return 'any';
    case 'slice':
    case 'repeat':
      return inferType(state, node.target);
    case 'convert':
      return conversionOutputKind(node.spec);
  }
}

function inferGroupType(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'group' }>,
): StaticType | undefined {
  const members = groupMembers(node);
  if (members.length === 0) return undefined;
  if (node.mode === 'list') return 'list';

  const types = members.map((member) => inferType(state, member));
  if (types.some((type) => type === undefined)) return undefined;
  const known = types as StaticType[];
  if (known.some((type) => type === 'any')) return 'any';
  const first = known[0] as StaticType;
  if (known.every((type) => type === first) && (first === 'byte' || first === 'string')) return first;
  return undefined;
}

// ---------------------------------------------------------------------------
// 类型校验
// ---------------------------------------------------------------------------

function checkNodes(
  nodes: ReadonlyMap<string, CanvasNode>,
  issues: CanvasIssue[],
): void {
  const state = createTypeState(nodes);
  for (const node of nodes.values()) {
    checkNode(state, node, issues);
  }
}

function checkNode(state: TypeState, node: CanvasNode, issues: CanvasIssue[]): void {
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
  }
}

/** 字面值必须能解码：存档里的 hex / 整数 / 浮点都可能被手工改坏。 */
function checkLiteral(node: Extract<CanvasNode, { kind: 'value' }>, issues: CanvasIssue[]): void {
  const decoded = decodeScalarValue(node.value);
  if (!decoded.ok) issues.push(errorIssue('invalid_value', node.id, decoded.message));
}

function checkGroup(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'group' }>,
  issues: CanvasIssue[],
): void {
  const members = groupMembers(node);
  if (members.length === 0) {
    issues.push(errorIssue('group_empty', node.id, '组合没有任何成员，给不出整体结果'));
    return;
  }
  if (node.mode !== 'merge') return;

  const types = members.map((member) => inferType(state, member));
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
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'relation' }>,
  issues: CanvasIssue[],
): void {
  const spec = binaryOperatorSpec(node.op);
  expectType(state, node, issues, node.left, spec.left, `${spec.label}的左边`);
  expectType(state, node, issues, node.right, spec.right, `${spec.label}的右边`);
}

function checkUnary(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'unary' }>,
  issues: CanvasIssue[],
): void {
  const spec = unaryOperatorSpec(node.op);
  const actual = inferType(state, node.operand);
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
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'index' }>,
  issues: CanvasIssue[],
): void {
  const target = inferType(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'list' && target !== 'byte' && target !== 'string') {
    issues.push(
      errorIssue('type_mismatch', node.id, `按索引取元素只接受列表、字节串和文本，收到${typeLabel(target)}`),
    );
  }
  expectType(state, node, issues, node.index, 'int', '索引');
}

function checkLookup(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'lookup' }>,
  issues: CanvasIssue[],
): void {
  const target = inferType(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'dict') {
    issues.push(errorIssue('type_mismatch', node.id, `按键取值只接受字典，收到${typeLabel(target)}`));
  }
  const key = inferType(state, node.key);
  if (key !== undefined && key !== 'any' && key !== 'int' && key !== 'string') {
    issues.push(errorIssue('type_mismatch', node.id, `字典键只能是整数或文本，收到${typeLabel(key)}`));
  }
}

function checkSlice(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'slice' }>,
  issues: CanvasIssue[],
): void {
  const target = inferType(state, node.target);
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
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'repeat' }>,
  issues: CanvasIssue[],
): void {
  const target = inferType(state, node.target);
  if (target !== undefined && target !== 'any' && target !== 'list' && target !== 'byte' && target !== 'string') {
    issues.push(errorIssue('type_mismatch', node.id, `重复只接受列表、字节串和文本，收到${typeLabel(target)}`));
  }
  expectType(state, node, issues, node.count, 'int', '重复次数');
}

function checkConvert(
  state: TypeState,
  node: Extract<CanvasNode, { kind: 'convert' }>,
  issues: CanvasIssue[],
): void {
  const actual = inferType(state, node.input);
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

/** 检查某个输入引用的静态类型；`undefined`/`any` 一律放过（留给求值阶段）。 */
function expectType(
  state: TypeState,
  node: CanvasNode,
  issues: CanvasIssue[],
  inputId: string,
  expected: ValueKind,
  label: string,
): void {
  const actual = inferType(state, inputId);
  if (actual === undefined || actual === 'any' || actual === expected) return;
  issues.push(
    errorIssue('type_mismatch', node.id, `${label}需要${typeLabel(expected)}，收到${typeLabel(actual)}`),
  );
}

function typeLabel(type: StaticType): string {
  return type === 'any' ? '未知类型' : VALUE_KIND_LABELS[type];
}
