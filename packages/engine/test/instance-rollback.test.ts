import { describe, expect, it } from 'vitest';
import type { Action, AuthorBlock, DebugInstance } from '@pwn2block/shared';
import { createDebugInstance } from '../src/instance';
import { replaySubmit } from '../src/replay';
import { readRegister } from '../src/state';
import type { EngineEnv } from '../src/env';
import type { TestChallengeOptions } from './helpers/challenge';
import { DATA_START, code, testKit } from './helpers/challenge';
import { memoryHex } from './helpers/fake-memory';

/**
 * D4 · BG06 回归：**被拒绝的动作不修改状态**（04 §2），包括积木的整块回滚。
 *
 * 缺陷复现路径：积木展开里第一条已生效（就地写了页表），第二条被拒 → `applyBlock` 用
 * `restore(guard)` 派生**新内存句柄**回滚，而 `applyOne` 的拒绝分支丢掉了这个句柄
 * （原先全文只有成功路径写回 `current`）。于是调试实例留下脏字节、判题实例
 * （`replaySubmit` 无条件写回）却是干净的——同一 payload 双实例不一致。
 *
 * 覆盖要求：积木必须**多于一条展开**。单条展开时「先校验后落笔」成立，永远走不到这条路径
 * （`instance.test.ts` 里的 `leak` 积木就是单条，所以那里的旧用例一直是绿的）。
 *
 * 放在单独文件而不是追加进 `instance.test.ts`：那个文件已经 720 行，加完会越过 07 §6 的
 * 800 行上限。
 */

function start(options: TestChallengeOptions = {}): { env: EngineEnv; instance: DebugInstance } {
  const kit = testKit(options);
  return { env: kit.env, instance: createDebugInstance(kit.env) };
}

function hexAt(env: EngineEnv, instance: DebugInstance, addr: bigint, len: number): string {
  return memoryHex(env.memory, instance.state().memory, addr, len);
}

const WRITE_AA: Action = { type: 'write_bytes', addr: '0x2000', hex: 'aa' };

