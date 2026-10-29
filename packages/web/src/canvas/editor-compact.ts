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

/** 流程按上下顺序吸附，保留前链位置，后链与嵌套包络整体移动。 */
export function compactFlowAfter(document: canvas.CanvasDocument, sequence: readonly string[], index: number): canvas.CanvasDocument {
  let next = document;
  for (let cursor = Math.max(1, index); cursor < sequence.length; cursor += 1) {
    const view = layoutCanvas({ document: next });
    const previous = structureIds(next, sequence[cursor - 1]);
    const current = structureIds(next, sequence[cursor]);
    const before = unionRects(view.boxes.filter((box) => previous.includes(box.nodeId)));
    const after = unionRects(view.boxes.filter((box) => current.includes(box.nodeId)));
    if (before === undefined || after === undefined) continue;
    const positions = canvasPositionsOf(next);
    const moves = current.flatMap((id) => {
      const point = positions.get(id);
      return point === undefined ? [] : [{ id, x: point.x + before.x - after.x, y: point.y + before.y + before.height + 48 - after.y }];
    });
    next = withLayout(next, moves);
  }
  return next;
}
