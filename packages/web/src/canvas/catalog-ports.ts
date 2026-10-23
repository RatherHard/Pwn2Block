import { canvas } from '@pwn2block/shared';

/**
 * 端口类型：端口**名字与标签**由 `shared/canvas/document.ts` 的 `inputRefsOf` 提供（唯一来源），
 * 目录只补「这个端口吃什么类型」。
 *
 * 类型全部来自静态目录，不另写一份判断：
 * - 关系 → `BINARY_OPERATORS` 的 `left` / `right`；
 * - 一元 → `UNARY_OPERATORS` 的 `accepts`；
 * - 转换 → `conversionInputKind`；
 * - 下标 / 切片 / 重复的目标 → 三种序列，索引与次数 → `int`，条件 → `bool`；
 * - 变量声明的绑定端口 → 声明类型，流程赋值的右值 → 目标声明类型（拿不到声明时 `'any'`）。
 *
 * 剩下的一律 `'any'`：组合成员、字典值、按键取值的键、方法参数。这些要么是元素级未知，
 * 要么只有编译期按题目声明才知道（方法参数），目录不重复猜。
 */

/** 下标、切片、重复都能吃这三种；顺序照 `VALUE_KINDS` 的排法。 */
const SEQUENCE_KINDS: readonly canvas.ValueKind[] = ['byte', 'string', 'list'];

/** 不限制类型。 */
const ANY = 'any';

/**
 * 某个端口接受的静态类型。
 *
 * `document` 只为变量相关端口准备：`assign` 的右值要看目标声明的类型。没给文档（或目标悬空、
 * 指向的不是变量）就退化成 `'any'`，界面照样能画端口，只是提示不精确。
 */
export function acceptsOf(
  node: canvas.CanvasNode,
  portName: string,
  document?: canvas.CanvasDocument,
): readonly canvas.ValueKind[] | 'any' {
  switch (node.kind) {
    case 'value':
    case 'start':
    case 'var-ref':
    case 'loop-index':
      // 这些节点没有数据输入；端口名不该出现，出现了也只是「不限类型」。
      return ANY;
    case 'group':
    case 'dict':
    case 'method':
      // 组合成员、字典值、方法参数：元素级类型未知。方法参数的**真实类型**只在编译期按题目声明
      // （`authorBlocks[].params`）校验，目录这里不重复猜——猜错会让界面拒掉本来合法的接线。
      return ANY;
    case 'relation': {
      const spec = canvas.binaryOperatorSpec(node.op);
      if (portName === 'left') return [spec.left];
      if (portName === 'right') return [spec.right];
      return ANY;
    }
    case 'unary': {
      const spec = canvas.unaryOperatorSpec(node.op);
      return portName === 'operand' ? spec.accepts : ANY;
    }
    case 'index':
      if (portName === 'target') return SEQUENCE_KINDS;
      return portName === 'index' ? ['int'] : ANY;
    case 'lookup':
      if (portName === 'target') return ['dict'];
      // 字典键既可能是整数也可能是文本（`1` 与 `"1"` 是两个键），目录不替学习者选。
      return ANY;
    case 'slice':
      if (portName === 'target') return SEQUENCE_KINDS;
      return portName === 'start' || portName === 'end' || portName === 'step' ? ['int'] : ANY;
    case 'repeat':
      if (portName === 'target') return SEQUENCE_KINDS;
      return portName === 'count' ? ['int'] : ANY;
    case 'convert':
      return portName === 'input' ? [canvas.conversionInputKind(node.spec)] : ANY;
    case 'var-decl':
      // 绑定端口的类型就是声明类型（固定类型，需求 §3.1）。
      return portName === 'input' ? [node.type] : ANY;
    case 'assign': {
      if (portName !== 'value') return ANY;
      const declared = declaredKindIn(document, node.target);
      return declared === undefined ? ANY : [declared];
    }
    case 'if':
      return portName === 'cond' ? ['bool'] : ANY;
    case 'loop':
      return portName === 'count' ? ['int'] : ANY;
  }
}

/**
 * 从文档里解析声明：`assign.target` 可以写声明本身，也可以写引用视图（`variables.ts` 的
 * `resolveVariable` 只认「引用 → 声明」一层，这里照同一口径，不多跳）。
 */
export function declNodeOf(
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  nodeId: string,
): canvas.VarDeclNode | undefined {
  const node = nodes.get(nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'var-decl') return node;
  if (node.kind !== 'var-ref') return undefined;
  const decl = nodes.get(node.decl);
  return decl?.kind === 'var-decl' ? decl : undefined;
}

/** 流程赋值右值的静态类型：目标的声明类型；没有文档或目标悬空时 `undefined`（端口退化成 `'any'`）。 */
function declaredKindIn(
  document: canvas.CanvasDocument | undefined,
  targetId: string,
): canvas.ValueKind | undefined {
  if (document === undefined) return undefined;
  return declNodeOf(canvas.nodeMapOf(document), targetId)?.type;
}
