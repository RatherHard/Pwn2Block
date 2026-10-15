import { describe, expect, it } from 'vitest';
import { ret2winPublic } from '@pwn2block/shared';
import { createArtifactTracker } from './artifact';
import { compileProgram } from './compile';
import {
  blockIdForAction,
  blockIdForSubmittedAction,
  firstLocatableError,
  highlightTargetForErrors,
  isLocatableError,
  locatableErrorBlockIds,
  originsAreCurrent,
  type OriginSource,
} from './locate';
import type {
  ActionOrigin,
  CompileError,
  CompileResult,
  CompilerChallenge,
  NormalizedBlock,
  NormalizedWorkspace,
} from './types';
import {
  ACTION_ORIGIN_VERSION,
  BLOCK_TYPES,
  INPUTS,
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
} from './types';

/**
 * 定位桥（05 §4、08 §9.2、09 §3.4）：D 拿它决定「高亮哪块积木 / 跳哪块积木」。
 *
 * 这些用例守的不是"函数能调用"，而是四条**必须按未知处理**的情形——定位错了比不定位更坏：
 * 1. 来源表版本与当前不一致（热更新、旧快照）→ 不猜下标；
 * 2. 表内下标与数组下标不符（产物不是这份表产生的）→ 不猜下标；
 * 3. 下标越界 / 不是非负整数 → 不猜下标；
 * 4. 空串 blockId（"没有开始积木"那条）→ 是"没有位置"，不是"位置是空串"。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const push = (value: number, extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) }, ...extras });

function chainOf(chain: readonly NormalizedBlock[]): NormalizedBlock | undefined {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    head = { ...(chain[i] as NormalizedBlock), next: head };
  }
  return head;
}

function programOf(chain: readonly NormalizedBlock[]): NormalizedWorkspace {
  return { blocks: [blk(BLOCK_TYPES.start, { next: chainOf(chain) })] };
}

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

function successOf(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result;
}

function errorsOf(result: CompileResult): readonly CompileError[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

/** 手写一份来源表：用来单独验证"对不上就当未知"，不掺进真实编译的偶然正确。 */
function sourceOf(origins: readonly ActionOrigin[], originsVersion = ACTION_ORIGIN_VERSION): OriginSource {
  return { origins, originsVersion };
}

describe('定位桥：动作来源表（0-based）', () => {
  it('真实编译产物上逐个下标都能定位到产生它的积木', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop1',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([push(1, { id: 'body_push' })]),
        },
      }),
      push(2, { id: 'after_loop' }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(result.actions).toHaveLength(3);
    // `CompileResult.ok` 结构上就是 `OriginSource`：D 不必造中间对象。
    expect([0, 1, 2].map((index) => blockIdForAction(result, index))).toEqual([
      'loop1',
      'loop1',
      'after_loop',
    ]);
    expect(blockIdForAction(result, 3)).toBeUndefined();
  });

  it('产品跟踪器里的产物同样直接可用（PayloadArtifact 结构上满足 OriginSource）', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(
      programOf([push(0x41, { id: 'p1' })]),
      { ...ret2winPublic, allowedActions: [...openChallenge.allowedActions] },
    );
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    expect(blockIdForAction(artifact, 0)).toBe('p1');
    expect(artifact.originsVersion).toBe(ACTION_ORIGIN_VERSION);
  });

  it('版本不一致一律按「来源未知」处理：一个下标都不许猜', () => {
    const stale = sourceOf([{ index: 0, blockId: 'p1' }], ACTION_ORIGIN_VERSION + 1);
    expect(originsAreCurrent(stale)).toBe(false);
    expect(blockIdForAction(stale, 0)).toBeUndefined();
    // 未来协议版本同理：桥只认当前这版，不做兼容猜测。
    expect(blockIdForAction(sourceOf([{ index: 0, blockId: 'p1' }], 999), 0)).toBeUndefined();
  });

  it('表内下标与数组下标不符：整份表按未知处理，不去凑一个"差不多"的位置', () => {
    const misaligned = sourceOf([
      { index: 0, blockId: 'p1' },
      { index: 5, blockId: 'p2' },
    ]);
    expect(blockIdForAction(misaligned, 1)).toBeUndefined();
    // 对得上的那一条仍然可用：不因为邻居错位就连带否掉正确的部分。
    expect(blockIdForAction(misaligned, 0)).toBe('p1');
  });

  it('下标越界 / 负数 / 小数 / 空串 id 都是 undefined', () => {
    const source = sourceOf([
      { index: 0, blockId: 'p1' },
      { index: 1, blockId: '' },
    ]);
    for (const index of [-1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(blockIdForAction(source, index), `下标 ${index} 不该定位`).toBeUndefined();
    }
    expect(blockIdForAction(source, 1)).toBeUndefined();
  });

  it('没有来源表（从未编译 / 旧产物被清掉）时是 undefined，不抛错', () => {
    expect(originsAreCurrent(undefined)).toBe(false);
    expect(blockIdForAction(undefined, 0)).toBeUndefined();
    expect(blockIdForAction(sourceOf([]), 0)).toBeUndefined();
  });
});

