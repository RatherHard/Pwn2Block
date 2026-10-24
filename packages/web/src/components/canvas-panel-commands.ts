import { canvas } from '@pwn2block/shared';
import {
  addExistingNode,
  addNode,
  connect,
  createGroup,
  createReference,
  createVariable,
  disconnect,
  dissolveGroup,
  edited,
  insertStatement,
  moveMember,
  moveStatementTo,
  newNodeId,
  nodeOf,
  refuse,
  regionOfId,
  regionSequenceOf,
  renameVariable,
  setRelationOp,
  setUnaryOp,
  setValue,
  type CanvasEdit,
  type StatementSlot,
} from '../canvas/editor';
import { rectOfNode, NODE_MIN_HEIGHT, NODE_MIN_WIDTH } from '../canvas/view-model';
import type { CanvasLayoutView, Point } from '../canvas/view-model';
import { inflateRect } from '../canvas/view-model-geometry';
import { FLOW_DATA_REFUSAL } from './canvas-panel-flow-drop';
import { boxAtPoint, portAtPoint, rectsIntersect, type DropTarget } from './canvas-panel-geometry';

/**
 * 面板对编辑命令的**适配层**（阶段三「界面事件 → `canvas/editor` 命令」）。
 *
 * 为什么单独一层：面板里每个控件都知道「用户改了什么字段」，但只有这里知道「该调哪条命令」。
 * 把映射集中起来，界面就不再直接改文档，所有写入都经过命令层的检查（类型、成环、上限）。
 *
 * 这个文件管**画布上的动作**：就地编辑、点方框换运算、加节点、拖动落位。
 * 侧栏字段那一半在 `canvas-panel-inspector-changes.ts`，两边一起从这里再导出，
 * 调用方只认一个入口。
 *
 * 一条硬边界：**命令层没有的能力不在这里手写**。组合成员只能整体建立（`createGroup`），
 * 没有「往已有组合里加一个成员」的命令，所以拖进别人的组合会被明确拒绝并给出替代路径，
 * 而不是绕开命令去改 `rows`。
 */

export * from './canvas-panel-inspector-changes';

/** 值节点「值」行与变量声明「名称」行的标签：与 `canvas/view-model-rows.ts` 的行文案同名。 */
const VALUE_ROW_LABEL = '值';
const NAME_ROW_LABEL = '名称';

/** 新建画布的默认文档：只有一个开始节点，且已经排在顶层序列第一位。 */
export function defaultDocument(): canvas.CanvasDocument {
  const added = addNode(canvas.emptyCanvasDocument(), 'start', 'start', { x: 64, y: 64 });
  return insertStatement(added.document, { ownerId: '', kind: 'main' }, 0, 'start').document;
}

// ---------------------------------------------------------------------------
// 就地编辑
// ---------------------------------------------------------------------------

/** 就地编辑框里的初始文本：字面值按种类给「能再解析回来」的写法。 */
export function editableTextOf(document: canvas.CanvasDocument, nodeId: string, rowLabel: string): string | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'value' && rowLabel === VALUE_ROW_LABEL) return literalTextOf(node.value);
  if (node.kind === 'var-decl' && rowLabel === NAME_ROW_LABEL) return node.name;
  return undefined;
}

/** 提交一次就地编辑；这一行不可编辑（例如方法参数）时返回 `undefined`。 */
export function applyRowEdit(
  document: canvas.CanvasDocument,
  nodeId: string,
  rowLabel: string,
  text: string,
): CanvasEdit | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'value' && rowLabel === VALUE_ROW_LABEL) {
    return setValue(document, nodeId, parseScalarValue(node.value.kind, text));
  }
  if (node.kind === 'var-decl' && rowLabel === NAME_ROW_LABEL) {
    return renameVariable(document, nodeId, text);
  }
  return undefined;
}

/**
 * 字面值的编辑文本。
 *
 * 字节串与整数原样给（`4141`、`-3`），文本不去动引号，布尔给「真/假」——
 * 提交时反向解析同一套写法，所以「双击看到什么就改什么」。
 */
function literalTextOf(value: canvas.EncodedScalarValue): string {
  switch (value.kind) {
    case 'byte':
      return value.hex;
    case 'int':
      return value.value;
    case 'double':
      return String(value.value);
    case 'string':
      return value.value;
    case 'bool':
      return value.value ? '真' : '假';
  }
}

/** 把编辑框文本解析成字面值；格式非法由 `setValue` 的检查拒绝（不在这里静默纠正）。 */
function parseScalarValue(kind: canvas.ScalarKind, text: string): canvas.EncodedScalarValue {
  switch (kind) {
    case 'byte':
      return { kind: 'byte', hex: text.trim().toLowerCase() };
    case 'int':
      return { kind: 'int', value: text.trim() };
    case 'double':
      return { kind: 'double', value: Number(text.trim()) };
    case 'string':
      return { kind: 'string', value: text };
    case 'bool': {
      const normalized = text.trim();
      return { kind: 'bool', value: normalized === '真' || normalized.toLowerCase() === 'true' };
    }
  }
}

