// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/components/view-manager';
import '../src/components/top-bar';
import '../src/components/stack-view';
import { SAMPLE_PROJECTION_START, SAMPLE_PUBLIC_CHALLENGE } from '../src/fixtures/sample';
import { createViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF } from '../src/viewmodel/diff';
import { createViewManagerState, moveView } from '../src/viewmodel/views';

const context = createViewContext({
  projection: SAMPLE_PROJECTION_START, challenge: SAMPLE_PUBLIC_CHALLENGE,
  archBits: 64, diff: EMPTY_DIFF,
});
afterEach(() => { document.body.replaceChildren(); });

describe('视图实际组件的 P0 交互', () => {
  it('跟随 sp 时调整对齐偏移，行首地址也随之变化', async () => {
    const view = document.createElement('pwn2block-stack-view');
    view.context = context;
    document.body.append(view);
    await view.updateComplete;
    const first = () => BigInt(view.renderRoot.querySelector('tbody th')?.textContent?.trim() ?? '0');
    const before = first();
    const input = view.renderRoot.querySelector<HTMLInputElement>('[aria-label="行首对齐偏移"]');
    if (!input) throw new Error('缺少对齐输入');
    input.value = '3';
    input.dispatchEvent(new Event('change'));
    await view.updateComplete;
    expect(first()).toBe(before + 3n);
    expect(view.renderRoot.textContent).toContain('跟随 sp');
  });

  it('菜单顺序反映实际视图顺序，而非固定目录顺序', async () => {
    const bar = document.createElement('pwn2block-top-bar');
    bar.views = moveView(createViewManagerState(), 'stack', 1);
    document.body.append(bar);
    await bar.updateComplete;
    expect([...bar.renderRoot.querySelectorAll('li .title')].map((node) => node.textContent)).toEqual([
      '指令视图', '栈视图', '寄存器视图', '自由视图', 'I/O 视图',
    ]);
  });

  it('拖动跨多个位置排序，按钮仍可键盘操作并复用同一个状态入口', async () => {
    const bar = document.createElement('pwn2block-top-bar');
    bar.addEventListener('p2b-view-move', ((event: CustomEvent<{ kind: 'stack'; delta: number }>) => {
      bar.views = moveView(bar.views, event.detail.kind, event.detail.delta);
    }) as EventListener);
    document.body.append(bar);
    await bar.updateComplete;
    const drag = bar.renderRoot.querySelector('[data-kind="stack"] [draggable]');
    const target = bar.renderRoot.querySelector('[data-kind="memory"]');
    if (!drag || !target) throw new Error('缺少拖动入口');
    drag.dispatchEvent(new Event('dragstart'));
    const over = new Event('dragover', { cancelable: true });
    target.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    target.dispatchEvent(new Event('drop', { cancelable: true }));
    await bar.updateComplete;
    expect(bar.views.order).toEqual(['disasm', 'registers', 'memory', 'stack', 'io']);
    expect(bar.views.shown).toEqual(['disasm', 'registers', 'memory', 'stack']);
    bar.renderRoot.querySelector<HTMLButtonElement>('[aria-label="上移栈视图"]')?.click();
    await bar.updateComplete;
    expect(bar.views.order).toEqual(['disasm', 'registers', 'stack', 'memory', 'io']);
    // 外部文本拖入不改顺序。
    target.dispatchEvent(new Event('drop'));
    expect(bar.views.order).toEqual(['disasm', 'registers', 'stack', 'memory', 'io']);
  });

  it('从全部隐藏恢复视图后，快捷键滚动使用新视口及实际槽位位置', async () => {
    const view = document.createElement('pwn2block-view-manager');
    view.context = context;
    view.views = createViewManagerState([]);
    document.body.append(view);
    await view.updateComplete;
    view.views = createViewManagerState();
    await view.updateComplete;
    const viewport = view.renderRoot.querySelector<HTMLElement>('.viewport');
    const second = view.renderRoot.querySelector<HTMLElement>('[data-index="1"]');
    if (!viewport || !second) throw new Error('视图未恢复');
    Object.defineProperty(viewport, 'clientHeight', { value: 600 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect);
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({ top: 450 } as DOMRect);
    viewport.scrollTo = vi.fn();
    view.views = { ...view.views, offset: 1 };
    await view.updateComplete;
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 400, behavior: 'smooth' });
  });
});
