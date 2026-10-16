// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import '../src/components/stack-view';
import '../src/components/disasm-view';
import { createViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF } from '../src/viewmodel/diff';
import { makeChallenge, makeProjection } from './helpers';

const initial = makeProjection({ disasm: [
  { addr: '0x400000', bytes: '00', text: 'jmp target', target: '0x400002' },
  { addr: '0x400001', bytes: '00', text: 'next' },
  { addr: '0x400002', bytes: '00', text: 'target' },
] });
const context = createViewContext({ projection: initial, challenge: makeChallenge(), archBits: 64, diff: EMPTY_DIFF });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

async function mount<K extends 'pwn2block-stack-view' | 'pwn2block-disasm-view'>(tag: K) {
  const slot = document.createElement('div');
  slot.scrollTo = vi.fn();
  vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300 } as DOMRect);
  const view = document.createElement(tag);
  view.context = context;
  slot.append(view);
  document.body.append(slot);
  await view.updateComplete;
  vi.mocked(slot.scrollTo).mockClear();
  return { slot, view };
}

it('新投影把 sp 所在行滚入当前槽位，界面重绘不抢回 sp', async () => {
  const { slot, view } = await mount('pwn2block-stack-view');
  // 新 sp 在第 6 行，几何位置位于槽位下方。
  const row = view.renderRoot.querySelectorAll('tbody tr')[5]!;
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 380, bottom: 400 } as DOMRect);
  const next = makeProjection({ registers: { RSP: '0x7fffff08', RBP: '0x7fffff10', RIP: '0x400001' }, steps: 1 });
  // 手动窗口保持不变，让新 sp 移入第 6 行。
  const field = view.renderRoot.querySelector<HTMLInputElement>('[aria-label="跳转到地址"]')!;
  field.value = '0x7ffffee0';
  field.dispatchEvent(new Event('input'));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await view.updateComplete;
  vi.mocked(slot.scrollTo).mockClear();
  view.context = { ...context, projection: next };
  await view.updateComplete;
  expect(slot.scrollTo).toHaveBeenLastCalledWith({ top: 100 });
  vi.mocked(slot.scrollTo).mockClear();
  view.context = { ...view.context };
  await view.updateComplete;
  expect(slot.scrollTo).not.toHaveBeenCalled();
});

it('手动点指令目标后，新投影恢复 ip 跟随；只滚槽位，不滚整页', async () => {
  const { slot, view } = await mount('pwn2block-disasm-view');
  const rows = view.renderRoot.querySelectorAll('tbody tr');
  vi.spyOn(rows[1]!, 'getBoundingClientRect').mockReturnValue({ top: 380, bottom: 400 } as DOMRect);
  vi.spyOn(rows[2]!, 'getBoundingClientRect').mockReturnValue({ top: 480, bottom: 500 } as DOMRect);
  view.renderRoot.querySelector<HTMLButtonElement>('.target')!.click();
  await view.updateComplete;
  expect(view.renderRoot.querySelector('tr.focused')?.textContent).toContain('target');
  vi.mocked(slot.scrollTo).mockClear();
  view.context = { ...context, projection: { ...initial, steps: 1, registers: initial.registers.map((reg) =>
    reg.name === 'RIP' ? { ...reg, value: '0x400001' } : reg) } };
  await view.updateComplete;
  expect(view.renderRoot.querySelector('tr.focused')).toBeNull();
  expect(slot.scrollTo).toHaveBeenCalledWith({ top: 100 });
});

it('栈搜索跳转后将第一行滚回槽位视野，而不是留下旧滚动位置', async () => {
  const { slot, view } = await mount('pwn2block-stack-view');
  slot.scrollTop = 200;
  vi.spyOn(view.renderRoot.querySelector('tbody tr')!, 'getBoundingClientRect')
    .mockReturnValue({ top: -100, bottom: -80 } as DOMRect);
  const input = view.renderRoot.querySelector<HTMLInputElement>('[aria-label="搜索字节序列"]')!;
  input.value = 'c9 c3';
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await view.updateComplete;
  expect(slot.scrollTo).toHaveBeenCalledWith({ top: 0 });
  expect(view.renderRoot.querySelector('[role="status"]')?.textContent).toContain('0x400000');
});
