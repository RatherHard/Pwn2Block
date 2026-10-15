/**
 * 视图管理器状态（05 §2.1）。纯函数：勾选显示/隐藏、列表排序、2 个槽位的滚动窗口。
 *
 * - 同时显示 `SLOT_COUNT` 个槽位，上下排列；`offset` 决定窗口落在 `shown` 的哪一段，
 *   组件按它做纵向滚动，`Ctrl+↑ / Ctrl+↓` 改的也是它；
 * - 「视图」菜单勾选改的是 `shown`（顺序仍按 `order`）；
 * - 所有函数返回新对象，不改动入参。
 */
import type { Projection } from '@pwn2block/shared';

export const VIEW_KINDS = ['stack', 'disasm', 'registers', 'memory', 'io'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** 槽位数量：05 §2.1 要求同时显示两个。 */
export const SLOT_COUNT = 2;

export const VIEW_TITLES: Readonly<Record<ViewKind, string>> = {
  stack: '栈视图',
  disasm: '指令视图',
  registers: '寄存器视图',
  memory: '自由视图',
  io: 'I/O 视图',
};

export const VIEW_DESCRIPTIONS: Readonly<Record<ViewKind, string>> = {
  stack: '按 W 字节一行浏览栈，带 sp / bp 锚点与跳转链附注',
  disasm: '服务端反汇编的地址 / 机器码 / 伪汇编，目标可点击',
  registers: '寄存器与 ZF / CF / SF，点击复制',
  memory: '全部 VMA 布局；非隐藏区域可 hex dump',
  io: 'stdin / stdout 与 syscall 速查（题目声明后出现）',
};

export interface ViewManagerState {
  /** 视图列表顺序（列表排序的结果）。 */
  readonly order: readonly ViewKind[];
  /** 勾选显示的视图，按 `order` 排列。 */
  readonly shown: readonly ViewKind[];
  /** 槽位窗口起点在 `shown` 上的下标。 */
  readonly offset: number;
  /** 键盘焦点所在槽位。 */
  readonly activeSlot: number;
}

/** 题目声明了 stdin / stdout 时才有 I/O 视图（05 §2.6）。 */
export function availableViews(projection: Projection): readonly ViewKind[] {
  const kinds: ViewKind[] = ['stack', 'disasm', 'registers', 'memory'];
  if (projection.stdin !== undefined || projection.stdout !== undefined) kinds.push('io');
  return kinds;
}

export function createViewManagerState(shown: readonly ViewKind[] = ['stack', 'disasm', 'registers', 'memory']): ViewManagerState {
  return {
    order: [...VIEW_KINDS],
    shown: sortByOrder(VIEW_KINDS, shown),
    offset: 0,
    activeSlot: 0,
  };
}

function sortByOrder(order: readonly ViewKind[], kinds: readonly ViewKind[]): readonly ViewKind[] {
  return order.filter((kind) => kinds.includes(kind));
}

export function maxOffset(state: ViewManagerState): number {
  return Math.max(0, state.shown.length - SLOT_COUNT);
}

export function hasMoreAbove(state: ViewManagerState): boolean {
  return state.offset > 0;
}

export function hasMoreBelow(state: ViewManagerState): boolean {
  return state.offset < maxOffset(state);
}

/** 两个槽位当前显示的视图；不足两个时补 undefined。 */
export function slotKinds(state: ViewManagerState): readonly (ViewKind | undefined)[] {
  const slots: (ViewKind | undefined)[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) slots.push(state.shown[state.offset + slot]);
  return slots;
}

export function activeView(state: ViewManagerState): ViewKind | undefined {
  return state.shown[state.offset + state.activeSlot];
}

export function isShown(state: ViewManagerState, kind: ViewKind): boolean {
  return state.shown.includes(kind);
}

function withOffset(state: ViewManagerState, offset: number): ViewManagerState {
  const clamped = Math.min(Math.max(0, offset), maxOffset(state));
  return clamped === state.offset ? state : { ...state, offset: clamped };
}

/** `Ctrl+↑` 传 -1（往前一个视图），`Ctrl+↓` 传 +1（往后一个视图）。 */
export function scrollViews(state: ViewManagerState, delta: number): ViewManagerState {
  if (delta === 0) return state;
  return withOffset(state, state.offset + (delta > 0 ? 1 : -1));
}

export function setViewShown(state: ViewManagerState, kind: ViewKind, shown: boolean): ViewManagerState {
  const already = isShown(state, kind);
  if (already === shown) return state;
  const next = shown ? sortByOrder(state.order, [...state.shown, kind]) : state.shown.filter((item) => item !== kind);
  return withOffset({ ...state, shown: next }, state.offset);
}

export function toggleView(state: ViewManagerState, kind: ViewKind): ViewManagerState {
  return setViewShown(state, kind, !isShown(state, kind));
}

/** 列表排序：把 `kind` 在 `order` 里前后移动一位（拖动排序在 D03 换成指针拖动）。 */
export function moveView(state: ViewManagerState, kind: ViewKind, delta: number): ViewManagerState {
  const index = state.order.indexOf(kind);
  if (index < 0 || delta === 0) return state;
  const target = index + (delta > 0 ? 1 : -1);
  if (target < 0 || target >= state.order.length) return state;
  const order = [...state.order];
  const moved = order[index] as ViewKind;
  order[index] = order[target] as ViewKind;
  order[target] = moved;
  return { ...state, order, shown: sortByOrder(order, state.shown) };
}

export function focusSlot(state: ViewManagerState, slot: number): ViewManagerState {
  const clamped = Math.min(Math.max(0, Math.floor(slot)), SLOT_COUNT - 1);
  return clamped === state.activeSlot ? state : { ...state, activeSlot: clamped };
}
