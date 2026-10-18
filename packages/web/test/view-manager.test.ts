// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { CSSResult } from 'lit';
import '../src/components/view-manager';
import { Pwn2BlockPseudocodeView } from '../src/components/pseudocode-view';
import { terminalTheme } from '../src/theme';
import { C_TOKEN_KINDS } from '../src/viewmodel/c-syntax';
import { createViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF } from '../src/viewmodel/diff';
import type { ViewKind } from '../src/viewmodel/views';
import { SAMPLE_PROJECTION_START, SAMPLE_PUBLIC_CHALLENGE } from '../src/fixtures/sample';

const context = createViewContext({
  projection: SAMPLE_PROJECTION_START,
  challenge: SAMPLE_PUBLIC_CHALLENGE,
  archBits: 64,
  diff: EMPTY_DIFF,
});
const noIo: readonly ViewKind[] = ['stack', 'disasm', 'registers', 'memory'];
/** 样例题（ret2win）的可用视图：有 I/O，没有伪代码。 */
const sampleViews: readonly ViewKind[] = [...noIo, 'io'];

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(active: ViewKind, available: readonly ViewKind[] = sampleViews, ctx = context) {
  const manager = document.createElement('pwn2block-view-manager');
  manager.context = ctx;
  manager.views = { active };
  manager.available = available;
  document.body.append(manager);
  await manager.updateComplete;
  return manager;
}

