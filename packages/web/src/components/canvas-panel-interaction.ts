import { structureIds, selectionRoots } from '../canvas/structure';
import type { canvas } from '@pwn2block/shared';
import { moveLayout } from '../canvas/editor';
import type { CanvasLayoutView, Point, Rect } from '../canvas/view-model';
import { canvasPositionsOf } from '../canvas/view-model-geometry';
import { cycleOperator, dropEditOf } from './canvas-panel-commands';
import {
  DRAG_THRESHOLD,
  dropTargetFor,
  rectBetween,
  rectOfBox,
  rectsIntersect,
  snapCoordinate,
  type DropTarget,
} from './canvas-panel-geometry';
import type { PanelInteractionHost } from './canvas-panel-host';
import { handleCommandKey, isTextEntry } from './canvas-panel-keys';
import { closestData, elementOf, listenDrag, toGraphPoint, unlistenDrag } from './canvas-panel-pointer';

/** 拖动只更新预览，松手提交一次可撤销编辑；Escape 丢弃预览。 */

/** 移动类拖动：节点（可多选）或整组（拖组合标题）。 */
interface MoveDrag {
  readonly kind: 'node' | 'group';
  /** 被拖动的节点；整组拖动时是组合的全部成员。 */
  readonly ids: readonly string[];
  readonly roots: readonly string[];
  /** 拖动起点时的位置：每一步都用「起点 + 位移」算，误差不会累积。 */
  readonly origins: ReadonlyMap<string, canvas.CanvasNodeLayout>;
  readonly start: Point;
  readonly moved: boolean;
  readonly preview: canvas.CanvasDocument;
  readonly drop: DropTarget | undefined;
  /** 按下的是哪个节点/组合：松手没拖动时按它决定选中。 */
  readonly pressedId: string;
  /** 按下时按着 Shift 且它**本来就在**选中集里：松手（没拖动）要把它移出选中。 */
  readonly togglesOff: boolean;
}

interface MarqueeDrag {
  readonly kind: 'marquee';
  readonly from: Point;
  readonly to: Point;
  readonly additive: boolean;
}

type Drag = MoveDrag | MarqueeDrag;

/** 拖动开始时冻结的视图与文档：吸附命中与「拖出组」都以它为准。 */
interface BaseState {
  readonly document: canvas.CanvasDocument;
  readonly view: CanvasLayoutView;
}

export class CanvasPanelInteraction {
  private drag: Drag | undefined;
  private base: BaseState | undefined;

  constructor(private readonly host: PanelInteractionHost) {}

  /** 渲染用的文档：拖动中给预览，否则给真文档。 */
  displayDocument(): canvas.CanvasDocument | undefined {
    const drag = this.drag;
    if (drag !== undefined && (drag.kind === 'node' || drag.kind === 'group') && drag.moved) return drag.preview;
    return this.host.currentDocument();
  }

  marqueeRect(): Rect | undefined {
    const drag = this.drag;
    return drag !== undefined && drag.kind === 'marquee' ? rectBetween(drag.from, drag.to) : undefined;
  }

  // -------------------------------------------------------------------------
  // 指针
  // -------------------------------------------------------------------------

  pointerDown = (event: MouseEvent): void => {
    if (event.button !== 0 || isTextEntry(event.target)) return;
    if (this.host.currentDocument() === undefined) return;
    const point = this.toGraph(event);
    // 关系方框只响应点击（切换运算），不参与拖动。
    const title = closestData(elementOf(event.target), 'data-group-title');
    if (title !== null) {
      this.startGroupDrag(title, point);
      return;
    }
    if (closestData(elementOf(event.target), 'data-relation') !== null) return;
    const node = closestData(elementOf(event.target), 'data-node');
    if (node !== null) {
      this.startNodeDrag(node, point, event.shiftKey);
      return;
    }
    this.startMarquee(point, event.shiftKey);
  };

