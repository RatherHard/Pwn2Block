import { LitElement, html, svg, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { styleMap } from 'lit/directives/style-map.js';
import { canvas } from '@pwn2block/shared';
import type { WorkflowIssue } from '../canvas/artifact';
import {
  connectLogic,
  detachLogicData,
  layoutLogicData,
  LOGIC_RELATION_WIDTH,
  createLogicEdge,
  logicBox,
  logicAttachmentHost,
  logicId,
  moveLogicNodes,
  nextLogicPosition,
  nearestLogicSnap,
  removeLogic,
  wrapLogic,
  type LogicSnap,
} from '../canvas/logic-editor';
import { copyLogicSelection, parseLogicSelection, pasteLogicSelection, serializeLogicSelection } from '../canvas/logic-clipboard';
import { terminalTheme, sharedStyles } from '../theme';
import { LogicNodeFields } from './logic-canvas-fields';
import { logicCanvasStyles } from './logic-canvas-styles';
import { logicEdgeGeometry, logicPointInsertionIndex, logicSummary, logicTitle } from './logic-canvas-view';

import { renderLogicLibrary, type AddableLogicKind, type LogicLibraryState } from './logic-canvas-library';

let localClipboard = '';
let clipboardWrite: Promise<void> = Promise.resolve();
type Drag = { id: string; startX: number; startY: number; original: canvas.LogicGraph; ids: string[]; moved: boolean; library?: boolean; baseline?: canvas.LogicGraph };
export class LogicCanvasElement extends LitElement {
  static override styles = [terminalTheme, sharedStyles, logicCanvasStyles];
  static override properties = {
    graph: { attribute: false },
    methods: { attribute: false },
    issues: { attribute: false },
    steps: { attribute: false },
    canUndo: { type: Boolean },
    canRedo: { type: Boolean },
  };
  declare graph: canvas.LogicGraph;
  declare methods: readonly canvas.CanvasMethodDecl[];
  declare issues: readonly WorkflowIssue[];
  declare steps: readonly canvas.CanvasStep[];
  declare canUndo: boolean;
  declare canRedo: boolean;
  private selected: string[] = [];
  private edgeId: string | undefined;
  private draft: canvas.LogicGraph | undefined;
  private snap: LogicSnap | undefined;
  private drag: Drag | undefined;
  private bend: { edgeId: string; index: number } | undefined;
  private bendDrag: { original: canvas.LogicGraph; startX: number; startY: number; moved: boolean } | undefined;
  private suppressLibraryClick = false;
  private viewOffset = { x: 0, y: 0 };
  private pan: { clientX: number; clientY: number; x: number; y: number } | undefined;
  private marquee: { x: number; y: number; endX: number; endY: number } | undefined;
  private wiring: { id: string; outlet: 'next' | 'then' | 'else' } | undefined;
  private message = '';
  private pasteCount = 0;
  private lastPasted = '';
  private targetId = '';
  private libraryState: LogicLibraryState = { page: 0 };
  private menuPosition: { x: number; y: number } | undefined;
  private menuReturnFocus: HTMLElement | undefined;
  constructor() {
    super();
    this.methods = [];
    this.issues = [];
    this.steps = [];
    this.canUndo = false;
    this.canRedo = false;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('keydown', this.keyDown);
    this.addEventListener('copy', this.copyEvent);
    this.addEventListener('cut', this.cutEvent);
    this.addEventListener('paste', this.pasteEvent);
    document.addEventListener('pointerdown', this.dismissMenu, true);
    document.addEventListener('focusin', this.dismissMenu, true);
    document.addEventListener('wheel', this.dismissMenu, { capture: true, passive: true });
    window.addEventListener('resize', this.closeMenu);
    window.addEventListener('blur', this.closeMenu);
    window.addEventListener('blur', this.cancelPointer);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.keyDown);
    this.removeEventListener('copy', this.copyEvent);
    this.removeEventListener('cut', this.cutEvent);
    this.removeEventListener('paste', this.pasteEvent);
    this.stopPointer();
    document.removeEventListener('pointerdown', this.dismissMenu, true);
    document.removeEventListener('focusin', this.dismissMenu, true);
    document.removeEventListener('wheel', this.dismissMenu, true);
    window.removeEventListener('resize', this.closeMenu);
    window.removeEventListener('blur', this.closeMenu);
    window.removeEventListener('blur', this.cancelPointer);
    this.menuPosition = undefined;
    this.menuReturnFocus = undefined;
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('graph') && this.graph) {
      this.selected = this.selected.filter((id) => this.graph.nodes.some((n) => n.id === id));
      if (this.edgeId && !this.graph.edges.some((e) => e.id === this.edgeId)) this.edgeId = undefined;
      if (this.bend && !this.graph.edges.some((e) => e.id === this.bend?.edgeId && e.kind === 'flow' && e.points?.[this.bend.index])) this.bend = undefined;
      if (this.wiring && !this.graph.nodes.some((n) => n.id === this.wiring?.id)) this.wiring = undefined;
    }
  }
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('graph') && this.graph &&
      ((this.drag && (this.drag.baseline ?? this.drag.original) !== this.graph) ||
       (this.bendDrag && this.bendDrag.original !== this.graph))) this.cancelPointer();
  }
  private closeMenu = (): void => {
    if (!this.menuPosition) return;
    this.menuPosition = undefined;
    this.menuReturnFocus = undefined;
    this.requestUpdate();
  };
  private dismissMenu = (event: Event): void => {
    if (!event.composedPath().some((target) => target instanceof HTMLElement && target.classList.contains('canvas-context-menu')))
      this.closeMenu();
  };
  private finishMenu(action?: 'logic-undo' | 'logic-redo'): void {
    const focus = this.menuReturnFocus;
    this.closeMenu();
    if (action) this.emit(action);
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    else this.focus({ preventScroll: true });
  }
  private openMenu = (event: MouseEvent): void => {
    // Keep native editing commands available inside form controls.
    if (event.composedPath().some((target) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    event.preventDefault();
    this.cancelPointer();
    this.menuReturnFocus = this.renderRoot.querySelector<HTMLElement>(':focus') ?? this;
    this.menuPosition = { x: event.clientX, y: event.clientY };
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const menu = this.renderRoot.querySelector<HTMLElement>('.canvas-context-menu');
      if (!menu || !this.menuPosition) return;
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(this.menuPosition.x, window.innerWidth - rect.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(this.menuPosition.y, window.innerHeight - rect.height - 8))}px`;
      (menu.querySelector<HTMLElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true });
    });
  };
  private menuKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); this.finishMenu(); return; }
    if (event.key === 'Tab') { this.finishMenu(); return; }
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.canvas-context-menu button:not(:disabled)')];
    const index = buttons.findIndex((button) => button === this.shadowRoot?.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const redo = event.shiftKey || event.key.toLowerCase() === 'y';
      if (redo ? this.canRedo : this.canUndo) this.finishMenu(redo ? 'logic-redo' : 'logic-undo');
    }
  };
  private contextMenu(): TemplateResult | typeof nothing {
    if (!this.menuPosition) return nothing;
    return html`<div class="canvas-context-menu" role="menu" aria-label="画布菜单" tabindex="-1"
      style=${styleMap({ left: `${this.menuPosition.x}px`, top: `${this.menuPosition.y}px` })}
      @keydown=${this.menuKeyDown} @contextmenu=${(event: Event) => { event.preventDefault(); event.stopPropagation(); }}>
      <div class="menu-title">画布编辑</div>
      <button role="menuitem" ?disabled=${!this.canUndo} @click=${() => this.finishMenu('logic-undo')}>撤销 <span>Ctrl Z</span></button>
      <button role="menuitem" ?disabled=${!this.canRedo} @click=${() => this.finishMenu('logic-redo')}>重做 <span>Ctrl Shift Z</span></button>
      <button role="menuitem" ?disabled=${!this.canCopy} @click=${() => this.clipboardMenu('copy')}>复制 <span>Ctrl C</span></button>
      <button role="menuitem" ?disabled=${!this.canCopy} @click=${() => this.clipboardMenu('cut')}>剪切 <span>Ctrl X</span></button>
      <button role="menuitem" @click=${() => this.clipboardMenu('paste')}>粘贴 <span>Ctrl V</span></button>
    </div>`;
  }
  private isTextEditing(event: Event): boolean {
    return event.composedPath().some((target) => target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable));
  }
  private get canCopy(): boolean {
    return this.graph.nodes.some((n) => this.selected.includes(n.id) && n.kind !== 'start');
  }
  private copySelection(cut = false, event?: ClipboardEvent): void {
    this.cancelPointer();
    const fragment = copyLogicSelection(this.graph, this.selected);
    if (!fragment) return;
    localClipboard = serializeLogicSelection(fragment);
    this.pasteCount = 0;
    this.lastPasted = '';
    if (event?.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData('text/plain', localClipboard);
    } else if (navigator.clipboard) {
      clipboardWrite = navigator.clipboard.writeText(localClipboard).catch(() => { /* In-app clipboard remains available. */ });
    }
    if (cut) {
      this.commit(removeLogic(this.graph, this.selected));
      this.selected = [];
      this.edgeId = undefined;
    }
    this.message = cut ? '已剪切所选节点' : '已复制所选节点';
    this.requestUpdate();
  }
  private pasteText(text: string, at?: { x: number; y: number }): void {
    const fragment = parseLogicSelection(text);
    if (!fragment) { this.message = '剪贴板中没有可粘贴的节点'; this.requestUpdate(); return; }
    this.cancelPointer();
    const count = text === this.lastPasted ? this.pasteCount : 0;
    this.attempt(() => {
      const pasted = pasteLogicSelection(this.graph, fragment, at ?? {
        x: -this.viewOffset.x + 40 + count * 24, y: -this.viewOffset.y + 50 + count * 24,
      });
      this.selected = pasted.selected;
      this.edgeId = undefined;
      this.bend = undefined;
      this.lastPasted = text;
      this.pasteCount = count + 1;
      return pasted.graph;
    });
  }
  private async pasteClipboard(at?: { x: number; y: number }): Promise<void> {
    const original = this.graph;
    await clipboardWrite;
    let text = localClipboard;
    try { if (navigator.clipboard) text = await navigator.clipboard.readText(); } catch { /* Use the in-app clipboard. */ }
    if (!this.isConnected || original !== this.graph) return;
    this.pasteText(text, at);
  }
  private copyEvent = (event: ClipboardEvent): void => { if (!this.isTextEditing(event)) this.copySelection(false, event); };
  private cutEvent = (event: ClipboardEvent): void => { if (!this.isTextEditing(event)) this.copySelection(true, event); };
  private pasteEvent = (event: ClipboardEvent): void => {
    if (this.isTextEditing(event)) return;
    event.preventDefault();
    this.pasteText(event.clipboardData?.getData('text/plain') ?? localClipboard);
  };
  private clipboardMenu(action: 'copy' | 'cut' | 'paste'): void {
    const at = this.menuPosition ? this.point({ clientX: this.menuPosition.x, clientY: this.menuPosition.y }) : undefined;
    this.finishMenu();
    if (action === 'paste') void this.pasteClipboard(at);
    else this.copySelection(action === 'cut');
  }
  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  private commit(graph: canvas.LogicGraph): void {
    if (graph === this.graph) return;
    if (!canvas.LogicGraphSchema.safeParse(graph).success) {
      this.message = '超出文档限制：最多 512 节点、2048 连接，每条流程线最多 128 个转折点，请检查字段长度与坐标范围';
      this.requestUpdate();
      return;
    }
    this.message = '';
    this.emit('logic-edit', graph);
    this.requestUpdate();
  }
  private attempt(work: () => canvas.LogicGraph): void {
    try {
      this.commit(work());
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    }
  }
  private point(event: Pick<MouseEvent, 'clientX' | 'clientY'>): { x: number; y: number } {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage')!;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left - this.viewOffset.x, y: event.clientY - rect.top - this.viewOffset.y };
  }
  locate(id: string): void {
    const edge = this.graph.edges.find((e) => e.id === id);
    this.bend = undefined;
    this.edgeId = edge?.id;
    this.selected = edge ? [] : [id];
    const box = logicBox(this.graph, edge?.from ?? id);
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    if (stage) {
      const left = box.x + this.viewOffset.x, top = box.y + this.viewOffset.y;
      if (left < 0 || top < 0 || left + box.width > stage.clientWidth || top + box.height > stage.clientHeight)
        this.viewOffset = { x: 100 - box.x, y: 100 - box.y };
    }
    this.requestUpdate();
  }
  private startNode(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus({ preventScroll: true });
    this.bend = undefined;
    if (this.wiring) {
      const edge: canvas.LogicEdge = {
        id: logicId(this.graph, 'edge'),
        kind: 'flow',
        from: this.wiring.id,
        to: id,
        outlet: this.wiring.outlet,
      };
      this.wiring = undefined;
      this.addEdge(edge);
      return;
    }
    if (event.shiftKey)
      this.selected = this.selected.includes(id) ? this.selected.filter((i) => i !== id) : [...this.selected, id];
    else if (!this.selected.includes(id)) this.selected = [id];
    this.edgeId = undefined;
    const point = this.point(event);
    this.drag = { id, startX: point.x, startY: point.y, original: this.graph, ids: [...this.selected], moved: false };
    this.listenPointer();
    this.requestUpdate();
  }
  private panWheel(event: WheelEvent): void {
    if (event.ctrlKey || this.drag || this.bendDrag || this.pan || this.marquee) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1;
    this.viewOffset = { x: this.viewOffset.x - (event.shiftKey ? event.deltaY : event.deltaX) * scale,
      y: this.viewOffset.y - (event.shiftKey ? event.deltaX : event.deltaY) * scale };
    this.requestUpdate();
  }
  private startStage(event: PointerEvent): void {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.node, .envelope-title, .relation, .edge-hit, .bend-handle, .attachment, .port')) return;
    event.preventDefault();
    this.focus({ preventScroll: true });
    const p = this.point(event);
    this.selected = [];
    this.edgeId = undefined;
    this.wiring = undefined;
    this.bend = undefined;
    if (event.shiftKey) this.marquee = { ...p, endX: p.x, endY: p.y };
    else this.pan = { clientX: event.clientX, clientY: event.clientY, ...this.viewOffset };
    this.listenPointer();
    this.requestUpdate();
  }
  private listenPointer(): void {
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointercancel', this.cancelPointer);
  }
  private stopPointer(): void {
    window.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('pointercancel', this.cancelPointer);
  }
  private pointerMove = (event: PointerEvent): void => {
    if (this.pan) {
      this.viewOffset = { x: this.pan.x + event.clientX - this.pan.clientX, y: this.pan.y + event.clientY - this.pan.clientY };
      this.requestUpdate();
      return;
    }
    const p = this.point(event);
    if (this.bendDrag && this.bend) {
      const { edgeId, index } = this.bend;
      const dx = p.x - this.bendDrag.startX, dy = p.y - this.bendDrag.startY;
      if (!this.bendDrag.moved && Math.hypot(dx, dy) < 4) return;
      this.bendDrag.moved = true;
      this.draft = this.withBendPoints(this.bendDrag.original, edgeId, (points) => points.map((point, i) =>
        i === index ? { x: point.x + dx, y: point.y + dy } : point));
    } else if (this.drag) {
      const dx = p.x - this.drag.startX,
        dy = p.y - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      if (this.drag.library) {
        this.suppressLibraryClick = true;
        if (!this.insideStage(event)) { this.draft = undefined; this.snap = undefined; this.requestUpdate(); return; }
      }
      this.draft = moveLogicNodes(detachLogicData(this.drag.original, this.drag.ids), this.drag.ids, dx, dy);
      this.snap = this.drag.ids.length === 1 ? nearestLogicSnap(this.draft, this.drag.id, this.methods) : undefined;
    } else if (this.marquee) this.marquee = { ...this.marquee, endX: p.x, endY: p.y };
    this.requestUpdate();
  };
  private pointerUp = (event: PointerEvent): void => {
    if (this.drag?.moved || this.bendDrag || this.pan) this.pointerMove(event);
    this.stopPointer();
    if (this.drag?.library) setTimeout(() => { this.suppressLibraryClick = false; }, 0);
    if (this.bendDrag && this.draft) this.commit(this.draft);
    if (this.drag?.moved && this.draft) {
      this.commit(this.snap?.graph ?? this.draft);
    }
    if (this.marquee) {
      const r = this.marquee,
        left = Math.min(r.x, r.endX),
        top = Math.min(r.y, r.endY),
        right = Math.max(r.x, r.endX),
        bottom = Math.max(r.y, r.endY);
      this.selected = this.graph.nodes
        .filter((n) => {
          if (logicAttachmentHost(n)) return false;
          const b = logicBox(this.graph, n.id);
          return b.x >= left && b.y >= top && b.x + b.width <= right && b.y + b.height <= bottom;
        })
        .map((n) => n.id);
    }
    this.pan = undefined;
    this.drag = undefined;
    this.bendDrag = undefined;
    this.draft = undefined;
    this.snap = undefined;
    this.marquee = undefined;
    this.requestUpdate();
  };
  private cancelPointer = (): void => {
    this.stopPointer();
    if (this.pan) this.viewOffset = { x: this.pan.x, y: this.pan.y };
    this.pan = undefined;
    this.drag = undefined;
    this.bendDrag = undefined;
    this.draft = undefined;
    this.snap = undefined;
    this.marquee = undefined;
    this.wiring = undefined;
    this.requestUpdate();
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (
      event
        .composedPath()
        .some(
          (t) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement,
        )
    )
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      this.bend = undefined;
      this.cancelPointer();
      this.selected = [];
      this.edgeId = undefined;
    } else if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.cancelPointer();
      this.emit(event.shiftKey ? 'logic-redo' : 'logic-undo');
    } else if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.cancelPointer();
      this.emit('logic-redo');
    } else if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selected = this.graph.nodes.map((n) => n.id);
    } else if (modifier && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      this.attempt(() => wrapLogic(this.graph, this.selected));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.removeSelection();
    } else if (this.selected.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 20 : 4;
      this.commit(
        moveLogicNodes(
          detachLogicData(this.graph, this.selected),
          this.selected,
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        ),
      );
    }
    this.requestUpdate();
  };
  private removeSelection(): void {
    if (this.bend) {
      const { edgeId, index } = this.bend;
      this.commit(this.withBendPoints(this.graph, edgeId, (points) => points.filter((_, i) => i !== index)));
      this.bend = undefined;
      return;
    }
    this.commit(removeLogic(this.graph, this.edgeId ? [this.edgeId] : this.selected));
    this.selected = [];
    this.edgeId = undefined;
  }
  private makeNode(kind: AddableLogicKind, method = ''): canvas.LogicNode {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    const base = {
      id: logicId(this.graph, kind),
      ...nextLogicPosition(this.graph, -this.viewOffset.x, -this.viewOffset.y, stage?.clientWidth ?? 800),
    };
    let node: canvas.LogicNode;
    if (kind === 'constant') node = { ...base, kind, value: { type: 'int', text: '0' } };
    else if (kind === 'variable')
      node = { ...base, kind, name: `变量${this.graph.nodes.filter((n) => n.kind === 'variable').length + 1}` };
    else if (kind === 'convert')
      node = {
        ...base,
        kind,
        value: { type: 'int', text: '0' },
        target: 'bytes',
        width: '8',
        endian: 'little',
        signed: false,
      };
    else if (kind === 'loop') node = { ...base, kind, count: '1' };
    else if (kind === 'method') node = { ...base, kind, method };
    else node = { ...base, kind };
    return node;
  }
  private add(kind: AddableLogicKind, method = ''): void {
    if (this.suppressLibraryClick) { this.suppressLibraryClick = false; return; }
    const node = this.makeNode(kind, method);
    this.selected = [node.id];
    this.edgeId = undefined;
    this.bend = undefined;
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, node] });
  }
  private insideStage(event: MouseEvent): boolean {
    const rect = this.renderRoot.querySelector('.stage')!.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
  }
  private startLibrary(event: PointerEvent, kind: AddableLogicKind, method?: string): void {
    if (event.button !== 0) return;
    this.cancelPointer();
    this.suppressLibraryClick = false;
    const point = this.point(event);
    const node = { ...this.makeNode(kind, method), x: point.x - 90, y: point.y - 38 };
    this.drag = { id: node.id, startX: point.x, startY: point.y,
      original: { ...this.graph, nodes: [...this.graph.nodes, node] }, baseline: this.graph,
      ids: [node.id], moved: false, library: true };
    this.selected = [node.id];
    this.edgeId = undefined;
    this.bend = undefined;
    this.listenPointer();
  }
  private withBendPoints(graph: canvas.LogicGraph, id: string,
    edit: (points: { x: number; y: number }[]) => { x: number; y: number }[]): canvas.LogicGraph {
    return { ...graph, edges: graph.edges.map((edge) => edge.id === id && edge.kind === 'flow'
      ? { ...edge, points: edit(edge.points ?? []) } : edge) };
  }
  private addBend(event: MouseEvent, edge: canvas.LogicEdge): void {
    if (edge.kind !== 'flow') return;
    event.preventDefault();
    event.stopPropagation();
    const p = this.point(event);
    const point = p;
    const index = logicPointInsertionIndex(this.graph, edge, point);
    this.edgeId = edge.id;
    this.selected = [];
    this.bend = { edgeId: edge.id, index };
    this.commit(this.withBendPoints(this.graph, edge.id, (points) => [...points.slice(0, index), point, ...points.slice(index)]));
  }
  private startBend(event: PointerEvent, edgeId: string, index: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus({ preventScroll: true });
    this.selected = [];
    this.edgeId = edgeId;
    this.bend = { edgeId, index };
    const point = this.point(event);
    this.bendDrag = { original: this.graph, startX: point.x, startY: point.y, moved: false };
    this.listenPointer();
    this.requestUpdate();
  }
  private addEdge(edge: canvas.LogicEdge): void {
    this.attempt(() => {
      const next = connectLogic(this.graph, edge);
      const old = new Set(canvas.validateLogicGraph(this.graph).map((i) => `${i.nodeId}:${i.message}`));
      const issue = canvas.validateLogicGraph(next).find((i) => !old.has(`${i.nodeId}:${i.message}`));
      if (issue) throw new Error(issue.message);
      return next;
    });
  }
  private chooseEdge(event: Event, id: string): void {
    event.stopPropagation();
    this.focus({ preventScroll: true });
    this.edgeId = id;
    this.bend = undefined;
    this.selected = [];
    this.requestUpdate();
  }
  private ports(node: canvas.LogicNode): TemplateResult | typeof nothing {
    if (!canvas.logicIsFlow(this.graph, node) || (node.kind === 'loop' && node.body)) return nothing;
    const startWire = (event: Event, outlet: 'next' | 'then' | 'else'): void => {
      if (event instanceof PointerEvent && event.button !== 0) return;
      event.stopPropagation();
      this.wiring = { id: node.id, outlet };
      this.message = '点击目标流程节点完成连接，Esc 取消';
      this.requestUpdate();
    };
    return html`${node.kind !== 'start'
      ? html`<button
          class="port port-in"
          aria-label="流程入口"
          @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}
        ></button>`
      : nothing}
    ${node.kind === 'branch'
      ? html`<span class="port-label then-label">true</span
          ><button
            class="port port-then"
            aria-label="true 分支"
            @pointerdown=${(e: Event) => startWire(e, 'then')}
          ></button
          ><span class="port-label else-label">false</span
          ><button
            class="port port-else"
            aria-label="false 分支"
            @pointerdown=${(e: Event) => startWire(e, 'else')}
          ></button>`
      : html`<button
          class="port port-out"
          aria-label="流程出口"
          @pointerdown=${(e: Event) => startWire(e, 'next')}
        ></button>`}`;
  }
  private edgeSvg(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult {
    const geometry = logicEdgeGeometry(graph, edge);
    return svg`<g data-edge=${edge.id} data-edge-kind=${edge.kind} class=${ghost ? 'ghost' : ''}>
      ${geometry.paths.map((d) => svg`<path class="${edge.kind === 'flow' ? 'flow-line' : 'reference-line'} ${this.edgeId === edge.id ? 'edge-selected' : ''}" d=${d} marker-end=${edge.kind === 'flow' ? 'url(#logic-arrow)' : nothing}></path>`)}
      ${!ghost && geometry.paths[0] ? svg`<path class="edge-hit" d=${geometry.paths[edge.kind === 'reference' ? 1 : 0]} @pointerdown=${(e: Event) => this.chooseEdge(e, edge.id)} @dblclick=${(e: MouseEvent) => this.addBend(e, edge)}></path>` : nothing}
      ${!ghost && edge.kind === 'flow' && this.edgeId === edge.id ? (edge.points ?? []).map((point, index) => svg`
        <circle class="bend-handle ${this.bend?.edgeId === edge.id && this.bend.index === index ? 'active' : ''}"
          cx=${point.x} cy=${point.y} r="6" tabindex="0" role="button" aria-label=${`转折点 ${index + 1}`}
          @pointerdown=${(event: PointerEvent) => this.startBend(event, edge.id, index)}
          @keydown=${(event: KeyboardEvent) => {
            if (['Delete', 'Backspace', 'Enter', ' '].includes(event.key)) {
              event.preventDefault(); event.stopPropagation(); this.bend = { edgeId: edge.id, index };
              if (event.key === 'Delete' || event.key === 'Backspace') this.removeSelection();
              this.requestUpdate();
            }
          }}></circle>`) : nothing}
    </g>`;
  }
  private relation(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult | typeof nothing {
    if (edge.kind !== 'data') return nothing;
    const p = logicEdgeGeometry(graph, edge);
    return html`<button
      data-edge=${edge.id}
      data-edge-kind="data"
      class="relation ${edge.op === 'assign' ? 'assignment' : edge.op === 'concat' ? 'concat' : ''} ${ghost
        ? 'ghost'
        : ''} ${this.edgeId === edge.id ? 'selected' : ''}"
      style=${styleMap({ left: `${p.x}px`, top: `${p.y}px`, width: `${LOGIC_RELATION_WIDTH}px` })}
      aria-label=${`数据连接 ${edge.op}`}
      @pointerdown=${(e: Event) => this.chooseEdge(e, edge.id)}
    >
      ${edge.op === 'assign' ? (logicBox(graph, edge.to).x <= logicBox(graph, edge.from).x ? '← 赋值' : '赋值 →') : edge.op === 'concat' ? '拼接 +' : edge.op}
    </button>`;
  }
  private renderNode(
    graph: canvas.LogicGraph,
    node: canvas.LogicNode,
    preview: ReadonlyMap<string, canvas.Value | string>,
  ): TemplateResult {
    const box = logicBox(graph, node.id),
      selected = this.selected.includes(node.id),
      snap = this.snap?.target === node.id;
    const attached = graph.nodes.filter(
      (n) => (n.kind === 'loop' && n.body === node.id) || (n.kind === 'convert' && n.input === node.id),
    );
    if (node.kind === 'envelope')
      return html`<div
        data-node=${node.id}
        data-kind="envelope"
        class="envelope ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''}"
        style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })}
      >
        <div class="envelope-header"><button class="envelope-title" @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}>
          ${node.title}
          [${node.category === 'data' ? (canvas.logicHasAssignment(graph, node.id) ? '数据 / 流程' : '数据') : '流程'}]
          </button>
          ${attached.map((n) => html`<button class="attachment ${this.selected.includes(n.id) ? 'selected' : ''} ${this.snap?.attachment === n.id ? 'ghost' : ''}"
            data-attachment=${n.id} aria-label=${`编辑 ${logicTitle(n, this.methods)}`}
            @pointerdown=${(e: PointerEvent) => { e.stopPropagation(); }}
            @click=${() => { this.selected = [n.id]; this.edgeId = undefined; this.bend = undefined; this.requestUpdate(); }}>
            ${logicTitle(n, this.methods)}${n.kind === 'loop' ? ` · ${n.count} 次` : ''}
          </button>`)}
        </div>${this.ports(node)}
      </div>`;
    const summary =
      node.kind === 'start'
        ? '全局定义完成后执行'
        : node.kind === 'loop'
          ? `${node.body ? '已附着' : '拖近流程包络附着'} · ${node.count} 次`
          : node.kind === 'branch'
            ? 'bool 引用 → true / false'
            : node.kind === 'method'
              ? '引用数据作为参数'
              : logicSummary(preview.get(node.id));
    return html`<div
      role="button"
      tabindex="0"
      data-node=${node.id}
      data-kind=${node.kind}
      aria-label=${logicTitle(node, this.methods)}
      aria-pressed=${selected}
      class="node ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''}"
      style=${styleMap({ left: `${box.x}px`, top: `${box.y}px` })}
      @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selected = [node.id];
          this.edgeId = undefined;
          this.requestUpdate();
        }
      }}
    >
      <span class="node-title">${logicTitle(node, this.methods)}</span
      ><span class="node-summary" title=${summary}>${summary}</span>${this.ports(node)}
    </div>`;
  }
  private inspector(): TemplateResult {
    const edge = this.graph.edges.find((e) => e.id === this.edgeId);
    if (edge)
      return html`<h3>连接属性</h3>
        <p>${edge.from} → ${edge.to}</p>
        ${edge.kind === 'flow' ? html`<p class="hint">双击连线添加转折点，拖动调整曲线；选中转折点后按 Delete 删除。</p>
          ${this.bend?.edgeId === edge.id ? html`<button @click=${() => this.removeSelection()}>删除转折点</button>` : nothing}` : nothing}
        ${edge.kind === 'data'
          ? html`<label
              >关系<select
                aria-label="关系"
                @change=${(e: Event) => {
                  const op = (e.target as HTMLSelectElement).value as canvas.LogicOperator;
                  const reverse = op === 'assign' && this.graph.nodes.some((n) => n.id === edge.from && n.kind === 'variable');
                  this.attempt(() => layoutLogicData({ ...this.graph, edges: this.graph.edges.map((item) => item.id === edge.id
                    ? { ...edge, op, from: reverse ? edge.to : edge.from, to: reverse ? edge.from : edge.to } : item) }, edge.to));
                }}
              >
                ${canvas.LOGIC_OPERATORS.map(
                  (op) =>
                    html`<option value=${op} .selected=${live(op === edge.op)}>
                      ${op === 'assign' ? '赋值（值 → 变量）' : op === 'concat' ? '拼接 +' : op === '*' ? '乘法 / 重复 *' : op}
                    </option>`,
                )}
              </select></label
            >`
          : edge.kind === 'reference'
            ? html`<label
                >引用端口<select
                  aria-label="引用端口"
                  @change=${(e: Event) =>
                    this.commit({
                      ...this.graph,
                      edges: this.graph.edges.map((item) =>
                        item.id === edge.id ? { ...edge, port: (e.target as HTMLSelectElement).value } : item,
                      ),
                    })}
                >
                  ${this.referencePorts(edge.to).map(
                    (port) => html`<option value=${port} .selected=${live(port === edge.port)}>${port}</option>`,
                  )}
                </select></label
              >`
            : html`<p>运行方向：${edge.outlet === 'next' ? '下一步' : edge.outlet === 'then' ? 'true' : 'false'}</p>`}
        <button @click=${() => this.removeSelection()}>删除连接</button>`;
    const node = this.selected.length === 1 ? this.graph.nodes.find((n) => n.id === this.selected[0]) : undefined;
    if (!node)
      return html`<h3>属性</h3>
        <p class="hint">
          ${this.selected.length
            ? `已选择 ${this.selected.length} 个节点，可创建包络。`
            : '点击节点或连接编辑属性。Shift 点击多选，空白处拖动平移，Shift 拖动框选。'}
        </p>`;
    const host = logicAttachmentHost(node);
    const connectionNode = this.graph.nodes.find((n) => n.id === host) ?? node;
    const targets = this.graph.nodes.filter((n) => n.id !== connectionNode.id && !logicAttachmentHost(n));
    const targetId = targets.some((n) => n.id === this.targetId) ? this.targetId : '';
    return html`<h3>${logicTitle(node, this.methods)}</h3>
      ${new LogicNodeFields(
        this.graph,
        this.methods,
        (graph) => this.commit(graph),
        (message) => {
          this.message = message;
          this.requestUpdate();
        },
      ).render(node)}
      ${host ? html`<p class="hint">连接将使用所属包络。</p>` : nothing}
      <label
        >连接到<select
          aria-label="连接到"
          @change=${(e: Event) => {
            this.targetId = (e.target as HTMLSelectElement).value;
            this.requestUpdate();
          }}
        >
          <option value="" .selected=${live(targetId === '')}>选择节点</option>
          ${targets.map((n) => html`<option value=${n.id} .selected=${live(n.id === targetId)}>${logicTitle(n, this.methods)} (${n.id})</option>`)}
        </select></label
      ><button
        ?disabled=${!targetId}
        @click=${() => {
          const target = targets.find((n) => n.id === targetId);
          const edge = target && createLogicEdge(this.graph, connectionNode, target, this.methods);
          if (edge) this.addEdge(edge);
          else {
            this.message = '这两个节点之间没有可用连接';
            this.requestUpdate();
          }
        }}
      >
        建立连接
      </button>
      <p class="hint">拖动数据节点预脱离原连接，松开后固定间距排列；Esc 恢复。赋值由值指向变量。</p>
      ${this.graph.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map(
          (e) =>
            html`<button
              @click=${() => {
                this.edgeId = e.id;
                this.selected = [];
                this.requestUpdate();
              }}
            >
              ${e.kind === 'reference' ? `引用 ${e.port}` : e.kind === 'data' ? e.op : e.outlet} ·
              ${e.from === node.id ? e.to : e.from}
            </button>`,
        )}`;
  }
  private referencePorts(id: string): string[] {
    const node = this.graph.nodes.find((n) => n.id === id);
    return node?.kind === 'branch'
      ? ['condition']
      : node?.kind === 'loop'
        ? ['count']
        : node?.kind === 'method'
          ? (this.methods.find((m) => m.id === node.method)?.params.map((p) => p.name) ?? [])
          : [];
  }
  override render(): TemplateResult {
    if (!this.graph) return html``;
    const graph = this.snap?.attachment ? this.snap.graph : this.draft ?? this.graph,
      preview = canvas.previewLogicGraph(graph);
    return html`<section class="workspace" @contextmenu=${this.openMenu}>
      <div class="toolbar">
        <button
          @click=${() => this.attempt(() => wrapLogic(this.graph, this.selected))}
          ?disabled=${!this.selected.length}
        >
          包络</button
        ><button @click=${() => this.removeSelection()} ?disabled=${!this.selected.length && !this.edgeId}>删除</button
        ><button @click=${() => this.emit('logic-undo')} ?disabled=${!this.canUndo}>撤销</button
        ><button @click=${() => this.emit('logic-redo')} ?disabled=${!this.canRedo}>重做</button
        ><button ?disabled=${!this.canCopy} @click=${() => this.copySelection()}>复制</button
        ><button ?disabled=${!this.canCopy} @click=${() => this.copySelection(true)}>剪切</button
        ><button @click=${() => this.pasteClipboard()}>粘贴</button
        ><button @click=${() => this.emit('logic-import')}>导入</button
        ><button @click=${() => this.emit('logic-export')}>导出</button
        ><button class="btn-run" @click=${() => this.emit('logic-run')} ?disabled=${this.issues.length > 0}>运行</button
        ><span class="status"
          >${graph.nodes.length} 节点 · ${graph.edges.length} 连接 · ${this.issues.length} 问题</span
        >
      </div>
      <div class="body">
        ${renderLogicLibrary({ state: this.libraryState, methods: this.methods,
          change: (state) => {
            const previous = this.libraryState.category;
            this.libraryState = state;
            this.requestUpdate();
            void this.updateComplete.then(() => {
              const options = this.renderRoot.querySelector('.library-options');
              if (options) options.scrollTop = 0;
              if (state.category !== previous) {
                this.renderRoot.querySelector<HTMLElement>(state.category ? '.library-back' : `.library-category[data-category="${previous}"]`)?.focus();
              }
            });
          },
          add: (kind, method) => this.add(kind, method),
          drag: (event, kind, method) => this.startLibrary(event, kind, method),
        })}
        <div class=${this.pan ? 'stage panning' : 'stage'} tabindex="0" aria-label="节点画布" @pointerdown=${this.startStage} @wheel=${this.panWheel}>
          <svg class="grid" width="100%" height="100%" aria-hidden="true">
            <defs><pattern id="logic-dots" width="20" height="20" patternUnits="userSpaceOnUse"
              x=${this.viewOffset.x % 20} y=${this.viewOffset.y % 20}>
              <rect width="1" height="1" fill="var(--p2b-line)"></rect>
            </pattern></defs>
            <rect width="100%" height="100%" fill="url(#logic-dots)"></rect>
          </svg>
          <div class="surface" style=${styleMap({ transform: `translate(${this.viewOffset.x}px, ${this.viewOffset.y}px)` })}>
            <svg class="wires reference-wires" width="100%" height="100%" aria-label="引用连接">
              ${graph.edges.filter((e) => e.kind === 'reference').map((e) => this.edgeSvg(graph, e))}
              ${this.snap?.edge?.kind === 'reference' ? this.edgeSvg(this.snap.graph, this.snap.edge, true) : nothing}
            </svg>
            <svg class="wires flow-wires" width="100%" height="100%" aria-label="流程连接">
              <defs>
                <marker id="logic-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M 0 0 L 6 3.5 L 0 7" fill="none" stroke="var(--p2b-fg)"></path>
                </marker>
              </defs>
              ${graph.edges.filter((e) => e.kind === 'flow').map((e) => this.edgeSvg(graph, e))}
              ${this.snap?.edge?.kind === 'flow' ? this.edgeSvg(this.snap.graph, this.snap.edge, true) : nothing}
            </svg>
            ${graph.nodes
              .filter((n) => n.kind === 'envelope')
              .map((n) => this.renderNode(graph, n, preview))}${graph.nodes
              .filter((n) => n.kind !== 'envelope' && !logicAttachmentHost(n))
              .map((n) => this.renderNode(graph, n, preview))}${graph.edges.map((e) => this.relation(graph, e))}${this
              .snap?.edge
              ? this.relation(this.snap.graph, this.snap.edge, true)
              : nothing}
            ${this.snap?.attachment
              ? html`<div
                  class="attachment ghost"
                  style=${styleMap({
                    position: 'absolute',
                    left: `${logicBox(graph, this.snap.target).x}px`,
                    top: `${logicBox(graph, this.snap.target).y - 20}px`,
                  })}
                >
                  松开附着
                </div>`
              : nothing}
            ${this.marquee
              ? html`<div
                  class="marquee"
                  style=${styleMap({
                    left: `${Math.min(this.marquee.x, this.marquee.endX)}px`,
                    top: `${Math.min(this.marquee.y, this.marquee.endY)}px`,
                    width: `${Math.abs(this.marquee.x - this.marquee.endX)}px`,
                    height: `${Math.abs(this.marquee.y - this.marquee.endY)}px`,
                  })}
                ></div>`
              : nothing}
          </div>
        </div>
        <aside class="inspector" aria-label="属性">${this.inspector()}</aside>
      </div>
      <div class="feedback" role="status">
        ${this.message ? html`<div>${this.message}</div>` : nothing}${this.issues.map(
          (i) => html`<div class="error"><button @click=${() => this.locate(i.nodeId)}>${i.message}</button></div>`,
        )}${!this.issues.length && !this.message
          ? '先定义全局变量，再连接开始流程。数据包络含赋值时，也可接入流程。'
          : nothing}
        ${this.steps.length
          ? html`<details class="steps">
              <summary>执行步骤与变量 (${this.steps.length})</summary>
              <table>
                <tbody>
                  ${this.steps.map(
                    (s) =>
                      html`<tr>
                        <td><button @click=${() => this.locate(s.nodeId)}>${s.step + 1} · ${s.nodeId}</button></td>
                        <td>
                          ${Object.entries(s.rounds)
                            .map(([id, round]) => `${id} 第 ${round + 1} 轮`)
                            .join(' / ')}
                        </td>
                        <td>${s.variables.map((v) => `${v.name} = ${logicSummary(v.value)}`).join('；')}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </details>`
          : nothing}
      </div>
      ${this.contextMenu()}
    </section>`;
  }
}
customElements.define('pwn2block-logic-canvas', LogicCanvasElement);
