/**
 * 提示面板（05 §5）：按 `hints` 顺序**逐级**揭示，`unlockAfterFailures` 达标自动解锁，
 * 手动进度按题目 id 存在本地（键带版本；损坏数据安全忽略）。纯函数 + 注入存储，可在 node 里单测。
 *
 * 三条来自文档的硬要求：
 * - 顺序揭示：只有「最大已揭示序号」之前的条目可见，不能跳着揭示后面的提示；
 * - 自动解锁是**单向加法**：`failures` 单调递增（04 §3），所以已揭示不会因回退 / 回放倒退；
 * - 本地保存只是便利：丢失、损坏、被禁用都不影响做题，进度退化成当前页面内存。
 */
import type { Hint } from '@pwn2block/shared';
import type { KeyValueStore } from './storage';

export interface HintItem {
  readonly index: number;
  readonly text: string;
  /** 由 `failures` 达到阈值自动解锁（而不是用户点「下一条提示」），界面要播报。 */
  readonly auto: boolean;
}

export interface HintPanelInput {
  readonly hints: readonly Hint[];
  /** 用户手动揭示的条数：本地保存的最大值。 */
  readonly revealed: number;
  /** 投影 `failures`（04 §4）：只增不减，喂给解锁阈值。 */
  readonly failures: number;
}

export interface HintLock {
  readonly index: number;
  readonly required: number;
  readonly failures: number;
}

export interface HintPanelModel {
  /** 已揭示的提示，按顺序，最多 `revealedCount` 条。 */
  readonly items: readonly HintItem[];
  readonly total: number;
  readonly revealedCount: number;
  readonly allRevealed: boolean;
  /** 可以手动揭示的下一条；全部揭示或下一条被阈值挡住时为 `undefined`。 */
  readonly next?: HintItem;
  /** 下一条被 `unlockAfterFailures` 挡住：按钮要说明还差几次失败（05 §6 同一条要求）。 */
  readonly locked?: HintLock;
  /** 因阈值达标自动解锁的条目：界面用 `aria-live` 播报（05 §5、§7）。 */
  readonly autoUnlocked: readonly HintItem[];
  /** 面板说明（纯文本，颜色不是唯一信息载体）。 */
  readonly message: string;
}

export const MESSAGE_NO_HINTS = '这道题没有提示。';

function clampRevealed(revealed: number, total: number): number {
  if (!Number.isSafeInteger(revealed) || revealed < 0) return 0;
  return Math.min(revealed, total);
}

/**
 * 自动解锁的条数：取「达标条目里最大的下标 + 1」。用最大值而不是逐条累积，
 * 是为了满足「按顺序逐级揭示」——自动解锁第 3 条时，前两条也一并可见。
 */
function autoRevealedCount(hints: readonly Hint[], failures: number): number {
  let count = 0;
  hints.forEach((hint, index) => {
    const threshold = hint.unlockAfterFailures;
    if (threshold !== undefined && failures >= threshold) count = Math.max(count, index + 1);
  });
  return count;
}

function messageOf(input: {
  readonly total: number;
  readonly revealedCount: number;
  readonly locked: HintLock | undefined;
}): string {
  if (input.total === 0) return MESSAGE_NO_HINTS;
  if (input.revealedCount >= input.total) return `提示已全部揭示（${input.total} 条）。`;
  const locked = input.locked;
  if (locked !== undefined) {
    return `下一条提示会在失败 ${locked.required} 次后自动解锁（当前 ${locked.failures} 次）。`;
  }
  return `已揭示 ${input.revealedCount} / ${input.total} 条：点「下一条提示」逐条看。`;
}

export function hintPanelModel(input: HintPanelInput): HintPanelModel {
  const total = input.hints.length;
  const manual = clampRevealed(input.revealed, total);
  const revealedCount = Math.max(manual, autoRevealedCount(input.hints, input.failures));

  const items: readonly HintItem[] = input.hints.slice(0, revealedCount).map((hint, index) => ({
    index,
    text: hint.text,
    // 手动揭示过的条目不算「自动解锁」，即使它也满足阈值。
    auto: index >= manual,
  }));

  const candidate = input.hints[revealedCount];
  const next =
    candidate !== undefined && candidate.unlockAfterFailures === undefined
      ? { index: revealedCount, text: candidate.text, auto: false }
      : undefined;
  // 走到这里时阈值一定还没达标：达标的话 `revealedCount` 已经越过它了。
  const locked =
    candidate === undefined || candidate.unlockAfterFailures === undefined
      ? undefined
      : { index: revealedCount, required: candidate.unlockAfterFailures, failures: input.failures };

  return {
    items,
    total,
    revealedCount,
    allRevealed: total > 0 && revealedCount >= total,
    ...(next === undefined ? {} : { next }),
    ...(locked === undefined ? {} : { locked }),
    autoUnlocked: items.filter((item) => item.auto),
    message: messageOf({ total, revealedCount, locked }),
  };
}

// ---------------------------------------------------------------------------
// 本地保存（05 §5：按题目 id 区分；丢失不影响做题）
// ---------------------------------------------------------------------------

/** 存储键的版本号：形状变了就换版本，旧键自然失效，不需要迁移代码。 */
export const HINT_STORAGE_VERSION = 1;

export function hintStorageKey(challengeId: string): string {
  return `pwn2block.hints.v${HINT_STORAGE_VERSION}.${challengeId}`;
}

// `KeyValueStore` / `defaultStore` 的唯一实现在 `viewmodel/storage.ts`（D5 起画布存档与会话记录
// 也用它）：同一套「存储接口 + 安全退化」实现两份必然漂移（09 §6）。
export { defaultStore } from './storage';
export type { KeyValueStore } from './storage';

/** 读取手动揭示条数：缺失、非数字、越界（题目换了 / 数据损坏）一律按 0。 */
export function readRevealed(store: KeyValueStore | undefined, challengeId: string, total: number): number {
  if (store === undefined) return 0;
  let raw: string | null;
  try {
    raw = store.getItem(hintStorageKey(challengeId));
  } catch {
    // 存储被禁用时某些浏览器连读属性都抛：与「没有存储」等价，进度退化成页面内存。
    return 0;
  }
  if (raw === null || !/^[0-9]+$/.test(raw.trim())) return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > total) return 0;
  return value;
}

/** 写入失败（配额满 / 隐私模式）不抛出：提示进度丢了不影响做题，但也不假装成功。 */
export function writeRevealed(
  store: KeyValueStore | undefined,
  challengeId: string,
  count: number,
): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(hintStorageKey(challengeId), String(count));
    return true;
  } catch {
    return false;
  }
}