  pointerMove = (event: MouseEvent): void => {
    const drag = this.drag;
    if (drag === undefined) return;
    const point = this.toGraph(event);
    if (drag.kind === 'marquee') {
      this.drag = { ...drag, to: point };
      this.host.requestRender();
      return;
    }
    this.moveDragged(drag, point, !event.shiftKey);
  };

  pointerUp = (event: MouseEvent): void => {
    const drag = this.drag;
    this.detachWindow();
    if (drag === undefined) return;
    if (drag.kind === 'marquee') {
      this.finishMarquee(drag);
      return;
    }
    this.finishMove(drag, event.shiftKey);
  };

  /** 点关系方框 = 循环切换运算（需求 §6.1）。 */
  click = (event: MouseEvent): void => {
    const target = closestData(elementOf(event.target), 'data-relation');
    if (target === null) return;
    const nodeId = target.dataset['relation'];
    const document = this.host.currentDocument();
    if (nodeId === undefined || document === undefined) return;
    this.host.selectNodes([nodeId]);
    const edit = cycleOperator(document, nodeId);
    if (edit !== undefined) this.host.applyEdit(edit);
  };

  /** 节点配置统一由侧栏编辑。 */

  // -------------------------------------------------------------------------
  // 键盘
  // -------------------------------------------------------------------------

  keyDown = (event: KeyboardEvent): void => {
    // 侧栏输入框自己处理编辑按键，画布不吃这些键。
    // 监听挂在宿主上，影子根里的输入框会被重定向成宿主本身，所以要看 `composedPath()` 的首项：
    // 否则在框里或侧栏里按退格，会把选中的节点删掉。
    if (isTextEntry(event.composedPath()[0] ?? event.target)) return;
    if (event.key === 'Escape') {
      this.cancelAll();
      return;
    }
    handleCommandKey(this.host, event);
  };

  /** 卸载时解绑全局监听，避免面板移除后还吃指针事件。 */
  destroy(): void {
    this.detachWindow();
    this.drag = undefined;
    this.base = undefined;
  }

  // -------------------------------------------------------------------------
  // 拖动
  // -------------------------------------------------------------------------

  /**
   * 按下节点身体：没选中就先选中它（多选时保持整组，方便一起拖）。
   * Shift 的加选/减选留到松手时处理——按下就改选中会让「Shift 点一下又松手」变成两次修改。
   */
  private startNodeDrag(element: HTMLElement, point: Point, shiftKey: boolean): void {
    const nodeId = element.dataset['node'];
    const document = this.host.currentDocument();
    if (nodeId === undefined || document === undefined) return;
    const selection = this.host.selection();
    const already = selection.includes(nodeId);
    if (!already) this.host.selectNodes(shiftKey ? [...selection, nodeId] : [nodeId]);
    const ids = this.host.selection().flatMap((id) => {
      const node = document.nodes.find((item) => item.id === id);
      return node?.kind === 'loop' || node?.kind === 'if' || node?.kind === 'convert' ? structureIds(document, id) : [id];
    });
    this.beginMove('node', [...new Set(ids)], nodeId, point, document, shiftKey && already);
  }

  private startGroupDrag(element: HTMLElement, point: Point): void {
    const groupId = element.dataset['groupTitle'];
    const document = this.host.currentDocument();
    if (groupId === undefined || document === undefined) return;
    const group = document.nodes.find((node) => node.id === groupId);
    if (group === undefined) return;
    this.beginMove('group', structureIds(document, groupId), groupId, point, document, false);
  }

  private beginMove(
    kind: 'node' | 'group',
    ids: readonly string[],
    pressedId: string,
    point: Point,
    document: canvas.CanvasDocument,
    togglesOff: boolean,
  ): void {
    if (ids.length === 0) return;
    const positions = canvasPositionsOf(document);
    const origins = new Map<string, canvas.CanvasNodeLayout>();
    for (const id of ids) {
      const position = positions.get(id);
      if (position !== undefined) origins.set(id, position);
    }
    this.base = { document, view: this.host.currentLayout() };
    this.drag = {
      kind,
      ids: [...origins.keys()],
      roots: kind === 'group' ? [pressedId] : [...this.host.selection()],
      origins,
      pressedId,
      togglesOff,
      start: point,
      moved: false,
      preview: document,
      drop: undefined,
    };
    this.attachWindow();
  }

