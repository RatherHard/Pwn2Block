import { LitElement, css, html, nothing } from 'lit';
import {
  LIBRARY_CATEGORIES,
  defaultParams,
  libraryGroups,
  nodeInputs,
  nodeOutput,
  nodeParams,
  nodeSpec,
  searchLibrary,
} from '@pwn2block/shared';
import type { NodeKindSpec, ParamSpec, ParamValue, PortContext } from '@pwn2block/shared';
import { defaultStore, type KeyValueStore } from '../viewmodel/storage';
import { nodeSkin, renderStaticNode } from './node-skin';
import type { StaticNodeRow } from './node-skin';
import { sharedStyles, terminalTheme } from '../theme';

/**
 * 节点库（10 §4）：两级目录（分类 → 节点） + 搜索 + 只读预览 + 拖拽添加。
 *
 * 组件只读节点目录、只发事件：
 * - `p2b-library-add`：点击或键盘添加；落点由父组件决定。
 * - `p2b-library-dragstart/dragmove/dragend`：拖拽全过程，父组件按落点建节点。
 *
 * 预览走 `renderStaticNode`，与画布上的节点同一套外观；它只调用目录里的纯函数，
 * 不执行任何代码、不发起请求。目录路径是纯便利数据，存不进去只影响下次打开。
 */

/** 独立于旧版折叠状态，保存当前目录路径。 */
export const LIBRARY_PATH_KEY = 'p2b:library:path';

/** 超过 4px 才算拖拽，避免点击时手抖被当成拖拽。 */
const DRAG_THRESHOLD = 4;

/** 预览里最多列出几个参数；其余用「…」收尾。 */
const PREVIEW_PARAM_LIMIT = 4;

export interface LibraryAddDetail {
  readonly kind: string;
}

export interface LibraryDragStartDetail {
  readonly kind: string;
  readonly clientX: number;
  readonly clientY: number;
}

export interface LibraryDragMoveDetail {
  readonly kind: string;
  readonly clientX: number;
  readonly clientY: number;
}

export interface LibraryDragEndDetail extends LibraryDragMoveDetail {
  readonly canceled: boolean;
}

interface DragState {
  readonly kind: string;
  readonly startX: number;
  readonly startY: number;
  readonly pointerId: number | undefined;
  readonly capture: HTMLElement | undefined;
  lastX: number;
  lastY: number;
  active: boolean;
}

/** 目录路径最多两级；过期路径在 willUpdate 中回退到可用的父目录。 */
function readPath(store: KeyValueStore | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(LIBRARY_PATH_KEY) ?? '[]');
    return Array.isArray(parsed) && parsed.length <= 2 && parsed.every((part) => typeof part === 'string')
      ? parsed as string[]
      : [];
  } catch {
    return [];
  }
}

