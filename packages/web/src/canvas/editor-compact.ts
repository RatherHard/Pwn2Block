import { canvas } from '@pwn2block/shared';
import { withLayout } from './editor-core';

import { layoutCanvas } from './view-model';
import { canvasPositionsOf, unionRects } from './view-model-geometry';
import { structureIds } from './structure';

/** 最小行列间距，列间留出中文关系框和两侧空隙。 */
export const ROW_PITCH = 142;
export const COL_PITCH = 292;

/** 组合的「组顶 / 组左」：优先组合自身坐标，其次成员坐标的左上角，都没有就是原点。 */
function groupOriginOf(document: canvas.CanvasDocument, group: canvas.GroupNode): canvas.CanvasNodeLayout {
  const own = document.layout[group.id];
  if (own !== undefined) return own;
  const points = canvas.groupMembers(group).flatMap((memberId) => document.layout[memberId] ?? []);
  if (points.length === 0) return { x: 0, y: 0 };
  return { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) };
}

/** 按真实结构尺寸压紧行列，嵌套表达式整体平移。 */
export function compactGroupMembers(document: canvas.CanvasDocument, group: canvas.GroupNode): canvas.CanvasDocument {
  const origin = groupOriginOf(document, group);
  const view = layoutCanvas({ document });
  const positions = canvasPositionsOf(document);
  const entries: (canvas.CanvasNodeLayout & { readonly id: string })[] = [];
  let y = origin.y;
  for (const row of group.rows) {
    let x = origin.x;
    let height = 0;
    for (const memberId of row) {
      const ids = structureIds(document, memberId);
      const bounds = unionRects(view.boxes.filter((box) => ids.includes(box.nodeId)));
      if (bounds === undefined) continue;
      for (const id of ids) {
        const point = positions.get(id);
        if (point !== undefined) entries.push({ id, x: point.x + x - bounds.x, y: point.y + y - bounds.y });
      }
      x += Math.max(COL_PITCH, bounds.width + 112);
      height = Math.max(height, bounds.height);
    }
    y += Math.max(ROW_PITCH, height + 48);
  }
  return withLayout(document, entries);
}
