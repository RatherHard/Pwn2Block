import { canvas } from '@pwn2block/shared';
import { addNode, connect, newNodeId, nodeOf, refuse, setValue, type CanvasEdit } from '../canvas/editor';
import { methodArgZeroValue } from '../canvas/catalog';
import { NODE_MIN_HEIGHT, NODE_MIN_WIDTH, rectOfNode } from '../canvas/view-model';
import { rectsIntersect } from './canvas-panel-geometry';

/**
 * 方法参数的就地编辑（需求 §6.1「字节串、整数等简单内容直接在节点内编辑」）。
 *
 * 方法参数本身只是一个引用，值在别的节点上。为了让「在方法框里直接敲参数」成立，这里定两条规则：
 * - 参数**没接线**：提交时新建一个字面值节点（按题目声明的参数类型），放在方法框左侧的空位并接上；
 * - 参数接的是**字面值**：直接改那个字面值节点，接线不动。
 * 接的是变量或表达式时这一行不可编辑（视图模型给 `editable: false`），这里也同样拒绝。
 *
 * 新建节点 + 写值 + 接线是三条命令，任意一条被拒就整体放弃，返回原文档：撤销栈里只有一步。
 */

/** 新建参数字面值时离方法框左边缘的距离。 */
const ARG_NODE_OFFSET_X = NODE_MIN_WIDTH + 60;
/** 空位搜索时每次往下挪的距离。 */
const ARG_NODE_STEP_Y = NODE_MIN_HEIGHT + 24;
const ARG_NODE_MAX_TRIES = 12;

/** 方法参数行的编辑初值；这一行不是方法参数、或接的不是字面值时返回 `undefined`。 */
export function methodArgTextOf(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  argName: string,
  literalTextOf: (value: canvas.EncodedScalarValue) => string,
): string | undefined {
  if (node.kind !== 'method' || !Object.hasOwn(node.args, argName)) return undefined;
  const sourceId = node.args[argName];
  if (sourceId === canvas.UNCONNECTED) return '';
  const source = nodeOf(document, sourceId);
  return source?.kind === 'value' ? literalTextOf(source.value) : undefined;
}

/** 提交方法参数行；这一行不是方法参数时返回 `undefined`（交给调用方的其他分支）。 */
export function applyMethodArgEdit(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  argName: string,
  text: string,
  methods: readonly canvas.CanvasMethodDecl[],
  parse: (kind: canvas.ScalarKind, text: string) => canvas.EncodedScalarValue,
): CanvasEdit | undefined {
  if (node.kind !== 'method' || !Object.hasOwn(node.args, argName)) return undefined;
  const sourceId = node.args[argName];
  if (sourceId !== canvas.UNCONNECTED) {
    const source = nodeOf(document, sourceId);
    if (source?.kind !== 'value') {
      return refuse(document, 'unknown_kind', node.id, `参数「${argName}」接的是「${sourceId}」，去那个节点上改`);
    }
    return setValue(document, sourceId, parse(source.value.kind, text));
  }
  const param = canvas.canvasMethodById(methods, node.block)?.params.find((item) => item.name === argName);
  if (param === undefined) {
    return refuse(document, 'method_mismatch', node.id, `题目没有声明参数「${argName}」，先在侧栏选方法`);
  }
  const zero = methodArgZeroValue(param.type);
  return createArgLiteral(document, node.id, argName, parse(zero.kind, text));
}

/** 新建字面值 → 写值 → 接到参数上；任何一步被拒都返回原文档与那一步的问题。 */
function createArgLiteral(
  document: canvas.CanvasDocument,
  methodId: string,
  argName: string,
  value: canvas.EncodedScalarValue,
): CanvasEdit {
  const literalId = newNodeId(document, argName.replace(/[^A-Za-z0-9_-]/g, '') || 'arg');
  const added = addNode(document, 'value', literalId, argSlotOf(document, methodId));
  if (added.issues.length > 0) return { document, issues: added.issues };
  const written = setValue(added.document, literalId, value);
  if (written.issues.length > 0) return { document, issues: written.issues };
  const wired = connect(written.document, methodId, argName, literalId);
  if (wired.issues.length > 0) return { document, issues: wired.issues };
  return wired;
}

/** 方法框左侧的第一个空位：从与方法框顶对齐开始往下找，找不到就用第一个候选。 */
function argSlotOf(document: canvas.CanvasDocument, methodId: string): canvas.CanvasNodeLayout {
  const anchor = rectOfNode(document, methodId) ?? { x: 0, y: 0, width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const taken = document.nodes
    .map((item) => rectOfNode(document, item.id))
    .filter((rect): rect is NonNullable<typeof rect> => rect !== undefined);
  const first = { x: Math.max(0, anchor.x - ARG_NODE_OFFSET_X), y: anchor.y };
  for (let index = 0; index < ARG_NODE_MAX_TRIES; index += 1) {
    const candidate = { x: first.x, y: first.y + index * ARG_NODE_STEP_Y };
    const rect = { ...candidate, width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    if (!taken.some((item) => rectsIntersect(item, rect))) return candidate;
  }
  return first;
}
