/**
 * 视图面板状态（设计 §3.1）。纯函数：单面板 + 标签切换。
 *
 * - 状态只有「当前标签」一项；哪些标签可用由题目决定（`availableViews`），不存进状态；
 * - 当前标签不可用时（例如本地存着 `io`，而本题没有 I/O）一律显示栈；
 * - 所有函数返回新对象，结果不变时返回原对象，不改动入参。
 */
import type { Projection, PublicChallenge } from '@pwn2block/shared';

export const VIEW_KINDS = ['stack', 'disasm', 'registers', 'memory', 'io', 'pseudocode'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** 当前标签不可用、或存储里读不出合法值时的回退标签。 */
const DEFAULT_VIEW: ViewKind = 'stack';

export const VIEW_TITLES: Readonly<Record<ViewKind, string>> = {
  stack: '栈视图',
  disasm: '指令视图',
  registers: '寄存器视图',
  memory: '自由视图',
  io: 'I/O 视图',
  pseudocode: '伪代码视图',
};

/** 标签栏上的短名（设计 §3.2：`[栈] 指令 寄存器 内存 I/O 伪代码`）。 */
export const VIEW_TAB_LABELS: Readonly<Record<ViewKind, string>> = {
  stack: '栈',
  disasm: '指令',
  registers: '寄存器',
  memory: '内存',
  io: 'I/O',
  pseudocode: '伪代码',
};

export interface ViewManagerState {
  readonly active: ViewKind;
}

/** 判断任意字符串是不是合法的视图种类（读存储时用）。 */
export function isViewKind(value: unknown): value is ViewKind {
  return typeof value === 'string' && (VIEW_KINDS as readonly string[]).includes(value);
}

/**
 * 有哪些视图可用。
 *
 * `io` 的出现条件按 05 §2.6：**题目声明了 `syscalls` 或 `fds`**——公开包是唯一判定输入
 * （所以要传 `challenge`）。只声明 `syscalls`、没有 fd 的题目同样出现 I/O 视图（至少给速查表），
 * 只看 `projection.stdin / stdout` 会漏掉这种情况。
 *
 * 保留“投影里已经有 I/O 状态就算数”的兼容分支：调用方拿不到公开包时（例如回放旧帧）
 * 也不会把明明有 stdin / stdout 的题目判成没有 I/O 视图。
 *
 * `pseudocode` 只在公开包带了伪代码（出题人提供了 `pseudocode.c`）时出现。
 */
export function availableViews(projection: Projection, challenge?: PublicChallenge): readonly ViewKind[] {
  const kinds: ViewKind[] = ['stack', 'disasm', 'registers', 'memory'];
  const declares = challenge !== undefined && (challenge.syscalls !== undefined || challenge.fds !== undefined);
  const hasStreams = projection.stdin !== undefined || projection.stdout !== undefined;
  if (declares || hasStreams) kinds.push('io');
  if (challenge?.pseudocode !== undefined) kinds.push('pseudocode');
  return kinds;
}

export function createViewManagerState(active: ViewKind = DEFAULT_VIEW): ViewManagerState {
  return { active };
}

function withActive(state: ViewManagerState, active: ViewKind): ViewManagerState {
  return active === state.active ? state : { ...state, active };
}

/** 切到指定标签；本题不可用的标签不接受。 */
export function selectView(
  state: ViewManagerState,
  kind: ViewKind,
  available: readonly ViewKind[],
): ViewManagerState {
  return available.includes(kind) ? withActive(state, kind) : state;
}

/** 当前标签不可用时回到栈。 */
export function normalizeActive(state: ViewManagerState, available: readonly ViewKind[]): ViewManagerState {
  return available.includes(state.active) ? state : withActive(state, DEFAULT_VIEW);
}

/**
 * `Ctrl+↑` 传 -1、`Ctrl+↓` 传 +1：在可用标签里首尾循环。
 * 起点按「界面上实际显示的那个标签」算（先 `normalizeActive`），与用户看到的一致。
 */
export function cycleView(
  state: ViewManagerState,
  delta: -1 | 1,
  available: readonly ViewKind[],
): ViewManagerState {
  const kinds = VIEW_KINDS.filter((kind) => available.includes(kind));
  if (kinds.length === 0) return state;
  const current = normalizeActive(state, kinds).active;
  const index = kinds.indexOf(current);
  const next = kinds[(index + delta + kinds.length) % kinds.length] ?? DEFAULT_VIEW;
  return withActive(state, next);
}