describe('applyRequest：被拒的多动作积木整块回滚（D4 · BG06）', () => {
  /** 第一条写可见 data 区（会成功），第二条写未映射的 0x9000（必被拒）。 */
  const PAIR: AuthorBlock = {
    id: 'pair',
    label: '写两块',
    params: [{ name: 'data', type: 'bytes' }],
    expand: [
      { type: 'write_bytes', addr: '0x2000', hex: '$data' },
      { type: 'write_bytes', addr: '0x9000', hex: '$data' },
    ],
  };
  const PAYLOAD: Action[] = [{ type: 'block', id: 'pair', args: { data: '41424344' } }];

  it('前一条已生效、后一条被拒：内存逐字节回到动作前，且与判题实例一致', () => {
    const { env, instance } = start({ authorBlocks: [PAIR] });
    const outcome = instance.applyRequest(PAYLOAD);

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('inaccessible_address');
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toBe(1);

    // 修复前这里是 41424344：第一条展开就地改了页表，回滚派生的新句柄被丢弃。
    expect(hexAt(env, instance, DATA_START, 4)).toBe('00000000');
    // 交给调用方的状态（HTTP 层投影用的那份）同样是干净的。
    expect(memoryHex(env.memory, outcome.state.memory, DATA_START, 4)).toBe('00000000');

    // 双实例口径（04 §1、D4 的 G2）：同 payload 在判题实例上本来就是干净的。
    const judged = replaySubmit(env, PAYLOAD);
    expect(judged.verdict).toBe('rejected');
    expect(memoryHex(env.memory, judged.finalState.memory, DATA_START, 4)).toBe('00000000');

    // history / failures 口径：被拒的动作不压快照，可回退深度为 0。
    expect(instance.historyDepth()).toEqual({ undo: 0, stepBack: 0 });
    expect(instance.failures()).toBe(1);
  });

  it('同一请求里前一个动作成功、后一个积木被拒：成功那步保留，积木整块回滚', () => {
    const { env, instance } = start({ authorBlocks: [PAIR] });
    const actions: Action[] = [WRITE_AA, ...PAYLOAD];
    const outcome = instance.applyRequest(actions);

    expect(outcome.results.map((result) => result.ok)).toEqual([true, false]);
    expect(outcome.executed).toBe(1);
    // 积木回滚到**积木自己**的执行前（`aa`），不是把整个请求都撤了。
    expect(hexAt(env, instance, DATA_START, 4)).toBe('aa000000');
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 0 });

    const judged = replaySubmit(env, actions);
    expect(memoryHex(env.memory, judged.finalState.memory, DATA_START, 4)).toBe('aa000000');

    // 唯一那份请求级快照回滚整个请求：成功的那步也一起回去。
    instance.applyRequest([{ type: 'undo' }]);
    expect(hexAt(env, instance, DATA_START, 4)).toBe('00000000');
  });

  it('积木里的 step 已推进时间线、后续展开被拒：指令层缓冲一并还原', () => {
    /** 先走一条指令（会进 `stepRing`），再写未映射地址（必被拒）→ 整块回滚。 */
    const STEP_THEN_BAD: AuthorBlock = {
      id: 'step_then_bad',
      label: '走一步再写坏地址',
      params: [],
      expand: [{ type: 'step' }, { type: 'write_bytes', addr: '0x9000', hex: '00' }],
    };
    const { instance } = start({ code: code(0x90, 0x90), authorBlocks: [STEP_THEN_BAD] });
    const outcome = instance.applyRequest([{ type: 'block', id: 'step_then_bad', args: {} }]);

    expect(outcome.results[0]?.error?.code).toBe('inaccessible_address');
    expect(outcome.executed).toBe(0);
    // 修复前这里是 1：块里那个 step 压进缓冲的快照属于被回滚掉的时间线。
    expect(instance.historyDepth()).toEqual({ undo: 0, stepBack: 0 });
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1000n);
    expect(instance.applyRequest([{ type: 'step_back' }]).results[0]?.error?.code).toBe('empty_history');
  });

  it('缓冲**已满**时被拒的积木：还原的是原来的时间线，不是「深度对得上」的空壳', () => {
    // 上一条只压了一条 `step`，走不到 `stepRing.shift()`。把窗口调到 4 先填满，
    // 再让积木里的 `step` 顶掉最旧一条：此时「按长度截断」和「逐项回填」的差别才会暴露——
    // 前者看起来深度一样，但最旧那条（RIP = 0x1000）已经永久丢了，一路退到底回不到程序起点。
    const STEP_THEN_BAD: AuthorBlock = {
      id: 'step_then_bad_full_ring',
      label: '走一步再写坏地址（缓冲已满）',
      params: [],
      expand: [{ type: 'step' }, { type: 'write_bytes', addr: '0x9000', hex: '00' }],
    };
    const { instance } = start({
      code: code(0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90),
      limits: { stepBackWindow: 4 },
      authorBlocks: [STEP_THEN_BAD],
    });

    // 4 条单步正好填满窗口（`beforeInstruction` 压的是**执行前**的状态）。
    const walked = instance.applyRequest([
      { type: 'step' },
      { type: 'step' },
      { type: 'step' },
      { type: 'step' },
    ]);
    expect(walked.executed).toBe(4);
    expect(instance.historyDepth().stepBack).toBe(4);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1004n);

    const rejected = instance.applyRequest([{ type: 'block', id: 'step_then_bad_full_ring', args: {} }]);
    expect(rejected.results[0]?.error?.code).toBe('inaccessible_address');
    expect(rejected.executed).toBe(0);
    expect(rejected.failures).toBe(1);

    // 深度回到 4，而且**内容**是原来那 4 条。
    expect(instance.historyDepth().stepBack).toBe(4);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1004n);
    for (const expected of [0x1003n, 0x1002n, 0x1001n, 0x1000n]) {
      expect(instance.applyRequest([{ type: 'step_back' }]).results[0]?.ok).toBe(true);
      expect(readRegister(instance.state(), 'RIP'), `退到 ${expected.toString(16)}`).toBe(expected);
    }
    expect(instance.historyDepth().stepBack).toBe(0);
    expect(instance.applyRequest([{ type: 'step_back' }]).results[0]?.error?.code).toBe('empty_history');
  });
});

