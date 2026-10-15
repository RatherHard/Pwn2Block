import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_FLAG_SENTINEL, describeError } from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import type { VmaView } from '@pwn2block/shared';
import { buildApp } from '../src/app';
import {
  HIDDEN_KEY_HEX,
  TEST_ENV,
  TEST_FLAG_VALUE,
  testPrivate,
  testPublic,
} from './support';
import {
  actionFrames,
  collectKeys,
  createSession,
  expectNoInternalLeak,
  expectProjectionUnchanged,
  getProjection,
  getState,
  makeRealChallengeRoot,
  postActions,
  postSubmit,
  registersOf,
} from './real-support';

/**
 * C03 · 回退与录像（04 §3、§5、§5.1；09 §3.4）。
 *
 * 全部走真实引擎 + 真实 HTTP，不注入 fake runtime。回退的断言口径来自引擎的三层历史：
 * 请求层（一次请求一次撤销）、指令层（64 条环形缓冲）、可 undo 的 `reset`（04 §3、B02）。
 */

const CHALLENGE_ID = 'ret2win';
/** 允许 `write_bytes` 的题目：用来把「直接动作碰隐藏区」这条拒绝路径跑起来。 */
const LEAK_LAB = 'leak-lab';

/** 虚拟文件内容：只存在于私有包，任何响应里都不该出现（01 §6 第 2 条）。 */
const FILE_CONTENT_HEX = 'de'.repeat(16);

function getsAction(retAddr = '0200400000000000'): Record<string, unknown> {
  return {
    type: 'block',
    id: 'gets',
    args: { data: `${'41'.repeat(16)}${'42'.repeat(8)}${retAddr}` },
  };
}

const WIN_ACTIONS: readonly Record<string, unknown>[] = [getsAction(), { type: 'step', count: 3 }];

let app: FastifyInstance;
let challengeRoot = '';

beforeAll(async () => {
  const basePub = testPublic();
  challengeRoot = makeRealChallengeRoot({
    [CHALLENGE_ID]: { pub: basePub, priv: testPrivate() },
    [LEAK_LAB]: {
      pub: testPublic({
        id: LEAK_LAB,
        // 放开写原语，才能让「直接动作碰隐藏 VMA」落到引擎的隐藏检查上。
        allowedActions: [...basePub.allowedActions, 'write_bytes'],
        fds: [
          { fd: 0, name: 'stdin', kind: 'stdin' },
          { fd: 1, name: 'stdout', kind: 'stdout' },
          { fd: 3, name: 'config', kind: 'file', size: FILE_CONTENT_HEX.length / 2 },
        ],
      }),
      priv: testPrivate({ files: { '3': { hex: FILE_CONTENT_HEX } } }),
    },
  });
  app = buildApp({ challengeDir: challengeRoot, env: TEST_ENV });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(challengeRoot, { recursive: true, force: true });
});

/** 从提交响应里收集所有出现过的 VMA 视图（初态 + 每帧的 diff）。 */
function allVmaViews(initial: readonly VmaView[], frames: readonly { changedVmas: readonly VmaView[] }[]): VmaView[] {
  return [...initial, ...frames.flatMap((frame) => frame.changedVmas)];
}

