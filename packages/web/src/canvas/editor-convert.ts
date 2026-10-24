import { canvas } from '@pwn2block/shared';
import { DEFAULT_CONVERSION } from './catalog';
import {
  edited,
  hasNode,
  isConversionKind,
  isValidNodeId,
  newNodeId,
  nodeOf,
  refuse,
  withLayout,
  withNodes,
  withoutLayout,
  type CanvasEdit,
} from './editor-core';
import { createGroup } from './editor-containers';
import { conversionSlotOf } from './editor-convert-slot';
import { rewireInputs } from './editor-convert-wiring';

/**
 * 「包络为转换」与「解除转换」（需求 §4.1、§6.3，验收表 AT-14）。
 *
 * 转换包络在文档里就是一个 `convert` 节点：`input` 指向**整体结果**，外壳连同内部结构对外只给
 * 一个转换结果（需求 §4.1）。所以「包络为转换」= 造一个 `convert` 并让原来的消费者改读它，
 * 「解除转换」= 删掉它并让消费者回到它原来的输入。两条命令都不改写选区内部的结构：
 * 多成员时先按 `createGroup` 合成组合（组合就是整体结果），解除时组合与成员一个字节都不动。
 *
 * 五条边界：
 * 1. **只有数据节点能包**：流程节点、开始节点、变量声明都没有数据结果，包进去表达不出来。
 * 2. **不许包住转换自己**：选区里已经有 `convert` 就拒绝，否则会绕成「转换包住自己」。
 * 3. **外部引用内部中间结果先处理**：选区里的某个节点被选区外的节点引用时，那条连接读的是
 *    内部中间结果，包完就会指向一个「再也拿不到」的值。所以先拒绝并点名引用者，
 *    让用户自己决定改接还是删除——命令层不替他删别人的节点（与 `dissolveGroup` 同一口径）。
 * 4. **整体结果的引用一律改接**：单成员时整体结果就是那个节点，多成员时是新建的组合。
 *    改接是**一次遍历**：所有指向整体结果的数据输入端口一起写上新 id，不逐个节点来回改。
 * 5. **一次调用只产出一个新文档**：组合、改接、新节点、坐标全在同一个返回值里，撤销一步就回到原样。
 *
 * 落点（「别压在包络线上」）在 `editor-convert-slot.ts`：那里按包络同一套规则算内部矩形；
 * 改接与断开在 `editor-convert-wiring.ts`：那里只做「一次遍历把引用改成新 id 或断掉」。
 */

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 「包络为转换」的结果：新文档，外加一句能不能做、为什么做不了的话（拒绝时界面直接显示它）。 */
export interface WrapConversionResult {
  readonly edit: CanvasEdit;
  readonly message?: string;
}

/** 一条外部引用：谁（`referrerId`）的哪个端口（`refName`）指着选区内。 */
export interface ExternalRef {
  readonly referrerId: string;
  readonly refName: string;
}

// ---------------------------------------------------------------------------
// 外部引用扫描
// ---------------------------------------------------------------------------

/**
 * 选区外、指向选区内节点的**数据引用**。
 *
 * 口径与删除的连带规则同源（`inputRefsOf`）：
 * - 算引用：方法参数、赋值右值、变量绑定的输入、关系 / 附属操作 / 下标 / 按键 / 切片 / 重复 /
 *   字典条目 / 转换 / 条件 / 循环的输入端口——凡是 `inputRefsOf` 列出来的数据输入都算；
 * - **不算引用**：组合的成员（`group.rows` 是结构归属，不是取值的输入，所以整类跳过）；
 *   变量引用的声明与循环索引指向的循环同样不是数据输入，`inputRefsOf` 对它们返回空数组，
 *   于是这里天然不会命中。
 *
 * 未接线（`UNCONNECTED`）不是引用，`inputRefsOf` 已经把它折成 `undefined`。
 */
export function externalRefsOf(
  document: canvas.CanvasDocument,
  memberIds: readonly string[],
): readonly ExternalRef[] {
  const inside = new Set(memberIds);
  const refs: ExternalRef[] = [];
  for (const node of document.nodes) {
    if (inside.has(node.id) || node.kind === 'group') continue;
    for (const ref of canvas.inputRefsOf(node)) {
      if (ref.id !== undefined && inside.has(ref.id)) refs.push({ referrerId: node.id, refName: ref.name });
    }
  }
  return refs;
}

