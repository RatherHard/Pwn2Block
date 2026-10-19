// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIBRARY_CATEGORIES,
  NODE,
  availableNodeSpecs,
  searchLibrary,
} from '@pwn2block/shared';
import type { Pwn2BlockNodeLibrary } from '../src/components/node-library';
import { LIBRARY_EXPANDED_KEY } from '../src/components/node-library';
import '../src/components/node-library';
import type { KeyValueStore } from '../src/viewmodel/storage';

/**
 * 节点库（10 §4）：分类、搜索、只读预览、拖拽添加与展开状态恢复。
 *
 * 全部用真实节点目录，不 mock shared 的纯函数；只替换存储和 `fetch`，
 * 后者用来证明预览不会偷偷发起求值请求。
 */

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const mounted: Pwn2BlockNodeLibrary[] = [];

function mount(store: KeyValueStore = new MemoryStore()): Pwn2BlockNodeLibrary {
  const library = document.createElement('pwn2block-node-library') as Pwn2BlockNodeLibrary;
  library.specs = availableNodeSpecs();
  library.context = { archBits: 64 };
  library.store = store;
  document.body.append(library);
  mounted.push(library);
  return library;
}

function shadow(library: Pwn2BlockNodeLibrary): ShadowRoot {
  const root = library.shadowRoot;
  if (root === null) throw new Error('节点库没有 shadow root');
  return root;
}

function entryOf(library: Pwn2BlockNodeLibrary, kind: string): HTMLButtonElement {
  const entry = shadow(library).querySelector<HTMLButtonElement>(`button[data-kind="${kind}"]`);
  if (entry === null) throw new Error(`找不到节点条目：${kind}`);
  return entry;
}

function detailsOf(library: Pwn2BlockNodeLibrary, category: string): HTMLDetailsElement {
  const details = shadow(library).querySelector<HTMLDetailsElement>(`details[data-category="${category}"]`);
  if (details === null) throw new Error(`找不到分类：${category}`);
  return details;
}

function listen<T>(library: Pwn2BlockNodeLibrary, name: string): T[] {
  const events: T[] = [];
  library.addEventListener(name, (event) => {
    events.push((event as CustomEvent<T>).detail);
  });
  return events;
}

function search(library: Pwn2BlockNodeLibrary, query: string): void {
  const input = shadow(library).querySelector<HTMLInputElement>('input[aria-label="搜索节点"]');
  if (input === null) throw new Error('找不到搜索框');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

function drag(library: Pwn2BlockNodeLibrary, kind: string): HTMLButtonElement {
  const entry = entryOf(library, kind);
  entry.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }));
  entry.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 }));
  return entry;
}

afterEach(() => {
  for (const library of mounted.splice(0)) library.remove();
});

describe('节点库：分类与条目', () => {
  it('渲染七个一级分类，并列出 data.fill', async () => {
    const library = mount();
    await library.updateComplete;
    const details = [...shadow(library).querySelectorAll<HTMLDetailsElement>('details.group')];
    expect(details).toHaveLength(LIBRARY_CATEGORIES.length);
    expect(details.map((item) => item.querySelector('h3')?.textContent)).toEqual(
      LIBRARY_CATEGORIES.map((category) => category.label),
    );
    expect(details.every((item) => item.open)).toBe(true);
    expect(entryOf(library, NODE.fill)).not.toBeNull();
  });
});

describe('节点库：添加与搜索', () => {
  it('点击条目派发 p2b-library-add，detail.kind 是节点种类', async () => {
    const library = mount();
    await library.updateComplete;
    const added = listen<{ kind: string }>(library, 'p2b-library-add');
    entryOf(library, NODE.fill).click();
    expect(added).toEqual([{ kind: NODE.fill }]);
  });

  it('搜索「填充」只列匹配项，并显示分类路径', async () => {
    const library = mount();
    await library.updateComplete;
    search(library, '填充');
    await library.updateComplete;
    const root = shadow(library);
    expect(root.querySelectorAll('details.group')).toHaveLength(0);
    const expected = searchLibrary(availableNodeSpecs(), '填充').map((match) => match.kind);
    const shown = [...root.querySelectorAll<HTMLButtonElement>('button[data-kind]')].map(
      (button) => button.dataset.kind,
    );
    expect(shown).toEqual(expected);
    expect(shown).toContain(NODE.fill);
    expect(root.textContent ?? '').toContain('字节与载荷');

    search(library, '不存在的节点名');
    await library.updateComplete;
    expect(root.textContent ?? '').toContain('没有匹配的节点');
  });
});

