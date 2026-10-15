import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeError,
  TEST_FLAG_SENTINEL,
} from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import {
  TEST_ENV,
  TEST_FLAG_VALUE,
  testPrivate,
  testPublic,
} from './support';
import {
  actionFrames,
  createSession,
  expectNoInternalLeak,
  expectProjectionUnchanged,
  frameShape,
  getProjection,
  getState,
  makeRealChallengeRoot,
  postActions,
  postSubmit,
  registersOf,
} from './real-support';

/**
 * C03 · 接真实引擎的 actions / submit / 双实例隔离（04 §1、§2、§5、§5.1）。
 *
 * 这一份**不注入 fake runtime**：`buildApp` 走默认的 `@pwn2block/engine` 装配工厂，
 * 所有请求经 `app.inject()` 打真实路由、真实请求 Schema、真实引擎（08 §1）。
 * 题目包写在临时目录，内容是 `./support.ts` 里的 ret2win 样例（含隐藏 VMA / fd / errorNotes）。
 *
 * 断言口径：引擎是确定的、不读时间、不用随机数，所以这里断言精确的寄存器、步数、
 * 历史深度与 verdict，不写模糊断言（CLAUDE.md「写代码时」、07 §5）。
 */

const CHALLENGE_ID = 'ret2win';
/** 没有 `fail` 谓词的题目：程序正常退出时终态是 `exited` 而不是 `failed`。 */
const EXIT_LAB = 'exit-lab';
/** `win` 与 `fail` 同时成立的题目：用来验证 `fail` 优先（04 §5.1）。 */
const TIE_LAB = 'tie-lab';

/**
 * ret2win 的溢出积木：16 字节 `buf` + 8 字节 saved rbp + 8 字节新返回地址。
 * 默认写 0x400002（`syscall win`），与 `ret2winSolutionActions` 同构。
 */
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
  challengeRoot = makeRealChallengeRoot({
    [CHALLENGE_ID]: { pub: testPublic(), priv: testPrivate() },
    [EXIT_LAB]: {
      pub: testPublic({ id: EXIT_LAB }),
      // 没有 fail 谓词：`leave; ret` 走到 0x400003 的 `syscall exit` 后是 `exited`。
      priv: testPrivate({ fail: [] }),
    },
    [TIE_LAB]: {
      pub: testPublic({ id: TIE_LAB }),
      priv: testPrivate({
        win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
        // 同一个条件既是 win 又是 fail：只能判 fail（03 §2.1、04 §5.1）。
        fail: [{ reg_eq: { reg: 'FLAG', value: '0x1' } }],
      }),
    },
  });
  app = buildApp({ challengeDir: challengeRoot, env: TEST_ENV });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(challengeRoot, { recursive: true, force: true });
});

