import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  MAX_ACTIONS_PER_REQUEST,
  MAX_BODY_BYTES,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  SessionStateResponseSchema,
  TEST_FLAG_SENTINEL,
  ret2winPublic,
} from '@pwn2block/shared';
import type {
  ActionsResponse,
  PrivateChallenge,
  PublicChallenge,
  SessionStateResponse,
} from '@pwn2block/shared';
import {
  expectApiError,
  expectNoInternalLeak,
  expectProjectionFieldsUnchanged,
  makeChallengeRoot,
  removeChallengeRoot,
  stateFieldsOf,
} from './support';
import type { TempChallengeRoot } from './support';

/**
 * S03 · 请求边界 — owner F（C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S03 · F，C 配合 请求边界：伪造快照/成功标记、未知动作、未允许的动作被拒绝；拒绝不修改状态，
 *     回退动作按契约仍可用。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 11 条：伪造判胜结果或提交快照的请求被拒绝。
 *   第 12 条：不在 `allowedActions` 里的动作被拒绝。
 *
 * 契约依据（04 §2、§3、§6；01 §6 第 3 条）：请求体一律 `strictObject`，多余字段被拒；被拒绝的动作不修改
 * 状态、不压快照；`failures` 单调递增，不随回退减少；回退类动作（`undo`/`step_back`/`reset`）始终可用；
 * `block` 同样始终可用（不受约束的是它的展开动作）。
 *
 * **真实对象**：真实 `@pwn2block/server` 的 `buildApp` + `inject`（真实 HTTP 路径、真实请求 Schema、
 * 真实 `@pwn2block/engine` 引擎），题目包用真实 Schema 构造后写进临时目录。
 * 这里没有任何 mock 的 runtime——mock 通过不算真实接口验收（08 §1）。
 * 本文件**没有** `describe.skip`、没有空体用例；从骨架切到真实用例的时间是 D2（F01-a）。
 *
 * `failures` 的口径（04 §3、§4）：拒绝一次 +1，回退不减少。请求体在 Schema 层被拒时**不进入引擎**，
 * 因此不计入 `failures`——04 未写明这条边界，已作为契约缺口报给 A/C（见 `s03` 用例内的注释）。
 */

/** 只有 `step` 被允许的题目：写原语与 `run` / `feed` 都该被 `action_not_allowed` 拒。 */
function reqLab(): { readonly pub: PublicChallenge; readonly priv: PrivateChallenge } {
  const pub = PublicChallengeSchema.parse({
    id: 'req-lab',
    title: '请求边界实验台',
    briefing: '只有 step 被允许。',
    archBits: 64,
    encoding: ret2winPublic.encoding,
    syscallAbi: ret2winPublic.syscallAbi,
    syscalls: ret2winPublic.syscalls,
    labels: [{ name: 'buf', addr: '0x500000', size: 16, kind: 'buffer' }],
    allowedActions: ['step'],
    authorBlocks: [
      {
        id: 'gets',
        label: 'gets(buf)',
        tooltip: '展开成一次 write_bytes',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: '0x500000', hex: '$data' }],
      },
    ],
    errorNotes: { action_not_allowed: '本题只允许单步执行' },
  });

  const priv = PrivateChallengeSchema.parse({
    registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    // RSP / RBP 落在**非隐藏**栈的中段：写原语若被允许是能成功的，所以拒绝只可能来自允许集。
    initRegisters: { RSP: '0x500010', RBP: '0x500010', RIP: '0x400000' },
    vmas: [
      {
        id: 'text',
        kind: 'code',
        start: '0x400000',
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        // leave; ret; syscall(exit); syscall(win) —— 单步能走，走三步会因为栈里是 0 而 invalid_ip。
        init: [{ at: '0x400000', hex: 'c9c30f0e' }],
      },
      {
        id: 'stack',
        kind: 'stack',
        start: '0x500000',
        size: '0x1000',
        perm: 'rw',
        hidden: false,
        init: [{ at: '0x500000', hex: 'bb'.repeat(8) }],
      },
    ],
    win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
    fail: [{ all: [{ exited: {} }, { not: { reg_eq: { reg: 'FLAG', value: '0x1' } } }] }],
    flag: 'env:FLAG_REQ_LAB',
  });

  return { pub, priv };
}

