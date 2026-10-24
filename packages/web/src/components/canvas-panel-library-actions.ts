import type { canvas } from '@pwn2block/shared';
import { createMethodNode, createNode } from '../canvas/catalog';
import { addExistingNode, newNodeId, type CanvasEdit } from '../canvas/editor';
import type { CanvasLayoutView, Point } from '../canvas/view-model';
import type { PanelActionHost } from './canvas-panel-actions';
import { freeSlotOf, dropEditOf } from './canvas-panel-commands';
import { flowDropAt, flowDropLabelOf } from './canvas-panel-flow-drop';
import { rectOfBox, snapCoordinate } from './canvas-panel-geometry';
import type { LibraryItem } from './canvas-panel-library-model';

/**
 * 节点库的放置动作：点击放到空位，拖到画布放在松手处。
 *
 * 拖放比点击多做一件事：**流程语句落在流程带上，直接排进那一步**。新手最常见的卡点是
 * 「方法节点放出来了，却没接进流程，运行时报错」；拖到哪就排到哪，省掉一次二次拖动。
 * 放节点与排进流程合成**一次**编辑，撤销一次就全部退回。
 *
 * 落在别的节点上不会成组：从库里拖出来的意图是「放一个新节点」，不是「和谁拼在一起」。
 */

/** 拖放时节点左上角相对指针的偏移：指针落在标题栏左侧，像是「拎着标题放下去」。 */
const DROP_GRAB = { x: 24, y: 12 } as const;

/** 拖放需要比点击多一样东西：放下后的布局（用来判流程带）。 */
export interface LibraryDropHost extends PanelActionHost {
  layoutOf(document: canvas.CanvasDocument): CanvasLayoutView;
}

/** 点击条目：放到空位，并选中新节点（方便马上在侧栏或节点内改）。 */
export function addLibraryItem(host: PanelActionHost, item: LibraryItem): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  const edit = addItemAt(host, document, item, freeSlotOf(document));
  commit(host, edit.edit, edit.id);
}

/** 拖到画布松手：放在指针处；流程语句压在流程带上就顺手排进去。 */
export function dropLibraryItem(host: LibraryDropHost, item: LibraryItem, point: Point): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  const at = { x: snapCoordinate(point.x - DROP_GRAB.x, true), y: snapCoordinate(point.y - DROP_GRAB.y, true) };
  const added = addItemAt(host, document, item, { x: Math.max(0, at.x), y: Math.max(0, at.y) });
  if (added.edit.issues.length > 0 || added.id === undefined) {
    commit(host, added.edit, undefined);
    return;
  }
  const placed = placeInFlow(host, added.edit.document, added.id, point);
  commit(host, placed?.edit ?? added.edit, added.id);
  if (placed?.message !== undefined) host.report(placed.message);
}

/** 造节点并加进文档；题目方法直接选好方法，参数按声明补成「未接线」。 */
function addItemAt(
  host: PanelActionHost,
  document: canvas.CanvasDocument,
  item: LibraryItem,
  at: canvas.CanvasNodeLayout,
): { readonly edit: CanvasEdit; readonly id: string | undefined } {
  const block = item.blockId === undefined ? undefined : host.authorBlocks()?.find((entry) => entry.id === item.blockId);
  if (item.blockId !== undefined && block === undefined) {
    host.report(`本题没有声明方法「${item.blockId}」`);
    return { edit: { document, issues: [] }, id: undefined };
  }
  const id = newNodeId(document, block?.id ?? item.nodeKind);
  const node = block === undefined ? createNode(item.nodeKind, id) : createMethodNode(id, block);
  const edit = addExistingNode(document, node, at);
  return { edit, id: edit.issues.length > 0 ? undefined : id };
}

/** 放下后若压在流程带上，排进那一步；不在带上或不是流程语句就保持原样。 */
function placeInFlow(
  host: LibraryDropHost,
  document: canvas.CanvasDocument,
  nodeId: string,
  point: Point,
): { readonly edit: CanvasEdit; readonly message?: string } | undefined {
  const view = host.layoutOf(document);
  const rects = new Map(view.boxes.map((box) => [box.nodeId, rectOfBox(box)] as const));
  const target = flowDropAt({ document, rectOf: (id) => rects.get(id), point, dragged: [nodeId] });
  if (target === undefined) return undefined;
  const outcome = dropEditOf(document, target, [nodeId]);
  if (outcome.edit.issues.length > 0) return { edit: { document, issues: outcome.edit.issues } };
  return { edit: outcome.edit, message: outcome.message ?? `已${flowDropLabelOf(target)}` };
}

function commit(host: PanelActionHost, edit: CanvasEdit, id: string | undefined): void {
  host.applyEdit(edit);
  if (id !== undefined && edit.issues.length === 0) host.selectNodes([id]);
}