describe('C03 · actions 走真实引擎（04 §2、§5）', () => {
  it('单步的真实指令语义、executed 与 history 深度都来自引擎', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const created = await getState(app, sessionId);
    expect(created.projection.steps).toBe(0);
    expect(created.projection.status).toBe('ready');
    expect(created.history).toEqual({ undo: 0, stepBack: 0 });
    expect(registersOf(created.projection)).toMatchObject({
      RIP: '0x400000',
      RSP: '0x7fffff00',
      RBP: '0x7fffff10',
      FLAG: '0x0',
    });

    // 第 1 条：0x400000 的 `leave` → `sp = bp; bp = [bp]`，ip 前移 1。
    const first = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(first.parsed.results).toEqual([{ ok: true, action: 'step' }]);
    expect(first.parsed.executed).toBe(1);
    expect(first.parsed.projection.steps).toBe(1);
    expect(first.parsed.projection.status).toBe('ready');
    expect(registersOf(first.parsed.projection)).toMatchObject({
      RIP: '0x400001',
      RSP: '0x7fffff18',
      RBP: '0x7fffff40',
    });
    expect(first.parsed.history).toEqual({ undo: 1, stepBack: 1 });

    // 第 2 条：0x400001 的 `ret` → ip 取栈上的 0x400003（题目初值是 lose）。
    const second = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(second.parsed.projection.steps).toBe(2);
    expect(registersOf(second.parsed.projection)).toMatchObject({
      RIP: '0x400003',
      RSP: '0x7fffff20',
    });
    expect(second.parsed.history).toEqual({ undo: 2, stepBack: 2 });

    // 第 3 条：0x400003 的 `syscall 60` 退出，命中 fail 谓词（exited 且 FLAG≠1）→ failed。
    const third = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(third.parsed.projection.status).toBe('failed');
    expect(third.parsed.projection.steps).toBe(3);
    expect(third.parsed.projection.lastStop).toEqual({ reason: 'exception', addr: '0x400003' });
    expect(third.parsed.results).toEqual([{ ok: true, action: 'step' }]);
    expect(third.parsed.history).toEqual({ undo: 3, stepBack: 3 });

    // undo 回到上一个请求之前（请求层快照是「一次请求一次撤销」）。
    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection.steps).toBe(2);
    expect(undone.parsed.projection.status).toBe('ready');
    // undo 清掉指令层缓冲：这条时间线不能再往回退（04 §3）。
    expect(undone.parsed.history).toEqual({ undo: 2, stepBack: 0 });
  });

  it('被拒绝的动作 results[k].ok=false 且带 error.code，executed 停在它之前', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);

    const call = await postActions(app, sessionId, [
      { type: 'step' },
      { type: 'write_bytes', addr: '0x7fffff00', hex: '41' },
      { type: 'step' },
    ]);

    expect(call.parsed.results).toHaveLength(2);
    expect(call.parsed.results[0]).toEqual({ ok: true, action: 'step' });
    // ret2win 的 allowedActions 只有 step / run / undo / reset，write_bytes 只能被引擎拒。
    expect(call.parsed.results[1]).toEqual({
      ok: false,
      action: 'write_bytes',
      error: { code: 'action_not_allowed', message: describeError('action_not_allowed') },
    });
    expect(call.parsed.executed).toBe(1);
    // 第三个动作没执行：只跑了 1 条指令（leave），快照也只压了一份。
    expect(call.parsed.projection.steps).toBe(1);
    expect(registersOf(call.parsed.projection).RIP).toBe('0x400001');
    expect(call.parsed.history).toEqual({ undo: 1, stepBack: 1 });
    // 被拒绝的动作让 failures +1（04 §3），而状态其余字段不变。
    expect(call.parsed.projection.failures).toBe(1);
    expectNoInternalLeak(call.body, ['不在本题的 allowedActions 里', TEST_FLAG_SENTINEL]);
  });

  it('进入 failed 后执行类动作被拒且状态不变，回退仍可用', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const lost = await postActions(app, sessionId, [{ type: 'step', count: 3 }]);
    expect(lost.parsed.projection.status).toBe('failed');
    expect(lost.parsed.projection.steps).toBe(3);
    const failedProjection = lost.parsed.projection;

    const blocked = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(blocked.parsed.results).toEqual([
      {
        ok: false,
        action: 'step',
        error: { code: 'not_executable', message: describeError('not_executable') },
      },
    ]);
    expect(blocked.parsed.executed).toBe(0);
    expectProjectionUnchanged(failedProjection, blocked.parsed.projection, 1);
    // 被拒的动作不压快照：历史深度不动。
    expect(blocked.parsed.history).toEqual(lost.parsed.history);

    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection.status).toBe('ready');
    expect(undone.parsed.projection.steps).toBe(0);
  });

  it('进入 exited 后执行类动作被拒且状态不变，回退仍可用', async () => {
    const sessionId = await createSession(app, EXIT_LAB);
    const finished = await postActions(app, sessionId, [{ type: 'run' }]);
    expect(finished.parsed.results).toEqual([{ ok: true, action: 'run' }]);
    expect(finished.parsed.executed).toBe(1);
    expect(finished.parsed.projection.status).toBe('exited');
    expect(finished.parsed.projection.steps).toBe(3);
    expect(finished.parsed.projection.lastStop).toEqual({ reason: 'exit', addr: '0x400003' });

    const blocked = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(blocked.parsed.results[0]?.error?.code).toBe('not_executable');
    expect(blocked.parsed.executed).toBe(0);
    expectProjectionUnchanged(finished.parsed.projection, blocked.parsed.projection, 1);

    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.projection.status).toBe('ready');
    expect(undone.parsed.projection.steps).toBe(0);
  });
});