/** 一条外部引用现在指着谁：端口名在引用者身上唯一定位一条输入，所以能反查出目标 id。 */
function refTargetOf(document: canvas.CanvasDocument, ref: ExternalRef): string | undefined {
  const referrer = nodeOf(document, ref.referrerId);
  if (referrer === undefined) return undefined;
  return canvas.inputRefsOf(referrer).find((item) => item.name === ref.refName)?.id;
}

// ---------------------------------------------------------------------------
// 选区的合法性
// ---------------------------------------------------------------------------

/** 拒绝一次包络：文档原样返回，同时给出一句可以直接显示的中文。 */
function refuseWrap(
  document: canvas.CanvasDocument,
  code: canvas.CanvasIssueCode,
  nodeId: string,
  message: string,
): WrapConversionResult {
  return { edit: refuse(document, code, nodeId, message), message };
}

type Members =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly result: WrapConversionResult };

/**
 * 选区 → 可以包的数据节点（顺序即选区顺序，重复 id 只算一次）。
 *
 * 判定顺序就是报错优先级：空选区 → 每个 id 都在文档里 → 不是转换 → 是数据节点。
 * 顺序这样排，用户先看到的是「根本没有东西可包」，再看到「这个东西为什么不能包」。
 */
function dataMembersOf(document: canvas.CanvasDocument, memberIds: readonly string[]): Members {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) {
    return { ok: false, result: refuseWrap(document, 'unknown_node', '', '先选中要包成转换的数据节点') };
  }
  for (const id of ids) {
    const node = nodeOf(document, id);
    if (node === undefined) {
      return { ok: false, result: refuseWrap(document, 'unknown_node', id, `选中的「${id}」不在文档里`) };
    }
    if (node.kind === 'convert') {
      return {
        ok: false,
        result: refuseWrap(
          document,
          'ownership_conflict',
          id,
          `选区里已经有转换「${id}」，转换不能包住自己，先解除它再包`,
        ),
      };
    }
    if (!canvas.isValueNode(node)) {
      return {
        ok: false,
        result: refuseWrap(
          document,
          'unknown_kind',
          id,
          `「${id}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，没有数据结果，不能包成转换`,
        ),
      };
    }
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------
// 整体结果
// ---------------------------------------------------------------------------

type Grouped =
  | { readonly ok: true; readonly document: canvas.CanvasDocument; readonly wholeId: string }
  | { readonly ok: false; readonly result: WrapConversionResult };

/**
 * 「整体结果」：多成员时先按 `createGroup` 合成组合（模式用它的默认判定），单成员时就是它自己。
 *
 * 组合的成员顺序就是选区顺序——`createGroup` 把 `memberIds` 按行切开，一行行就是选区顺序。
 */
function groupedResultOf(document: canvas.CanvasDocument, ids: readonly string[]): Grouped {
  const wholeId = ids[0];
  if (wholeId === undefined) {
    return { ok: false, result: refuseWrap(document, 'unknown_node', '', '先选中要包成转换的数据节点') };
  }
  if (ids.length === 1) return { ok: true, document, wholeId };
  const groupId = newNodeId(document, 'group');
  const edit = createGroup(document, ids, groupId);
  const issue = edit.issues[0];
  if (issue !== undefined) return { ok: false, result: { edit, message: issue.message } };
  return { ok: true, document: edit.document, wholeId: groupId };
}

// ---------------------------------------------------------------------------
// 包络为转换 / 解除转换
// ---------------------------------------------------------------------------

/**
 * 外部引用内部中间结果时的拒绝；单成员没有「内部」可言（外部引用读的就是整体结果），所以放行。
 *
 * 消息里点名引用者与被引用的内部节点，用户可以直接去那条连接上改接或删除。
 */
function intermediateRefusalOf(
  document: canvas.CanvasDocument,
  grouped: canvas.CanvasDocument,
  ids: readonly string[],
): WrapConversionResult | undefined {
  if (ids.length === 1) return undefined;
  const first = externalRefsOf(grouped, ids)[0];
  if (first === undefined) return undefined;
  const target = refTargetOf(grouped, first) ?? ids[0] ?? '';
  return refuseWrap(
    document,
    'ownership_conflict',
    first.referrerId,
    `「${first.referrerId}」还引用着内部的「${target}」，先把它改接或删除再包成转换`,
  );
}

/**
 * 把选中的合法数据片段包成一个转换包络。
 *
 * 单成员：整体结果就是它自己，外部对它的连接改接新转换，转换摆到它右侧。
 * 多成员：先 `createGroup` 合成组合（组合就是整体结果），再有转换包络包住这个组合；
 * 组合是新建的，所以没有「整体结果的外部连接」要改接。
 * 类型是否匹配不在这里判：需求 §4.1 的「类型不匹配时标错」由 `validateCanvasDocument` 说，
 * 命令层只保证结构成立（与 `connect` 之外的其它结构命令同一分工）。
 */
export function wrapInConversion(
  document: canvas.CanvasDocument,
  memberIds: readonly string[],
  convertId?: string,
  spec?: canvas.ConversionSpec,
): WrapConversionResult {
  const id = convertId ?? newNodeId(document, 'convert');
  if (!isValidNodeId(id)) {
    return refuseWrap(document, 'invalid_id', id, `节点 id「${id}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, id)) {
    return refuseWrap(document, 'duplicate_id', id, `节点 id「${id}」已经存在，换一个再包`);
  }
  if (spec !== undefined && !isConversionKind(spec.kind)) {
    return refuseWrap(document, 'unknown_kind', id, `未知的转换种类「${String(spec.kind)}」`);
  }
  const members = dataMembersOf(document, memberIds);
  if (!members.ok) return members.result;
  const grouped = groupedResultOf(document, members.ids);
  if (!grouped.ok) return grouped.result;
  // 组合 id 也来自 `newNodeId` 的「前缀 + 序号」：调用方显式传进来的转换 id 可能正好撞上刚生成的组合 id，
  // 所以建组之后要再查一次，绝不把两个节点写成同一个 id。
  if (hasNode(grouped.document, id)) {
    return refuseWrap(document, 'duplicate_id', id, `节点 id「${id}」已经存在，换一个再包`);
  }
  const blocked = intermediateRefusalOf(document, grouped.document, members.ids);
  if (blocked !== undefined) return blocked;
  const rewired = rewireInputs(grouped.document, grouped.wholeId, id);
  const at = conversionSlotOf(rewired, grouped.wholeId);
  const node: canvas.ConvertNode = {
    kind: 'convert',
    id,
    spec: spec ?? DEFAULT_CONVERSION,
    input: grouped.wholeId,
  };
  const placed = withLayout(rewired, [{ id, x: at.x, y: at.y }]);
  return { edit: edited(withNodes(placed, [...placed.nodes, node])) };
}

/**
 * 解除转换：删掉转换节点与包络，内部结构原样留下。
 *
 * - 消费者改接回 `input`（那个整体结果），于是「包上再解除」回到原来的连接；
 * - `input` 是 `UNCONNECTED` 时消费者一律断开，不留悬空引用；
 * - `input` 若是组合，组合与成员都不动（组合包络还在）；若是普通节点，也不动；
 * - `layout` 只清掉转换节点自己的坐标。
 */
export function unwrapConversion(document: canvas.CanvasDocument, convertId: string): CanvasEdit {
  const node = nodeOf(document, convertId);
  if (node === undefined) return refuse(document, 'unknown_node', convertId, `节点「${convertId}」不存在`);
  if (node.kind !== 'convert') {
    return refuse(
      document,
      'unknown_kind',
      convertId,
      `节点「${convertId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是转换，没有包络可以解除`,
    );
  }
  const input = node.input === canvas.UNCONNECTED ? undefined : node.input;
  const rewired = rewireInputs(document, convertId, input);
  const nodes = rewired.nodes.filter((item) => item.id !== convertId);
  return edited(withoutLayout({ ...rewired, nodes }, new Set([convertId])));
}
