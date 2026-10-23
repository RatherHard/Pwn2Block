import type { Point } from '../canvas/view-model';
import { canvasPositionsOf } from '../canvas/view-model-geometry';
import { moveLayout, removeNodes } from '../canvas/editor';
import type { PanelInteractionHost } from './canvas-panel-host';

/**
 * 键盘命令：撤销/重做、删除、方向键微调（需求 §10 任务第 11–12 条）。
 *
 * 与指针交互分开的理由：这四条命令只依赖「文档 + 选中集 + 宿主」，不需要拖动状态，
 * 也不读写渲染状态——放在同一个类里只会让那个状态机更难读。
 */

/** 方向键步长：8px；按住 Shift 32px。 */
const NUDGE_STEP = 8;
const NUDGE_STEP_LARGE = 32;

/** 输入框/下拉里的按键不归画布管（否则在侧栏里按退格会删节点）。 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
}

/** 处理一条键盘命令；返回是否吃掉了这个按键。 */
export function handleCommandKey(host: PanelInteractionHost, event: KeyboardEvent): boolean {
  if (isRedoKey(event)) {
    event.preventDefault();
    host.redo();
    return true;
  }
  if (isUndoKey(event)) {
    event.preventDefault();
    host.undo();
    return true;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelection(host);
    return true;
  }
  const delta = arrowDeltaOf(event);
  if (delta === undefined) return false;
  event.preventDefault();
  nudgeSelection(host, delta);
  return true;
}

/** 删除选中的全部节点：连带删除、空包络清理都由 `removeNodes` 决定。 */
export function deleteSelection(host: PanelInteractionHost): void {
  const document = host.currentDocument();
  const ids = host.selection();
  if (document === undefined) return;
  if (ids.length === 0) {
    host.report('先选中节点再删除');
    return;
  }
  const removed = removeNodes(document, ids);
  host.selectNodes([]);
  host.applyEdit({ document: removed.document, issues: [] });
}

/** 方向键微调：整组一起挪，步长按 Shift 分两档。 */
export function nudgeSelection(host: PanelInteractionHost, delta: Point): void {
  const document = host.currentDocument();
  const ids = host.selection();
  if (document === undefined || ids.length === 0) return;
  const positions = canvasPositionsOf(document);
  const moves = ids.map((id) => {
    const position = positions.get(id) ?? { x: 0, y: 0 };
    return { id, x: position.x + delta.x, y: position.y + delta.y };
  });
  host.applyEdit({ document: moveLayout(document, moves), issues: [] });
}

function isUndoKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
}

function isRedoKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z';
}

function arrowDeltaOf(event: KeyboardEvent): Point | undefined {
  const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
  switch (event.key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return undefined;
  }
}