describe('C03 · 四种 verdict（04 §5.1）', () => {
  it('won：参考解法判胜并下发注入的 flag，录像只含公开投影', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const call = await postSubmit(app, sessionId, WIN_ACTIONS);

    expect(call.parsed.verdict).toBe('won');
    expect(call.parsed.executed).toBe(2);
    expect(call.parsed.results).toEqual([
      { ok: true, action: 'block' },
      { ok: true, action: 'step' },
    ]);
    expect(call.parsed.flag).toBe(TEST_FLAG_VALUE);
    expect(Object.keys(call.parsed)).toContain('flag');
    // flag 只出现在顶层 `flag` 字段；录像里不含 flag 真值、隐藏区内容与 win / fail 谓词。
    expectNoInternalLeak(JSON.stringify(call.parsed.replay), [
      TEST_FLAG_VALUE,
      TEST_FLAG_SENTINEL,
      'reg_eq',
      'mem_contains',
    ]);
    expectNoInternalLeak(call.body, [TEST_FLAG_SENTINEL, 'reg_eq', 'mem_contains']);
  });

  it('failed：运行期异常判负，不下发 flag', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    // 返回地址改成 0x400004：`ret` 之后取到未编码的 0x00，取指异常。
    const call = await postSubmit(app, sessionId, [getsAction('0400400000000000'), { type: 'step', count: 3 }]);

    expect(call.parsed.verdict).toBe('failed');
    expect(call.parsed.executed).toBe(2);
    expect(Object.keys(call.parsed)).not.toContain('flag');
    expect(call.body).not.toContain(TEST_FLAG_VALUE);
    // 失败那条动作帧带运行期异常码，且它是最后一帧。
    const last = call.parsed.replay.frames.at(-1);
    expect(last?.kind).toBe('action');
    expect(last?.error?.code).toBe('invalid_instruction');
  });

  it('rejected：任一动作被拒即终止，不下发 flag', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const call = await postSubmit(app, sessionId, [
      { type: 'write_bytes', addr: '0x7fffff00', hex: '41' },
    ]);

    expect(call.parsed.verdict).toBe('rejected');
    expect(call.parsed.executed).toBe(0);
    expect(call.parsed.results[0]?.error?.code).toBe('action_not_allowed');
    expect(Object.keys(call.parsed)).not.toContain('flag');
    expect(call.body).not.toContain(TEST_FLAG_VALUE);
  });

  it('incomplete：回放跑完但成功条件未满足，不下发 flag', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    // 只覆盖返回地址、不执行：程序仍停在 0x400000，FLAG 未置位。
    const call = await postSubmit(app, sessionId, [getsAction()]);

    expect(call.parsed.verdict).toBe('incomplete');
    expect(call.parsed.executed).toBe(1);
    expect(call.parsed.results).toEqual([{ ok: true, action: 'block' }]);
    expect(Object.keys(call.parsed)).not.toContain('flag');
    expect(call.body).not.toContain(TEST_FLAG_VALUE);
    expect(call.parsed.replay.frames.at(-1)?.status).toBe('ready');
  });

  it('fail 优先于 win：两个谓词同时成立时判 failed', async () => {
    const sessionId = await createSession(app, TIE_LAB);
    const call = await postSubmit(app, sessionId, WIN_ACTIONS);

    // 这条 payload 让 FLAG=1：win（FLAG==1）与 fail（FLAG==1）同时成立。
    expect(call.parsed.verdict).toBe('failed');
    expect(Object.keys(call.parsed)).not.toContain('flag');
    expect(call.body).not.toContain(TEST_FLAG_VALUE);
  });
});

