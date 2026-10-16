import { describe, expect, it } from 'vitest';
import { ACTION_ORIGIN_VERSION, MESSAGE_NO_START_BLOCK } from '../src/compiler/types';
import { blockIdForAction } from '../src/compiler/locate';
import { debugOffset, highlightBlockId, rejectedRowFor } from '../src/viewmodel/highlight';
import { makeArtifact } from './fake-api';

/**
 * 「该高亮哪块积木」的唯一派生点（D5 ②，05 §4/§6、09 §3.4）。
 *
 * 这里的用例答的是三处界面（画布 / 程序区 / 输出区）共用的那一个问题，
 * 定位判据全部走 H 的 `compiler/locate.ts`。
 */

const ACTIONS = [{ type: 'ret' }, { type: 'push', value: '0x1' }] as const;

describe('编译错误的定位（05 §4）', () => {
  it('第一条错误没有位置时继续往后找，而不是直接放弃定位', () => {
    // 「画布上没有开始积木」这条错误的 blockId 是空串：它没有具体位置可指。
    const id = highlightBlockId({
      mode: 'debug',
      artifact: undefined,
      errors: [
        { blockId: '', message: MESSAGE_NO_START_BLOCK },
        { blockId: 'blk-later', message: '循环展开超过上限' },
      ],
      results: [],
      cursor: 0,
    });
    expect(id).toBe('blk-later');
  });

  it('全部错误都没有位置时清掉高亮：不把空串当积木 id 传下去', () => {
    expect(
      highlightBlockId({
        mode: 'debug',
        artifact: undefined,
        errors: [{ blockId: '', message: MESSAGE_NO_START_BLOCK }],
        results: [],
        cursor: 0,
      }),
    ).toBeUndefined();
  });

  it('有产物、没有错误时不高亮任何积木', () => {
    expect(
      highlightBlockId({
        mode: 'debug',
        artifact: makeArtifact(ACTIONS),
        errors: [],
        results: [],
        cursor: 0,
      }),
    ).toBeUndefined();
  });
});

describe('被拒绝动作的定位（05 §6）', () => {
  it('调试结果里的被拒绝动作：按游标偏移对回产物里的那一行', () => {
    const artifact = makeArtifact(ACTIONS);
    // 第一条成功、第二条被拒；游标停在 2，所以结果的第 0 条对应产物的第 0 个动作。
    const results = [
      { ok: true, action: 'ret' },
      { ok: false, action: 'push', error: { code: 'hidden_address', message: '落在隐藏区域' } },
    ] as const;
    expect(debugOffset(results, 2)).toBe(0);
    expect(rejectedRowFor(artifact, results, debugOffset(results, 2))).toBe(1);
    expect(
      highlightBlockId({ mode: 'debug', artifact, errors: [], results, cursor: 2 }),
    ).toBe(blockIdForAction(artifact, 1));
  });

  it('游标在中途时的偏移也要对：结果挂在游标之前的那些动作上', () => {
    const artifact = makeArtifact([...ACTIONS, { type: 'ret' }]);
    const results = [
      { ok: true, action: 'ret' },
      { ok: false, action: 'ret', error: { code: 'memory_fault', message: '越界' } },
    ] as const;
    // 已经执行过 3 个动作（游标 3），这两条结果说的是第 1、2 个。
    expect(debugOffset(results, 3)).toBe(1);
    expect(rejectedRowFor(artifact, results, 1)).toBe(2);
  });

  it('动作类型对不上就按「来源未知」处理：宁可不说，也不指向错的积木', () => {
    const artifact = makeArtifact(ACTIONS);
    const results = [{ ok: false, action: 'pop', error: { code: 'empty_history', message: '栈是空的' } }] as const;
    expect(rejectedRowFor(artifact, results, 0)).toBeUndefined();
    expect(highlightBlockId({ mode: 'debug', artifact, errors: [], results, cursor: 1 })).toBeUndefined();
  });

  it('判题那份来源表版本不符时不猜位置（09 §3.4），但也不挡掉编译错误的定位', () => {
    const stale = {
      results: [{ ok: false, action: 'ret', error: { code: 'invalid_ip', message: '指令指针越界' } }] as const,
      origins: [{ index: 0, blockId: 'blk-0' }],
      originsVersion: ACTION_ORIGIN_VERSION - 1,
    };
    expect(
      highlightBlockId({ mode: 'verdict', verdict: stale, artifact: undefined, errors: [], results: [], cursor: 0 }),
    ).toBeUndefined();
    // 版本对得上时正常定位。
    expect(
      highlightBlockId({
        mode: 'verdict',
        verdict: { ...stale, originsVersion: ACTION_ORIGIN_VERSION },
        artifact: undefined,
        errors: [],
        results: [],
        cursor: 0,
      }),
    ).toBe('blk-0');
  });
});
