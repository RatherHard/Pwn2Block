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
 * 2. 失败：**清空产物**、保留错误、`revision` 不动（旧产物绝不能留下来被运行或提交）；
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

  it('上一份成功的产物不会在失败后留下来：报错之后没有可运行的东西', () => {
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

describe('产物跟踪器：编辑 → 过期 → 重编译的完整序列（05 §3、09 §8 第 8 条）', () => {
  /**
   * D 的接线只有两种调用：画布变了就 `noteEdit()`，然后（必须）`compile()`。
   * 这一组用例把「一轮编辑」的每个阶段都钉住，尤其是**失败那一轮**：产物被清掉之后，
   * 界面既不能拿旧产物去运行，也不能因为"有错误"就丢掉错误列表。
   */
  it('五个阶段逐阶段断言：成功 → 编辑 → 编译失败 → 修好 → 再成功', () => {
    const tracker = createArtifactTracker();
    const first = tracker.compile(goodProgram, openChallenge);
    expect(tracker.state).toEqual({ artifact: first, errors: [], stale: false, revision: 1 });

    // 阶段 2：画布改了，但还没重编译——产物过期，界面必须禁用运行与提交。
    tracker.noteEdit();
    expect(tracker.state.stale).toBe(true);
    expect(tracker.state.artifact).toBe(first);
    expect(tracker.state.revision).toBe(1);

    // 阶段 3：重编译失败——旧产物**必须消失**（否则会拿它去跑一个不属于画布的 payload）。
    expect(tracker.compile(badProgram, openChallenge)).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.state.errors).toHaveLength(1);
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.revision).toBe(1);

    // 阶段 4：又编辑了一次。这时没有产物，`noteEdit()` 是空操作，`stale` 保持 false，
    // 错误留到下一次编译——界面此时靠"编译失败"而不是"已过期"来解释按钮为什么不可用。
    tracker.noteEdit();
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.errors).toHaveLength(1);

    // 阶段 5：修好之后编译成功：错误清空、产物换新、revision 前进。
    const second = tracker.compile(goodProgram, openChallenge);
    expect(second?.revision).toBe(2);
    expect(tracker.state).toEqual({ artifact: second, errors: [], stale: false, revision: 2 });
    expect(second).not.toBe(first);
  });

  it('产物与错误互斥：任何阶段都不会出现「有产物又有错误」这种自相矛盾的状态', () => {
    const tracker = createArtifactTracker();
    const stages: (() => void)[] = [
      () => void tracker.compile(goodProgram, openChallenge),
      () => tracker.noteEdit(),
      () => void tracker.compile(badProgram, openChallenge),
      () => tracker.noteEdit(),
      () => void tracker.compile(noStartProgram, openChallenge),
      () => void tracker.compile(goodProgram, openChallenge),
      () => tracker.clear(),
    ];
    for (const stage of stages) {
      stage();
      const { artifact, errors } = tracker.state;
      expect(artifact !== undefined && errors.length > 0).toBe(false);
    }
  });

  it('重新编译后的来源表属于**新**程序：旧积木 id 不会留在产物里', () => {
    const tracker = createArtifactTracker();
    const beforePush = push(0x41);
    tracker.compile(programOf([beforePush]), openChallenge);

    const afterPush = push(0x42);
    const after = tracker.compile(programOf([afterPush]), openChallenge);
    expect(after?.actions).toEqual([{ type: 'push', value: '0x42' }]);
    expect(after?.origins).toEqual([{ index: 0, blockId: afterPush.id }]);
    expect(after?.revision).toBe(2);
    expect(after?.origins.map((origin) => origin.blockId)).not.toContain(beforePush.id);
  });

  it('程序化装载（画布没有派发编辑事件）：只标过期不重编译时按钮保持禁用', () => {
    const tracker = createArtifactTracker();
    const loaded = tracker.compile(goodProgram, openChallenge);
    // 页面对"装载"的兜底接线：至少调一次 `noteEdit()`，让产物立刻过期。
    tracker.noteEdit();
    expect(tracker.state.stale).toBe(true);
    expect(tracker.state.artifact).toBe(loaded);

    // 重编译之后才恢复可用，且产物对应的是装载后的程序。
    const reloaded = tracker.compile(programOf([push(0x50)]), openChallenge);
    expect(tracker.state.stale).toBe(false);
    expect(reloaded?.actions).toEqual([{ type: 'push', value: '0x50' }]);
    expect(reloaded?.revision).toBe(2);
  });
});
