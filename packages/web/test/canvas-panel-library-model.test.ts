import { describe, expect, it } from 'vitest';
import { ret2winPublic } from '@pwn2block/shared';
import { CANVAS_CATALOG } from '../src/canvas/catalog';
import {
  BLOCK_TIER,
  INITIAL_LIBRARY_STATE,
  LIBRARY_PAGE_SIZE,
  libraryItems,
  libraryPageOf,
  libraryTabsOf,
  matchesQuery,
  tiersOf,
} from '../src/components/canvas-panel-library-model';

/**
 * 节点库模型：分页、分级与搜索的口径都在这里定死，渲染层只照着可见集合加 `hidden`。
 */

const BLOCKS = ret2winPublic.authorBlocks;
const ITEMS = libraryItems(BLOCKS);

function visibleKeys(state: Partial<typeof INITIAL_LIBRARY_STATE>): readonly string[] {
  const page = libraryPageOf(ITEMS, { ...INITIAL_LIBRARY_STATE, ...state });
  return ITEMS.filter((item) => page.visible.has(item.key)).map((item) => item.key);
}

describe('节点库条目', () => {
  it('目录节点按目录顺序，题目方法排在最后并归「方法 / 本题方法」', () => {
    expect(ITEMS.slice(0, CANVAS_CATALOG.length).map((item) => item.nodeKind)).toEqual(
      CANVAS_CATALOG.map((spec) => spec.kind),
    );
    const block = ITEMS[ITEMS.length - 1];
    expect(block).toMatchObject({ key: 'block:gets', category: 'method', tier: BLOCK_TIER, nodeKind: 'method', blockId: 'gets' });
    expect(block.description).toBe('从 buf 起写入字节，不检查长度');
  });

  it('没有题目方法时只有十八项', () => {
    expect(libraryItems(undefined)).toHaveLength(18);
  });

  it('标签页「全部」在最前，计数按分类累加', () => {
    const tabs = libraryTabsOf(ITEMS);
    expect(tabs.map((tab) => tab.tab)).toEqual(['all', 'value', 'collection', 'operator', 'convert', 'variable', 'flow', 'method']);
    expect(tabs[0].count).toBe(19);
    expect(tabs.find((tab) => tab.tab === 'collection')?.count).toBe(6);
    expect(tabs.find((tab) => tab.tab === 'method')?.count).toBe(2);
  });

  it('小类按第一次出现的顺序分段，段内顺序不变', () => {
    const collection = ITEMS.filter((item) => item.category === 'collection');
    expect(tiersOf(collection).map((tier) => [tier.tier, tier.items.map((item) => item.nodeKind)])).toEqual([
      ['组装', ['group', 'dict']],
      ['取用', ['index', 'lookup', 'slice']],
      ['变换', ['repeat']],
    ]);
  });
});

describe('分页与搜索', () => {
  it('「全部」不分页，一项不少', () => {
    const page = libraryPageOf(ITEMS, INITIAL_LIBRARY_STATE);
    expect(page.pageCount).toBe(1);
    expect(page.visible.size).toBe(ITEMS.length);
  });

  it(`单个分类每页 ${LIBRARY_PAGE_SIZE} 项，第二页接着排`, () => {
    expect(visibleKeys({ tab: 'collection' })).toEqual([
      'node:group',
      'node:dict',
      'node:index',
      'node:lookup',
      'node:slice',
    ]);
    expect(visibleKeys({ tab: 'collection', page: 1 })).toEqual(['node:repeat']);
    expect(libraryPageOf(ITEMS, { ...INITIAL_LIBRARY_STATE, tab: 'collection' }).pageCount).toBe(2);
  });

  it('页码越界收敛到最后一页，负数收敛到第一页', () => {
    expect(libraryPageOf(ITEMS, { ...INITIAL_LIBRARY_STATE, tab: 'collection', page: 9 }).page).toBe(1);
    expect(libraryPageOf(ITEMS, { ...INITIAL_LIBRARY_STATE, tab: 'collection', page: -3 }).page).toBe(0);
  });

  it('有搜索词时不分页：标签、说明、种类标识与小类都能命中，不分大小写', () => {
    expect(visibleKeys({ query: '切片' })).toEqual(['node:slice']);
    expect(visibleKeys({ query: 'LOOP' })).toEqual(['node:loop-index', 'node:loop']);
    expect(visibleKeys({ query: '本题' })).toEqual(['block:gets']);
    expect(matchesQuery(ITEMS[0], '   ')).toBe(true);
  });

  it('搜索与标签页同时生效；一项不中时 empty 为真', () => {
    expect(visibleKeys({ tab: 'flow', query: 'loop' })).toEqual(['node:loop']);
    expect(libraryPageOf(ITEMS, { ...INITIAL_LIBRARY_STATE, query: '不存在的节点' }).empty).toBe(true);
  });
});