function tabs(manager: HTMLElement & { renderRoot: ParentNode }) {
  return [...manager.renderRoot.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

function panelOf(manager: HTMLElement & { renderRoot: ParentNode }, tag: string): HTMLElement {
  const view = manager.renderRoot.querySelector(tag);
  const panel = view?.closest<HTMLElement>('[role="tabpanel"]');
  if (!panel) throw new Error(`缺少 ${tag} 的标签面板`);
  return panel;
}

describe('视图面板（设计 §3.2）', () => {
  it('标签栏是 tablist，当前标签反显且带方括号', async () => {
    const manager = await mount('stack');
    expect(manager.renderRoot.querySelector('[role="tablist"]')).not.toBeNull();
    const list = tabs(manager);
    expect(list.map((tab) => tab.textContent?.trim())).toEqual(['[栈]', '指令', '寄存器', '内存', 'I/O']);
    expect(list.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(list.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    const controls = list[0]?.getAttribute('aria-controls') ?? '';
    expect(manager.renderRoot.querySelector(`#${controls}`)?.getAttribute('role')).toBe('tabpanel');
  });

  it('五个视图常驻，非当前用 hidden', async () => {
    const manager = await mount('stack');
    const stack = manager.renderRoot.querySelector('pwn2block-stack-view');
    expect(panelOf(manager, 'pwn2block-stack-view').hidden).toBe(false);
    manager.views = { active: 'registers' };
    await manager.updateComplete;
    expect(manager.renderRoot.querySelector('pwn2block-stack-view')).toBe(stack);
    expect(panelOf(manager, 'pwn2block-stack-view').hidden).toBe(true);
    expect(stack?.active).toBe(false);
    const disasm = manager.renderRoot.querySelector('pwn2block-disasm-view');
    expect(disasm?.active).toBe(false);
    expect(panelOf(manager, 'pwn2block-registers-view').hidden).toBe(false);
    expect(manager.renderRoot.querySelectorAll('[role="tabpanel"]')).toHaveLength(5);
    // 只有栈视图与指令视图有 active（跟随滚动用）；切到指令后它变为 true。
    manager.views = { active: 'disasm' };
    await manager.updateComplete;
    expect(disasm?.active).toBe(true);
    expect(stack?.active).toBe(false);
  });

  it('无 I/O 题目不渲染 I/O 视图与标签', async () => {
    const manager = await mount('stack', noIo);
    expect(manager.renderRoot.querySelector('pwn2block-io-view')).toBeNull();
    expect(tabs(manager).map((tab) => tab.textContent?.trim())).toEqual(['[栈]', '指令', '寄存器', '内存']);
  });

  it('← → Home End 在标签栏上切换并移动焦点', async () => {
    const manager = await mount('stack');
    const kinds: string[] = [];
    manager.addEventListener('p2b-view-select', (event) => {
      const kind = (event as CustomEvent<{ kind: ViewKind }>).detail.kind;
      kinds.push(kind);
      manager.views = { active: kind };
    });
    const tablist = manager.renderRoot.querySelector<HTMLElement>('[role="tablist"]');
    if (!tablist) throw new Error('缺少标签栏');
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowLeft', 'Home', 'End']) {
      tablist.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
      await manager.updateComplete;
    }
    expect(kinds).toEqual(['disasm', 'stack', 'io', 'stack', 'io']);
    expect(manager.shadowRoot?.activeElement?.textContent?.trim()).toBe('[I/O]');
  });

  it('带修饰键的方向键不归标签栏：Alt+← 不切换、不拦截', async () => {
    const manager = await mount('disasm');
    const kinds: string[] = [];
    manager.addEventListener('p2b-view-select', (event) => {
      kinds.push((event as CustomEvent<{ kind: ViewKind }>).detail.kind);
    });
    const tab = tabs(manager)[1];
    if (!tab) throw new Error('缺少指令标签');
    tab.focus();
    const press = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, composed: true, cancelable: true });
    tab.dispatchEvent(press);
    await manager.updateComplete;
    expect(kinds).toEqual([]);
    expect(press.defaultPrevented).toBe(false);
  });

  it('点击标签派发 p2b-view-select', async () => {
    const manager = await mount('stack');
    const kinds: string[] = [];
    manager.addEventListener('p2b-view-select', (event) => {
      kinds.push((event as CustomEvent<{ kind: ViewKind }>).detail.kind);
    });
    tabs(manager)[3]?.click();
    expect(kinds).toEqual(['memory']);
  });

  it('存了 io 但本题无 I/O：显示栈', async () => {
    const manager = await mount('io', noIo);
    expect(panelOf(manager, 'pwn2block-stack-view').hidden).toBe(false);
    expect(tabs(manager).some((tab) => tab.textContent?.includes('I/O'))).toBe(false);
    expect(tabs(manager)[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('有伪代码时最后多一个「伪代码」标签，按 C 语法着色但文本不变', async () => {
    const pseudocode = 'int main() {\n  char *s = "<b>&amp;</b>"; // 注入\n}';
    const withCode = createViewContext({
      projection: SAMPLE_PROJECTION_START,
      challenge: { ...SAMPLE_PUBLIC_CHALLENGE, pseudocode },
      archBits: 64,
      diff: EMPTY_DIFF,
    });
    const manager = await mount('pseudocode', [...sampleViews, 'pseudocode'], withCode);
    expect(tabs(manager).map((tab) => tab.textContent?.trim())).toEqual(['栈', '指令', '寄存器', '内存', 'I/O', '[伪代码]']);
    expect(tabs(manager)[5]?.title).toBe('伪代码视图');
    const view = manager.renderRoot.querySelector('pwn2block-pseudocode-view');
    if (!view) throw new Error('缺少伪代码视图');
    await view.updateComplete;
    expect(panelOf(manager, 'pwn2block-pseudocode-view').hidden).toBe(false);
    const pre = view.renderRoot.querySelector('pre');
    // 着色是包在 span 里的，拼回来的文本必须与原文逐字相同。
    expect(pre?.textContent).toBe(pseudocode);
    expect(pre?.querySelector('b')).toBeNull();
    expect([...(pre?.querySelectorAll('span') ?? [])].map((span) => span.className)).toEqual([
      'syn-type',
      'syn-function',
      'syn-type',
      'syn-string',
      'syn-comment',
    ]);
    expect(pre?.querySelector('span.syn-string')?.textContent).toBe('"<b>&amp;</b>"');
  });

  it('每种着色类别都有配色：样式里有 .syn-<kind>，主题里有 --p2b-syn-<kind>', () => {
    const viewStyles = (Pwn2BlockPseudocodeView.styles as readonly CSSResult[]).map((style) => style.cssText).join('\n');
    for (const kind of C_TOKEN_KINDS) {
      if (kind === 'plain') continue;
      expect(viewStyles, `.syn-${kind} 没有样式`).toContain(`.syn-${kind}`);
      expect(terminalTheme.cssText, `--p2b-syn-${kind} 没有定义`).toContain(`--p2b-syn-${kind}:`);
    }
  });

  it('没有伪代码的题目不渲染伪代码视图；存了 pseudocode 时显示栈', async () => {
    const manager = await mount('pseudocode');
    expect(manager.renderRoot.querySelector('pwn2block-pseudocode-view')).toBeNull();
    expect(tabs(manager).some((tab) => tab.textContent?.includes('伪代码'))).toBe(false);
    expect(panelOf(manager, 'pwn2block-stack-view').hidden).toBe(false);
  });

  it('底部图例一行', async () => {
    const manager = await mount('stack');
    const legend = manager.renderRoot.querySelector('.legend')?.textContent ?? '';
    for (const word of ['代码', '栈', '数据', '隐藏', '未映射']) expect(legend).toContain(word);
  });
});