/**
 * G2 独立复核在 D4 发现的**第二条真实缺陷**（与 BG06 同一类，`stepRing` 与 `undoStack` 修复不对称）：
 *
 * `pushUndo` 在 `undoStack` 达到 `maxSnapshots` 时会 `shift()` 丢掉最旧一条，而被拒分支只
 * `undoStack.pop()` —— 弹掉的是刚压进去的那条，**被挤掉的那条不会自己回来**。于是
 * 「为了试一下」的一次被拒动作会静默缩掉一层可撤销历史（默认 1000 时 1000 → 999）。
 *
 * 这里同时钉住**反向**要求：修复必须是 `markRequest` 的**精确逆操作**，不能整栈回填——
 * 同一请求里前面若有成功的 `undo`（它自己会 `pop`），整栈回填会把那次成功的回退也抹掉。
 */
describe('undo 容量边界：被拒动作不得吃掉一层撤销历史（D4 · G2 复核发现）', () => {
  const writeAt = (hex: string): Action => ({ type: 'write_bytes', addr: '0x2000', hex });

  it('撤销栈已满时被拒：深度与**内容**都要原样还在（能一路退到起点）', () => {
    // 第一条展开写 0x2000 成功，第二条写未映射的 0x9000 必被拒 → 走 `pushedNow` 那条路径。
    const PAIR: AuthorBlock = {
      id: 'pair_cap',
      label: '写两块',
      params: [{ name: 'data', type: 'bytes' }],
      expand: [
        { type: 'write_bytes', addr: '0x2000', hex: '$data' },
        { type: 'write_bytes', addr: '0x9000', hex: '$data' },
      ],
    };
    const { env, instance } = start({ limits: { maxSnapshots: 3 }, authorBlocks: [PAIR] });

    // 三条各自成请求，正好把 3 层撤销栈填满。
    for (const byte of ['01', '02', '03']) {
      expect(instance.applyRequest([writeAt(byte)]).executed).toBe(1);
    }
    expect(instance.historyDepth().undo).toBe(3);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('03');

    const rejected = instance.applyRequest([{ type: 'block', id: 'pair_cap', args: { data: 'ff' } }]);
    expect(rejected.results[0]?.error?.code).toBe('inaccessible_address');
    expect(rejected.executed).toBe(0);
    // 修复前这里是 2：最旧那条（回到全零）被 `shift()` 挤掉后再也没回来。
    expect(instance.historyDepth().undo, '被拒不得缩掉撤销深度').toBe(3);
    expect(hexAt(env, instance, DATA_START, 1), '被拒的动作自己不留痕').toBe('03');

    // 内容也要在：三次 undo 必须正好一路退到起点，第四次才是空历史。
    for (const expected of ['02', '01', '00']) {
      expect(instance.applyRequest([{ type: 'undo' }]).results[0]?.ok).toBe(true);
      expect(hexAt(env, instance, DATA_START, 1), `退到 ${expected}`).toBe(expected);
    }
    expect(instance.historyDepth().undo).toBe(0);
    expect(instance.applyRequest([{ type: 'undo' }]).results[0]?.error?.code).toBe('empty_history');
  });

  it('生产默认 maxSnapshots：填满后一次被拒同样不掉层', () => {
    const { instance } = start();
    const cap = 1000; // `MAX_SNAPSHOTS` 的生产默认值（04 §3 的撤销深度）
    for (let index = 0; index < cap; index += 1) instance.applyRequest([writeAt('01')]);
    expect(instance.historyDepth().undo).toBe(cap);

    const rejected = instance.applyRequest([WRITE_AA_BAD]);
    expect(rejected.executed).toBe(0);
    // G2 复核实测修复前是 999。
    expect(instance.historyDepth().undo).toBe(cap);
  });

  it('反向要求：不得整栈回填——同一请求里前面成功的 undo 必须留下', () => {
    const { env, instance } = start({ authorBlocks: [PAIR_FOR_OVERROLLBACK] });

    for (const byte of ['01', '02', '03']) instance.applyRequest([writeAt(byte)]);
    expect(instance.historyDepth().undo).toBe(3);

    // `undo` 先成功（自己弹掉一层）→ 状态回到写入 03 之前；随后的积木被拒，只该撤掉**积木那次**压栈。
    const outcome = instance.applyRequest([{ type: 'undo' }, { type: 'block', id: 'pair_over', args: { data: 'ff' } }]);
    expect(outcome.results.map((result) => result.ok)).toEqual([true, false]);
    expect(outcome.executed).toBe(1);
    expect(hexAt(env, instance, DATA_START, 1), '成功的 undo 已生效：回到 02').toBe('02');
    // 整栈回填的实现会在这里给出 3（把成功的 undo 也抹掉）。
    expect(instance.historyDepth().undo, '成功的 undo 不能被拒绝分支连坐').toBe(2);

    instance.applyRequest([{ type: 'undo' }]);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('01');
  });
});