// ---------------------------------------------------------------------------
// 关系方框：点击切换运算
// ---------------------------------------------------------------------------

/** 点一次关系方框 = 切换成目录里的下一种运算；从后往前绕回。 */
export function cycleOperator(document: canvas.CanvasDocument, nodeId: string): CanvasEdit | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'relation') return setRelationOp(document, nodeId, nextOf(canvas.BINARY_OPERATORS, node.op));
  if (node.kind === 'unary') return setUnaryOp(document, nodeId, nextOf(canvas.UNARY_OPERATORS, node.op));
  return undefined;
}

function nextOf<T extends string>(list: readonly T[], current: T): T {
  const index = list.indexOf(current);
  return list[(index + 1) % list.length];
}

// ---------------------------------------------------------------------------
// 工具栏动作
// ---------------------------------------------------------------------------

/** 新建节点时找一个空位：先按 4 列网格扫，全都占着就往文档末尾排。 */
export function freeSlotOf(document: canvas.CanvasDocument): canvas.CanvasNodeLayout {
  const taken: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[] = [];
  for (const node of document.nodes) {
    const rect = rectOfNode(document, node.id);
    if (rect !== undefined) taken.push(rect);
  }
  for (let row = 0; row < 24; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const candidate = { x: 48 + column * 240, y: 48 + row * 150 };
      const rect = { ...candidate, width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      if (!taken.some((item) => rectsIntersect(item, inflateRect(rect, 20)))) return candidate;
    }
  }
  return { x: 48, y: 48 + document.nodes.length * 150 };
}

/** 新变量名：先用 a–z，用完了退回 v1、v2……（重名由 `createVariable` 再挡一次）。 */
export function newVariableNameOf(document: canvas.CanvasDocument): string {
  const used = new Set(canvas.variableTableOf(document).byName.keys());
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    if (!used.has(letter)) return letter;
  }
  for (let index = 1; index < 1000; index += 1) {
    const name = `v${index}`;
    if (!used.has(name)) return name;
  }
  return 'v';
}

/**
 * 「加变量」：新建一个整数变量声明。
 *
 * 不写坐标——视图模型对没有 `layout` 的节点按 id 排序填网格，坐标仍然确定，
 * 用户拖动一次以后才把位置写进存档。
 */
export function addVariable(document: canvas.CanvasDocument): CanvasEdit {
  return createVariable(document, newNodeId(document, 'var'), newVariableNameOf(document), 'int');
}

/** 「引用变量」：给选中的声明（或第一个声明）造一个引用视图。 */
export function addReference(document: canvas.CanvasDocument, selectedDeclId: string | undefined): CanvasEdit {
  const declId = selectedDeclId ?? canvas.variableTableOf(document).declarations[0]?.id;
  if (declId === undefined) {
    return refuse(document, 'variable_error', '', '还没有变量声明，先点「加变量」');
  }
  return createReference(document, declId, newNodeId(document, 'ref'), freeSlotOf(document));
}

/** 数据节点候选（侧栏下拉用）：带数据结果的全部节点，顺序同文档。 */
export function valueNodeCandidates(document: canvas.CanvasDocument): readonly canvas.CanvasNode[] {
  return document.nodes.filter((node) => canvas.isValueNode(node));
}

// ---------------------------------------------------------------------------
// 接线落点
// ---------------------------------------------------------------------------

/**
 * 拉线松手的判定：落在别的端口上接那个节点，落在别的盒子上接那个节点，落在空白就断开。
 *
 * 「从端口拉出来」拉的是**目标端口**：每个端口都是某个节点的输入，所以「从这里拖到谁身上」
 * 就是「这个输入由谁来喂」。松在自己的端口上不算连接，原地松手等于取消。
 */
export function wireEditOf(
  document: canvas.CanvasDocument,
  view: CanvasLayoutView,
  from: { readonly nodeId: string; readonly name: string },
  point: Point,
): CanvasEdit {
  const port = portAtPoint(view.ports, point);
  if (port !== undefined && !(port.nodeId === from.nodeId && port.name === from.name)) {
    return connect(document, from.nodeId, from.name, port.nodeId);
  }
  const box = port === undefined ? boxAtPoint(view.boxes, point) : undefined;
  if (box !== undefined && box.nodeId !== from.nodeId) return connect(document, from.nodeId, from.name, box.nodeId);
  return disconnect(document, from.nodeId, from.name);
}

// ---------------------------------------------------------------------------
// 吸附落位
// ---------------------------------------------------------------------------

/** 松手后的结构改动；`message` 是不能改时给用户的一句话（不静默失败）。 */
export interface DropOutcome {
  readonly edit: CanvasEdit;
  readonly message?: string;
}

/**
 * 松手落位。
 *
 * - 落在自己所属组合的行带上 → `moveMember`（组内换行、换列）；
 * - 落在流程序列的带上 → 已经排进序列就 `moveStatementTo`（换位、跨区域），还没排就 `insertStatement`；
 * - 落在另一个节点上 → `createGroup`（吸附成组）；
 * - 落在空白且自己属于组合 → 移出组合：两个成员时直接 `dissolveGroup`，
 *   更多成员时用「解除 + 按原行列重建」表达「只移出这一个」（仍是可撤销的一步）；
 * - 落在空白而自己是流程语句 → **只改坐标，仍在原序列里**：流程带很窄，松手偏一点就
 *   悄悄掉出流程会毁掉整份程序；要换序列就拖到另一条序列的带上。
 * - 落在别人的组合里 → 明确拒绝：命令层没有「往已有组合加成员」这条命令。
 */
