import { canvas } from '@pwn2block/shared';
import { withLayout } from './editor-core';

/**
 * 落位后的坐标压紧（需求 §6.2「落位后自动压紧并对齐行首，不保留空洞」）。
 *
 * 组合的 `rows` 是权威行列，这一层只负责把行列**翻译成坐标**：行 y = 组顶 + 行号 × `ROW_PITCH`，
 * 列 x = 组左 + 列号 × `COL_PITCH`。所以「换行 / 删行 / 插行」之后成员在视觉上真的对齐，
 * 而不用靠渲染容差去猜。
 *
 * 三条约定：
 * - **组合自身坐标不动**：组的位置是用户拖出来的，压紧只排成员；
 * - **空行不产生坐标**：没有成员的行既没有空洞也没有空条目；
 * - **不碰其它节点**：只写这个组合成员的坐标，其余布局原样保留。
 *
 * 单独一个文件的原因：`editor-containers.ts` 本来就贴到 400 行上限，压紧是自成一体的几何规则，
 * 分出来两边都好读；常量从 `editor-containers.ts` 再导出，调用方只认 `canvas/editor`。
 */

/**
 * 压紧时的行距。
 *
 * `view-model-geometry.ts` 没有可复用的行距（那里的 `GRID_STEP_Y` 是给没有坐标的节点兜底的网格，
 * 不对外），所以这里给一条自己的常量：最高的节点盒子是值节点 72 + 22 = 94
 * （`NODE_MIN_HEIGHT` + `NODE_ROW_HEIGHT`），再加 6 像素缝。
 */
export const ROW_PITCH = 100;
/** 压紧时的列距：最窄的节点盒子 180（`NODE_MIN_WIDTH`），再加 20 像素缝就是 200。 */
export const COL_PITCH = 200;

/** 组合的「组顶 / 组左」：优先组合自身坐标，其次成员坐标的左上角，都没有就是原点。 */
function groupOriginOf(document: canvas.CanvasDocument, group: canvas.GroupNode): canvas.CanvasNodeLayout {
  const own = document.layout[group.id];
  if (own !== undefined) return own;
  const points = canvas.groupMembers(group).flatMap((memberId) => document.layout[memberId] ?? []);
  if (points.length === 0) return { x: 0, y: 0 };
  return { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) };
}

/** 按行列重写每个成员的坐标；组合自己的 `layout` 一个字节不改。 */
export function compactGroupMembers(
  document: canvas.CanvasDocument,
  group: canvas.GroupNode,
): canvas.CanvasDocument {
  const origin = groupOriginOf(document, group);
  const entries: (canvas.CanvasNodeLayout & { readonly id: string })[] = [];
  group.rows.forEach((row, rowIndex) => {
    row.forEach((memberId, columnIndex) => {
      entries.push({ id: memberId, x: origin.x + columnIndex * COL_PITCH, y: origin.y + rowIndex * ROW_PITCH });
    });
  });
  return withLayout(document, entries);
}
