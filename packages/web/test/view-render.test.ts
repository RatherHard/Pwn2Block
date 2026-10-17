// @vitest-environment jsdom
/**
 * 五个视图的 pwndbg 风格排版（frontend-tui 设计 §3.3）。
 *
 * 只断言渲染层：行元素是 `<div class="row">`，文本按 pwndbg 的列顺序排列；
 * 数据来源仍是 `viewmodel/*`，交互逻辑另有 stack-interactions / view-follow 覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LitElement } from 'lit';
import type { Projection, PublicChallenge } from '@pwn2block/shared';
import '../src/components/stack-view';
import '../src/components/disasm-view';
import '../src/components/registers-view';
import '../src/components/memory-view';
import '../src/components/io-view';
import { createViewContext, type ViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF, diffProjections } from '../src/viewmodel/diff';
import { SAMPLE_FDS, SAMPLE_SYSCALLS, hexOf, makeChallenge, makeProjection, makeVma, p64 } from './helpers';

type ViewTag =
  | 'pwn2block-stack-view'
  | 'pwn2block-disasm-view'
  | 'pwn2block-registers-view'
  | 'pwn2block-memory-view'
  | 'pwn2block-io-view';

const TEXT_VMA = makeVma({ id: 'text', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c9e80f0e' }) });
/** 栈从 sp 开始，所以窗口第 0 行就是 sp 行；`+8` 处存一个指回栈顶的指针。 */
const STACK_VMA_HEX = hexOf(0x100, { 8: p64(0x7fffff00n) });
const KEY_VMA = makeVma({ id: 'key', kind: 'key', start: '0x80000000', size: '0x1000', perm: 'r', hidden: true });

function stackProjection(stackHex = STACK_VMA_HEX, registers?: Readonly<Record<string, string>>): Projection {
  return makeProjection({
    ...(registers === undefined ? {} : { registers }),
    vmas: [
      TEXT_VMA,
      makeVma({ id: 'stack', kind: 'stack', start: '0x7fffff00', size: '0x100', perm: 'rw', hex: stackHex }),
      KEY_VMA,
    ],
    disasm: [
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
      { addr: '0x400001', bytes: 'e8', text: 'call win', target: '0x400002' },
      { addr: '0x400002', bytes: '0f', text: 'syscall win' },
    ],
    stdin: { hex: '414243', pos: 1 },
    stdout: { hex: '6869' },
  });
}

const CHALLENGE = makeChallenge({
  syscalls: SAMPLE_SYSCALLS,
  fds: SAMPLE_FDS,
  labels: [
    { name: 'vuln', addr: '0x400000', size: 2, kind: 'func' },
    { name: 'win', addr: '0x400002', size: 2, kind: 'func' },
  ],
});

function contextOf(projection: Projection, previous?: Projection, challenge: PublicChallenge = CHALLENGE): ViewContext {
  return createViewContext({
    projection,
    challenge,
    archBits: 64,
    diff: previous === undefined ? EMPTY_DIFF : diffProjections(previous, projection),
    ...(previous === undefined ? {} : { previous }),
  });
}