describe('C03 · 回退（04 §3、§5）', () => {
  it('undo / step_back 的可回退深度与状态按引擎历史契约变化', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    expect((await getState(app, sessionId)).history).toEqual({ undo: 0, stepBack: 0 });

    // 一次请求压一份请求层快照；两条指令各进一次指令层环形缓冲。
    const two = await postActions(app, sessionId, [{ type: 'step', count: 2 }]);
    expect(two.parsed.results).toEqual([{ ok: true, action: 'step' }]);
    expect(two.parsed.executed).toBe(1);
    expect(two.parsed.projection.steps).toBe(2);
    expect(two.parsed.history).toEqual({ undo: 1, stepBack: 2 });

    const back = await postActions(app, sessionId, [{ type: 'step_back' }]);
    expect(back.parsed.results).toEqual([{ ok: true, action: 'step_back' }]);
    expect(back.parsed.executed).toBe(1);
    expect(back.parsed.projection.steps).toBe(1);
    expect(registersOf(back.parsed.projection).RIP).toBe('0x400001');
    expect(back.parsed.history).toEqual({ undo: 1, stepBack: 1 });

    // undo 回到整批请求之前，并清掉指令层缓冲（04 §3：undo 之后不能再用 step_back 往回退）。
    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection.steps).toBe(0);
    expect(registersOf(undone.parsed.projection)).toMatchObject({
      RIP: '0x400000',
      RSP: '0x7fffff00',
      RBP: '0x7fffff10',
    });
    expect(undone.parsed.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('历史为空时回退被拒绝（results[0].ok=false）且状态不变', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const before = await getProjection(app, sessionId);

    for (const type of ['undo', 'step_back'] as const) {
      const call = await postActions(app, sessionId, [{ type }]);
      expect(call.parsed.results).toEqual([
        {
          ok: false,
          action: type,
          error: { code: 'empty_history', message: describeError('empty_history') },
        },
      ]);
      expect(call.parsed.executed).toBe(0);
      expect(call.parsed.history).toEqual({ undo: 0, stepBack: 0 });
    }

    // 拒绝只让 failures 单调 +1（两次拒绝），状态其余字段逐字段不变。
    const after = await getProjection(app, sessionId);
    expect(after.failures).toBe(2);
    expectProjectionUnchanged(before, after, 2);
  });

  it('reset 可被 undo 撤销，failures 单调不回退', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);

    // 全被拒的请求不压快照（04 §2），所以历史深度不动，只有 failures +1。
    const rejected = await postActions(app, sessionId, [
      { type: 'write_bytes', addr: '0x7fffff00', hex: '41' },
    ]);
    expect(rejected.parsed.projection.failures).toBe(1);
    expect(rejected.parsed.history).toEqual({ undo: 0, stepBack: 0 });

    // 走到 fail 谓词：状态 failed，failures 再 +1。
    const lost = await postActions(app, sessionId, [{ type: 'step', count: 3 }]);
    expect(lost.parsed.projection.status).toBe('failed');
    expect(lost.parsed.projection.failures).toBe(2);
    expect(lost.parsed.history).toEqual({ undo: 1, stepBack: 3 });
    const failedProjection = lost.parsed.projection;

    const reset = await postActions(app, sessionId, [{ type: 'reset' }]);
    expect(reset.parsed.results).toEqual([{ ok: true, action: 'reset' }]);
    expect(reset.parsed.projection.status).toBe('ready');
    expect(reset.parsed.projection.steps).toBe(0);
    // reset 自己压一份快照（所以可被撤销）并清空指令层缓冲；failures 不因 reset 减少。
    expect(reset.parsed.history).toEqual({ undo: 2, stepBack: 0 });
    expect(reset.parsed.projection.failures).toBe(2);

    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.history).toEqual({ undo: 1, stepBack: 0 });
    // 状态字段（status / steps / registers / lastStop…）逐字段回到 reset 之前那个 failed 状态。
    // **已报 B 的引擎行为**：`undo` 把状态恢复成 `failed` 后，`instance.applyRequest` 在动作之后
    // 又看到 `current.status === 'failed'`，于是再记一次失败，`failures` 从 2 变成 3。
    // 04 §4 的计数口径是「被拒绝 + 失败的动作计数」，而这次 undo 本身是成功的，
    // 所以这一次 +1 与该口径不符；`failures` 只能由引擎的 `DebugInstance` 给出，服务端无法纠正。
    expectProjectionUnchanged(failedProjection, undone.parsed.projection, 1);
    expect(undone.parsed.projection.status).toBe('failed');
    expect(undone.parsed.projection.steps).toBe(3);

    // failures 的完整轨迹：只增不减（04 §3）。最后一个数字是上面那条引擎行为。
    expect([
      rejected.parsed.projection.failures,
      lost.parsed.projection.failures,
      reset.parsed.projection.failures,
      undone.parsed.projection.failures,
    ]).toEqual([1, 2, 2, 3]);
  });
});

