import type { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { CANVAS_CATALOG, CANVAS_CATEGORY_LABELS } from '../canvas/catalog';
import type { CanvasNodeCategory } from '../canvas/catalog';

/**
 * 节点库的**纯数据模型**：分页（分类标签页 + 页内翻页）、分级（分类 → 小类）、搜索与预览目标。
 *
 * 渲染层只认这里算出的「哪些条目可见、第几页、共几页」，自己不做筛选；所以分页与搜索的口径
 * 可以脱离 DOM 单测。两条硬约束：
 * - 目录里的十八种节点**始终都在 DOM 里**（被筛掉的只加 `hidden`）：单测与浏览器回归都按
 *   `.tool[data-kind]` 找按钮，换页不能让按钮消失；
 * - 题目声明的方法（`authorBlocks`）作为「方法」类下的第二级条目单列：点一下直接得到选好方法、
 *   参数齐全的方法节点，不必先放一个空方法再去侧栏选。
 */

/** 标签页：「全部」或某一个分类。 */
export type LibraryTab = 'all' | CanvasNodeCategory;

/** 节点库的状态：归面板持有，重渲染不丢。 */
export interface LibraryState {
  readonly tab: LibraryTab;
  /** 当前页（从 0 起）；只在单个分类标签页里生效。 */
  readonly page: number;
  readonly query: string;
  /** 正在预览的条目键；`undefined` 时预览区给提示。 */
  readonly preview: string | undefined;
}

export const INITIAL_LIBRARY_STATE: LibraryState = { tab: 'all', page: 0, query: '', preview: undefined };

/** 单个分类标签页里每页最多几项。「全部」与搜索结果不分页（一眼看全更快）。 */
export const LIBRARY_PAGE_SIZE = 5;

/** 节点库里的一项：目录节点或题目方法。 */
export interface LibraryItem {
  /** 稳定键：`node:<kind>` 或 `block:<id>`。 */
  readonly key: string;
  readonly category: CanvasNodeCategory;
  /** 第二级：分类里的小类名。 */
  readonly tier: string;
  readonly label: string;
  readonly description: string;
  readonly nodeKind: canvas.CanvasNodeKind;
  /** 题目方法条目的方法标识；目录节点没有。 */
  readonly blockId?: string;
}

/**
 * 每种节点归在分类里的哪个小类。小类只是阅读上的分段，不改目录顺序：
 * 同一分类里的种类本来就连续，小类按第一次出现的位置排。
 */
const TIER_OF_KIND: Readonly<Record<canvas.CanvasNodeKind, string>> = {
  value: '字面量',
  group: '组装',
  dict: '组装',
  index: '取用',
  lookup: '取用',
  slice: '取用',
  repeat: '变换',
  relation: '二元',
  unary: '一元',
  convert: '显式转换',
  'var-decl': '声明',
  'var-ref': '读取',
  'loop-index': '读取',
  start: '入口',
  if: '控制',
  loop: '控制',
  assign: '写入',
  method: '通用',
};

/** 题目方法条目所在的小类。 */
export const BLOCK_TIER = '本题方法';

/** 全部条目：目录节点按目录顺序，题目方法排在「方法」类的最后。 */
export function libraryItems(blocks: readonly AuthorBlock[] | undefined): readonly LibraryItem[] {
  const nodes: LibraryItem[] = CANVAS_CATALOG.map((spec) => ({
    key: `node:${spec.kind}`,
    category: spec.category,
    tier: TIER_OF_KIND[spec.kind],
    label: spec.label,
    description: spec.description,
    nodeKind: spec.kind,
  }));
  const methods: LibraryItem[] = (blocks ?? []).map((block) => ({
    key: `block:${block.id}`,
    category: 'method',
    tier: BLOCK_TIER,
    label: block.label,
    description: block.tooltip ?? `调用本题方法「${block.label}」`,
    nodeKind: 'method',
    blockId: block.id,
  }));
  return [...nodes, ...methods];
}

/** 标签页的一项：键、文字与条目数。 */
export interface LibraryTabView {
  readonly tab: LibraryTab;
  readonly label: string;
  readonly count: number;
}

/** 标签页：「全部」在最前，其余按分类第一次出现的顺序。 */
export function libraryTabsOf(items: readonly LibraryItem[]): readonly LibraryTabView[] {
  const tabs: LibraryTabView[] = [{ tab: 'all', label: '全部', count: items.length }];
  for (const item of items) {
    const existing = tabs.findIndex((tab) => tab.tab === item.category);
    if (existing < 0) {
      tabs.push({ tab: item.category, label: CANVAS_CATEGORY_LABELS[item.category], count: 1 });
      continue;
    }
    const tab = tabs[existing];
    tabs[existing] = { ...tab, count: tab.count + 1 };
  }
  return tabs;
}

/** 搜索：标签、说明、种类标识与小类名里任意一处包含关键词（不分大小写）。 */
export function matchesQuery(item: LibraryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [item.label, item.description, item.nodeKind, item.tier, item.blockId ?? '']
    .some((text) => text.toLowerCase().includes(needle));
}

/** 当前状态下的可见结果。 */
export interface LibraryPageView {
  /** 可见条目的键。 */
  readonly visible: ReadonlySet<string>;
  /** 收敛到合法范围后的页码。 */
  readonly page: number;
  readonly pageCount: number;
  /** 一项都不可见（搜索无结果）。 */
  readonly empty: boolean;
}

/**
 * 按标签页、搜索与页码算出可见条目。
 *
 * 只有「单个分类 + 没有搜索词」才分页：搜索时用户要的是「一眼看到全部匹配」，翻页只会把结果藏起来。
 * 页码越界（比如换了题目，方法变少）时收敛到最后一页，而不是给一页空白。
 */
export function libraryPageOf(items: readonly LibraryItem[], state: LibraryState): LibraryPageView {
  const matched = items.filter(
    (item) => (state.tab === 'all' || item.category === state.tab) && matchesQuery(item, state.query),
  );
  const paged = state.tab !== 'all' && state.query.trim() === '';
  const pageCount = paged ? Math.max(1, Math.ceil(matched.length / LIBRARY_PAGE_SIZE)) : 1;
  const page = Math.min(Math.max(0, state.page), pageCount - 1);
  const shown = paged ? matched.slice(page * LIBRARY_PAGE_SIZE, (page + 1) * LIBRARY_PAGE_SIZE) : matched;
  return { visible: new Set(shown.map((item) => item.key)), page, pageCount, empty: shown.length === 0 };
}

/** 一个分类里按小类分段：小类按第一次出现的顺序，段内保持条目顺序。 */
export function tiersOf(items: readonly LibraryItem[]): readonly { readonly tier: string; readonly items: readonly LibraryItem[] }[] {
  const tiers: { tier: string; items: LibraryItem[] }[] = [];
  for (const item of items) {
    const found = tiers.find((entry) => entry.tier === item.tier);
    if (found === undefined) tiers.push({ tier: item.tier, items: [item] });
    else found.items.push(item);
  }
  return tiers;
}