export function dropEditOf(
  document: canvas.CanvasDocument,
  target: DropTarget | undefined,
  dragged: readonly string[],
): DropOutcome {
  if (target === undefined || dragged.length !== 1) return { edit: edited(document) };
  const memberId = dragged[0];
  if (target.kind === 'flow' || target.kind === 'flow-blocked') return flowDropEditOf(document, target, memberId);
  const owner = canvas.ownerMapOf(document).get(memberId);
  if (target.kind === 'group') {
    if (owner === target.groupId) {
      return { edit: moveMember(document, target.groupId, memberId, target.rowIndex, target.columnIndex) };
    }
    return {
      edit: edited(document),
      message: '组合成员只能整体创建：按住 Shift 选中两个以上节点后点「成组」',
    };
  }
  if (target.kind === 'node') {
    if (owner !== undefined) {
      return { edit: edited(document), message: `「${memberId}」已经属于组合「${owner}」，先在组外释放再重新成组` };
    }
    return { edit: createGroup(document, [target.nodeId, memberId], newNodeId(document, 'group')) };
  }
  if (owner === undefined) return { edit: edited(document) };
  return detachMember(document, owner, memberId);
}

/**
 * 流程带上松手：已经排进某条序列就换位（跨区域也行），还没排进去就插进去。
 *
 * - 开始节点固定在顶层第一，任何流程落位都拒绝——它一挪整份程序就编译不过；
 * - 非流程节点（数据节点、组合、声明）给一句原因，文档不变；
 * - `main` 的第一位永远留给开始节点：落点算出来是 0 就顺延到 1，
 *   免得「往左偏一点」直接拼出一份开始节点不在第一步的文档。
 */
function flowDropEditOf(document: canvas.CanvasDocument, target: DropTarget, nodeId: string): DropOutcome {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return { edit: edited(document) };
  if (!canvas.isFlowNode(node)) return { edit: edited(document), message: flowRefusalOf(node) };
  if (node.kind === 'start') {
    return { edit: edited(document), message: '开始节点固定排在顶层第一位，不能挪进别的序列' };
  }
  // `flow-blocked` 只会被非流程节点命中，上面两句已经挡掉了；这里收窄类型。
  if (target.kind !== 'flow') return { edit: edited(document) };
  const index = startAwareIndex(document, target.region, target.index);
  const at = statementSlotOf(document, nodeId);
  if (at === undefined) return { edit: insertStatement(document, target.region, index, nodeId) };
  return { edit: moveStatementTo(document, at, { region: target.region, index }) };
}

/** 进不了流程的节点该怎么说：数据节点是最常见的一种，说法与吸附提示共用同一句。 */
function flowRefusalOf(node: canvas.CanvasNode): string {
  if (canvas.isValueNode(node)) return FLOW_DATA_REFUSAL;
  return `「${node.id}」是${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}，不能排进流程序列`;
}

/** 这条语句现在在哪条序列的第几项；还没排进任何序列时返回 `undefined`。 */
function statementSlotOf(document: canvas.CanvasDocument, nodeId: string): StatementSlot | undefined {
  const region = regionOfId(document, nodeId);
  if (region === undefined) return undefined;
  const sequence = regionSequenceOf(document, region);
  const index = sequence === undefined ? -1 : sequence.indexOf(nodeId);
  return index < 0 ? undefined : { region, index };
}

/** `main` 的第一位留给开始节点：落到它前面就顺延到第二位。 */
function startAwareIndex(document: canvas.CanvasDocument, region: canvas.FlowRegionRef, index: number): number {
  if (region.kind !== 'main' || index > 0) return index;
  const head = document.main[0] === undefined ? undefined : nodeOf(document, document.main[0]);
  return head !== undefined && head.kind === 'start' ? 1 : index;
}

/** 把一个成员从组合里移出：两成员时整组解除，更多成员时解除后按原行列重建。 */
function detachMember(document: canvas.CanvasDocument, groupId: string, memberId: string): DropOutcome {
  const group = nodeOf(document, groupId);
  if (group === undefined || group.kind !== 'group') return { edit: edited(document) };
  if (canvas.groupMembers(group).length <= 2) {
    return { edit: dissolveGroup(document, groupId), message: '组合只剩两个成员，已解除包络' };
  }
  const position = document.layout[groupId] ?? { x: 0, y: 0 };
  const rows = group.rows
    .map((row) => row.filter((id) => id !== memberId))
    .filter((row) => row.length > 0);
  const dissolved = dissolveGroup(document, groupId).document;
  const rebuilt = addExistingNode(dissolved, { ...group, rows }, position);
  return { edit: rebuilt, message: `已把「${memberId}」移出组合「${groupId}」` };
}