const WRITE_AA_BAD: Action = { type: 'block', id: 'nope', args: {} };

const PAIR_FOR_OVERROLLBACK: AuthorBlock = {
  id: 'pair_over',
  label: '写两块',
  params: [{ name: 'data', type: 'bytes' }],
  expand: [
    { type: 'write_bytes', addr: '0x2000', hex: '$data' },
    { type: 'write_bytes', addr: '0x9000', hex: '$data' },
  ],
};

/**
 * 同类排查（BG06 要求 3）：`applyOne` 里其余「拒绝且丢弃 `outcome.state`」的分支，都在任何
 * 写入之前返回，因此没有 BG06 那种残留。这些用例把「零残留」钉成精确断言，防止以后有人把
 * 校验挪到写入之后。
 *
 * 「读状态积木」（`reads_state`）不在引擎侧：它是**编译期**防线（05 §4、09 §8 第 4 条），
 * 线上动作集无法表达，服务端与引擎不产出该错误码，所以这里没有对应分支可测。
 */
describe('applyOne：其他拒绝分支同样不改状态与历史（D4 · BG06 排查）', () => {
  it('动作不在 allowedActions：内存、历史、单步缓冲全不动', () => {
    const { env, instance } = start({ code: code(0x90, 0x90), allowedActions: ['step'] });
    const outcome = instance.applyRequest([{ type: 'step', count: 1 }, WRITE_AA]);

    expect(outcome.results.map((result) => result.ok)).toEqual([true, false]);
    expect(outcome.results[1]?.error?.code).toBe('action_not_allowed');
    expect(outcome.executed).toBe(1);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('00');
    // 成功那步的缓冲必须留下：拒绝只还原到自己请求前，不是把整批都清了。
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 1 });

    instance.applyRequest([{ type: 'step_back' }]);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1000n);
    expect(instance.historyDepth().stepBack).toBe(0);
  });

  it('实例已退出 → not_executable：内存与历史不动', () => {
    const { env, instance } = start({ code: code(0x1c), fail: [] });
    expect(instance.applyRequest([{ type: 'step', count: 1 }]).state.status).toBe('exited');
    const before = instance.historyDepth();

    const outcome = instance.applyRequest([WRITE_AA]);
    expect(outcome.results[0]?.error?.code).toBe('not_executable');
    expect(outcome.executed).toBe(0);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('00');
    expect(instance.historyDepth()).toEqual(before);
  });

  it('未知积木 id → unknown_action：不动内存，也不吞掉同一请求里已成功的那步', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([WRITE_AA, { type: 'block', id: 'nope', args: {} }]);

    expect(outcome.results.map((result) => result.ok)).toEqual([true, false]);
    expect(outcome.results[1]?.error?.code).toBe('unknown_action');
    expect(outcome.executed).toBe(1);
    expect(hexAt(env, instance, DATA_START, 2)).toBe('aa00');
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 0 });
  });

  it('积木参数非法（展开期失败）→ invalid_arguments：不压快照、内存不动', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'block', id: 'setip', args: {} }]);

    expect(outcome.results[0]?.error?.code).toBe('invalid_arguments');
    expect(outcome.executed).toBe(0);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('00');
    expect(instance.historyDepth()).toEqual({ undo: 0, stepBack: 0 });
    expect(instance.failures()).toBe(1);
  });
});
