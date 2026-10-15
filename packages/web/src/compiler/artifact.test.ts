import { describe, expect, it } from 'vitest';
import { ret2winPublic, type PublicChallenge } from '@pwn2block/shared';
import { createArtifactTracker, type PayloadArtifact } from './artifact';
import { compileProgram } from './compile';
import type { NormalizedBlock, NormalizedWorkspace } from './types';
import {
  ACTION_ORIGIN_VERSION,
  BLOCK_TYPES,
  INPUTS,
  MESSAGE_NO_START_BLOCK,
  authorBlockType,
} from './types';

/**
 * 编译产物与「编辑后过期」状态机（05 §3、09 §3.2）。
 *
 * D 按冻结语义接线：读 `state.stale / artifact / errors / revision`，调 `compile / noteEdit / clear`。
 * 所以这里逐条钉住那五句话，而不是只测"能编译"：
 * 1. 成功：替换产物、`revision + 1`、`stale = false`、清空错误；
 * 2. 失败：**清空产物**、保留错误、`revision` 不动（旧产物绝不能留下来被试运行或提交）；
 * 3. `noteEdit()`：有产物才标过期；没有产物是空操作；
 * 4. `clear()`：三项全清，`revision` 不回退（避免新旧产物撞号）；
 * 5. 来源表错位是有真实输出时的硬不变式，正常编译不会误报。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const push = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) } });

const rawBytes = (hex: string): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: hex } });

function chainOf(chain: readonly NormalizedBlock[]): NormalizedBlock | undefined {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i] as NormalizedBlock;
    head = { ...current, next: head };
  }
  return head;
}

function programOf(chain: readonly NormalizedBlock[]): NormalizedWorkspace {
  return { blocks: [blk(BLOCK_TYPES.start, { next: chainOf(chain) })] };
}

/** ret2win 的真实公开包，只放开动作白名单，其余字段照旧（tracker 要完整 `PublicChallenge`）。 */
const openChallenge: PublicChallenge = {
  ...ret2winPublic,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
};

const goodProgram = programOf([push(0x41), push(0x42)]);
const badProgram = programOf([blk('bad_block', { id: 'bad' })]);
/** 只有「开始」积木：合法且动作数为 0（契约明写的"空程序"）。 */
const emptyProgram: NormalizedWorkspace = programOf([]);
/** 没有「开始」积木：编译失败，错误用空串 blockId。 */
const noStartProgram: NormalizedWorkspace = { blocks: [] };

describe('产物跟踪器：成功编译', () => {
  it('初始状态干净：没有产物、没有错误、不过期、revision 为 0', () => {
    const tracker = createArtifactTracker();
    expect(tracker.state).toEqual({ artifact: undefined, errors: [], stale: false, revision: 0 });
  });

  it('成功：返回产物、revision + 1、stale = false、错误清零', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(goodProgram, openChallenge);

    expect(artifact).toBeDefined();
    expect(artifact?.actions).toEqual([
      { type: 'push', value: '0x41' },
      { type: 'push', value: '0x42' },
    ]);
    expect(artifact?.originsVersion).toBe(ACTION_ORIGIN_VERSION);
    expect(artifact?.revision).toBe(1);

    expect(tracker.state.artifact).toBe(artifact);
    expect(tracker.state.revision).toBe(1);
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.errors).toEqual([]);
  });

  it('每次成功都 +1，且产物是新对象（旧产物不被就地改写）', () => {
    const tracker = createArtifactTracker();
    const first = tracker.compile(goodProgram, openChallenge);
    const before = tracker.state;
    const second = tracker.compile(goodProgram, openChallenge);

    expect(second?.revision).toBe(2);
    expect(tracker.state.revision).toBe(2);
    expect(second).not.toBe(first);
    // 之前取到的 state 快照仍然指向那一次编译的产物：不可变数据，读者不会脚下换地。
    expect(before.artifact).toBe(first);
    expect(before.revision).toBe(1);
  });

  it('空程序（只有开始积木）也能编译成功：空产物是合法产物', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(emptyProgram, openChallenge);
    expect(artifact?.actions).toEqual([]);
    expect(artifact?.origins).toEqual([]);
    expect(tracker.state.stale).toBe(false);
  });
});

describe('产物跟踪器：编译失败', () => {
  it('失败：清空产物、保留错误、revision 不动、stale = false', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    const failed = tracker.compile(badProgram, openChallenge);

    expect(failed).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.state.errors).toEqual([
      { blockId: 'bad', message: '未知积木类型：bad_block' },
    ]);
    expect(tracker.state.stale).toBe(false);
    // 失败不推进 revision：它没有产出可被引用的产物。
    expect(tracker.state.revision).toBe(1);
  });

  it('错误与 compileProgram 的结果逐字一致（界面直接显示它）', () => {
    const tracker = createArtifactTracker();
    const direct = compileProgram({ program: noStartProgram, challenge: openChallenge });
    expect(direct.ok).toBe(false);
    tracker.compile(noStartProgram, openChallenge);
    expect(tracker.state.errors).toEqual([{ blockId: '', message: MESSAGE_NO_START_BLOCK }]);
  });

  it('失败结果里的错误数组不跨编译复用（新一轮一定有新数组）', () => {
    const tracker = createArtifactTracker();
    tracker.compile(badProgram, openChallenge);
    const first = tracker.state.errors;
    tracker.compile(badProgram, openChallenge);
    expect(tracker.state.errors).toEqual(first);
    expect(tracker.state.errors).not.toBe(first);
  });

  it('上一份成功的产物不会在失败后留下来：报错之后没有可试运行的东西', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    tracker.compile(badProgram, openChallenge);
    expect(tracker.state.artifact).toBeUndefined();
    // 再编辑也不会因"有产物"而标过期——它本来就没有产物。
    tracker.noteEdit();
    expect(tracker.state.stale).toBe(false);
  });
});

