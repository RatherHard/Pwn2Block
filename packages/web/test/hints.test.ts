import { describe, expect, it } from 'vitest';
import type { Hint } from '@pwn2block/shared';
import {
  HINT_STORAGE_VERSION,
  MESSAGE_NO_HINTS,
  defaultStore,
  hintPanelModel,
  hintStorageKey,
  readRevealed,
  writeRevealed,
  type KeyValueStore,
} from '../src/viewmodel/hints';

/** 与 `challenges/ret2win/public.json` 同形：最后一条按失败次数解锁。 */
const HINTS: readonly Hint[] = [
  { text: '先看栈视图：buf、saved rbp、ret addr 三段是连在一起的' },
  { text: 'gets 从 buf 开始写，中间少写一个字节，返回地址就会错位' },
  { text: '覆盖 ret addr 的是 8 个字节，地址低位在前', unlockAfterFailures: 3 },
];

/** 顺序：第 2 条（下标 1）带阈值，用来钉住「不跳过前面的提示」。 */
const GAPPED: readonly Hint[] = [
  { text: 'A' },
  { text: 'B', unlockAfterFailures: 2 },
  { text: 'C' },
];

function memoryStore(initial: Readonly<Record<string, string>> = {}): KeyValueStore {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function stored(store: KeyValueStore, key: string): string | null {
  return store.getItem(key);
}

describe('提示逐级揭示与 unlockAfterFailures（05 §5）', () => {
  it('初始一条都不显示：下一条可手动揭示，且不带锁定说明', () => {
    const model = hintPanelModel({ hints: HINTS, revealed: 0, failures: 0 });
    expect(model.total).toBe(3);
    expect(model.revealedCount).toBe(0);
    expect(model.items).toEqual([]);
    expect(model.next).toEqual({ index: 0, text: HINTS[0]?.text, auto: false });
    expect(model.locked).toBeUndefined();
    expect(model.allRevealed).toBe(false);
    expect(model.autoUnlocked).toEqual([]);
    expect(model.message).toBe('已揭示 0 / 3 条：点「下一条提示」逐条看。');
  });

  it('手动揭示按顺序推进；下一条带阈值时禁用并说明还差几次失败', () => {
    const first = hintPanelModel({ hints: HINTS, revealed: 1, failures: 0 });
    expect(first.items.map((item) => item.text)).toEqual([HINTS[0]?.text]);
    expect(first.items[0]?.auto).toBe(false);
    expect(first.next?.index).toBe(1);

    // 前两条揭示完，第三条要失败 3 次才解锁：不能手动跳过去。
    const gated = hintPanelModel({ hints: HINTS, revealed: 2, failures: 0 });
    expect(gated.items).toHaveLength(2);
    expect(gated.next).toBeUndefined();
    expect(gated.locked).toEqual({ index: 2, required: 3, failures: 0 });
    expect(gated.message).toBe('下一条提示会在失败 3 次后自动解锁（当前 0 次）。');
  });

  it('failures 达到阈值：自动解锁并标出是自动的（界面据此 aria-live 播报）', () => {
    const model = hintPanelModel({ hints: HINTS, revealed: 2, failures: 3 });
    expect(model.revealedCount).toBe(3);
    expect(model.allRevealed).toBe(true);
    expect(model.locked).toBeUndefined();
    expect(model.next).toBeUndefined();
    expect(model.autoUnlocked).toEqual([{ index: 2, text: HINTS[2]?.text, auto: true }]);
    expect(model.message).toBe('提示已全部揭示（3 条）。');
  });

  it('自动解锁跟着最大已揭示序号走：不跳过它前面的提示', () => {
    const model = hintPanelModel({ hints: GAPPED, revealed: 0, failures: 2 });
    // 下标 1 达标 ⇒ 0 与 1 一起揭示，但下标 2 仍然要手动点。
    expect(model.items.map((item) => item.text)).toEqual(['A', 'B']);
    expect(model.items.map((item) => item.auto)).toEqual([true, true]);
    expect(model.next).toEqual({ index: 2, text: 'C', auto: false });
  });

  it('已经手动揭示过的条目不重复算作自动解锁，failures 再涨也不倒退', () => {
    const model = hintPanelModel({ hints: HINTS, revealed: 3, failures: 9 });
    expect(model.revealedCount).toBe(3);
    expect(model.autoUnlocked).toEqual([]);
    expect(model.items.every((item) => !item.auto)).toBe(true);
  });

  it('阈值未达时 failures 不影响已揭示条数', () => {
    const model = hintPanelModel({ hints: HINTS, revealed: 1, failures: 2 });
    expect(model.revealedCount).toBe(1);
    expect(model.items.map((item) => item.text)).toEqual([HINTS[0]?.text]);
    expect(model.autoUnlocked).toEqual([]);
  });

  it('越界与非法的手动揭示条数按 0 或总数收敛', () => {
    expect(hintPanelModel({ hints: HINTS, revealed: 99, failures: 0 }).revealedCount).toBe(3);
    expect(hintPanelModel({ hints: HINTS, revealed: -3, failures: 0 }).revealedCount).toBe(0);
    expect(hintPanelModel({ hints: HINTS, revealed: 1.5, failures: 0 }).revealedCount).toBe(0);
  });

  it('题目没有提示时给出明确说明，而不是空白面板', () => {
    const model = hintPanelModel({ hints: [], revealed: 0, failures: 5 });
    expect(model.total).toBe(0);
    expect(model.allRevealed).toBe(false);
    expect(model.message).toBe(MESSAGE_NO_HINTS);
  });
});

describe('提示进度的本地保存（05 §5：键带版本、损坏数据安全忽略）', () => {
  it('键按题目 id 区分并带版本号', () => {
    expect(HINT_STORAGE_VERSION).toBe(1);
    expect(hintStorageKey('ret2win')).toBe('pwn2block.hints.v1.ret2win');
    expect(hintStorageKey('ret2win')).not.toBe(hintStorageKey('stack-frame'));
  });

  it('写入后可读回，越界与损坏的数据一律按 0', () => {
    const store = memoryStore();
    expect(readRevealed(store, 'ret2win', 3)).toBe(0);
    expect(writeRevealed(store, 'ret2win', 2)).toBe(true);
    expect(stored(store, hintStorageKey('ret2win'))).toBe('2');
    expect(readRevealed(store, 'ret2win', 3)).toBe(2);

    for (const broken of ['', 'abc', '-1', '1.5', 'NaN', '{}', '999']) {
      expect(readRevealed(memoryStore({ [hintStorageKey('ret2win')]: broken }), 'ret2win', 3)).toBe(0);
    }
  });

  it('存储不可用（没有它 / 写入抛错）不抛出，也不假装成功', () => {
    expect(readRevealed(undefined, 'ret2win', 3)).toBe(0);
    expect(writeRevealed(undefined, 'ret2win', 1)).toBe(false);

    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('存储被禁用');
      },
      setItem: () => {
        throw new Error('配额已满');
      },
    };
    // 读写都不抛：读退化成 0，写如实返回 false（不假装成功）。
    expect(readRevealed(throwing, 'ret2win', 3)).toBe(0);
    expect(writeRevealed(throwing, 'ret2win', 1)).toBe(false);
    expect(() => defaultStore()).not.toThrow();
  });
});