describe('节点库：只读预览', () => {
  it('聚焦显示实际节点外观、类型与默认参数，离开后关闭', async () => {
    const library = mount();
    await library.updateComplete;
    const previews = listen<{ kind: string | undefined }>(library, 'p2b-library-preview');
    const entry = entryOf(library, NODE.fill);
    entry.focus();
    await library.updateComplete;

    const preview = shadow(library).querySelector('.preview');
    expect(preview).not.toBeNull();
    const text = preview?.textContent ?? '';
    expect(text).toContain('填充字节');
    expect(text).toContain('整数');
    expect(text).toContain('字节');
    expect(text).toContain('65');
    expect(text).toContain('16');
    expect(previews.at(-1)).toEqual({ kind: NODE.fill });

    entry.blur();
    await library.updateComplete;
    expect(shadow(library).querySelector('.preview')).toBeNull();
    expect(previews.at(-1)).toEqual({ kind: undefined });

    entry.dispatchEvent(new Event('pointerenter'));
    await library.updateComplete;
    expect(shadow(library).querySelector('.preview')).not.toBeNull();
    entry.dispatchEvent(new Event('pointerleave'));
    await library.updateComplete;
    expect(shadow(library).querySelector('.preview')).toBeNull();
  });
});

describe('节点库：展开状态', () => {
  it('折叠后写入 store，重新挂载仍保持折叠', async () => {
    const store = new MemoryStore();
    const category = LIBRARY_CATEGORIES[0];
    if (category === undefined) throw new Error('目录没有分类');
    const library = mount(store);
    await library.updateComplete;
    const details = detailsOf(library, category.id);
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    await library.updateComplete;

    const saved = JSON.parse(store.getItem(LIBRARY_EXPANDED_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved[category.id]).toBe(false);

    library.remove();
    const rebuilt = mount(store);
    await rebuilt.updateComplete;
    expect(detailsOf(rebuilt, category.id).open).toBe(false);
  });
});

describe('节点库：拖拽', () => {
  it('超过 4px 才派发 dragstart/dragmove，松手以 canceled=false 结束', async () => {
    const library = mount();
    await library.updateComplete;
    const starts = listen<{ kind: string; clientX: number; clientY: number }>(library, 'p2b-library-dragstart');
    const moves = listen<{ kind: string; clientX: number; clientY: number }>(library, 'p2b-library-dragmove');
    const ends = listen<{ kind: string; clientX: number; clientY: number; canceled: boolean }>(
      library,
      'p2b-library-dragend',
    );
    const added = listen<{ kind: string }>(library, 'p2b-library-add');

    const entry = entryOf(library, NODE.fill);
    entry.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }));
    entry.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 11, clientY: 10 }));
    await library.updateComplete;
    expect(starts).toHaveLength(0);

    entry.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 }));
    await library.updateComplete;
    expect(starts).toEqual([{ kind: NODE.fill, clientX: 30, clientY: 10 }]);
    expect(moves).toEqual([{ kind: NODE.fill, clientX: 30, clientY: 10 }]);
    expect(library.hasAttribute('data-dragging')).toBe(true);

    entry.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 40, clientY: 10 }));
    await library.updateComplete;
    expect(ends).toEqual([{ kind: NODE.fill, clientX: 40, clientY: 10, canceled: false }]);
    expect(library.hasAttribute('data-dragging')).toBe(false);

    // 浏览器在拖拽后补发的 click 不能变成一次添加。
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(added).toHaveLength(0);
  });

  it('按 Esc 以 canceled=true 结束拖拽', async () => {
    const library = mount();
    await library.updateComplete;
    const ends = listen<{ kind: string; canceled: boolean }>(library, 'p2b-library-dragend');
    const entry = drag(library, NODE.fill);
    await library.updateComplete;
    expect(library.hasAttribute('data-dragging')).toBe(true);

    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await library.updateComplete;
    expect(ends).toHaveLength(1);
    expect(ends[0]?.canceled).toBe(true);
    expect(library.hasAttribute('data-dragging')).toBe(false);
  });
});

describe('节点库：预览不触发求值', () => {
  it('焦点、悬停与搜索期间 fetch 调用次数为 0', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      throw new Error('节点库预览不应发起请求');
    }) as typeof fetch;
    try {
      const library = mount();
      await library.updateComplete;
      const entry = entryOf(library, NODE.fill);
      entry.focus();
      entry.dispatchEvent(new Event('pointerenter'));
      await library.updateComplete;
      expect(shadow(library).querySelector('.preview')).not.toBeNull();
      search(library, '填充');
      await library.updateComplete;
      // 输入搜索时预览关闭；整段过程都不该请求网络。
      expect(shadow(library).querySelector('.preview')).toBeNull();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
