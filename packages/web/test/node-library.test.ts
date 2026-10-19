// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIBRARY_CATEGORIES,
  NODE,
  availableNodeSpecs,
  searchLibrary,
} from '@pwn2block/shared';
import type { Pwn2BlockNodeLibrary } from '../src/components/node-library';
import { LIBRARY_PATH_KEY } from '../src/components/node-library';
import '../src/components/node-library';
import type { KeyValueStore } from '../src/viewmodel/storage';

/**
 * 节点库（10 §4）：分类、搜索、只读预览、拖拽添加与目录路径恢复。
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

async function openFolder(library: Pwn2BlockNodeLibrary, selector: string): Promise<void> {
  const folder = shadow(library).querySelector<HTMLButtonElement>(selector);
  if (folder === null) throw new Error(`找不到目录入口：${selector}`);
  folder.click();
  await library.updateComplete;
}

async function openFillFolder(library: Pwn2BlockNodeLibrary): Promise<void> {
  await openFolder(library, '[data-category="payload"]');
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
  it('首页只有分类，进入即显示节点并能返回', async () => {
    const library = mount();
    await library.updateComplete;
    const folders = [...shadow(library).querySelectorAll('button[data-category]')];
    expect(folders.map((item) => item.getAttribute('aria-label'))).toEqual(
      LIBRARY_CATEGORIES.map((category) => category.label),
    );
    expect(shadow(library).querySelectorAll('.entry')).toHaveLength(0);
    await openFolder(library, '[data-category="payload"]');
    expect(shadow(library).querySelectorAll('[data-section]')).toHaveLength(0);
    expect(entryOf(library, NODE.fill).querySelector('.static-node')).not.toBeNull();
    expect(shadow(library).querySelector('.path')?.textContent).toBe('节点库 / 字节与载荷');
    await openFolder(library, '.back');
    expect(shadow(library).querySelectorAll('[data-category]')).toHaveLength(LIBRARY_CATEGORIES.length);
    await openFolder(library, '[data-category="data"]');
    expect(entryOf(library, NODE.int).querySelector('.preview')).not.toBeNull();
    expect(shadow(library).querySelectorAll('[data-section]')).toHaveLength(0);
  });

  it('没有可用节点时隐藏空分类', async () => {
    const library = mount();
    library.specs = [];
    await library.updateComplete;
    expect(shadow(library).textContent).toContain('暂无可用节点');
    expect(shadow(library).querySelectorAll('[data-category]')).toHaveLength(0);
  });
});

describe('节点库：添加与搜索', () => {
  it('点击条目派发 p2b-library-add，detail.kind 是节点种类', async () => {
    const library = mount();
    await library.updateComplete;
    await openFillFolder(library);
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
  it('目录内所有节点常驻预览，失焦或离开指针后仍显示', async () => {
    const library = mount();
    await library.updateComplete;
    await openFillFolder(library);
    const entry = entryOf(library, NODE.fill);
    expect(shadow(library).querySelectorAll('.preview').length).toBe(
      shadow(library).querySelectorAll('.entry').length,
    );
    const text = entry.querySelector('.preview')?.textContent ?? '';
    for (const value of ['填充字节', '整数', '字节', '65', '16']) expect(text).toContain(value);
    entry.focus();
    entry.blur();
    entry.dispatchEvent(new Event('pointerenter'));
    entry.dispatchEvent(new Event('pointerleave'));
    await library.updateComplete;
    expect(entry.querySelector('.preview')).not.toBeNull();
  });

  it('跨目录搜索显示预览，清空或返回目录恢复原路径', async () => {
    const library = mount();
    await library.updateComplete;
    await openFillFolder(library);
    search(library, NODE.int);
    await library.updateComplete;
    expect(entryOf(library, NODE.int).querySelector('.preview')).not.toBeNull();
    search(library, '');
    await library.updateComplete;
    expect(entryOf(library, NODE.fill)).not.toBeNull();
    search(library, NODE.int);
    await library.updateComplete;
    await openFolder(library, '.back');
    expect(entryOf(library, NODE.fill)).not.toBeNull();
    expect(shadow(library).querySelector('.path')?.textContent).toContain('字节与载荷');
  });
});

describe('节点库：目录状态', () => {
  it('重新挂载恢复目录路径', async () => {
    const store = new MemoryStore();
    const library = mount(store);
    await library.updateComplete;
    await openFillFolder(library);
    expect(JSON.parse(store.getItem(LIBRARY_PATH_KEY) ?? '[]')).toEqual(['payload']);
    library.remove();
    const rebuilt = mount(store);
    await rebuilt.updateComplete;
    expect(entryOf(rebuilt, NODE.fill)).not.toBeNull();
  });

  it.each(['{bad-json', '[1]', '["unknown"]', '{}'])(
    '损坏的路径 %s 回退到首页', async (raw) => {
      const store = new MemoryStore();
      store.setItem(LIBRARY_PATH_KEY, raw);
      const library = mount(store);
      await library.updateComplete;
      expect(shadow(library).querySelectorAll('[data-category]')).toHaveLength(LIBRARY_CATEGORIES.length);
    },
  );

  it('失效的子目录回到父目录，禁写存储不影响导航', async () => {
    const store: KeyValueStore = {
      getItem: () => '["payload", "removed"]',
      setItem: () => { throw new Error('storage disabled'); },
      removeItem: () => {},
    };
    const library = mount(store);
    await library.updateComplete;
    expect(shadow(library).querySelector('[data-section]')).toBeNull();
    expect(entryOf(library, NODE.fill)).not.toBeNull();
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
    await openFillFolder(library);
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
    await openFillFolder(library);
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
      await openFillFolder(library);
      const entry = entryOf(library, NODE.fill);
      entry.focus();
      entry.dispatchEvent(new Event('pointerenter'));
      await library.updateComplete;
      expect(shadow(library).querySelector('.preview')).not.toBeNull();
      search(library, '填充');
      await library.updateComplete;
      // 搜索结果也常驻预览，整段过程不请求网络。
      expect(shadow(library).querySelector('.preview')).not.toBeNull();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