async function mount(tag: ViewTag, context: ViewContext): Promise<LitElement & { context: ViewContext }> {
  const view = document.createElement(tag) as LitElement & { context: ViewContext };
  view.context = context;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

/** textContent 规整空白：pwndbg 排版的列间距由 CSS gap 决定，断言只看列顺序。 */
function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function rows(view: LitElement, scope = ''): Element[] {
  return [...view.renderRoot.querySelectorAll(`${scope} .row`.trim())];
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('pwndbg 风格排版（设计 §3.3）', () => {
  it('不再使用 table', async () => {
    const context = contextOf(stackProjection());
    const tags: readonly ViewTag[] = [
      'pwn2block-stack-view',
      'pwn2block-disasm-view',
      'pwn2block-registers-view',
      'pwn2block-memory-view',
      'pwn2block-io-view',
    ];
    const allViews = await Promise.all(tags.map((tag) => mount(tag, context)));
    for (const view of allViews) {
      expect(view.shadowRoot!.querySelector('table')).toBeNull();
      expect(rows(view).length).toBeGreaterThan(0);
    }
  });

  it('栈行：NN:OOOO│ 前缀、锚点、地址、链', async () => {
    const view = await mount('pwn2block-stack-view', contextOf(stackProjection()));
    const list = rows(view);
    expect(list).toHaveLength(40);
    const first = text(list[0]);
    expect(first.startsWith('00:0000│')).toBe(true);
    expect(first).toContain('sp');
    expect(first).toContain('0x000000007fffff00');
    expect(text(list[1]).startsWith('01:0008│')).toBe(true);
    expect(text(list[1])).toContain('—▸ 0x7fffff00');
    expect(list[1]!.querySelector('.value')?.classList.contains('r-stack')).toBe(true);
    // 值 0 不指向任何映射：不着色。
    const plain = list[0]!.querySelector('.value');
    expect(plain).not.toBeNull();
    expect([...plain!.classList].some((name) => name.startsWith('r-'))).toBe(false);
    expect(text(list[2])).toContain('bp');
  });

  it('栈行：隐藏字节 ??、变化字节逐个高亮', async () => {
    const before = stackProjection();
    const after = stackProjection(hexOf(0x100, { 8: p64(0x7fffff00n), 0x10: '41' }));
    const view = await mount('pwn2block-stack-view', contextOf(after, before));
    const list = rows(view);
    // 0x80000000 起是隐藏 VMA：第 32 行起每个字节格都是 ??，不下发任何内容。
    const hiddenCells = [...list[32]!.querySelectorAll('.byte')];
    expect(hiddenCells).toHaveLength(8);
    for (const cell of hiddenCells) expect(cell.textContent?.trim()).toBe('??');
    expect(text(list[32])).toContain('隐藏 VMA「key」');
    const changed = view.renderRoot.querySelectorAll('.byte.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.textContent?.trim()).toBe('41');
  });

  it('指令行：► 当前行、<符号>、可点 <win>', async () => {
    const view = await mount('pwn2block-disasm-view', contextOf(stackProjection()));
    const list = rows(view);
    expect(list).toHaveLength(3);
    const ip = view.renderRoot.querySelector('.row.ip');
    expect(ip).toBe(list[0]);
    expect(text(ip).startsWith('► 0x0000000000400000')).toBe(true);
    expect(text(ip)).toContain('<vuln+0>');
    expect(text(ip)).toContain('c9');
    expect(text(ip)).toContain('leave');
    expect(text(list[1]).startsWith('►')).toBe(false);
    const target = list[1]!.querySelector<HTMLButtonElement>('button.target');
    expect(target?.textContent?.trim()).toBe('<win>');
    // 函数列表在命令栏里，按钮仍可点。
    const cmd = view.renderRoot.querySelector('.cmd');
    expect([...cmd!.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['vuln', 'win']);
  });

  it('指令视图录像帧无反汇编时保留提示', async () => {
    const notice = '录像期间代码段被改写，这一帧没有可信的反汇编';
    const view = await mount('pwn2block-disasm-view', { ...contextOf(stackProjection()), disasmNotice: notice });
    expect(text(view.renderRoot.querySelector('[role="status"]'))).toBe(notice);
    expect(rows(view)).toHaveLength(0);
  });

  it('寄存器行：*RAX 0x… (十进制) —▸ …，FLAGS 行', async () => {
    const base = { RSP: '0x7fffff00', RBP: '0x7fffff10', RIP: '0x400000' };
    const before = makeProjection({ registers: { ...base, RAX: '0x0' }, flags: { ZF: true, CF: false, SF: false } });
    const after = makeProjection({ registers: { ...base, RAX: '0x1337' }, flags: { ZF: true, CF: false, SF: false } });
    const view = await mount('pwn2block-registers-view', contextOf(after, before));
    const list = rows(view);
    const rax = list.find((row) => text(row).includes('RAX'));
    expect(text(rax).startsWith('*RAX 0x0000000000001337 (4919)')).toBe(true);
    expect(rax!.querySelector('.value')?.classList.contains('changed')).toBe(true);
    const rsp = list.find((row) => text(row).includes('RSP'));
    expect(text(rsp).startsWith('RSP')).toBe(true);
    expect(text(rsp)).toContain('—▸');
    expect(rsp!.querySelector('.value')?.classList.contains('changed')).toBe(false);
    expect(rsp!.querySelector('.value')?.classList.contains('r-stack')).toBe(true);
    expect(text(list[list.length - 1])).toBe('FLAGS [ ZF cf sf ]');
  });

  it('寄存器点击值仍复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const view = await mount('pwn2block-registers-view', contextOf(makeProjection({
        registers: { RSP: '0x7fffff00', RBP: '0x7fffff10', RIP: '0x400000', RAX: '0x1337' },
      })));
      const rax = rows(view).find((row) => text(row).includes('RAX'));
      rax!.querySelector<HTMLButtonElement>('button.value')!.click();
      await vi.waitFor(() => expect(view.renderRoot.querySelector('.copied')).not.toBeNull());
      expect(writeText).toHaveBeenCalledWith('0x0000000000001337');
      expect(text(view.renderRoot.querySelector('.copied'))).toBe('已复制 RAX = 0x0000000000001337');
    } finally {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard');
    }
  });

  it('内存：VMA 行 起始 结束 权限 大小 名称，隐藏行标注', async () => {
    const view = await mount('pwn2block-memory-view', contextOf(stackProjection()));
    const list = rows(view);
    expect(list).toHaveLength(3);
    expect(text(list[0]).startsWith('0x0000000000400000 0x0000000000401000 rx 0x1000 text')).toBe(true);
    expect(list[0]!.classList.contains('r-code')).toBe(true);
    expect(list[1]!.classList.contains('r-stack')).toBe(true);
    const hidden = list[2]!;
    expect(hidden.classList.contains('r-hidden')).toBe(true);
    expect(text(hidden)).toContain('隐藏');
    expect(text(hidden).startsWith('0x0000000080000000 0x0000000080001000 r 0x1000 key')).toBe(true);
  });

  it('内存：hexdump 行 地址  16 字节  |ASCII|', async () => {
    const view = await mount('pwn2block-memory-view', contextOf(stackProjection()));
    const pick = rows(view)[0]!.querySelector<HTMLButtonElement>('button');
    expect(pick?.textContent?.trim()).toBe('text');
    pick!.click();
    await view.updateComplete;
    expect(pick!.getAttribute('aria-pressed')).toBe('true');
    const dump = rows(view, '.dump');
    expect(dump.length).toBeGreaterThan(0);
    const first = dump[0]!.textContent ?? '';
    expect(first).toMatch(/^0x[0-9a-f]+ {2}([0-9a-f]{2} ){15}[0-9a-f]{2} {2}\|.{16}\|$/);
    expect(first.startsWith('0x0000000000400000  c9 e8 0f 0e 00')).toBe(true);
  });

  it('I/O：stdin / stdout 原文与已读、新写高亮不变', async () => {
    const before = stackProjection();
    const after = { ...before, stdout: { hex: '686921' } };
    const view = await mount('pwn2block-io-view', contextOf(after, before));
    const stdout = view.renderRoot.querySelector('.stdout');
    expect(stdout?.textContent).toBe('hi!');
    const fresh = [...view.renderRoot.querySelectorAll('.stdout .byte.new')];
    expect(fresh.map((node) => node.textContent)).toEqual(['!']);
    const read = [...view.renderRoot.querySelectorAll('.stdin .byte.read')];
    expect(read.map((node) => node.textContent?.trim())).toEqual(['41', 'A']);
    expect(view.renderRoot.querySelectorAll('.stdin .byte:not(.read)')).toHaveLength(4);
    const syscalls = rows(view, '.syscalls');
    expect(text(syscalls[0]).startsWith('60 (0x3c) exit')).toBe(true);
    const fds = rows(view, '.fds');
    expect(text(fds[1]).startsWith('1 stdout')).toBe(true);
  });
});
