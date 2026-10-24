import { canvas } from '@pwn2block/shared';
import { nodeOf } from './editor-core';
import { ENVELOPE_PADDING, GROUP_PADDING, inflateRect, rectOfNode, unionRects } from './view-model-geometry';
import type { Rect } from './view-model-types';

/**
 * 新转换节点的落点（需求 §4.1「包络 = `input` 的矩形各边 +16」）。
 *
 * 转换包络画在**内部结构**外面：`input` 是组合时包住成员盒子的并集（各边 +12），
 * 其余情况包住节点自己的锚框；两侧各再 +16 就是包络线。所以新节点摆在
 * 「内部矩形右侧 + 包络边距 16 + 24 像素缝」处，一定落在包络线之外。
 *
 * 单独一个文件的原因与 `editor-compact.ts` 相同：`editor-convert.ts` 本来就贴着 300 行上限，
 * 而落点是自成一体的几何规则，分出来两边都好读。
 */

/** 新转换节点与内层包络之间留的缝隙：包络各边 +16，再留 24 像素才不会压在包络线上。 */
const CONVERT_GAP = 24;

/** 兜底坐标：整体结果连锚框都算不出来时（脏存档成环）用画布左上角。 */
const FALLBACK_SLOT: canvas.CanvasNodeLayout = { x: 48, y: 48 };

/**
 * 内层结构的矩形：组合用成员盒子的并集各边 +12（与包络同一套规则），其余用它自己的锚框。
 *
 * `visiting` 挡住脏存档里两个组合互相记成成员的环——遇到环就当这一支没有盒子，
 * 外层退回「用组合自己的锚框」，保证任何输入都能算完。
 */
function innerRectOf(
  document: canvas.CanvasDocument,
  nodeId: string,
  visiting: Set<string> = new Set(),
): Rect | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  if (node.kind !== 'group') return rectOfNode(document, nodeId);
  if (visiting.has(nodeId)) return undefined;
  visiting.add(nodeId);
  const members: Rect[] = [];
  for (const memberId of canvas.groupMembers(node)) {
    const rect = innerRectOf(document, memberId, visiting);
    if (rect !== undefined) members.push(rect);
  }
  visiting.delete(nodeId);
  const union = unionRects(members);
  return union === undefined ? rectOfNode(document, nodeId) : inflateRect(union, GROUP_PADDING);
}

/** 新转换节点的落点：整体结构右侧，让开包络的 +16 边距再留 24 像素缝，顶边与内部对齐。 */
export function conversionSlotOf(document: canvas.CanvasDocument, wholeId: string): canvas.CanvasNodeLayout {
  const inner = innerRectOf(document, wholeId);
  if (inner === undefined) return FALLBACK_SLOT;
  return { x: inner.x + inner.width + ENVELOPE_PADDING + CONVERT_GAP, y: inner.y };
}
