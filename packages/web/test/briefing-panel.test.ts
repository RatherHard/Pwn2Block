// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Hint } from '@pwn2block/shared';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/briefing-panel';
import type { Pwn2BlockBriefingPanel } from '../src/components/briefing-panel';
import { hintStorageKey, type KeyValueStore } from '../src/viewmodel/hints';

/**
 * 题面与提示面板（05 §1、§5）：逐级揭示、按 `failures` 自动解锁、进度存本地。
 *
 * 判定逻辑在 `hints.test.ts` 里用纯函数钉住；这里只证明**接线**是对的：
 * 按钮 → 状态 → 本地写入 → 重新挂载能读回来，以及自动解锁会进 `aria-live`。
 */

const HINTS: readonly Hint[] = [
  { text: '提示一' },
  { text: '提示二' },
  { text: '提示三', unlockAfterFailures: 3 },
];

function memoryStore(initial: Readonly<Record<string, string>> = {}): KeyValueStore & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const panels: Pwn2BlockBriefingPanel[] = [];

async function mount(
  options: {
    readonly hints?: readonly Hint[];
    readonly failures?: number;
    readonly storage?: KeyValueStore;
  } = {},
): Promise<Pwn2BlockBriefingPanel> {
  const panel = document.createElement('pwn2block-briefing-panel') as Pwn2BlockBriefingPanel;
  panel.challengeId = 'ret2win';
  panel.challengeTitle = '回到胜利';
  panel.briefing = '题面正文';
  panel.hints = options.hints ?? HINTS;
  panel.failures = options.failures ?? 0;
  panel.storage = options.storage ?? memoryStore();
  document.body.append(panel);
  await panel.updateComplete;
  await panel.updateComplete;
  panels.push(panel);
  return panel;
}

function hintTexts(panel: Pwn2BlockBriefingPanel): readonly string[] {
  return [...panel.renderRoot.querySelectorAll('li .text')].map((item) => item.textContent?.trim() ?? '');
}

function revealButton(panel: Pwn2BlockBriefingPanel): HTMLButtonElement {
  const button = panel.renderRoot.querySelector<HTMLButtonElement>('.hint-actions button');
  if (button === null) throw new Error('没有「下一条提示」按钮');
  return button;
}

function liveNote(panel: Pwn2BlockBriefingPanel): HTMLElement {
  const note = panel.renderRoot.querySelector<HTMLElement>('[role="status"]');
  if (note === null) throw new Error('没有 aria-live 播报区');
  return note;
}

afterEach(() => {
  for (const panel of panels.splice(0)) panel.remove();
});

describe('题面与提示面板（05 §5）', () => {
  it('初始不显示任何提示，点一次揭示一条并写进本地（键带版本）', async () => {
    const storage = memoryStore();
    const panel = await mount({ storage });
    expect(panel.renderRoot.textContent).toContain('题面正文');
    expect(hintTexts(panel)).toEqual([]);
    expect(revealButton(panel).disabled).toBe(false);

    revealButton(panel).click();
    await panel.updateComplete;
    expect(hintTexts(panel)).toEqual(['提示一']);
    expect(storage.data[hintStorageKey('ret2win')]).toBe('1');

    revealButton(panel).click();
    await panel.updateComplete;
    expect(hintTexts(panel)).toEqual(['提示一', '提示二']);
    expect(storage.data[hintStorageKey('ret2win')]).toBe('2');
  });

  it('下一条带 unlockAfterFailures 时按钮禁用，并按 05 §6 写出原因', async () => {
    const panel = await mount({ storage: memoryStore({ [hintStorageKey('ret2win')]: '2' }) });
    expect(hintTexts(panel)).toEqual(['提示一', '提示二']);
    expect(revealButton(panel).disabled).toBe(true);
    expect(revealButton(panel).title).toContain('失败 3 次后自动解锁');
    expect(panel.renderRoot.textContent).toContain('会在失败 3 次后自动解锁（当前 0 次）');
  });

  it('failures 达标后自动解锁，界面标出来源并在 aria-live 里播报', async () => {
    const panel = await mount({ storage: memoryStore({ [hintStorageKey('ret2win')]: '2' }), failures: 3 });
    expect(hintTexts(panel)).toEqual(['提示一', '提示二', '提示三']);
    expect(panel.renderRoot.querySelectorAll('.tag')).toHaveLength(1);
    expect(liveNote(panel).textContent).toContain('自动解锁第 3 条提示');
    expect(revealButton(panel).disabled).toBe(true);
    expect(panel.renderRoot.textContent).toContain('提示已全部揭示（3 条）。');
  });

  it('本地数据损坏（不是数字 / 超出条数）时当作没保存过，不抛出', async () => {
    for (const broken of ['abc', '99', '-1']) {
      const panel = await mount({ storage: memoryStore({ [hintStorageKey('ret2win')]: broken }) });
      expect(hintTexts(panel)).toEqual([]);
      expect(revealButton(panel).disabled).toBe(false);
    }
  });

  it('写入失败（存储被禁用）只影响下次打开，这一次照样揭示', async () => {
    const throwing: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('配额已满');
      },
    };
    const panel = await mount({ storage: throwing });
    revealButton(panel).click();
    await panel.updateComplete;
    expect(hintTexts(panel)).toEqual(['提示一']);
  });

  it('题目没有提示时不渲染提示区，只留题面', async () => {
    const panel = await mount({ hints: [] });
    expect(panel.renderRoot.querySelector('.hints')).toBeNull();
    expect(panel.renderRoot.textContent).toContain('这道题没有提示。');
    expect(panel.renderRoot.textContent).toContain('题面正文');
  });

  it('题面与提示走同一渲染器，HTML 不被解析', async () => {
    const panel = await mount({
      hints: [{ text: '用 `ret`' }],
    });
    panel.briefing = '## 目标\n\n<img src=x onerror=alert(1)> **win**';
    await panel.updateComplete;
    revealButton(panel).click();
    await panel.updateComplete;
    const root = panel.renderRoot;
    expect(root.querySelector('h2, h3, h4')?.textContent).toBe('目标');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('win');
    const hintItem = root.querySelector('.hints li');
    expect(hintItem?.querySelector('code')?.textContent).toBe('ret');
  });
});