describe('产物跟踪器：编辑后过期', () => {
  it('有产物时 noteEdit 标过期，重复调用保持稳定', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);

    tracker.noteEdit();
    expect(tracker.state.stale).toBe(true);
    const stale = tracker.state;
    tracker.noteEdit();
    // 已经过期就什么都不做：状态对象不变，避免无意义的重渲染。
    expect(tracker.state).toBe(stale);
  });

  it('没有产物时 noteEdit 是空操作（stale 保持 false）', () => {
    const tracker = createArtifactTracker();
    const initial = tracker.state;
    tracker.noteEdit();
    expect(tracker.state).toBe(initial);
    expect(tracker.state.stale).toBe(false);
  });

  it('过期后重新编译：stale 回到 false，revision 继续 +1', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    tracker.noteEdit();

    const again = tracker.compile(programOf([push(0x41), push(0x43)]), openChallenge);
    expect(again?.actions).toEqual([
      { type: 'push', value: '0x41' },
      { type: 'push', value: '0x43' },
    ]);
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.revision).toBe(2);
  });

  it('原地继续编辑：每次 noteEdit 之后产物都还在（界面仍能显示上一份编译结果）', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(goodProgram, openChallenge);
    tracker.noteEdit();
    expect(tracker.state.artifact).toBe(artifact);
  });
});

describe('产物跟踪器：clear', () => {
  it('三项全清，revision 不回退', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    tracker.compile(badProgram, openChallenge);
    expect(tracker.state.revision).toBe(1);

    tracker.clear();
    expect(tracker.state).toEqual({ artifact: undefined, errors: [], stale: false, revision: 1 });
  });

  it('clear 之后再次编译：revision 从保留值继续单调递增，不与旧产物撞号', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    tracker.compile(goodProgram, openChallenge);
    tracker.clear();
    expect(tracker.compile(goodProgram, openChallenge)?.revision).toBe(3);
  });

  it('清掉过期标记：clear 之后 stale 是 false，即使之前已过期', () => {
    const tracker = createArtifactTracker();
    tracker.compile(goodProgram, openChallenge);
    tracker.noteEdit();
    tracker.clear();
    expect(tracker.state.stale).toBe(false);
  });
});

describe('产物跟踪器：来源表不变式', () => {
  /** 循环 + 出题人积木的真实编译输出：来源表里两类归因都要有。 */
  const complexProgram = programOf([
    blk(BLOCK_TYPES.controlsRepeat, {
      id: 'loop',
      inputs: { [INPUTS.times]: num(2), [INPUTS.body]: chainOf([push(1)]) },
    }),
    blk(authorBlockType('gets'), { id: 'gets_block', inputs: { data: rawBytes('aabb') } }),
  ]);

  it('有真实编译输出时不误报：等长同序，origins[i].index === i', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(complexProgram, openChallenge);
    expect(artifact).toBeDefined();
    const { actions, origins } = artifact as PayloadArtifact;
    expect(actions).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
      { type: 'block', id: 'gets', args: { data: 'aabb' } },
    ]);
    expect(origins).toEqual([
      { index: 0, blockId: 'loop' },
      { index: 1, blockId: 'loop' },
      { index: 2, blockId: 'gets_block' },
    ]);
  });

  it('来源表不进请求体：产物里的动作单独序列化时没有来源元数据', () => {
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(complexProgram, openChallenge);
    const body = JSON.stringify({ actions: artifact?.actions });
    expect(body).not.toContain('origins');
    expect(body).not.toContain('blockId');
  });
});

describe('产物跟踪器：上限透传', () => {
  it('构造参数里的 limits 会传给编译器（错误条数上限生效）', () => {
    const tracker = createArtifactTracker({ errors: 1 });
    const manyBad = programOf([
      blk('bad_one', { id: 'b1' }),
      blk('bad_two', { id: 'b2' }),
      blk('bad_three', { id: 'b3' }),
    ]);
    tracker.compile(manyBad, openChallenge);
    expect(tracker.state.errors).toEqual([
      { blockId: 'b1', message: '未知积木类型：bad_one' },
    ]);
  });

  it('动作数上限透传：超限即失败，不产生产物', () => {
    const tracker = createArtifactTracker({ actions: 1 });
    expect(tracker.compile(goodProgram, openChallenge)).toBeUndefined();
    expect(tracker.state.errors[0]?.message).toContain('动作数超过上限 1');
  });
});
