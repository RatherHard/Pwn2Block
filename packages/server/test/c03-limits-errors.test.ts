import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ACTIONS_PER_REQUEST,
  MAX_BODY_BYTES,
  MAX_IO_BYTES,
  MAX_RUN_MAX_STEPS,
  MAX_STEP_COUNT,
  MAX_SUBMIT_ACTIONS,
  describeError,
} from '@pwn2block/shared';
import type { ChallengeVma } from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import {
  HIDDEN_KEY_HEX,
  TEST_ENV,
  expectApiError,
  testPrivate,
  testPublic,
} from './support';
import type { ChallengePackage } from './real-support';
import {
  createSession,
  expectNoInternalLeak,
  expectProjectionUnchanged,
  getProjection,
  getState,
  makeRealChallengeRoot,
  postActions,
  postSubmit,
  withoutFailures,
} from './real-support';

/**
 * C03 · 资源限制与错误映射（04 §2、§4、§6；`shared/limits.ts`）。
 *
 * 两类拒绝必须分清，断言口径也不同：
 * - **Schema 层拒绝**（请求体超限、动作数超限、`step.count` / `run.maxSteps` 超限）：
 *   请求根本没进引擎，`failures` 也不能变。
 * - **引擎层拒绝**（`feed` 累计超 4KB、隐藏区写、未允许动作）：动作不生效、状态不变，
 *   但 `failures` 按 04 §3 单调 +1，所以它单列正面断言。
 */

const CHALLENGE_ID = 'ret2win';
/** 允许 `feed` 的题目：用来把 stdin 4KB 上限跑到。 */
const FEED_LAB = 'feed-lab';
/** 允许 `write_bytes` 的题目：用来把隐藏 / 越权地址的拒绝路径跑到。 */
const PROBE_LAB = 'probe-lab';
/**
 * 指纹实验台：程序用 `copy` 效果把**隐藏 VMA** 的 16 字节拷进可见栈。
 *
 * 这样「隐藏内存有没有被拒绝的动作悄悄改过」就有了可观察口径——HTTP 投影里看不到隐藏字节，
 * 只能让程序自己把它们搬出来再比较（01 §6 第 2 条：隐藏内容只能经由程序执行获取）。
 */
const FINGERPRINT_LAB = 'fingerprint-lab';
const FINGERPRINT_BUF = '0x500000';
const FINGERPRINT_KEY = '0x600000';
const FINGERPRINT_LEN = 16;
/** 隐藏 VMA 的内容：只要被改掉一个字节，搬进可见栈的那 16 字节就会不同。 */
const FINGERPRINT_KEY_HEX = 'c0ffee00c0ffee00c0ffee00c0ffee00';

const HIDDEN_NOTE = '这块内存只能让程序自己去读';

/** 引擎 rejectError 的 detail：永远不下发（04 §4：`VmError.detail` 不进投影）。 */
const ENGINE_DETAILS: readonly string[] = [
  '未声明的出题人积木',
  '缺少参数',
  '需要偶数字节的 hex 字符串',
  '不在本题的 allowedActions 里',
  '区间落在隐藏 VMA 内',
  '区间未映射或权限不足',
  'stdin 累计',
];

let app: FastifyInstance;
let challengeRoot = '';
const basePub = testPublic();

