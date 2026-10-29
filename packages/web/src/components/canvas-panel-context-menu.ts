import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { PanelActionHost } from './canvas-panel-actions';
import { groupSelection, dissolveSelection, applyInspectorField } from './canvas-panel-actions';
import { wrapTargetOf, convertWrapTargetOf } from './canvas-panel-wrap-target';

export interface CanvasMenuState { readonly x: number; readonly y: number }
export interface CanvasMenuInput {
  readonly position: CanvasMenuState;
  readonly host: PanelActionHost;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly close: () => void;
}

/** 所有菜单动作复用编辑命令；选区保持不变，直到动作成功。 */
export function renderCanvasMenu(input: CanvasMenuInput): TemplateResult {
  const { host } = input;
  const document = host.currentDocument() ?? canvas.emptyCanvasDocument();
  const ids = host.selection();
  const selected = document.nodes.filter((node) => ids.includes(node.id));
  const data = selected.length > 0 && selected.every(canvas.isValueNode);
  const flow = !('reason' in wrapTargetOf(document, ids));
  const convert = !('reason' in convertWrapTargetOf(document, ids));
  const envelope = selected.length === 1 && ['group', 'convert', 'loop', 'if'].includes(selected[0].kind);
  const action = (run: () => void): void => { input.close(); run(); };
  const keyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    const menu = event.currentTarget;
    if (!(menu instanceof HTMLElement)) return;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.findIndex((button) => button.matches(':focus'));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === 'Escape' || event.key === 'Tab') input.close();
  };
  return html`<div class="canvas-context-menu" role="menu" aria-label="画布菜单" style=${`left:${input.position.x}px;top:${input.position.y}px`} @pointerdown=${(e: Event) => e.stopPropagation()} @keydown=${keyDown} @contextmenu=${(e: Event) => e.preventDefault()}>
    <button role="menuitem" class="menu-undo" ?disabled=${!input.canUndo} @click=${() => action(input.undo)}>撤销 <span>Ctrl Z</span></button>
    <button role="menuitem" class="menu-redo" ?disabled=${!input.canRedo} @click=${() => action(input.redo)}>重做 <span>Ctrl Shift Z</span></button>
    <hr />
    <button role="menuitem" class="menu-wrap" ?disabled=${!data} @click=${() => action(() => groupSelection(host))}>包络</button>
    <button role="menuitem" class="menu-wrap-loop" ?disabled=${!flow} @click=${() => action(() => applyInspectorField(host, { kind: 'wrap-loop' }))}>包络为循环</button>
    <button role="menuitem" class="menu-wrap-branch" ?disabled=${!flow} @click=${() => action(() => applyInspectorField(host, { kind: 'wrap-branch' }))}>包络为条件分支</button>
    <button role="menuitem" class="menu-wrap-convert" ?disabled=${!convert} @click=${() => action(() => applyInspectorField(host, { kind: 'wrap-convert' }))}>包络为转换</button>
    <button role="menuitem" class="menu-dissolve" ?disabled=${!envelope} @click=${() => action(() => dissolveSelection(host))}>解除包络</button>
  </div>`;
}
