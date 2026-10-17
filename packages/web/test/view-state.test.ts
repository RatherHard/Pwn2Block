import { describe, expect, it } from 'vitest';
import { viewTabDelta, isEditableTarget } from '../src/viewmodel/keymap';
import { readViewTab, writeViewTab, VIEW_TAB_KEY, type KeyValueStore } from '../src/viewmodel/storage';
import {
  VIEW_KINDS,
  VIEW_TAB_LABELS,
  availableViews,
  createViewManagerState,
  cycleView,
  normalizeActive,
  selectView,
} from '../src/viewmodel/views';
import { SAMPLE_PROJECTION_START, SAMPLE_PUBLIC_CHALLENGE } from '../src/fixtures/sample';
import { makeProjection } from './helpers';

const all = VIEW_KINDS;
const noIo = ['stack', 'disasm', 'registers', 'memory'] as const;

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('视图标签状态（设计 §3.1）', () => {
  it('缺省标签是栈，标签名依次为 栈 指令 寄存器 内存 I/O', () => {
    expect(createViewManagerState()).toEqual({ active: 'stack' });
    expect(createViewManagerState('disasm')).toEqual({ active: 'disasm' });
    expect(VIEW_KINDS.map((kind) => VIEW_TAB_LABELS[kind])).toEqual(['栈', '指令', '寄存器', '内存', 'I/O']);
  });

  it('selectView 只接受可用标签', () => {
    expect(selectView({ active: 'stack' }, 'memory', all)).toEqual({ active: 'memory' });
    const s = { active: 'stack' } as const;
    expect(selectView(s, 'io', noIo)).toBe(s);
    expect(selectView(s, 'stack', all)).toBe(s);
  });

  it('cycleView 首尾循环并跳过 I/O', () => {
    expect(cycleView({ active: 'memory' }, 1, noIo)).toEqual({ active: 'stack' });
    expect(cycleView({ active: 'stack' }, -1, noIo)).toEqual({ active: 'memory' });
    expect(cycleView({ active: 'memory' }, 1, all)).toEqual({ active: 'io' });
    expect(cycleView({ active: 'io' }, 1, all)).toEqual({ active: 'stack' });
    expect(cycleView({ active: 'stack' }, 1, noIo)).toEqual({ active: 'disasm' });
  });

  it('cycleView 从不可用的当前标签出发时先回到栈再走', () => {
    expect(cycleView({ active: 'io' }, 1, noIo)).toEqual({ active: 'disasm' });
    const only = { active: 'stack' } as const;
    expect(cycleView(only, 1, ['stack'])).toBe(only);
  });

  it('normalizeActive 不可用时回到栈', () => {
    expect(normalizeActive({ active: 'io' }, noIo)).toEqual({ active: 'stack' });
    const s = { active: 'memory' } as const;
    expect(normalizeActive(s, noIo)).toBe(s);
  });

  it('持久化读写与回退', () => {
    const store = memoryStore();
    expect(VIEW_TAB_KEY).toBe('p2b:view-tab');
    expect(readViewTab(store)).toBe('stack');
    writeViewTab(store, 'registers');
    expect(store.getItem('p2b:view-tab')).toBe('registers');
    expect(readViewTab(store)).toBe('registers');
    store.setItem('p2b:view-tab', 'garbage');
    expect(readViewTab(store)).toBe('stack');
    const throwing = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(readViewTab(throwing)).toBe('stack');
    expect(() => writeViewTab(throwing, 'memory')).not.toThrow();
  });

  it('I/O 视图按公开包的出现条件判定（05 §2.6）：rt2win 声明了 syscalls，所以有', () => {
    expect(availableViews(SAMPLE_PROJECTION_START, SAMPLE_PUBLIC_CHALLENGE)).toEqual([
      'stack',
      'disasm',
      'registers',
      'memory',
      'io',
    ]);
    // 兼容分支：调用方只有投影时，投影里已有 I/O 状态也算数。
    const withIo = makeProjection({ stdin: { hex: '4141', pos: 0 } });
    expect(availableViews(withIo)).toContain('io');
  });
});

describe('快捷键（设计 §3.1）', () => {
  it('viewTabDelta：Ctrl+↑/↓ 返回 -1/1', () => {
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: true })).toBe(-1);
    expect(viewTabDelta({ key: 'ArrowDown', ctrlKey: true })).toBe(1);
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: false })).toBe(0);
    expect(viewTabDelta({ key: 'a', ctrlKey: true })).toBe(0);
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: true, metaKey: true })).toBe(0);
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: true, altKey: true })).toBe(0);
  });

  it('viewTabDelta：输入框与可编辑区域里返回 0', () => {
    expect(isEditableTarget({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'input' } })).toBe(true);
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'TEXTAREA' } })).toBe(0);
    expect(viewTabDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'DIV' } })).toBe(-1);
    expect(
      viewTabDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }),
    ).toBe(0);
  });
});
