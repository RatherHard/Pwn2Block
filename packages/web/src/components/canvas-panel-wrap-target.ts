import { canvas } from '@pwn2block/shared';
import { nodeOf, regionLabel, regionOfId, regionSequenceOf } from '../canvas/editor';

/**
 * 选中集 → 一次包络请求的定位（需求 §6.3、验收表 AT-15「同一区域连续流程包络为循环」）。
 *
 * 面板里的选中集**是一组 id，不是一个有序区间**：普通点选会把它收敛到一个 id，Shift 点选与框选
 * 往同一个集合里增删（见 `canvas-panel-interaction.ts` 的 `applyClickSelection` 与 `finishMarquee`）。
 * 所以「连续」不能按选择顺序判断，只能把每个 id 映射回它所在序列的下标、再看下标是否铺满一段。
 * 这个文件就是那条判断：纯函数、不碰 DOM，组件只负责把结论画成按钮与提示。
 *
 * 判定顺序（先报最根本的问题，用户才知道下一步该做什么）：
 * 1. 空选区；
 * 2. 每个 id 都在文档里；
 * 3. 每个 id 都是流程语句（数据节点、组合、声明都不行）；
 * 4. 每一条都已经排进某条序列；
 * 5. 不是开始节点（它必须留在顶层第一位，包进区域会立刻破坏结构）；
 * 6. 全部落在**同一条**序列里（`ownerId` 与 `kind` 都相同）；
 * 7. 下标恰好铺满一段（`to - from + 1` 等于条数）。
 *
 * 「跨 if 的成立 / 不成立分支」在第 6 条上失败：那是两条序列，一次只能包其中一条。
 */

/** 包络的定位：`ownerId` 是序列所属容器（顶层 `main` 用空串），`from` / `to` 是 0 基下标且含端点。 */
export interface WrapTarget {
  readonly ownerId: string;
  readonly from: number;
  readonly to: number;
  /** 容器里的区域才有：`then` / `else` / `body`；`main` 省略（与 `WrapRequest.kind` 同一口径）。 */
  readonly kind?: canvas.FlowRegionKind;
}

/** 不能包时只给一句中文原因：界面照原样显示（标题与块底提示），不猜也不静默。 */
export type WrapTargetResult = WrapTarget | { readonly reason: string };

/** 一个选中 id 的落点；不满足条件时就是那句原因。 */
type Placement =
  | { readonly ok: true; readonly region: canvas.FlowRegionRef; readonly index: number }
  | { readonly ok: false; readonly reason: string };

/** 单条语句的落点：存在 → 是流程语句 → 不是开始节点 → 已经排进某条序列。 */
function placementOf(document: canvas.CanvasDocument, id: string): Placement {
  const node = nodeOf(document, id);
  if (node === undefined) return { ok: false, reason: `选中的「${id}」不在文档里` };
  if (!canvas.isFlowNode(node)) {
    return {
      ok: false,
      reason: canvas.isValueNode(node)
        ? `「${id}」是数据节点，只有流程语句能包进循环或条件分支`
        : `「${id}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是流程语句，不能包进循环或条件分支`,
    };
  }
  if (node.kind === 'start') {
    return { ok: false, reason: `「${id}」是开始节点，必须留在顶层序列第一位，不能包进区域` };
  }
  const region = regionOfId(document, id);
  const sequence = region === undefined ? undefined : regionSequenceOf(document, region);
  if (region === undefined || sequence === undefined || !sequence.includes(id)) {
    return { ok: false, reason: `「${id}」还没排进任何流程序列，先把它放进流程再包` };
  }
  return { ok: true, region, index: sequence.indexOf(id) };
}

/**
 * 把选中集算成一段连续区间；算不出来时给一句原因。
 *
 * 重复 id 只算一次（选中集本来就是集合），所以「同一句选了两遍」不会挤成「不相邻」。
 */
export function wrapTargetOf(document: canvas.CanvasDocument, ids: readonly string[]): WrapTargetResult {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { reason: '先选中要包起来的流程语句' };
  const regions: canvas.FlowRegionRef[] = [];
  const positions: number[] = [];
  for (const id of unique) {
    const placement = placementOf(document, id);
    if (!placement.ok) return { reason: placement.reason };
    regions.push(placement.region);
    positions.push(placement.index);
  }
  const head = regions[0];
  if (head === undefined) return { reason: '先选中要包起来的流程语句' };
  const sameRegion = regions.every((region) => region.ownerId === head.ownerId && region.kind === head.kind);
  if (!sameRegion) return { reason: '选中的语句不在同一条序列里：一次只包同一区域的连续语句' };
  const from = Math.min(...positions);
  const to = Math.max(...positions);
  if (to - from + 1 !== positions.length) return { reason: '选中的语句在序列里不相邻：一次只包连续的一段' };
  return head.kind === 'main'
    ? { ownerId: head.ownerId, from, to }
    : { ownerId: head.ownerId, kind: head.kind, from, to };
}

/** 区域的权威写法：`kind` 缺省就是顶层 `main`（与 `WrapTarget` 同一口径）。 */
function regionOfTarget(target: WrapTarget): canvas.FlowRegionRef {
  return target.kind === undefined
    ? { ownerId: target.ownerId, kind: 'main' }
    : { ownerId: target.ownerId, kind: target.kind };
}

/**
 * 选区在序列里的位置说明：`当前选区是第 2–4 项（共 6 项，位于顶层序列）`。
 *
 * 下标对用户按 1 起数（命令层的 `from` / `to` 是 0 基），单条不说成「第 3–3 项」；
 * 区域名沿用 `regionLabel`，于是「位于顶层序列」与「位于「if1」的成立分支」是同一套口径。
 */
export function wrapTargetCaptionOf(document: canvas.CanvasDocument, target: WrapTarget): string {
  const region = regionOfTarget(target);
  const sequence = regionSequenceOf(document, region);
  const count = sequence === undefined ? target.to - target.from + 1 : sequence.length;
  const span = target.from === target.to ? `第 ${target.from + 1} 项` : `第 ${target.from + 1}–${target.to + 1} 项`;
  return `当前选区是${span}（共 ${count} 项，位于${regionLabel(region)}）`;
}
