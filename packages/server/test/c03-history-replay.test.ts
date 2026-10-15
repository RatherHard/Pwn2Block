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
  TEST_RATE_LIMIT,
  actionFrames,
  collectKeys,
  createSession,
  deleteSession,
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
/**
 * 「先满足、后失败」实验台：用来查 `step_back` 到底能恢复出哪些状态。
 *
 * 指令 0（`syscall 5`）把 RAX 置 1 且**不退出**，判题立刻判 `satisfied`；但 `satisfied` 不是
 * 终态（09 §7 第 5 条），取指循环继续；指令 1 是 `0x00`（非法指令）→ 状态 `failed`。
 * 于是指令层环形缓冲里同时存在「`ready`」和「`satisfied`」两种位置，
 * 可以判定 `step_back` 能不能恢复出 `failed`。
 */
const SATISFIED_LAB = 'satisfied-lab';

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
    [SATISFIED_LAB]: {
      pub: testPublic({
        id: SATISFIED_LAB,
        encoding: [
          { opcode: '0x11', op: 'syscall', operands: ['const:5'], mnemonic: 'syscall mark' },
        ],
        syscalls: [
          {
            nr: 5,
            name: 'mark',
            kind: 'custom',
            doc: '把 RAX 置 1（不退出）',
            effects: [{ type: 'set_reg', reg: 'RAX', value: '0x1' }],
          },
          { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
        ],
        labels: [],
      }),
      priv: testPrivate({
        initRegisters: { RSP: '0x500010', RBP: '0x500010', RIP: '0x400000' },
        vmas: [
          {
            id: 'text',
            kind: 'code',
            start: '0x400000',
            size: '0x1000',
            perm: 'rx',
            hidden: false,
            // 0x11 = `syscall 5`（置 RAX=1），0x00 = 非法指令。
            init: [{ at: '0x400000', hex: '1100' }],
          },
          {
            id: 'stack',
            kind: 'stack',
            start: '0x500000',
            size: '0x1000',
            perm: 'rw',
            hidden: false,
          },
        ],
        // 成功条件不依赖 flag：置 RAX=1 即满足，但程序还没退出，会继续跑下一条非法指令。
        win: { reg_eq: { reg: 'RAX', value: '0x1' } },
        fail: [],
      }),
    },
  });
  app = buildApp({ challengeDir: challengeRoot, env: TEST_ENV, rateLimit: TEST_RATE_LIMIT });
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
    // 回退类动作**不计入 failures**（09 §8 第 1 条）：`undo` 只是把旧的 `failed` 状态搬了回来，
    // 并没有把实例推进到 `failed`，所以这里 failuresDelta 必须是 0，不是 +1。
    expectProjectionUnchanged(failedProjection, undone.parsed.projection, 0);
    expect(undone.parsed.projection.status).toBe('failed');
    expect(undone.parsed.projection.steps).toBe(3);

    // failures 的完整轨迹：只增不减（04 §3），且不会被回退动作虚增（09 §8 第 1 条）。
    // `undo` / `reset` 恢复 failed 状态都不加，只有「被拒的动作」与「推进到 failed 的执行类动作」加。
    expect([
      rejected.parsed.projection.failures,
      lost.parsed.projection.failures,
      reset.parsed.projection.failures,
      undone.parsed.projection.failures,
    ]).toEqual([1, 2, 2, 2]);
  });

  it('step_back 恢复不出 failed：指令层环形缓冲里不存在终态位置', async () => {
    // B 的复核判断：`step_back` 恢复出 `failed` 在真实实现里不可达（`stepOnce` 对 failed / exited
    // 的早退发生在 `beforeInstruction` 钩子之前），所以 09 §8 第 1 条里那条 `step_back` 分支是防御性的。
    // 这里用真实引擎 + 真实 HTTP 把这个判断钉死。
    const sessionId = await createSession(app, CHALLENGE_ID);
    const lost = await postActions(app, sessionId, [{ type: 'step', count: 3 }]);
    expect(lost.parsed.projection.status).toBe('failed');
    expect(lost.parsed.projection.failures).toBe(1);
    expect(lost.parsed.history).toEqual({ undo: 1, stepBack: 3 });

    // 连退三次：每一次都只回退到「那条指令执行之前」，那一刻状态必然不是终态，
    // 所以看到的只会是 `ready`（三次都还没走到 fail 谓词）。
    const statuses: string[] = [];
    const failureTrail: number[] = [];
    for (const expectedSteps of [2, 1, 0]) {
      const back = await postActions(app, sessionId, [{ type: 'step_back' }]);
      expect(back.parsed.results).toEqual([{ ok: true, action: 'step_back' }]);
      expect(back.parsed.projection.steps).toBe(expectedSteps);
      // 回退类动作不计入 failures（09 §8 第 1 条），`step_back` 也不例外。
      expect(back.parsed.projection.failures).toBe(1);
      statuses.push(back.parsed.projection.status);
      failureTrail.push(back.parsed.projection.failures);
    }
    expect(statuses).toEqual(['ready', 'ready', 'ready']);
    expect(statuses).not.toContain('failed');
    expect(failureTrail).toEqual([1, 1, 1]);

    // 缓冲空了 → 拒绝，不会因为「没得退」而伪造出一个 failed。
    const exhausted = await postActions(app, sessionId, [{ type: 'step_back' }]);
    expect(exhausted.parsed.results[0]?.error?.code).toBe('empty_history');
    expect(exhausted.parsed.projection.status).toBe('ready');
    // 这次 +1 来自「被拒绝的动作」，与那 3 次成功回退无关（04 §4、09 §8 第 1 条）。
    expect(exhausted.parsed.projection.failures).toBe(2);

    // 请求层快照仍然在：`undo` 撤销的是整个 `step count 3` 请求，回到请求之前的 `ready`，
    // 而不是那个 `failed`（要让 failed 重新出现，得先 `reset` 把 failed 压进请求层，
    // 见上一条用例的 `reset` → `undo`）。
    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection.status).toBe('ready');
    expect(undone.parsed.projection.steps).toBe(0);
    // `undo` 成功恢复既有状态：不计入 failures（09 §8 第 1 条）。
    expect(undone.parsed.projection.failures).toBe(2);
    // 而 `undo` 清空了指令层缓冲，之后 step_back 一律 `empty_history`（B 的第二条理由）。
    const afterUndo = await postActions(app, sessionId, [{ type: 'step_back' }]);
    expect(afterUndo.parsed.results[0]?.error?.code).toBe('empty_history');
    expect(afterUndo.parsed.projection.failures).toBe(3);
    // 请求层快照也空了：这一步回去的路已经没了，但 failed 也绝不会从 step_back 里冒出来。
    const undoneAgain = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undoneAgain.parsed.results[0]?.error?.code).toBe('empty_history');
    expect(undoneAgain.parsed.projection.status).toBe('ready');
    expect(undoneAgain.parsed.projection.failures).toBe(4);

    // `reset` 同样清空环形缓冲：failed 之后 reset，再 step_back 也回不到 failed。
    const resetSession = await createSession(app, CHALLENGE_ID);
    await postActions(app, resetSession, [{ type: 'step', count: 3 }]);
    const reset = await postActions(app, resetSession, [{ type: 'reset' }]);
    expect(reset.parsed.projection.status).toBe('ready');
    expect(reset.parsed.projection.failures).toBe(1);
    const afterReset = await postActions(app, resetSession, [{ type: 'step_back' }]);
    expect(afterReset.parsed.results[0]?.error?.code).toBe('empty_history');
    expect(afterReset.parsed.projection.status).toBe('ready');
    expect(afterReset.parsed.projection.failures).toBe(2);

    // 反向对照：环形缓冲**确实**能恢复出非 `ready` 的状态——`satisfied` 不是终态（09 §7 第 5 条），
    // 所以它是合法位置。真正的不变量是「缓冲里只有非终态位置」，而不是「只能回到 ready」。
    const satisfiedSession = await createSession(app, SATISFIED_LAB);
    const marked = await postActions(app, satisfiedSession, [{ type: 'step', count: 2 }]);
    // 指令 0（`syscall mark`）成功：steps=1、RAX=1、状态 `satisfied`（但循环继续，因为不是终态）；
    // 指令 1（`0x00`）无法解码：它不计入 steps，实例转 `failed`。
    expect(marked.parsed.projection.steps).toBe(1);
    expect(marked.parsed.projection.status).toBe('failed');
    expect(marked.parsed.projection.failures).toBe(1);
    expect(marked.parsed.projection.error?.code).toBe('invalid_instruction');
    expect(registersOf(marked.parsed.projection).RAX).toBe('0x1');
    expect(marked.parsed.results[0]?.error).toEqual({
      code: 'invalid_instruction',
      message: describeError('invalid_instruction', 0x400001n),
    });

    const backToSatisfied = await postActions(app, satisfiedSession, [{ type: 'step_back' }]);
    expect(backToSatisfied.parsed.results).toEqual([{ ok: true, action: 'step_back' }]);
    // 恢复出来的是「指令 1 执行之前」那一刻：已经是 `satisfied`——既不是 `ready`，也不是 `failed`。
    expect(backToSatisfied.parsed.projection.status).toBe('satisfied');
    expect(backToSatisfied.parsed.projection.steps).toBe(1);
    expect(backToSatisfied.parsed.projection.error).toBeUndefined();
    // 恢复出来的既有状态是 satisfied，不是 failed：failed 只由「推进」产生，从不被回退恢复。
    expect(backToSatisfied.parsed.projection.status).not.toBe('failed');
    expect(backToSatisfied.parsed.projection.failures).toBe(1);
  });

  it('抽样穷举：任何成功的 step_back 都不会让投影出现 failed', async () => {
    // 上一条是定向构造；这条做系统抽样：枚举所有长度 ≤ 2 的动作前缀（1+6+36 个），
    // 每个前缀后连发 3 次 step_back，覆盖「step_back 落在第 1/2/3 次」的所有情形。
    // 它只是证据，不是证明——证明在引擎源码的不变量里：`stepOnce` 对 failed / exited 的早退
    // 发生在 `beforeInstruction` 钩子之前，所以环形缓冲里根本不存在终态位置。
    type Batch = readonly unknown[];
    /** 六个单批次动作符号。 */
    const BATCHES: readonly Batch[] = [
      [{ type: 'step' }],
      [{ type: 'step', count: 3 }],
      [{ type: 'run' }],
      [{ type: 'reset' }],
      [{ type: 'undo' }],
      [{ type: 'step_back' }],
    ];
    /** 每个元素是一条动作序列（若干批次）。 */
    const prefixes: Batch[][] = [[]];
    for (const first of BATCHES) {
      prefixes.push([first]);
      for (const second of BATCHES) prefixes.push([first, second]);
    }
    expect(prefixes).toHaveLength(1 + 6 + 36);

    let failedStatesSeen = 0;
    let stepBackRuns = 0;
    let stepBackAfterFailed = 0;
    const restoredStatuses = new Set<string>();
    for (const challengeId of [CHALLENGE_ID, SATISFIED_LAB]) {
      for (const prefix of prefixes) {
        const sessionId = await createSession(app, challengeId);
        const batches: Batch[] = [...prefix];
        for (let back = 0; back < 3; back += 1) batches.push([{ type: 'step_back' }]);
        try {
          let status = 'ready';
          for (const batch of batches) {
            const call = await postActions(app, sessionId, batch);
            const statusBefore = status;
            status = call.parsed.projection.status;
            if (status === 'failed') failedStatesSeen += 1;
            if (call.parsed.results[0]?.action !== 'step_back') continue;
            if (call.parsed.executed !== 1) continue; // 被拒（empty_history）不算回退成功
            stepBackRuns += 1;
            if (statusBefore === 'failed') stepBackAfterFailed += 1;
            restoredStatuses.add(status);
            expect(status).not.toBe('failed');
            expect(status).not.toBe('exited');
          }
        } finally {
          await deleteSession(app, sessionId);
        }
      }
    }

    // 非平凡性正面证据：failed 确实被走到过，而且「先 failed 再 step_back」的组合确实出现过。
    expect(failedStatesSeen).toBeGreaterThan(0);
    expect(stepBackRuns).toBeGreaterThan(0);
    expect(stepBackAfterFailed).toBeGreaterThan(0);
    expect([...restoredStatuses].sort()).toEqual(['ready', 'satisfied']);
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
