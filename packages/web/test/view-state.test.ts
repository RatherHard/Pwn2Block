import { describe, expect, it } from 'vitest';
import { viewScrollDelta, isEditableTarget } from '../src/viewmodel/keymap';
import {
  applyProjection,
  createPageState,
  setMode,
  statusLine,
  statusMarker,
  statusTextOf,
} from '../src/viewmodel/session';
import {
  SLOT_COUNT,
  VIEW_KINDS,
  activeView,
  availableViews,
  createViewManagerState,
  focusSlot,
  hasMoreAbove,
  hasMoreBelow,
  isShown,
  maxOffset,
  moveView,
  scrollViews,
  setViewShown,
  slotKinds,
  toggleView,
} from '../src/viewmodel/views';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START, SAMPLE_PUBLIC_CHALLENGE } from '../src/fixtures/sample';
import { makeProjection } from './helpers';

describe('视图管理器状态（05 §2.1）', () => {
  it('默认勾选四个视图并显示前两个槽位', () => {
    const state = createViewManagerState();
    expect(state.order).toEqual([...VIEW_KINDS]);
    expect(state.shown).toEqual(['stack', 'disasm', 'registers', 'memory']);
    expect(slotKinds(state)).toEqual(['stack', 'disasm']);
    expect(activeView(state)).toBe('stack');
    expect(maxOffset(state)).toBe(2);
  });

  it('Ctrl+↑ / Ctrl+↓ 在视图之间滚动，越界时夹住', () => {
    const state = createViewManagerState();
    const down = scrollViews(state, 1);
    expect(slotKinds(down)).toEqual(['disasm', 'registers']);
    expect(hasMoreAbove(down)).toBe(true);
    const end = scrollViews(scrollViews(down, 1), 1);
    expect(end.offset).toBe(2);
    expect(slotKinds(end)).toEqual(['registers', 'memory']);
    expect(scrollViews(end, 1)).toBe(end);
    expect(scrollViews(state, -1)).toBe(state);
    expect(hasMoreBelow(end)).toBe(false);
  });

  it('勾选显示 / 隐藏，勾回来的顺序仍按列表顺序', () => {
    const state = createViewManagerState();
    const hidden = setViewShown(state, 'disasm', false);
    expect(hidden.shown).toEqual(['stack', 'registers', 'memory']);
    expect(isShown(hidden, 'disasm')).toBe(false);
    const back = setViewShown(hidden, 'disasm', true);
    expect(back.shown).toEqual(['stack', 'disasm', 'registers', 'memory']);
    expect(setViewShown(state, 'io', false)).toBe(state);
    expect(toggleView(state, 'memory').shown).toEqual(['stack', 'disasm', 'registers']);
  });

  it('窗口起点在视图减少后收敛到合法范围', () => {
    const state = { ...createViewManagerState(), offset: 2 };
    const fewer = setViewShown(state, 'memory', false);
    expect(fewer.shown).toHaveLength(3);
    expect(fewer.offset).toBe(1);
  });

  it('全部隐藏时没有槽位内容', () => {
    let state = createViewManagerState();
    for (const kind of [...state.shown]) state = setViewShown(state, kind, false);
    expect(state.shown).toEqual([]);
    expect(slotKinds(state)).toEqual([undefined, undefined]);
    expect(maxOffset(state)).toBe(0);
  });

  it('列表排序可上下移动，边界不动', () => {
    const state = createViewManagerState();
    expect(moveView(state, 'stack', 1).order.slice(0, 2)).toEqual(['disasm', 'stack']);
    expect(moveView(state, 'stack', -1)).toBe(state);
    expect(moveView(state, 'io', 1)).toBe(state);
    const moved = moveView(state, 'disasm', -1);
    expect(moved.order.slice(0, 2)).toEqual(['disasm', 'stack']);
    expect(moved.shown.slice(0, 2)).toEqual(['disasm', 'stack']);
  });

  it('槽位焦点限制在 0..SLOT_COUNT-1', () => {
    const state = createViewManagerState();
    expect(focusSlot(state, 1).activeSlot).toBe(1);
    expect(focusSlot(state, 9).activeSlot).toBe(SLOT_COUNT - 1);
    expect(focusSlot(state, -3).activeSlot).toBe(0);
    expect(focusSlot(state, 0)).toBe(state);
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

describe('快捷键（05 §2.1）', () => {
  it('Ctrl+↑ / Ctrl+↓ 映射为前后一个视图', () => {
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: true })).toBe(-1);
    expect(viewScrollDelta({ key: 'ArrowDown', ctrlKey: true })).toBe(1);
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: false })).toBe(0);
    expect(viewScrollDelta({ key: 'a', ctrlKey: true })).toBe(0);
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: true, metaKey: true })).toBe(0);
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: true, altKey: true })).toBe(0);
  });

  it('输入框与可编辑区域里不抢快捷键', () => {
    expect(isEditableTarget({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'input' } })).toBe(true);
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'TEXTAREA' } })).toBe(0);
    expect(viewScrollDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'DIV' } })).toBe(-1);
    expect(
      viewScrollDelta({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }),
    ).toBe(0);
  });
});

describe('页面状态与状态栏文案（05 §1、§6）', () => {
  it('默认是调试模式，切到判题结果再切回来', () => {
    const state = createPageState(SAMPLE_PROJECTION_START);
    expect(state.mode).toBe('debug');
    expect(setMode(state, 'verdict').mode).toBe('verdict');
    expect(setMode(state, 'debug')).toBe(state);
  });

  it('新投影保留上一份用于差分', () => {
    const state = createPageState(SAMPLE_PROJECTION_START);
    const next = applyProjection(state, SAMPLE_PROJECTION_AFTER);
    expect(next.previous).toBe(SAMPLE_PROJECTION_START);
    expect(next.projection).toBe(SAMPLE_PROJECTION_AFTER);
    expect(applyProjection(next, SAMPLE_PROJECTION_AFTER)).toBe(next);
  });

  it('四种调试状态各有文案，判题结果模式另说', () => {
    expect(statusTextOf(makeProjection({ status: 'ready', steps: 3 }), 'debug').text).toContain('已执行 3 条指令');
    expect(statusTextOf(makeProjection({ status: 'satisfied' }), 'debug').text).toContain('已满足成功条件');
    expect(statusTextOf(makeProjection({ status: 'satisfied' }), 'debug').text).toContain('不发 flag');
    const failed = statusTextOf(
      makeProjection({
        status: 'failed',
        error: { code: 'memory_fault', message: '访问了未映射或权限不足的地址', note: '题目自定义说明' },
      }),
      'debug',
    );
    expect(failed.tone).toBe('error');
    expect(failed.text).toContain('题目自定义说明');
    expect(statusTextOf(makeProjection({ status: 'exited' }), 'debug').tone).toBe('warn');
    expect(statusTextOf(SAMPLE_PROJECTION_START, 'verdict').text).toContain('判题结果模式');
  });

  it('状态栏同时给出符号与模式名（05 §7：颜色不是唯一信息载体）', () => {
    expect(statusLine(SAMPLE_PROJECTION_START, 'debug')).toBe('调试模式 · 可继续执行');
    expect(statusLine(SAMPLE_PROJECTION_START, 'verdict')).toBe('判题结果 · 可继续执行');
    expect(statusMarker('ok')).not.toBe(statusMarker('error'));
    expect(statusMarker('error').length).toBeGreaterThan(0);
  });
});
