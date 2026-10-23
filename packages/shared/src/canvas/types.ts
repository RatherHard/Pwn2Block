import { groupMembers, nodeMapOf, type CanvasDocument, type CanvasNode } from './document';
import { binaryOperatorSpec, conversionOutputKind, unaryOperatorSpec } from './operators';
import type { ValueKind } from './value';

/**
 * 静态类型推导：只推「值种类」这一层。
 *
 * 列表元素类型、字典取出的值都算「未知（any）」，具体元素类型在求值时检查，
 * 这样异构列表与嵌套集合不需要类型推导入门门槛。
 *
 * 单独成模块是为了断开校验器与流程分析之间的循环依赖：
 * 流程分析要问「这个数据节点的静态类型」，校验器要调流程分析。
 */

/** 静态类型：`'any'` 表示元素级未知。 */
export type StaticType = ValueKind | 'any';

export interface TypeChecker {
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly memo: Map<string, StaticType>;
  readonly visiting: Set<string>;
}

export function createTypeChecker(nodes: ReadonlyMap<string, CanvasNode>): TypeChecker {
  return { nodes, memo: new Map(), visiting: new Set() };
}

/** 一个节点的静态类型；`undefined` 表示因为更早的错误推不出来。 */
export function staticTypeOf(document: CanvasDocument, nodeId: string): StaticType | undefined {
  return inferType(createTypeChecker(nodeMapOf(document)), nodeId);
}

/** 在已建好的推导状态里问一个节点：校验器内部批量检查时复用同一份缓存。 */
export function staticTypeIn(state: TypeChecker, nodeId: string): StaticType | undefined {
  return inferType(state, nodeId);
}

function inferType(state: TypeChecker, nodeId: string): StaticType | undefined {
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

function inferNodeType(state: TypeChecker, node: CanvasNode): StaticType | undefined {
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
    case 'var-ref':
      return declaredKindOf(state, node.decl);
    case 'loop-index':
      return 'int';
    case 'var-decl':
    case 'start':
    case 'if':
    case 'loop':
    case 'method':
    case 'assign':
      // 这些节点没有数据结果；把它们接到数据输入由求值器与校验器报错。
      return undefined;
  }
}

/** 引用视图的类型就是它所指声明的类型：声明类型固定，所以这里能给出精确类型。 */
function declaredKindOf(state: TypeChecker, declId: string): StaticType | undefined {
  const decl = state.nodes.get(declId);
  return decl?.kind === 'var-decl' ? decl.type : undefined;
}

function inferGroupType(
  state: TypeChecker,
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