  private moveDragged(drag: MoveDrag, point: Point, snapEnabled: boolean): void {
    const base = this.base;
    if (base === undefined) return;
    const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
    if (!drag.moved && Math.abs(delta.x) + Math.abs(delta.y) < DRAG_THRESHOLD) return;
    const moves = [...drag.origins].map(([id, origin]) => ({
      id,
      x: drag.ids.length > 1 ? origin.x + snapCoordinate(delta.x, snapEnabled) : snapCoordinate(origin.x + delta.x, snapEnabled),
      y: drag.ids.length > 1 ? origin.y + snapCoordinate(delta.y, snapEnabled) : snapCoordinate(origin.y + delta.y, snapEnabled),
    }));
    const drop = snapEnabled ? this.dropAt(base, point, drag.roots) : undefined;
    this.drag = { ...drag, moved: true, preview: moveLayout(base.document, moves), drop };
    this.host.requestRender();
  }

  private dropAt(base: BaseState, point: Point, dragged: readonly string[]): DropTarget | undefined {
    return dropTargetFor(base.document, base.view, point, dragged);
  }

  private finishMove(drag: MoveDrag, shiftKey: boolean): void {
    this.drag = undefined;
    this.base = undefined;
    if (!drag.moved) {
      this.applyClickSelection(drag, shiftKey);
      this.host.requestRender();
      return;
    }
    const outcome = dropEditOf(drag.preview, drag.drop, drag.roots);
    this.host.applyEdit(outcome.edit);
    if (outcome.message !== undefined) this.host.report(outcome.message);
    this.host.requestRender();
  }

  /** 没拖动就是点击：Shift 加选/减选，普通点选收敛到按下的那一个。 */
  private applyClickSelection(drag: MoveDrag, shiftKey: boolean): void {
    if (drag.kind === 'group' || !shiftKey) {
      this.host.selectNodes([drag.pressedId]);
      return;
    }
    if (!drag.togglesOff) return;
    this.host.selectNodes(this.host.selection().filter((id) => id !== drag.pressedId));
  }

  // -------------------------------------------------------------------------
  // 框选
  // -------------------------------------------------------------------------

  private startMarquee(point: Point, additive: boolean): void {
    const document = this.host.currentDocument();
    if (document === undefined) return;
    this.base = { document, view: this.host.currentLayout() };
    this.drag = { kind: 'marquee', from: point, to: point, additive };
    this.attachWindow();
  }

  private finishMarquee(drag: MarqueeDrag): void {
    const base = this.base;
    this.drag = undefined;
    this.base = undefined;
    const rect = rectBetween(drag.from, drag.to);
    if (rect.width < DRAG_THRESHOLD && rect.height < DRAG_THRESHOLD) {
      if (!drag.additive) this.host.selectNodes([]);
      this.host.requestRender();
      return;
    }
    if (base === undefined) return;
    const hits = base.view.boxes
      .filter((box) => box.kind === 'node')
      .filter((box) => rectsIntersect(rectOfBox(box), rect))
      .map((box) => box.nodeId);
    this.host.selectNodes(selectionRoots(base.document, drag.additive ? [...new Set([...this.host.selection(), ...hits])] : hits));
    this.host.requestRender();
  }

  private cancelAll(): void {
    this.detachWindow();
    const wasActive = this.drag !== undefined;
    this.drag = undefined;
    this.base = undefined;
    if (wasActive) this.host.requestRender();
  }

  // -------------------------------------------------------------------------
  // 坐标与全局监听
  // -------------------------------------------------------------------------

  private toGraph(event: MouseEvent): Point {
    return toGraphPoint(this.host.stageElement(), event);
  }

  private attachWindow(): void {
    listenDrag(this.pointerMove, this.pointerUp);
  }

  private detachWindow(): void {
    unlistenDrag(this.pointerMove, this.pointerUp);
  }
}