describe('C03 · 双实例隔离（04 §1、§5.1）', () => {
  it('submit 前后调试实例投影逐字段相等，history 不变，undo 仍回退到提交前的手工请求', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const initial = await getProjection(app, sessionId);

    const manual = await postActions(app, sessionId, [
      { type: 'block', id: 'gets', args: { data: '41'.repeat(4) } },
    ]);
    expect(manual.parsed.results).toEqual([{ ok: true, action: 'block' }]);
    expect(manual.parsed.history).toEqual({ undo: 1, stepBack: 0 });
    const beforeSubmit = manual.parsed.projection;

    const submitted = await postSubmit(app, sessionId, WIN_ACTIONS);
    expect(submitted.parsed.verdict).toBe('won');
    expect(submitted.parsed.flag).toBe(TEST_FLAG_VALUE);

    // submit 不改动调试实例：投影**含 failures** 逐字段相等（04 §5.1）。
    const afterSubmit = await getState(app, sessionId);
    expect(afterSubmit.projection).toEqual(beforeSubmit);
    // submit 也不消耗调试实例的历史深度。
    expect(afterSubmit.history).toEqual({ undo: 1, stepBack: 0 });

    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection).toEqual(initial);
    expect(undone.parsed.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('submit 从初态回放：手工改过内存的会话与全新会话提交同一 payload 结果逐字段一致', async () => {
    const manualSession = await createSession(app, CHALLENGE_ID);
    // 手工把返回地址覆盖成 win 的地址，但这份 payload 里**不含**这一步。
    await postActions(app, manualSession, [getsAction()]);
    const withManual = await postSubmit(app, manualSession, [{ type: 'step', count: 3 }]);

    const freshSession = await createSession(app, CHALLENGE_ID);
    const fresh = await postSubmit(app, freshSession, [{ type: 'step', count: 3 }]);

    // 判题实例从初态开始，借不到手工写进去的返回地址：只能判负。
    expect(withManual.parsed.verdict).toBe('failed');
    expect(Object.keys(withManual.parsed)).not.toContain('flag');
    expect(JSON.stringify(withManual.parsed)).toBe(JSON.stringify(fresh.parsed));

    // 调试实例里确实被改过，而录像初态里没有这些字节。
    const debugStack = (await getProjection(app, manualSession)).vmas.find(
      (vma) => vma.id === 'stack',
    );
    expect(debugStack?.hex).toContain('41414141');
    const replayStack = withManual.parsed.replay.initial.vmas.find((vma) => vma.id === 'stack');
    expect(replayStack?.hex).not.toContain('4141');
    expect(withManual.parsed.replay.initial).toEqual(await getProjection(app, freshSession));
  });

  it('调试实例 satisfied 不发 flag、不被记录为通过，也不影响后续提交', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const debugRun = await postActions(app, sessionId, WIN_ACTIONS);

    expect(debugRun.parsed.projection.status).toBe('satisfied');
    expect(debugRun.parsed.executed).toBe(2);
    // 调试响应里没有 flag 字段，也没有任何「已通过」字段。
    expect(Object.keys(debugRun.parsed)).toEqual(['results', 'executed', 'projection', 'history']);
    expect(debugRun.body).not.toContain(TEST_FLAG_VALUE);
    expect(debugRun.body).not.toContain(TEST_FLAG_SENTINEL);

    // satisfied 不是终态也不能「借」给判题实例：提交一个不完整 payload 仍判 incomplete。
    const submitted = await postSubmit(app, sessionId, [getsAction()]);
    expect(submitted.parsed.verdict).toBe('incomplete');
    expect(Object.keys(submitted.parsed)).not.toContain('flag');
    expect(submitted.body).not.toContain(TEST_FLAG_VALUE);

    // submit 之后调试实例仍是原来那份 satisfied 投影。
    const after = await getState(app, sessionId);
    expect(after.projection).toEqual(debugRun.parsed.projection);
    expect(after.history).toEqual(debugRun.parsed.history);
  });

  it('提交次数不限：连续多次 submit 互相独立，不因上一次判胜而改变', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const first = await postSubmit(app, sessionId, WIN_ACTIONS);
    const second = await postSubmit(app, sessionId, WIN_ACTIONS);
    const third = await postSubmit(app, sessionId, [getsAction()]);

    expect(first.parsed.verdict).toBe('won');
    expect(second.parsed.verdict).toBe('won');
    expect(JSON.stringify(second.parsed)).toBe(JSON.stringify(first.parsed));
    expect(third.parsed.verdict).toBe('incomplete');
    expect(Object.keys(third.parsed)).not.toContain('flag');
  });
});