/** 一条 `syscall exit` 就正常退出的题目：没有 `fail` 谓词，所以退出的终态是 `exited` 而不是 `failed`。 */
function exitLab(): { readonly pub: PublicChallenge; readonly priv: PrivateChallenge } {
  const pub = PublicChallengeSchema.parse({
    id: 'exit-lab',
    title: '退出终态实验台',
    briefing: '第一条指令就退出。',
    archBits: 64,
    encoding: ret2winPublic.encoding,
    syscallAbi: ret2winPublic.syscallAbi,
    syscalls: ret2winPublic.syscalls,
    allowedActions: ['step'],
  });

  const priv = PrivateChallengeSchema.parse({
    registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    initRegisters: { RSP: '0x500010', RBP: '0x500010', RIP: '0x400000', RDI: '0x2a' },
    vmas: [
      {
        id: 'text',
        kind: 'code',
        start: '0x400000',
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        // 0x0e = ret2win 编码表里的 `syscall exit`。
        init: [{ at: '0x400000', hex: '0e' }],
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
    win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
    // 空数组：退出即 `exited`，不判负（判负优先只对声明了 fail 的题目成立）。
    fail: [],
    flag: 'env:FLAG_EXIT_LAB',
  });

  return { pub, priv };
}

const REQ_LAB = 'req-lab';
const EXIT_LAB = 'exit-lab';

type App = ReturnType<typeof buildApp>;

let app: App;
let root: TempChallengeRoot;

beforeAll(async () => {
  root = makeChallengeRoot({
    [REQ_LAB]: reqLab(),
    [EXIT_LAB]: exitLab(),
  });
  app = buildApp({
    challengeDir: root.challengeDir,
    presetDir: root.presetDir,
    env: { FLAG_REQ_LAB: TEST_FLAG_SENTINEL, FLAG_EXIT_LAB: TEST_FLAG_SENTINEL },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  removeChallengeRoot(root);
});

async function newSession(challengeId: string = REQ_LAB): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

async function getState(sessionId: string): Promise<SessionStateResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  expect(response.statusCode).toBe(200);
  return SessionStateResponseSchema.parse(response.json());
}

/** 发一批动作但不假定结果（用于期望被拒的请求）。 */
async function postActions(
  sessionId: string,
  actions: readonly unknown[],
  extra: Readonly<Record<string, unknown>> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/actions`,
    payload: { actions, ...extra },
  });
}

/** 发一批动作并断言 HTTP 200（动作级拒绝是正常应答，不是 HTTP 错误）。 */
async function actOk(
  sessionId: string,
  actions: readonly unknown[],
): Promise<{ readonly body: ActionsResponse }> {
  const response = await postActions(sessionId, actions);
  expect(response.statusCode).toBe(200);
  return { body: ActionsResponseSchema.parse(response.json()) };
}

describe('S03 请求边界 · 真实 REST 路径（G2 · D4）', () => {
  it('伪造判胜结果 / 成功标记的请求体被 strictObject 拒绝，且状态不变', async () => {
    const sessionId = await newSession();
    const before = await getState(sessionId);

    const forged = [
      { verdict: 'won' },
      { ok: true },
      { won: true },
      { succeeded: true },
      { passed: true },
      { win: true },
      { flag: TEST_FLAG_SENTINEL },
      { status: 'won' },
    ];
    for (const extra of forged) {
      const response = await postActions(sessionId, [{ type: 'step' }], extra);
      expectApiError(response, 'invalid_request', [TEST_FLAG_SENTINEL]);
    }

    const after = await getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(after.projection.steps).toBe(0);
    expect(after.projection.status).toBe('ready');
    expect(after.history).toEqual(before.history);
  });

  it('伪造快照 / 客户端状态的请求体被拒绝，服务端不接受任何客户端状态', async () => {
    const sessionId = await newSession();
    const before = await getState(sessionId);

    const forged = [
      { snapshot: { memory: 'whatever' } },
      { state: { registers: { RIP: '0x400000' } } },
      { clientState: { steps: 99 } },
      { projection: before.projection },
      { history: { undo: 9, stepBack: 9 } },
      { memory: 'deadbeef' },
    ];
    for (const extra of forged) {
      const response = await postActions(sessionId, [{ type: 'step' }], extra);
      expectApiError(response, 'invalid_request');
    }

    const after = await getState(sessionId);
    expect(after.projection.steps).toBe(0);
    expect(after.history).toEqual(before.history);
  });

  it('提交接口与创建会话同样拒绝伪造的判胜结果与快照', async () => {
    const sessionId = await newSession();

    for (const extra of [
      { verdict: 'won' },
      { flag: TEST_FLAG_SENTINEL },
      { snapshot: { memory: 'x' } },
      { state: { registers: {} } },
      { replay: { frames: [] } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: [{ type: 'step' }], ...extra },
      });
      expectApiError(response, 'invalid_request', [TEST_FLAG_SENTINEL]);
    }

    for (const extra of [{ state: {} }, { projection: {} }, { sessionId: 'self-chosen' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: REQ_LAB, ...extra },
      });
      expectApiError(response, 'invalid_request');
    }
  });

  it('未知动作名在请求 Schema 层被拒；未声明的积木 id 才回 unknown_action', async () => {
    const sessionId = await newSession();

    // 04 §2 的动作集是**封闭的 12 个名字**：请求 Schema 是 discriminatedUnion，
    // 未知名字根本进不了引擎，所以这里是 invalid_request，而不是引擎的 unknown_action。
    const unknownAction = await postActions(sessionId, [{ type: 'teleport' }]);
    expectApiError(unknownAction, 'invalid_request');

    // 合法动作名（`block`）+ 未声明的积木 id：这才是引擎给出的 unknown_action。
    const unknownBlock = await actOk(sessionId, [{ type: 'block', id: 'nope', args: {} }]);
    expect(unknownBlock.body.executed).toBe(0);
    expect(unknownBlock.body.results[0]?.ok).toBe(false);
    expect(unknownBlock.body.results[0]?.action).toBe('block');
    expect(unknownBlock.body.results[0]?.error?.code).toBe('unknown_action');

    const after = await getState(sessionId);
    expect(after.projection.steps).toBe(0);
    expect(after.projection.status).toBe('ready');
    // 只有**引擎真的拒掉的动作**计入 `failures`（04 §4）：未声明的积木 id 进过一次引擎，计 1。
    // 上面那次请求体在 Schema 层就被拒（HTTP 400），根本没到引擎，所以不计入——
    // 「04 是否该写明 Schema 层拒绝也计数」属于契约缺口，已在验收报告里报给 A/C。
    expect(after.projection.failures).toBe(1);
    expect(after.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('不在 allowedActions 里的动作被拒（action_not_allowed），状态不变且不压快照', async () => {
    const sessionId = await newSession();
    const before = await getState(sessionId);

    const rejected: readonly { readonly type: string }[] = [
      { type: 'write_bytes' },
      { type: 'pop' },
      { type: 'push' },
      { type: 'call' },
      { type: 'ret' },
      { type: 'run' },
      { type: 'feed' },
    ];
    const payloadOf: Readonly<Record<string, unknown>> = {
      write_bytes: { type: 'write_bytes', addr: '0x500000', hex: '41' },
      pop: { type: 'pop' },
      push: { type: 'push', value: '0x1' },
      call: { type: 'call', addr: '0x400000' },
      ret: { type: 'ret' },
      run: { type: 'run' },
      feed: { type: 'feed', hex: '41' },
    };

    for (const [index, action] of rejected.entries()) {
      const { body } = await actOk(sessionId, [payloadOf[action.type]]);
      expect(body.executed).toBe(0);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]?.action).toBe(action.type);
      expect(body.results[0]?.ok).toBe(false);
      expect(body.results[0]?.error?.code).toBe('action_not_allowed');
      expect(body.results[0]?.error?.note).toBe('本题只允许单步执行');
      // `failures` 按 04 §3 单调递增：被拒绝一次就 +1，回退也不许减少。
      expect(body.projection.failures).toBe(index + 1);
      expect(body.history).toEqual(before.history);
    }

    const after = await getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(after.projection.failures).toBe(rejected.length);
    expect(after.history).toEqual(before.history);
  });

  it('被拒绝的请求逐字段比对：投影每个字段（含每个 VMA 的 hex）单独断言不变（04 §2）', async () => {
    const sessionId = await newSession();
    const before = await getState(sessionId);

    // 一、**引擎级拒绝**（HTTP 200、动作 `ok: false`）：请求进了引擎，`failures` 按 04 §3 +1。
    const engineRejections: readonly { readonly why: string; readonly actions: readonly unknown[] }[] = [
      { why: '未允许的动作', actions: [{ type: 'write_bytes', addr: '0x500000', hex: '41' }] },
      { why: '未声明的积木 id', actions: [{ type: 'block', id: 'nope', args: {} }] },
      { why: '空历史的 step_back', actions: [{ type: 'step_back' }] },
      { why: '空历史的 undo', actions: [{ type: 'undo' }] },
    ];
    let expectedFailures = before.projection.failures;
    for (const item of engineRejections) {
      const { body } = await actOk(sessionId, item.actions);
      expect(body.results[0]?.ok, item.why).toBe(false);
      expectedFailures += 1;

      const after = await getState(sessionId);
      // 逐字段：status / steps / registers / roles / flags / vmas（含每个 VMA 的 hex）/
      // stdin / stdout / disasm / lastStop / error —— 一个都不许变。
      expectProjectionFieldsUnchanged(before.projection, after.projection);
      expect(after.projection.failures, item.why).toBe(expectedFailures);
      expect(after.history, item.why).toEqual(before.history);
      expect(body.projection.steps, item.why).toBe(0);
    }

    // 二、**Schema 层拒绝**（HTTP 400）：请求根本没进引擎，逐字段不变且 `failures` 也不动（09 §8 第 3 条）。
    for (const extra of [{ verdict: 'won' }, { snapshot: {} }, { state: {} }]) {
      const response = await postActions(sessionId, [{ type: 'step' }], extra);
      expectApiError(response, 'invalid_request');

      const after = await getState(sessionId);
      expectProjectionFieldsUnchanged(before.projection, after.projection);
      expect(after.projection.failures).toBe(expectedFailures);
      expect(after.history).toEqual(before.history);
    }
  });

  it('允许集内的动作照常生效；`block` 始终可用，不受 allowedActions 约束', async () => {
    const sessionId = await newSession();

    const step = await actOk(sessionId, [{ type: 'step' }]);
    expect(step.body.results[0]?.ok).toBe(true);
    expect(step.body.executed).toBe(1);
    expect(step.body.projection.steps).toBe(1);

    // `write_bytes` 不在 allowedActions 里，但 `block` 与回退类一样始终可用（04 §2、03 §3）：
    // 受约束的是积木的**展开动作**，而这条规定正是出题人「禁裸写、只留 gets」的手段。
    const block = await actOk(sessionId, [{ type: 'block', id: 'gets', args: { data: '4142' } }]);
    expect(block.body.results[0]?.ok).toBe(true);
    expect(block.body.executed).toBe(1);
    const stack = block.body.projection.vmas.find((vma) => vma.id === 'stack');
    expect(stack?.hex?.startsWith('4142')).toBe(true);
  });

  it('failures 单调递增：拒绝 +1，回退后不减少（04 §3）', async () => {
    const sessionId = await newSession();

    const first = await actOk(sessionId, [{ type: 'write_bytes', addr: '0x500000', hex: '41' }]);
    expect(first.body.results[0]?.error?.code).toBe('action_not_allowed');
    expect(first.body.projection.failures).toBe(1);

    const step = await actOk(sessionId, [{ type: 'step' }]);
    expect(step.body.results[0]?.ok).toBe(true);
    expect(step.body.projection.steps).toBe(1);
    expect(step.body.projection.failures).toBe(1);

    const undone = await actOk(sessionId, [{ type: 'undo' }]);
    expect(undone.body.results[0]?.ok).toBe(true);
    expect(undone.body.projection.steps).toBe(0);
    // 回退把状态退回去了，但「挣扎了多少」不减少。
    expect(undone.body.projection.failures).toBe(1);

    const second = await actOk(sessionId, [{ type: 'write_bytes', addr: '0x500000', hex: '41' }]);
    expect(second.body.projection.failures).toBe(2);
  });

  it('回退动作不受 allowedActions 约束：undo / step_back / reset 始终可用', async () => {
    // `req-lab` 的 `allowedActions` 只有 `step`，回退类动作一个都没声明。
    const sessionId = await newSession();

    const step = await actOk(sessionId, [{ type: 'step' }]);
    expect(step.body.projection.steps).toBe(1);
    expect(step.body.history.stepBack).toBe(1);

    const stepBack = await actOk(sessionId, [{ type: 'step_back' }]);
    expect(stepBack.body.results[0]?.ok).toBe(true);
    expect(stepBack.body.results[0]?.error).toBeUndefined();
    expect(stepBack.body.projection.steps).toBe(0);

    const undo = await actOk(sessionId, [{ type: 'undo' }]);
    expect(undo.body.results[0]?.ok).toBe(true);
    expect(undo.body.projection.steps).toBe(0);

    const reset = await actOk(sessionId, [{ type: 'reset' }]);
    expect(reset.body.results[0]?.ok).toBe(true);
    expect(reset.body.projection.steps).toBe(0);

    // `reset` 压栈，所以它自己可以被 undo（04 §3）。
    const undoReset = await actOk(sessionId, [{ type: 'undo' }]);
    expect(undoReset.body.results[0]?.ok).toBe(true);
  });

  it('历史为空时回退被拒绝并回 empty_history，而不是静默成功', async () => {
    const sessionId = await newSession();

    for (const action of [{ type: 'undo' }, { type: 'step_back' }]) {
      const { body } = await actOk(sessionId, [action]);
      expect(body.executed).toBe(0);
      expect(body.results[0]?.ok).toBe(false);
      expect(body.results[0]?.error?.code).toBe('empty_history');
    }

    const after = await getState(sessionId);
    expect(after.projection.failures).toBe(2);
    expect(after.projection.steps).toBe(0);
    expect(after.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('failed 状态下执行类动作被拒（not_executable），回退类仍可用', async () => {
    const sessionId = await newSession();

    // leave → ret（栈槽是 0，ip 跳到未映射的 0）→ invalid_ip：实例进入 failed。
    const failed = await actOk(sessionId, [{ type: 'step', count: 3 }]);
    expect(failed.body.projection.status).toBe('failed');
    expect(failed.body.projection.steps).toBe(2);
    expect(failed.body.projection.error?.code).toBe('invalid_ip');

    const blocked = await actOk(sessionId, [{ type: 'step' }]);
    expect(blocked.body.executed).toBe(0);
    expect(blocked.body.results[0]?.ok).toBe(false);
    expect(blocked.body.results[0]?.error?.code).toBe('not_executable');
    expect(blocked.body.projection.status).toBe('failed');

    const undone = await actOk(sessionId, [{ type: 'undo' }]);
    expect(undone.body.results[0]?.ok).toBe(true);
    expect(undone.body.projection.status).toBe('ready');
    expect(undone.body.projection.steps).toBe(0);
  });

  it('exited 状态下执行类动作被拒（not_executable），回退类仍可用', async () => {
    const sessionId = await newSession(EXIT_LAB);

    const exited = await actOk(sessionId, [{ type: 'step' }]);
    expect(exited.body.projection.status).toBe('exited');
    expect(exited.body.projection.steps).toBe(1);

    const blocked = await actOk(sessionId, [{ type: 'step' }]);
    expect(blocked.body.executed).toBe(0);
    expect(blocked.body.results[0]?.error?.code).toBe('not_executable');

    const undone = await actOk(sessionId, [{ type: 'undo' }]);
    expect(undone.body.results[0]?.ok).toBe(true);
    expect(undone.body.projection.status).toBe('ready');
    expect(undone.body.projection.steps).toBe(0);
  });

  it('动作数超过 MAX_ACTIONS_PER_REQUEST 被拒绝，边界内仍然接受（04 §6）', async () => {
    const tooMany = await newSession();
    const rejected = await postActions(
      tooMany,
      Array.from({ length: MAX_ACTIONS_PER_REQUEST + 1 }, () => ({ type: 'step' })),
    );
    expectApiError(rejected, 'invalid_request');

    // 边界内是合法的：否则上面的拒绝可能只是「所有大批量都被拒」的假阳性。
    const boundary = await newSession();
    const accepted = await actOk(
      boundary,
      Array.from({ length: MAX_ACTIONS_PER_REQUEST }, () => ({ type: 'step' })),
    );
    expect(accepted.body.results.length).toBeGreaterThan(0);
  });

  it('请求体超过体积上限被拒绝（04 §6）', async () => {
    const sessionId = await newSession();
    const response = await postActions(sessionId, [{ type: 'step' }], {
      junk: 'x'.repeat(MAX_BODY_BYTES + 1024),
    });
    expectApiError(response, 'invalid_request');

    // 对照：同一会话上的正常请求仍然通过（证明上面不是「这个会话坏了」）。
    const ok = await actOk(sessionId, [{ type: 'step' }]);
    expect(ok.body.results[0]?.ok).toBe(true);
    expect(ok.body.projection.steps).toBe(1);
  });

  it('拒绝响应的错误体不含内部堆栈、文件路径或私有包字段（04 §6）', async () => {
    const sessionId = await newSession();
    const responses = [
      await postActions(sessionId, [{ type: 'teleport' }]),
      await postActions(sessionId, [{ type: 'step' }], { verdict: 'won' }),
      await postActions(sessionId, [{ type: 'step' }], { state: {} }),
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: [{ type: 'step' }], snapshot: {} },
      }),
      await app.inject({
        method: 'POST',
        url: '/api/sessions/ffffffffffffffffffffffffffffffff/actions',
        payload: { actions: [{ type: 'step' }] },
      }),
    ];

    for (const response of responses) {
      expectNoInternalLeak(response.body, [TEST_FLAG_SENTINEL, root.root]);
    }
  });
});
