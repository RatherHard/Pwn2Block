import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { CANVAS_CATEGORY_LABELS } from '../canvas/catalog';
import type { CanvasNodeCategory } from '../canvas/catalog';
import {
  libraryItems,
  libraryPageOf,
  libraryTabsOf,
  tiersOf,
  type LibraryItem,
  type LibraryPageView,
  type LibraryState,
  type LibraryTab,
} from './canvas-panel-library-model';
import { renderLibraryPreview } from './canvas-panel-library-preview';

/**
 * 左侧节点库（需求「左侧节点库要有分页分级和节点预览」）。
 *
 * 自上而下：常用动作 → 搜索 → 分类标签页 → 分级列表（分类 h3 → 小类 → 条目）→ 翻页 → 预览。
 * 可见性全部来自 `libraryPageOf`，这里只负责把「可见集合」翻成 `hidden`，不自己筛选。
 *
 * 两种放置方式：
 * - **点击**：放到画布空位（与旧工具箱一致，单测与浏览器回归都走这条）；
 * - **拖到画布**：放在松手处；流程语句落在流程带上会直接排进那一步（见 `canvas-panel-library-drop`）。
 *
 * 搜索框里按 Enter 放第一项、Esc 清空；所以「找节点 → 放节点」全程可以不碰鼠标。
 */

/** 节点库需要的状态与回调（面板外壳提供）。 */
export interface LibraryInput {
  readonly state: LibraryState;
  readonly blocks: readonly AuthorBlock[] | undefined;
  readonly methods: readonly canvas.CanvasMethodDecl[];
  readonly onChange: (next: LibraryState) => void;
  readonly onAdd: (item: LibraryItem) => void;
  readonly onDragStart: (item: LibraryItem, event: DragEvent) => void;
  readonly onAddVariable: () => void;
  readonly onAddReference: () => void;
}

/** 拖动时随 `dataTransfer` 带的类型：只为让浏览器认这是一次拖动，读取以面板记下的条目为准。 */
export const LIBRARY_DRAG_TYPE = 'application/x-p2b-library';

export function renderLibrary(input: LibraryInput): TemplateResult {
  const items = libraryItems(input.blocks);
  const page = libraryPageOf(items, input.state);
  const home = input.state.tab === 'all' && input.state.query.trim() === '';
  return html`<aside class="toolbox" aria-label="工具箱">
    <div class="toolbox-actions">
      <button class="btn-add-variable" @click=${input.onAddVariable}>加变量</button>
      <button class="btn-add-reference" @click=${input.onAddReference}>引用变量</button>
    </div>
    ${renderSearch(input, items, page)} ${renderTabs(input, items)}
    <div class="library-list" ?hidden=${home}>
      ${groupsOf(items).map((group) => renderGroup(group.category, group.items, page, input))}
      ${page.empty ? html`<p class="hint library-empty">没有匹配「${input.state.query.trim()}」的节点</p>` : nothing}
    </div>
    ${home ? nothing : renderPager(input, page)}
  </aside>`;
}

// ---------------------------------------------------------------------------
// 搜索与标签页
// ---------------------------------------------------------------------------

function renderSearch(input: LibraryInput, items: readonly LibraryItem[], page: LibraryPageView): TemplateResult {
  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    input.onChange({ ...input.state, query: target.value, page: 0 });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      input.onChange({ ...input.state, query: '', page: 0 });
      return;
    }
    if (event.key !== 'Enter') return;
    const first = items.find((item) => page.visible.has(item.key));
    if (first !== undefined) input.onAdd(first);
  };
  return html`<input
    class="library-query"
    type="text"
    aria-label="搜索节点"
    placeholder="搜索：名称、说明或种类"
    .value=${input.state.query}
    @input=${onInput}
    @keydown=${onKeyDown}
  />`;
}

