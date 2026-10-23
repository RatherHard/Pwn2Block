import { applyRowEdit, editableTextOf } from './canvas-panel-commands';
import type { PanelInteractionHost } from './canvas-panel-host';
import type { InlineEditState } from './canvas-panel-render';

/**
 * 就地编辑（需求 §6.1「双击可编辑行就地改，Enter/失焦提交、Esc 取消」）。
 *
 * 只维护「哪一行的输入框开着、里面的初值是什么」，提交时把文案交给 `applyRowEdit`：
 * 这一层不认识字面值格式，也不认识命令，所以「双击看到什么」和「提交后变成什么」
 * 由命令层单独负责，改解析规则不用碰这里。
 */
export class CanvasInlineEdit {
  private state: InlineEditState | undefined;

  constructor(private readonly host: PanelInteractionHost) {}

  /** 当前正在编辑的那一行；渲染层据此把 `.row-value` 换成输入框。 */
  current(): InlineEditState | undefined {
    return this.state;
  }

  /** 开一个编辑框；调用方已经确认这一行可编辑。 */
  begin(nodeId: string, rowIndex: number, text: string): void {
    this.state = { nodeId, rowIndex, value: text };
    this.host.selectNodes([nodeId]);
    this.host.requestRender();
  }

  /** 输入框的键：Enter 提交、Esc 取消；其余键留给输入框自己。 */
  rowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    this.commit(inputValueOf(event.target));
  };

  /** 失焦即提交（需求 §6.1）；Esc 时 `state` 已经清掉，这里就成了空操作。 */
  rowBlur = (event: FocusEvent): void => {
    this.commit(inputValueOf(event.target));
  };

  cancel(): void {
    if (this.state === undefined) return;
    this.state = undefined;
    this.host.requestRender();
  }

  /** 提交一次编辑；输入框已经不在或这一行消失时安静收场。 */
  commit(text: string | undefined): void {
    const inline = this.state;
    if (inline === undefined) return;
    this.state = undefined;
    const document = this.host.currentDocument();
    const row = this.host.currentLayout().rowsByNode.get(inline.nodeId)?.[inline.rowIndex];
    if (document === undefined || text === undefined || row === undefined) {
      this.host.requestRender();
      return;
    }
    const edit = applyRowEdit(document, inline.nodeId, row.label, text);
    if (edit !== undefined) this.host.applyEdit(edit);
    this.host.requestRender();
  }

  /**
   * 双击某一行：可编辑就开框，不可编辑（方法参数、复杂配置）改为打开侧栏。
   * 返回是否进入了编辑态，供交互层决定还要不要做别的。
   */
  beginAt(nodeId: string, rowIndex: number): boolean {
    const document = this.host.currentDocument();
    if (document === undefined) return false;
    const row = this.host.currentLayout().rowsByNode.get(nodeId)?.[rowIndex];
    const text = row === undefined || !row.editable ? undefined : editableTextOf(document, nodeId, row.label);
    if (row === undefined || text === undefined) {
      this.host.selectNodes([nodeId]);
      this.host.requestRender();
      return false;
    }
    this.begin(nodeId, rowIndex, text);
    return true;
  }
}

function inputValueOf(target: EventTarget | null): string | undefined {
  return target instanceof HTMLInputElement ? target.value : undefined;
}