/** 参数默认值的短摘要：长文本截断，数组用顿号连接。 */
function summarizeParam(param: ParamSpec, value: ParamValue | undefined): string {
  const actual = value ?? param.default;
  let text: string;
  if (typeof actual === 'string') text = actual;
  else if (typeof actual === 'number') text = String(actual);
  else text = actual.join('、');
  if (text === '') return '（空）';
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

export class Pwn2BlockNodeLibrary extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    nodeSkin,
    css`
      :host {
        display: block;
        height: 100%;
        overflow: auto;
        scrollbar-color: var(--p2b-line) transparent;
      }

      :host([data-dragging]) {
        user-select: none;
        -webkit-user-select: none;
      }

      .library {
        display: flex;
        flex-direction: column;
        min-height: 100%;
      }

      .search {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        padding: 0.5rem;
        border-bottom: 1px solid var(--p2b-line);
        background: var(--p2b-bg);
      }

      .search input[type='search'] {
        width: 100%;
        min-height: 2rem;
        padding: 0.3rem 0.55rem;
        border: var(--p2b-border) solid var(--p2b-line);
        border-radius: 0;
        color: var(--p2b-fg);
        background: var(--p2b-bg);
        outline: none;
      }

      .search input[type='search']:focus {
        border-color: var(--p2b-focus);
      }

      .stage-note {
        margin: 0;
        color: var(--p2b-dim);
      }

      button::before,
      button::after {
        content: none;
      }
      .navigation {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .back {
        width: 100%;
        text-align: left;
      }
      .path,
      .match-path,
      .preview-summary {
        margin: 0;
        color: var(--p2b-dim);
        overflow-wrap: anywhere;
      }
      .directory,
      .matches {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.5rem;
      }
      .folder {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.65rem 0.5rem;
        text-align: left;
      }
      .folder-label {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .count {
        flex: none;
      }
      .entry {
        display: block;
        width: 100%;
        padding: 0.35rem;
        text-align: left;
        touch-action: pan-y;
      }
      button:is(:hover, :active, :focus-visible):not(:disabled) {
        background: var(--p2b-fg);
        color: var(--p2b-bg);
        border-color: var(--p2b-focus);
      }
      button:is(:hover, :active, :focus-visible):not(:disabled) * {
        color: var(--p2b-bg);
        border-color: var(--p2b-bg);
      }
      .entry:is(:hover, :active, :focus-visible) .static-node,
      .entry:is(:hover, :active, :focus-visible) .node-head {
        background: var(--p2b-fg);
      }
      .entry:focus-visible {
        outline: 2px solid var(--p2b-focus);
        outline-offset: 1px;
      }
      .node-title {
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .static-node .node-head {
        cursor: grab;
      }
      .preview-summary,
      .match-path {
        display: block;
        margin-top: 0.35rem;
      }
    `,
  ];

  static override properties = {
    specs: { attribute: false },
    context: { attribute: false },
    store: { attribute: false },
    stageLabel: { attribute: false },
  };

  /** 当前可用节点；父组件按题目权限与学习阶段筛好后传入。 */
  declare specs: readonly NodeKindSpec[];
  /** 端口推导上下文（题目位宽 / 出题人积木）。 */
  declare context: PortContext | undefined;
  /** 当前目录的键值存储；缺省时尝试 `defaultStore()`。 */
  declare store: KeyValueStore | undefined;
  /** 可选的阶段说明，例如「按当前学习阶段可用」。 */
  declare stageLabel: string | undefined;

  private path: string[] = [];
  private pathLoaded = false;
  private loadedStore: KeyValueStore | undefined;
  private fallbackStore: KeyValueStore | undefined;
  private fallbackResolved = false;
  private query = '';
  private drag: DragState | undefined;
  /** 拖拽后浏览器还会补一个 click；用它拦住那次添加，下一次 pointerdown 重置。 */
  private suppressClick = false;

  constructor() {
    super();
    this.specs = [];
    this.context = undefined;
    this.store = undefined;
    this.stageLabel = undefined;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.drag = undefined;
    this.removeAttribute('data-dragging');
    window.removeEventListener('keydown', this.onKeyDown);
  }

  override willUpdate(): void {
    const store = this.storeOrFallback();
    if (!this.pathLoaded || this.loadedStore !== store) {
      this.loadedStore = store;
      this.pathLoaded = true;
      this.path = readPath(store);
    }
    // 旧目录路径可能包含子分类；新目录最多只保留一级分类。
    this.path = this.path.slice(0, 1);
    if (!libraryGroups(this.specs).some((group) => group.id === this.path[0])) this.path = [];
  }

  override render() {
    const category = LIBRARY_CATEGORIES.find((item) => item.id === this.path[0]);
    const searching = this.query.trim() !== '';
    const pathLabel = ['节点库', category?.label].filter(Boolean).join(' / ');
    return html`<div class="library" @keydown=${this.onKeyDown}>
      <div class="search">
        <nav class="navigation" aria-label="节点库目录">
          ${this.path.length === 0 && !searching ? nothing : html`<button
            type="button" class="back"
            @click=${() => searching ? this.clearSearch() : this.navigate(this.path.slice(0, -1))}
          >${searching ? '返回目录' : '返回上一级'}</button>`}
          <p class="path" aria-live="polite">${searching ? '搜索结果 · 全部节点' : pathLabel}</p>
        </nav>
        <input type="search" aria-label="搜索节点" placeholder="搜索全部节点"
          .value=${this.query} @input=${this.onSearchInput} />
        ${this.stageLabel === undefined || this.stageLabel === ''
          ? nothing : html`<p class="stage-note">${this.stageLabel}</p>`}
      </div>
      ${searching ? this.renderMatches() : this.renderDirectory()}
    </div>`;
  }

  private renderDirectory() {
    const groups = libraryGroups(this.specs);
    const group = groups.find((candidate) => candidate.id === this.path[0]);
    if (groups.length === 0) return html`<p class="empty">暂无可用节点</p>`;
    if (group === undefined) {
      return html`<div class="directory">${groups.map((category) => {
        const count = category.sections.reduce((total, section) => total + section.entries.length, 0);
        return html`<button class="folder" type="button" data-category=${category.id}
          aria-label=${category.label} title=${category.summary}
          @click=${() => this.navigate([category.id])}>
          <span class="folder-label">${category.label}</span><span class="count">${count}</span>
          <span aria-hidden="true">›</span>
        </button>`;
      })}</div>`;
    }
    return html`<div class="directory">
      ${group.sections.flatMap((section) => section.entries).map((entry) => this.renderEntry(entry.kind, entry.label))}
    </div>`;
  }

  private navigate(path: string[]): void {
    this.path = path;
    this.persistPath();
    this.resetDirectoryView();
  }

  private clearSearch(): void {
    this.query = '';
    this.resetDirectoryView();
  }

  private resetDirectoryView(): void {
    this.scrollTop = 0;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.back, .folder, .entry')?.focus({ preventScroll: true });
    });
  }

  private renderMatches() {
    const matches = searchLibrary(this.specs, this.query);
    if (matches.length === 0) return html`<p class="empty">没有匹配的节点</p>`;
    return html`<div class="matches">
      ${matches.map((match) => this.renderEntry(match.kind, match.label, match.path))}
    </div>`;
  }

  private renderEntry(kind: string, label: string, path?: string) {
    const spec = this.specs.find((candidate) => candidate.kind === kind) ?? nodeSpec(kind);
    if (spec === undefined) return nothing;
    return html`<button
      type="button"
      class="entry"
      data-kind=${kind}
      aria-label=${label}
      title="点击添加，或拖入画布"
      @click=${(event: MouseEvent) => this.onEntryClick(event, kind)}
      @pointerdown=${(event: PointerEvent) => this.onPointerDown(event, kind)}
      @pointermove=${(event: PointerEvent) => this.onPointerMove(event)}
      @pointerup=${(event: PointerEvent) => this.onPointerUp(event)}
      @pointercancel=${(event: PointerEvent) => this.onPointerCancel(event)}
    >
      ${this.renderPreview(spec)}
      ${path === undefined ? nothing : html`<span class="match-path">${path}</span>`}
    </button>`;
  }

  private onSearchInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (value === this.query) return;
    this.query = value;
    this.scrollTop = 0;
    this.requestUpdate();
  }

  /** 预览只用目录里的纯函数：不执行代码，也不发起请求。 */
  private renderPreview(spec: NodeKindSpec) {
    const params = defaultParams(spec);
    const context = this.context ?? { archBits: 64 };
    const inputs = nodeInputs(spec, params, context);
    const output = nodeOutput(spec, params);
    const declared = nodeParams(spec, params);
    const shown = declared.slice(0, PREVIEW_PARAM_LIMIT);
    const truncated = declared.length > PREVIEW_PARAM_LIMIT;
    const rows: StaticNodeRow[] = [
      ...inputs.map((input) => ({ kind: 'in' as const, label: input.label, type: input.type })),
      ...(output === undefined
        ? []
        : [{ kind: 'out' as const, label: output.label, type: output.type }]),
      ...shown.map((param) => ({
        kind: 'param' as const,
        label: param.label,
        value: summarizeParam(param, params[param.name]),
      })),
    ];
    return html`<div class="preview">
      ${renderStaticNode({
        title: spec.label,
        rows,
        footer: truncated ? '… 更多参数可在添加后配置' : undefined,
      })}
      <p class="preview-summary">${spec.summary}</p>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // 添加与拖拽
  // -------------------------------------------------------------------------

  private onEntryClick(event: MouseEvent, kind: string): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      // 拖拽结束后浏览器补发的 click（detail > 0）不能变成一次添加。
      if (event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    this.emit<LibraryAddDetail>('p2b-library-add', { kind });
  }

  private onPointerDown(event: PointerEvent, kind: string): void {
    if (event.button !== 0) return;
    this.suppressClick = false;
    const capture = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    this.drag = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      capture,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
    };
    if (
      capture !== undefined &&
      typeof capture.setPointerCapture === 'function' &&
      typeof event.pointerId === 'number'
    ) {
      try {
        capture.setPointerCapture(event.pointerId);
      } catch {
        // jsdom 等环境没有指针捕获：收不到移动事件时就是不拖拽，不影响点击。
      }
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === undefined) return;
    if (
      drag.pointerId !== undefined &&
      event.pointerId !== undefined &&
      drag.pointerId !== event.pointerId
    ) {
      return;
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance <= DRAG_THRESHOLD) return;
      drag.active = true;
      this.toggleAttribute('data-dragging', true);
      window.addEventListener('keydown', this.onKeyDown);
      this.suppressClick = true;
      this.emit<LibraryDragStartDetail>('p2b-library-dragstart', {
        kind: drag.kind,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }

    this.emit<LibraryDragMoveDetail>('p2b-library-dragmove', {
      kind: drag.kind,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === undefined) return;
    if (
      drag.pointerId !== undefined &&
      event.pointerId !== undefined &&
      drag.pointerId !== event.pointerId
    ) {
      return;
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.active) {
      this.drag = undefined;
      this.releaseCapture(drag);
      return;
    }
    this.finishDrag(drag, false, event.clientX, event.clientY);
  }

  private onPointerCancel(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === undefined) return;
    if (
      drag.pointerId !== undefined &&
      event.pointerId !== undefined &&
      drag.pointerId !== event.pointerId
    ) {
      return;
    }
    this.finishDrag(drag, true, drag.lastX, drag.lastY);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const drag = this.drag;
    if (drag === undefined) return;
    if (drag.active) event.preventDefault();
    this.finishDrag(drag, true, drag.lastX, drag.lastY);
  };

  private finishDrag(drag: DragState, canceled: boolean, clientX: number, clientY: number): void {
    this.drag = undefined;
    this.releaseCapture(drag);
    if (drag.active) {
      this.suppressClick = true;
      this.emit<LibraryDragEndDetail>('p2b-library-dragend', {
        kind: drag.kind,
        clientX,
        clientY,
        canceled,
      });
    }
    this.removeAttribute('data-dragging');
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private releaseCapture(drag: DragState): void {
    if (
      drag.capture === undefined ||
      typeof drag.capture.releasePointerCapture !== 'function' ||
      typeof drag.pointerId !== 'number'
    ) {
      return;
    }
    try {
      drag.capture.releasePointerCapture(drag.pointerId);
    } catch {
      // 捕获早已释放或元素被移除：没有需要补救的状态。
    }
  }

  // -------------------------------------------------------------------------
  // 存储与事件
  // -------------------------------------------------------------------------

  private storeOrFallback(): KeyValueStore | undefined {
    if (this.store !== undefined) return this.store;
    if (!this.fallbackResolved) {
      this.fallbackResolved = true;
      this.fallbackStore = defaultStore();
    }
    return this.fallbackStore;
  }

  private persistPath(): void {
    const store = this.storeOrFallback();
    if (store === undefined) return;
    try {
      store.setItem(LIBRARY_PATH_KEY, JSON.stringify(this.path));
    } catch {
      // 配额满 / 被禁写：目录路径丢了，但节点库本身必须继续可用。
    }
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }
}

customElements.define('pwn2block-node-library', Pwn2BlockNodeLibrary);
declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-node-library': Pwn2BlockNodeLibrary;
  }
}