/** 指纹实验台：程序用 `copy` 效果把隐藏 VMA 的 16 字节搬进可见栈，供跨会话比较。 */
function fingerprintPackages(): ChallengePackage {
  const textVma: ChallengeVma = {
    id: 'text',
    kind: 'code',
    start: '0x400000',
    size: '0x1000',
    perm: 'rx',
    hidden: false,
    // 0x11 = `syscall 7`（copy 隐藏区 16 字节 → 可见栈，然后退出）。
    init: [{ at: '0x400000', hex: '11' }],
  };
  const stackVma: ChallengeVma = {
    id: 'stack',
    kind: 'stack',
    start: FINGERPRINT_BUF,
    size: '0x1000',
    perm: 'rw',
    hidden: false,
  };
  const keyVma: ChallengeVma = {
    id: 'key',
    kind: 'key',
    start: FINGERPRINT_KEY,
    size: '0x1000',
    perm: 'r',
    hidden: true,
    init: [{ at: FINGERPRINT_KEY, hex: FINGERPRINT_KEY_HEX }],
  };

  return {
    pub: testPublic({
      id: FINGERPRINT_LAB,
      encoding: [
        { opcode: '0x11', op: 'syscall', operands: ['const:7'], mnemonic: 'syscall copy' },
      ],
      syscalls: [
        { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
        {
          nr: 7,
          name: 'copy',
          kind: 'custom',
          doc: '把隐藏区 16 字节拷进可见栈',
          effects: [
            { type: 'copy', src: FINGERPRINT_KEY, dst: FINGERPRINT_BUF, len: FINGERPRINT_LEN },
            { type: 'exit' },
          ],
        },
      ],
      labels: [],
      allowedActions: [...basePub.allowedActions, 'write_bytes'],
      errorNotes: { hidden_address: HIDDEN_NOTE },
    }),
    priv: testPrivate({
      initRegisters: { RSP: '0x500010', RBP: '0x500010', RIP: '0x400000' },
      vmas: [textVma, stackVma, keyVma],
      win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
      fail: [],
      flag: 'env:FLAG_FINGERPRINT',
    }),
  };
}

beforeAll(async () => {
  challengeRoot = makeRealChallengeRoot({
    [CHALLENGE_ID]: { pub: basePub, priv: testPrivate() },
    [FEED_LAB]: {
      pub: testPublic({ id: FEED_LAB, allowedActions: [...basePub.allowedActions, 'feed'] }),
      priv: testPrivate(),
    },
    [PROBE_LAB]: {
      pub: testPublic({
        id: PROBE_LAB,
        allowedActions: [...basePub.allowedActions, 'write_bytes'],
      }),
      priv: testPrivate(),
    },
    [FINGERPRINT_LAB]: fingerprintPackages(),
  });
  app = buildApp({
    challengeDir: challengeRoot,
    env: { ...TEST_ENV, FLAG_FINGERPRINT: 'flag{fingerprint-lab-sentinel}' },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(challengeRoot, { recursive: true, force: true });
});

describe('C03 · 资源限制（04 §6、shared/limits.ts）', () => {
  it('请求体超 MAX_BODY_BYTES 被拒，状态与 failures 都不变', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const before = await getProjection(app, sessionId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'step' }], junk: 'x'.repeat(MAX_BODY_BYTES + 1024) },
    });

    // Fastify 的 bodyLimit 在 CTP 层以 413 中断解析，`app.setErrorHandler` 按 shared 的映射
    // 把它归一成 `invalid_request`（04 §6）；HTTP 状态取自 `API_ERROR_STATUS['invalid_request']` = 400，
    // 客户端不会看到 Fastify 内部的 413 / FST_ERR_*。
    expectApiError(response, 'invalid_request');
    expectNoInternalLeak(response.body, ['FST_ERR', String(MAX_BODY_BYTES)]);

    // 请求没进引擎：投影（含 failures）与历史深度都不动。
    expectProjectionUnchanged(before, await getProjection(app, sessionId), 0);
    expect((await getState(app, sessionId)).history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('动作数超 MAX_ACTIONS_PER_REQUEST / MAX_SUBMIT_ACTIONS 被拒，边界内仍然接受', async () => {
    const actionsSession = await createSession(app, CHALLENGE_ID);
    const beforeActions = await getProjection(app, actionsSession);
    const tooManyActions = await app.inject({
      method: 'POST',
      url: `/api/sessions/${actionsSession}/actions`,
      payload: {
        actions: Array.from({ length: MAX_ACTIONS_PER_REQUEST + 1 }, () => ({ type: 'step' })),
      },
    });
    expectApiError(tooManyActions, 'invalid_request');
    expectProjectionUnchanged(beforeActions, await getProjection(app, actionsSession), 0);

    // 边界内必须仍然接受，否则上面的拒绝只是「批量一律被拒」的假阳性。
    const boundarySession = await createSession(app, CHALLENGE_ID);
    const boundary = await postActions(
      app,
      boundarySession,
      Array.from({ length: MAX_ACTIONS_PER_REQUEST }, () => ({ type: 'step' })),
    );
    // 第 3 个动作走到 `syscall exit` 命中 fail 谓词后引擎停止，后续动作不再执行。
    expect(boundary.parsed.executed).toBe(3);
    expect(boundary.parsed.results).toHaveLength(3);

    const submitSession = await createSession(app, CHALLENGE_ID);
    const beforeSubmit = await getProjection(app, submitSession);
    const tooManySubmit = await app.inject({
      method: 'POST',
      url: `/api/sessions/${submitSession}/submit`,
      payload: {
        actions: Array.from({ length: MAX_SUBMIT_ACTIONS + 1 }, () => ({ type: 'step' })),
      },
    });
    expectApiError(tooManySubmit, 'invalid_request');
    expectProjectionUnchanged(beforeSubmit, await getProjection(app, submitSession), 0);

    const boundarySubmit = await postSubmit(
      app,
      submitSession,
      Array.from({ length: MAX_SUBMIT_ACTIONS }, () => ({ type: 'step' })),
    );
    expect(boundarySubmit.parsed.verdict).toBe('failed');
    expect(boundarySubmit.parsed.executed).toBe(3);
  });

  it('step.count / run.maxSteps 超限被 Schema 拒，状态与 failures 都不变', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);
    const before = await getProjection(app, sessionId);
    const url = `/api/sessions/${sessionId}/actions`;

    for (const payload of [
      { actions: [{ type: 'step', count: MAX_STEP_COUNT + 1 }] },
      { actions: [{ type: 'step', count: 0 }] },
      { actions: [{ type: 'step', count: -1 }] },
      { actions: [{ type: 'run', maxSteps: MAX_RUN_MAX_STEPS + 1 }] },
      { actions: [{ type: 'run', maxSteps: 0 }] },
    ]) {
      expectApiError(await app.inject({ method: 'POST', url, payload }), 'invalid_request');
    }
    // 提交路径复用同一份动作 Schema，同样在进引擎之前被拒。
    expectApiError(
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: [{ type: 'step', count: MAX_STEP_COUNT + 1 }] },
      }),
      'invalid_request',
    );

    // Schema 层拒绝不进引擎：failures 也不能变（04 §4 的计数口径）。
    expectProjectionUnchanged(before, await getProjection(app, sessionId), 0);
  });

  it('feed 累计超 4KB 被拒，状态不变，回退仍可用', async () => {
    const sessionId = await createSession(app, FEED_LAB);
    const full = await postActions(app, sessionId, [
      { type: 'feed', hex: '41'.repeat(MAX_IO_BYTES) },
    ]);
    expect(full.parsed.results).toEqual([{ ok: true, action: 'feed' }]);
    expect(full.parsed.executed).toBe(1);
    expect(full.parsed.projection.stdin).toEqual({ hex: '41'.repeat(MAX_IO_BYTES), pos: 0 });
    expect(full.parsed.history).toEqual({ undo: 1, stepBack: 0 });

    const overflow = await postActions(app, sessionId, [{ type: 'feed', hex: '42' }]);
    expect(overflow.parsed.results).toEqual([
      {
        ok: false,
        action: 'feed',
        error: { code: 'stdin_overflow', message: describeError('stdin_overflow') },
      },
    ]);
    expect(overflow.parsed.executed).toBe(0);
    // 整段拒绝：一个字节都没追加，读位置也不动。
    expect(overflow.parsed.projection.stdin).toEqual({ hex: '41'.repeat(MAX_IO_BYTES), pos: 0 });
    expect(overflow.parsed.projection.failures).toBe(full.parsed.projection.failures + 1);
    expect(withoutFailures(overflow.parsed.projection)).toBe(
      withoutFailures(full.parsed.projection),
    );
    expectNoInternalLeak(overflow.body, ENGINE_DETAILS);

    // 被拒的动作不压快照，回退类动作按契约仍可用（S03）。
    const undone = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(undone.parsed.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.parsed.projection.stdin).toEqual({ hex: '', pos: 0 });
    expect(undone.parsed.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('被拒的 feed 不留下隐藏副作用：与从未发过它的会话行为逐字段等价', async () => {
    const dirty = await createSession(app, FEED_LAB);
    await postActions(app, dirty, [{ type: 'feed', hex: '41'.repeat(MAX_IO_BYTES) }]);
    const rejected = await postActions(app, dirty, [{ type: 'feed', hex: '42' }]);
    expect(rejected.parsed.executed).toBe(0);

    const clean = await createSession(app, FEED_LAB);
    await postActions(app, clean, [{ type: 'feed', hex: '41'.repeat(MAX_IO_BYTES) }]);

    // 唯一差别是 failures（被拒一次 +1）；其余状态逐字段一致，包括 stdin 与历史深度。
    const dirtyState = await getState(app, dirty);
    const cleanState = await getState(app, clean);
    expect(dirtyState.projection.failures).toBe(cleanState.projection.failures + 1);
    expect(withoutFailures(dirtyState.projection)).toBe(withoutFailures(cleanState.projection));
    expect(dirtyState.history).toEqual(cleanState.history);

    // 后续同一批动作在两个会话上得到同一结果（引擎状态指纹的等价性检验）。
    const followUp = [{ type: 'step' }];
    const dirtyNext = await postActions(app, dirty, followUp);
    const cleanNext = await postActions(app, clean, followUp);
    expect(dirtyNext.parsed.executed).toBe(cleanNext.parsed.executed);
    expect(withoutFailures(dirtyNext.parsed.projection)).toBe(
      withoutFailures(cleanNext.parsed.projection),
    );
    expect(dirtyNext.parsed.projection.failures).toBe(cleanNext.parsed.projection.failures + 1);
  });

  it('被拒的隐藏区写不留下痕迹：程序搬出来的隐藏字节与干净会话逐字节相同', async () => {
    // 先读题：隐藏 VMA（key）只给布局，内容不下发。
    const layoutOnly = await createSession(app, FINGERPRINT_LAB);
    const keyView = (await getProjection(app, layoutOnly)).vmas.find((vma) => vma.id === 'key');
    expect(keyView).toEqual({
      id: 'key',
      kind: 'key',
      start: FINGERPRINT_KEY,
      size: '0x1000',
      perm: 'r',
      hidden: true,
    });

    // 脏会话：先发一次会被拒的隐藏区写，再让程序把隐藏区搬进可见栈。
    const dirty = await createSession(app, FINGERPRINT_LAB);
    const rejected = await postActions(app, dirty, [
      { type: 'write_bytes', addr: FINGERPRINT_KEY, hex: '41' },
    ]);
    expect(rejected.parsed.results[0]?.error?.code).toBe('hidden_address');
    expect(rejected.parsed.executed).toBe(0);
    const dirtyRun = await postActions(app, dirty, [{ type: 'run' }]);
    expect(dirtyRun.parsed.projection.status).toBe('exited');

    // 干净会话：同一段程序，没发过那次被拒的写。
    const clean = await createSession(app, FINGERPRINT_LAB);
    const cleanRun = await postActions(app, clean, [{ type: 'run' }]);

    // 隐藏内存的指纹：搬进可见栈的就是隐藏区的 16 字节本身（先正面确认口径有效）。
    const expectedStack = FINGERPRINT_KEY_HEX + '00'.repeat(0x1000 - FINGERPRINT_LEN);
    const dirtyStack = dirtyRun.parsed.projection.vmas.find((vma) => vma.id === 'stack')?.hex;
    const cleanStack = cleanRun.parsed.projection.vmas.find((vma) => vma.id === 'stack')?.hex;
    expect(dirtyStack).toBe(expectedStack);
    expect(cleanStack).toBe(expectedStack);
    // 若那次被拒的写真的落了地，这里 16 字节就会变成 `41...`：所以这条不是平凡的。
    expect(dirtyStack).not.toContain('41414141');

    // 两次请求序列的唯一差别是 failures（被拒一次 +1），其余逐字段一致。
    expect(dirtyRun.parsed.projection.failures).toBe(1);
    expect(cleanRun.parsed.projection.failures).toBe(0);
    expect(withoutFailures(dirtyRun.parsed.projection)).toBe(
      withoutFailures(cleanRun.parsed.projection),
    );
  });
});

describe('C03 · 错误映射（04 §4、§6）', () => {
  it('unknown_action / invalid_arguments / action_not_allowed 原样进响应，文案不含内部信息', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);

    const unknown = await postActions(app, sessionId, [{ type: 'block', id: 'nope', args: {} }]);
    expect(unknown.parsed.results).toEqual([
      {
        ok: false,
        action: 'block',
        error: { code: 'unknown_action', message: describeError('unknown_action') },
      },
    ]);

    // 缺参数与参数类型不对走同一个码，但引擎的 detail 不同——两条都不能下发。
    const missing = await postActions(app, sessionId, [{ type: 'block', id: 'gets', args: {} }]);
    const badArg = await postActions(app, sessionId, [
      { type: 'block', id: 'gets', args: { data: 'zz' } },
    ]);
    for (const call of [missing, badArg]) {
      expect(call.parsed.results[0]?.error).toEqual({
        code: 'invalid_arguments',
        message: describeError('invalid_arguments'),
      });
      expect(call.parsed.executed).toBe(0);
    }

    const notAllowed = await postActions(app, sessionId, [{ type: 'push', value: '0x1' }]);
    expect(notAllowed.parsed.results[0]?.error).toEqual({
      code: 'action_not_allowed',
      message: describeError('action_not_allowed'),
    });

    for (const call of [unknown, missing, badArg, notAllowed]) {
      expect(call.parsed.executed).toBe(0);
      expectNoInternalLeak(call.body, ENGINE_DETAILS);
    }
  });

  it('hidden_address / inaccessible_address：错误码 + 地址文案 + 题目 note，且不含隐藏内容', async () => {
    const sessionId = await createSession(app, PROBE_LAB);
    const before = await getProjection(app, sessionId);

    // 隐藏 VMA（key，0x600000，perm=r）只能由程序自己读：直接动作被拒。
    const hidden = await postActions(app, sessionId, [
      { type: 'write_bytes', addr: '0x600000', hex: '41' },
    ]);
    expect(hidden.parsed.results).toEqual([
      {
        ok: false,
        action: 'write_bytes',
        error: {
          code: 'hidden_address',
          message: describeError('hidden_address', 0x600000n),
          note: HIDDEN_NOTE,
        },
      },
    ]);
    expectNoInternalLeak(hidden.body, [...ENGINE_DETAILS, HIDDEN_KEY_HEX]);

    // 未映射地址（0x900000 不在任何 VMA 内）走另一个码，没有题目 note。
    const unmapped = await postActions(app, sessionId, [
      { type: 'write_bytes', addr: '0x900000', hex: '41' },
    ]);
    expect(unmapped.parsed.results).toEqual([
      {
        ok: false,
        action: 'write_bytes',
        error: {
          code: 'inaccessible_address',
          message: describeError('inaccessible_address', 0x900000n),
        },
      },
    ]);
    expectNoInternalLeak(unmapped.body, ENGINE_DETAILS);

    // 两次拒绝都不改状态，只让 failures +2（04 §3）。
    expectProjectionUnchanged(before, await getProjection(app, sessionId), 2);
  });

  it('empty_history / not_executable / invalid_request 的路径各自回自己的码', async () => {
    const sessionId = await createSession(app, CHALLENGE_ID);

    const empty = await postActions(app, sessionId, [{ type: 'undo' }]);
    expect(empty.parsed.results[0]?.error).toEqual({
      code: 'empty_history',
      message: describeError('empty_history'),
    });

    await postActions(app, sessionId, [{ type: 'step', count: 3 }]);
    const terminal = await postActions(app, sessionId, [{ type: 'step' }]);
    expect(terminal.parsed.results[0]?.error).toEqual({
      code: 'not_executable',
      message: describeError('not_executable'),
    });

    // 未知动作类型属于请求 Schema 的职责：HTTP 层拒绝，不是引擎的错误码。
    const bogus = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'teleport' }] },
    });
    expectApiError(bogus, 'invalid_request');
    expectNoInternalLeak(bogus.body, ENGINE_DETAILS);
  });
});