function renderTabs(input: LibraryInput, items: readonly LibraryItem[]): TemplateResult {
  const select = (tab: LibraryTab): void => input.onChange({ ...input.state, tab, page: 0 });
  if (input.state.tab !== 'all' || input.state.query.trim() !== '') {
    return html`<button class="library-back" @click=${() => input.onChange({ ...input.state, tab: 'all', query: '', page: 0 })}>← 返回分类</button>`;
  }
  return html`<div class="library-tabs" role="group" aria-label="节点分类">
    ${libraryTabsOf(items).filter((tab) => tab.tab !== 'all').map((tab) => html`<button class="library-tab" data-tab=${tab.tab} @click=${() => select(tab.tab)}>${tab.label}<span class="tab-count">${tab.count}</span><span>→</span></button>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// 分级列表
// ---------------------------------------------------------------------------

interface CategoryGroup {
  readonly category: CanvasNodeCategory;
  readonly items: readonly LibraryItem[];
}

/** 按分类第一次出现的顺序分组：组序就是目录顺序，题目方法自然落在「方法」组末尾。 */
function groupsOf(items: readonly LibraryItem[]): readonly CategoryGroup[] {
  const groups: { category: CanvasNodeCategory; items: LibraryItem[] }[] = [];
  for (const item of items) {
    const group = groups.find((entry) => entry.category === item.category);
    if (group === undefined) groups.push({ category: item.category, items: [item] });
    else group.items.push(item);
  }
  return groups;
}

/** 一个分类：h3 只放分类名（读屏与单测都按它找），条目数放在旁边。 */
function renderGroup(
  category: CanvasNodeCategory,
  items: readonly LibraryItem[],
  page: LibraryPageView,
  input: LibraryInput,
): TemplateResult {
  const shown = items.filter((item) => page.visible.has(item.key)).length;
  return html`<div class="toolbox-group" data-category=${category} ?hidden=${shown === 0}>
    <div class="group-head">
      <h3>${CANVAS_CATEGORY_LABELS[category]}</h3>
      <span class="group-count">${items.length}</span>
    </div>
    ${tiersOf(items).map(
      (tier) => html`<div
        class="library-tier"
        data-tier=${tier.tier}
        ?hidden=${!tier.items.some((item) => page.visible.has(item.key))}
      >
        <div class="tier-label">${tier.tier}</div>
        ${tier.items.map((item) => renderItem(item, page.visible.has(item.key), input))}
      </div>`,
    )}
  </div>`;
}

/**
 * 一个条目。目录节点是 `.tool[data-kind]`，题目方法是 `.tool-block[data-block]`：
 * 两种选择器不重叠，「十八种节点各一个按钮」的口径不会被题目方法撑大。
 */
function renderItem(item: LibraryItem, visible: boolean, input: LibraryInput): TemplateResult {
  const dragStart = (event: DragEvent): void => {
    const transfer = event.dataTransfer ?? undefined;
    transfer?.setData(LIBRARY_DRAG_TYPE, item.key);
    if (transfer !== undefined) transfer.effectAllowed = 'copy';
    input.onDragStart(item, event);
  };
  if (item.blockId !== undefined) {
    return html`<button
      class="tool-block"
      data-block=${item.blockId}
      draggable="true"
      ?hidden=${!visible}
      title=${item.description}
      @click=${() => input.onAdd(item)}
      @dragstart=${dragStart}
    >
      ${item.label}${renderLibraryPreview(item, input.blocks, input.methods)}
    </button>`;
  }
  return html`<button
    class="tool"
    data-kind=${item.nodeKind}
    draggable="true"
    ?hidden=${!visible}
    title=${item.description}
    @click=${() => input.onAdd(item)}
    @dragstart=${dragStart}
  >
    ${item.label}${renderLibraryPreview(item, input.blocks, input.methods)}
  </button>`;
}

// ---------------------------------------------------------------------------
// 翻页
// ---------------------------------------------------------------------------

function renderPager(input: LibraryInput, page: LibraryPageView): TemplateResult | typeof nothing {
  if (page.pageCount <= 1) return nothing;
  const go = (next: number): void => input.onChange({ ...input.state, page: next });
  return html`<div class="library-pager">
    <button class="btn-page-prev" ?disabled=${page.page === 0} @click=${() => go(page.page - 1)}>上一页</button>
    <span class="page-of">第 ${page.page + 1}/${page.pageCount} 页</span>
    <button class="btn-page-next" ?disabled=${page.page >= page.pageCount - 1} @click=${() => go(page.page + 1)}>
      下一页
    </button>
  </div>`;
}