describe('C03 · 录像与提交动作的关联（09 §3.4）', () => {
  it('replay.initial 是题目初态，而不是调试实例的当前状态', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const created = await getProjection(app, sessionId);

    // 手工把返回地址覆盖好并单步一次：调试实例已经离初态很远。
    await postActions(app, sessionId, [getsAction(), { type: 'step' }]);
    const debugNow = await getProjection(app, sessionId);
    expect(debugNow).not.toEqual(created);
    expect(debugNow.steps).toBe(1);

    const call = await postSubmit(app, sessionId, WIN_ACTIONS);
    expect(call.parsed.verdict).toBe('won');
    // 录像初态与**创建会话时**的投影逐字段一致（含 steps=0 / status=ready / 未被改写的栈）。
    expect(call.parsed.replay.initial).toEqual(created);
    expect(call.parsed.replay.initial.steps).toBe(0);
    expect(call.parsed.replay.initial.status).toBe('ready');
    expect(call.parsed.replay.initial).not.toHaveProperty('lastStop');
    expect(call.parsed.replay.initial).not.toHaveProperty('error');
    const stack = call.parsed.replay.initial.vmas.find((vma) => vma.id === 'stack');
    expect(stack?.hex).not.toContain('4141');
  });

  it('录像只含公开投影：隐藏 VMA 内容、虚拟文件内容、win / fail 谓词、flag 都不出现', async () => {
    const sessionId = await createSession(app, LEAK_LAB);
    // 直接动作写隐藏 VMA：引擎回 hidden_address，动作帧带 error，回放随即终止。
    const call = await postSubmit(app, sessionId, [
      { type: 'write_bytes', addr: '0x600000', hex: '41' },
    ]);

    expect(call.parsed.verdict).toBe('rejected');
    expect(call.parsed.results[0]?.error?.code).toBe('hidden_address');
    expect(actionFrames(call.parsed.replay.frames)).toHaveLength(call.parsed.results.length);

    // 隐藏区任何地方都只有布局、没有内容（含每帧的 changedVmas）。
    for (const vma of allVmaViews(call.parsed.replay.initial.vmas, call.parsed.replay.frames)) {
      if (!vma.hidden) continue;
      expect(vma.id).toBe('key');
      expect(vma).not.toHaveProperty('hex');
    }

    // 正文里没有任何秘密：隐藏区内容、虚拟文件内容、win / fail 谓词、flag 真值。
    expectNoInternalLeak(call.body, [
      HIDDEN_KEY_HEX,
      TEST_FLAG_SENTINEL,
      TEST_FLAG_VALUE,
      FILE_CONTENT_HEX,
      'reg_eq',
      'mem_contains',
    ]);
    // 投影形状里也没有承载虚拟文件内容 / 谓词的字段。
    const keys = collectKeys(call.parsed);
    for (const forbidden of ['win', 'fail', 'files', 'flag']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(Object.keys(call.parsed)).not.toContain('flag');
  });

  it('won 的录像同样不含 flag 真值，只有顶层 flag 字段带出 flag', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const call = await postSubmit(app, sessionId, WIN_ACTIONS);

    expect(call.parsed.flag).toBe(TEST_FLAG_VALUE);
    expectNoInternalLeak(JSON.stringify(call.parsed.replay), [
      TEST_FLAG_VALUE,
      TEST_FLAG_SENTINEL,
      HIDDEN_KEY_HEX,
      'reg_eq',
      'mem_contains',
    ]);
  });
});