describe('C03 · 录像帧与提交动作的关联（09 §3.4）', () => {
  it('四种 verdict 下 results 与 action 帧一一对应，帧序连续', async () => {
    const payloads: readonly (readonly Record<string, unknown>[])[] = [
      WIN_ACTIONS,
      [getsAction('0400400000000000'), { type: 'step', count: 3 }],
      [{ type: 'write_bytes', addr: '0x7fffff00', hex: '41' }],
      [getsAction()],
    ];
    const verdicts: string[] = [];

    for (const payload of payloads) {
      const sessionId = await createSession(app, CHALLENGE_ID);
      const call = await postSubmit(app, sessionId, payload);
      verdicts.push(call.parsed.verdict);

      const frames = actionFrames(call.parsed.replay.frames);
      expect(frames).toHaveLength(call.parsed.results.length);
      frames.forEach((frame, k) => {
        expect(frame.label).toBe(call.parsed.results[k]?.action);
      });
      expect(call.parsed.replay.frames.map((frame) => frame.index)).toEqual(
        call.parsed.replay.frames.map((_, index) => index),
      );
    }

    expect(verdicts).toEqual(['won', 'failed', 'rejected', 'incomplete']);
  });

  it('被拒绝 / 失败的动作照样占一帧带 error，其后回放终止', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const rejected = await postSubmit(app, sessionId, [getsAction(), { type: 'undo' }]);

    expect(rejected.parsed.verdict).toBe('rejected');
    expect(rejected.parsed.results.map((item) => item.ok)).toEqual([true, false]);
    expect(frameShape(rejected.parsed.replay.frames)).toEqual(['action:block', 'action:undo']);
    const lastRejected = rejected.parsed.replay.frames.at(-1);
    expect(lastRejected?.error?.code).toBe('action_not_allowed');
    expect(actionFrames(rejected.parsed.replay.frames)).toHaveLength(
      rejected.parsed.results.length,
    );
  });

  it('instruction 帧成段紧贴它自己的 action 帧之前（真实行为，与 09 §3.4 的措辞不一致）', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const call = await postSubmit(app, sessionId, WIN_ACTIONS);
    const frames = call.parsed.replay.frames;

    // 真实引擎在动作执行完才 push 动作帧，指令帧由 afterInstruction 钩子在执行中先 push，
    // 所以一次动作的指令帧是**一段连续的 instruction 帧，紧跟它自己的 action 帧之前**；
    // 夹在两个 action 帧之间的指令帧属于**后一个** action，不属于前一个
    // （09 §3.4 / 04 §5.1 的措辞与此相反，已报 A，不迁就文档改实现）。
    expect(frameShape(frames)).toEqual([
      'action:block',
      'instruction:leave',
      'instruction:ret',
      'instruction:syscall win',
      'action:step',
    ]);

    // 关键是归属方向：夹在 action#0（gets 积木）与 action#1（step）之间的三条指令属于 action#1。
    const previousAction = 0;
    const nextAction = 4;
    const between = frames.slice(previousAction + 1, nextAction);
    expect(between.map((frame) => frame.kind)).toEqual([
      'instruction',
      'instruction',
      'instruction',
    ]);
    expect(frames[previousAction]?.label).toBe('block');
    expect(frames[nextAction]?.label).toBe('step');

    // 通用形式：每个 action 帧往回走的连续 instruction 段就是它自己的指令，段之前必是上一个 action 帧。
    frames.forEach((frame, index) => {
      if (frame.kind !== 'action') return;
      let cursor = index - 1;
      while (cursor >= 0 && frames[cursor]?.kind === 'instruction') cursor -= 1;
      if (cursor >= 0) expect(frames[cursor]?.kind).toBe('action');
    });
    // 帧序列以 action 帧收尾：不会有悬空的 instruction 帧。
    expect(frames.at(-1)?.kind).toBe('action');
  });
});