describe('定位桥：录像动作帧（1-based，09 §3.4）', () => {
  it('第 k 个 action 帧对应第 k 个提交动作：ordinal 直接喂 k，不用手写 -1', () => {
    const program = programOf([push(1, { id: 'p1' }), push(2, { id: 'p2' }), push(3, { id: 'p3' })]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));

    // 录像约定：`kind === 'action'` 的帧按出现顺序编号（这里用最小帧序列表达编号规则本身）。
    const frames: readonly { kind: 'action' | 'instruction' }[] = [
      { kind: 'instruction' },
      { kind: 'action' },
      { kind: 'action' },
      { kind: 'action' },
    ];
    const ordinals = frames
      .filter((frame) => frame.kind === 'action')
      .map((_frame, index) => index + 1);

    expect(ordinals).toEqual([1, 2, 3]);
    expect(ordinals.map((ordinal) => blockIdForSubmittedAction(result, ordinal))).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    // 0 与超出动作数的编号都不定位（录像里没有第 0 个动作，也没有第 4 个）。
    expect(blockIdForSubmittedAction(result, 0)).toBeUndefined();
    expect(blockIdForSubmittedAction(result, ordinals.length + 1)).toBeUndefined();
    expect(blockIdForSubmittedAction(result, 1.5)).toBeUndefined();
  });

  it('循环展开的动作：第 k 帧指向循环积木本身（08 §9.2）', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop1',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([push(9, { id: 'body_push' })]),
        },
      }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(blockIdForSubmittedAction(result, 1)).toBe('loop1');
    expect(blockIdForSubmittedAction(result, 2)).toBe('loop1');
  });
});

describe('定位桥：编译错误 → 高亮目标（05 §4）', () => {
  it('"没有开始积木"那条没有位置：返回 undefined 让界面清高亮，而不是高亮空串', () => {
    const result = compileProgram({
      program: { blocks: [push(1, { id: 'loose' })] },
      challenge: openChallenge,
    });
    const errors = errorsOf(result);
    expect(errors).toEqual([{ blockId: '', message: MESSAGE_NO_START_BLOCK }]);
    // 空串 ≠ 积木 id：D 若照抄 `errors[0].blockId` 去 highlight，等于把高亮清掉但以为自己高亮了。
    expect(isLocatableError(errors[0] as CompileError)).toBe(false);
    expect(firstLocatableError(errors)).toBeUndefined();
    expect(highlightTargetForErrors(errors)).toBeUndefined();
    expect(locatableErrorBlockIds(errors)).toEqual([]);
  });

  it('未知积木 / 多个开始积木：第一条可定位错误就是该高亮的那块', () => {
    const bad = compileProgram({
      program: programOf([blk('bad_block', { id: 'bad1' })]),
      challenge: openChallenge,
    });
    expect(highlightTargetForErrors(errorsOf(bad))).toBe('bad1');

    const twoStarts = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, { id: 'start_a' }),
          blk(BLOCK_TYPES.start, { id: 'start_b' }),
        ],
      },
      challenge: openChallenge,
    });
    const errors = errorsOf(twoStarts);
    expect(errors.map((error) => error.message)).toEqual([
      MESSAGE_MULTIPLE_START_BLOCKS,
      MESSAGE_MULTIPLE_START_BLOCKS,
    ]);
    expect(highlightTargetForErrors(errors)).toBe('start_a');
    expect(locatableErrorBlockIds(errors)).toEqual(['start_a', 'start_b']);
  });

  it('第一条错误定位不了时继续往后找：可定位的那条仍然给得出来', () => {
    // 编译器目前不会产出这种组合（空串只出现在"一个开始块都没有"，那时只有这一条），
    // 但桥的口径必须比当前实现宽：否则将来多一种"无位置错误"就会让整次定位失效。
    const errors: readonly CompileError[] = [
      { blockId: '', message: '整棵树没有开始积木' },
      { blockId: 'b2', message: '这块积木有问题' },
    ];
    expect(highlightTargetForErrors(errors)).toBe('b2');
    expect(firstLocatableError(errors)?.message).toBe('这块积木有问题');
  });

  it('多条错误按顺序去重：给「下一处错误」跳转用，不重复指同一块', () => {
    const errors: readonly CompileError[] = [
      { blockId: 'b1', message: '缺输入' },
      { blockId: 'b1', message: '类型不对' },
      { blockId: '', message: '没有位置' },
      { blockId: 'b2', message: '未知类型' },
    ];
    expect(locatableErrorBlockIds(errors)).toEqual(['b1', 'b2']);
  });

  it('编译成功（没有错误）时高亮目标是 undefined：界面据此清掉上一次的高亮', () => {
    const result = successOf(
      compileProgram({ program: programOf([push(1, { id: 'p1' })]), challenge: openChallenge }),
    );
    expect(result.origins).toEqual([{ index: 0, blockId: 'p1' }]);
    expect(highlightTargetForErrors([])).toBeUndefined();
  });

  it('真实编译错误的 blockId 一定来自画布：桥只是把它原样交给 highlight', () => {
    const program = programOf([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'feed1',
        inputs: { [INPUTS.bytes]: blk(BLOCK_TYPES.bytesRaw, { id: 'raw_bad', fields: { HEX: 'abc' } }) },
      }),
    ]);
    const errors = errorsOf(compileProgram({ program, challenge: openChallenge }));
    expect(highlightTargetForErrors(errors)).toBe('raw_bad');
    expect(locatableErrorBlockIds(errors)).toEqual(['raw_bad']);
  });
});
