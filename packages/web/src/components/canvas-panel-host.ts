import type { canvas } from '@pwn2block/shared';
import type { CanvasEdit } from '../canvas/editor';
import type { CanvasLayoutView } from '../canvas/view-model';

/**
 * 交互层要用到的宿主能力（面板外壳实现）。
 *
 * 交互、就地编辑与键盘三块都只认这个接口，不认 Lit：于是它们能脱离组件单测，
 * 也让「谁改文档」只有一个答案——所有写入都从 `applyEdit` 走，历史与存档都在外壳里。
 */
export interface PanelInteractionHost {
  currentDocument(): canvas.CanvasDocument | undefined;
  currentLayout(): CanvasLayoutView;
  selection(): readonly string[];
  selectNodes(ids: readonly string[]): void;
  applyEdit(edit: CanvasEdit): void;
  report(message: string | undefined): void;
  requestRender(): void;
  stageElement(): HTMLElement | null;
  undo(): void;
  redo(): void;
  /** 题目声明的方法目录：方法参数就地编辑时按它取参数类型。 */
  methods(): readonly canvas.CanvasMethodDecl[];
}
