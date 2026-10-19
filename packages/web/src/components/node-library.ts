import { LitElement, css, html, nothing } from 'lit';
import {
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_IDS,
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
 * 节点库（10 §4）：七个一级分类 + 搜索 + 只读预览 + 拖拽添加。
 *
 * 组件只读节点目录、只发事件：
 * - `p2b-library-add`：点击或键盘添加；落点由父组件决定。
 * - `p2b-library-dragstart/dragmove/dragend`：拖拽全过程，父组件按落点建节点。
 * - `p2b-library-preview`：预览打开/关闭，供状态栏提示。
 *
 * 预览走 `renderStaticNode`，与画布上的节点同一套外观；它只调用目录里的纯函数，
 * 不执行 Python、不发起请求。展开状态是纯便利数据，存不进去只影响下次打开。
 */

/** 展开状态的存储键名（值是分类 id → 是否展开的 JSON 对象）。 */
export const LIBRARY_EXPANDED_KEY = 'p2b:library:expanded';

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

export interface LibraryPreviewDetail {
  readonly kind: string | undefined;
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

/** 默认全部展开；读不到或读到坏数据时也用它。 */
function defaultExpansion(): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  for (const id of LIBRARY_CATEGORY_IDS) expanded[id] = true;
  return expanded;
}

/** 读展开状态：只接受布尔值，坏 JSON / 非对象 / 缺字段都回退到默认展开。 */
function readExpansion(store: KeyValueStore | undefined): Record<string, boolean> {
  const expanded = defaultExpansion();
  if (store === undefined) return expanded;
  let raw: string | null;
  try {
    raw = store.getItem(LIBRARY_EXPANDED_KEY);
  } catch {
    return expanded;
  }
  if (raw === null || raw === '') return expanded;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return expanded;
    const record = parsed as Record<string, unknown>;
    for (const id of LIBRARY_CATEGORY_IDS) {
      const value = record[id];
      if (typeof value === 'boolean') expanded[id] = value;
    }
  } catch {
    return defaultExpansion();
  }
  return expanded;
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
        padding: 0.4rem;
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

      .group {
        border-bottom: 1px solid var(--p2b-line);
      }

      .group > summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
        padding: 0.2rem 0.4rem;
        cursor: pointer;
      }

      .group > summary:hover {
        color: var(--p2b-bg);
        background: var(--p2b-fg);
      }

      .group > summary:hover h3,
      .group > summary:hover .count {
        color: var(--p2b-bg);
      }

      .group h3 {
        margin: 0;
      }

      .count {
        color: var(--p2b-dim);
      }

      .section-title {
        margin: 0;
        padding: 0.2rem 0.6rem 0.1rem;
        color: var(--p2b-dim);
        font-size: inherit;
        font-weight: 700;
      }

      .entry {
        display: block;
        width: 100%;
        min-height: 1.9rem;
        padding: 0.2rem 0.6rem;
        border: 0;
        border-top: 1px dotted var(--p2b-line);
        border-radius: 0;
        text-align: left;
      }

      .entry-label,
      .match-path {
        display: block;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .match-path {
        color: var(--p2b-dim);
      }

      .entry:hover .match-path {
        color: var(--p2b-bg);
      }

      .preview {
        position: sticky;
        bottom: 0;
        margin-top: auto;
        padding: 0.4rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
        background: var(--p2b-bg);
        /* 纯只读信息：不接指针事件，否则会挡住滚动到底部的节点条目（10 §4）。 */
        pointer-events: none;
      }

      .preview-summary {
        margin: 0.35rem 0 0;
        color: var(--p2b-dim);
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
  /** 展开状态的键值存储；缺省时尝试 `defaultStore()`。 */
  declare store: KeyValueStore | undefined;
  /** 可选的阶段说明，例如「按当前学习阶段可用」。 */
  declare stageLabel: string | undefined;

  private expanded: Record<string, boolean> = defaultExpansion();
  private expansionLoaded = false;
  private loadedStore: KeyValueStore | undefined;
  private fallbackStore: KeyValueStore | undefined;
  private fallbackResolved = false;
  private query = '';
  private previewKind: string | undefined;
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
    if (this.expansionLoaded && this.loadedStore === store) return;
    this.loadedStore = store;
    this.expansionLoaded = true;
    this.expanded = readExpansion(store);
  }

  override render() {
    const preview = this.previewSpec();
    return html`<div class="library" @keydown=${this.onKeyDown}>
      <div class="search">
        <input
          type="search"
          aria-label="搜索节点"
          placeholder="搜索节点"
          .value=${this.query}
          @input=${this.onSearchInput}
        />
        ${this.stageLabel === undefined || this.stageLabel === ''
          ? nothing
          : html`<p class="stage-note">${this.stageLabel}</p>`}
      </div>
      ${this.query.trim() === '' ? this.renderGroups() : this.renderMatches()}
      ${preview === undefined ? nothing : this.renderPreview(preview)}
    </div>`;
  }

  // -------------------------------------------------------------------------
  // 分类与搜索
  // -------------------------------------------------------------------------

  private renderGroups() {
    const groups = new Map(libraryGroups(this.specs).map((group) => [group.id, group]));
    return html`${LIBRARY_CATEGORIES.map((category) => {
      const group = groups.get(category.id);
      return this.renderGroup(category.id, category.label, category.summary, group?.sections ?? []);
    })}`;
  }

  private renderGroup(
    id: string,
    label: string,
    summary: string,
    sections: readonly { readonly name?: string; readonly entries: readonly { readonly kind: string; readonly label: string }[] }[],
  ) {
    const count = sections.reduce((total, section) => total + section.entries.length, 0);
    // 只有真的存在二级目录时才显示标题：唯一且无名的分组直接平铺。
    const showSectionNames =
      sections.length > 1 || (sections.length === 1 && (sections[0]?.name ?? '') !== '');
    return html`<details
      class="group"
      data-category=${id}
      ?open=${this.expanded[id] ?? true}
      @toggle=${(event: Event) => this.onGroupToggle(id, event)}
    >
      <summary title=${summary}>
        <h3>${label}</h3>
        <span class="count">${count}</span>
      </summary>
      ${count === 0
        ? html`<p class="empty">暂无可用节点</p>`
        : sections.map(
            (section) => html`
              ${showSectionNames && (section.name ?? '') !== ''
                ? html`<h4 class="section-title">${section.name}</h4>`
                : nothing}
              ${section.entries.map((entry) => this.renderEntry(entry.kind, entry.label))}
            `,
          )}
    </details>`;
  }

  private renderMatches() {
    const matches = searchLibrary(this.specs, this.query);
    if (matches.length === 0) return html`<p class="empty">没有匹配的节点</p>`;
    return html`<div class="matches">
      ${matches.map((match) => this.renderEntry(match.kind, match.label, match.path))}
    </div>`;
  }

  private renderEntry(kind: string, label: string, path?: string) {
    return html`<button
      type="button"
      class="entry"
      data-kind=${kind}
      @click=${(event: MouseEvent) => this.onEntryClick(event, kind)}
      @pointerdown=${(event: PointerEvent) => this.onPointerDown(event, kind)}
      @pointermove=${(event: PointerEvent) => this.onPointerMove(event)}
      @pointerup=${(event: PointerEvent) => this.onPointerUp(event)}
      @pointercancel=${(event: PointerEvent) => this.onPointerCancel(event)}
      @pointerenter=${() => this.showPreview(kind)}
      @pointerleave=${() => this.hidePreview(kind)}
      @focus=${() => this.showPreview(kind)}
      @blur=${() => this.hidePreview(kind)}
    >
      <span class="entry-label">${label}</span>
      ${path === undefined ? nothing : html`<span class="match-path">${path}</span>`}
    </button>`;
  }

  private onSearchInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (value === this.query) return;
    this.query = value;
    this.hidePreview();
    this.requestUpdate();
  }

  private onGroupToggle(id: string, event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement | null;
    if (details === null) return;
    const open = details.open;
    if ((this.expanded[id] ?? true) === open) return;
    this.expanded = { ...this.expanded, [id]: open };
    this.persistExpansion();
    this.requestUpdate();
  }

  // -------------------------------------------------------------------------
  // 只读预览
  // -------------------------------------------------------------------------

  private previewSpec(): NodeKindSpec | undefined {
    const kind = this.previewKind;
    if (kind === undefined) return undefined;
    return this.specs.find((spec) => spec.kind === kind) ?? nodeSpec(kind);
  }

  private showPreview(kind: string): void {
    if (this.drag !== undefined) return;
    if (this.previewKind === kind) return;
    const spec = this.specs.find((candidate) => candidate.kind === kind) ?? nodeSpec(kind);
    if (spec === undefined) return;
    this.previewKind = kind;
    this.emit<LibraryPreviewDetail>('p2b-library-preview', { kind });
    this.requestUpdate();
  }

  private hidePreview(kind?: string): void {
    if (this.previewKind === undefined) return;
    if (kind !== undefined && this.previewKind !== kind) return;
    this.previewKind = undefined;
    this.emit<LibraryPreviewDetail>('p2b-library-preview', { kind: undefined });
    this.requestUpdate();
  }

  /** 预览只用目录里的纯函数：不执行 Python，也不发起请求。 */
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
    return html`<section class="preview" aria-label="节点预览">
      ${renderStaticNode({
        title: spec.label,
        rows,
        footer: truncated ? '… 只读预览，不执行代码' : '只读预览，不执行代码',
      })}
      <p class="preview-summary">${spec.summary}</p>
    </section>`;
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
      this.hidePreview();
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

  private persistExpansion(): void {
    const store = this.storeOrFallback();
    if (store === undefined) return;
    try {
      store.setItem(LIBRARY_EXPANDED_KEY, JSON.stringify(this.expanded));
    } catch {
      // 配额满 / 被禁写：展开状态丢了，但节点库本身必须继续可用。
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
