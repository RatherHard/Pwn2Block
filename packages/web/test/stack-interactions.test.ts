// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import '../src/components/stack-view';
import { createViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF } from '../src/viewmodel/diff';
import { makeChallenge, makeProjection, makeVma } from './helpers';

const projection = makeProjection({ vmas: [
  makeVma({ id: 'stack', start: '0x1000', size: '0x8', hex: '0041422000000000' }),
] });
afterEach(() => { document.body.replaceChildren(); });

async function mount() {
  const view = document.createElement('pwn2block-stack-view');
  view.context = createViewContext({ projection, challenge: makeChallenge(), archBits: 64, diff: EMPTY_DIFF });
  document.body.append(view);
  await view.updateComplete;
  return view;
}
function input(view: HTMLElement, label: string, value: string, event = 'input') {
  const node = view.shadowRoot?.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  if (!node) throw new Error(`缺少输入：${label}`);
  node.value = value;
  node.dispatchEvent(new Event(event));
  return node;
}

describe('栈搜索实际组件', () => {
  it('Enter 搜索 hex 后跳转并恢复对齐，命中字节不会被偏移跳过', async () => {
    const view = await mount();
    input(view, '行首对齐偏移', '7', 'change');
    const field = input(view, '搜索字节序列', '41 42');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await view.updateComplete;
    expect(view.renderRoot.querySelector('tbody th')?.textContent?.trim()).toBe('0x0000000000001000');
    expect(view.renderRoot.querySelector('[role="status"]')?.textContent).toContain('0x1001');
    expect(view.renderRoot.querySelector<HTMLInputElement>('[aria-label="行首对齐偏移"]')?.value).toBe('0');
  });
  it('ASCII 按钮搜索、未命中与错误反馈，不会用无效结果改变地址', async () => {
    const view = await mount();
    input(view, '搜索编码', 'ascii', 'change');
    const search = () => [...view.renderRoot.querySelectorAll('button')].find((button) => button.textContent === '搜索')?.click();
    input(view, '搜索字节序列', 'AB ');
    search();
    await view.updateComplete;
    const before = view.renderRoot.querySelector('tbody th')?.textContent;
    expect(view.renderRoot.querySelector('[role="status"]')?.textContent).toContain('0x1001');
    input(view, '搜索字节序列', 'XYZ');
    search();
    await view.updateComplete;
    expect(view.renderRoot.querySelector('[role="status"]')?.textContent).toContain('未找到');
    input(view, '搜索字节序列', '中文');
    search();
    await view.updateComplete;
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toContain('ASCII');
    expect(view.renderRoot.querySelector('tbody th')?.textContent).toBe(before);
  });
});
