import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  INSTANCE_STATUSES,
  InstanceStatusSchema,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  ret2winSolutionActions,
} from '@pwn2block/shared';
import type {
  ActionsResponse,
  PrivateChallenge,
  Projection,
  PublicChallenge,
  SessionStateResponse,
  SubmitResponse,
} from '@pwn2block/shared';
import {
  collectKeys,
  expectNoInternalLeak,
  jsonOf,
  makeChallengeRoot,
  removeChallengeRoot,
  stateFieldsOf,
} from './support';
import type { TempChallengeRoot } from './support';

/**
 * S02 · 判题边界 — owner F（B/C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S02 · F，B/C 配合 判题边界：调试 satisfied 不发 flag、不记录通过；submit 从初态回放，不能借用手工调试状态，
 *     且不修改调试实例。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 8 条：调试实例的投影里永远没有 `flag` 字段，哪怕当前状态已满足成功条件。
 *   第 9 条：调试实例里满足成功条件只回“已满足”，不下发 flag、不记录通过。
 *   08 §5 另加的提交隔离：判题实例从初态回放，不能借用调试实例里的手工状态，且不修改调试实例。
 *
 * 契约依据（04 §1、§1.1、§5.1）：调试实例没有 `won`；提交是纯函数 `reset → 回放 → 判定`，`fail` 优先；
 * 判题实例没有回退，提交不限次数、不压调试实例快照。
 *
 * **状态（D3 / F01-b）：已转成真实用例。** 本文件没有 `describe.skip`、没有 `it.todo`、没有空体。
 * 真实对象是真实 `@pwn2block/server` 的 `buildApp` + `inject`（真实 HTTP 路径与请求 Schema）
 * 加真实 `@pwn2block/engine`（`replaySubmit` 纯回放 + 调试实例）。这里没有任何 mock 的 runtime ——
 * mock 通过不算真实接口验收（08 §1）。两段：
 *
 * 1. `verdict-lab` / `fail-first-lab` 临时题目包（真实 Schema 构造，写进临时目录）：
 *    §5 的 11 条条件逐条一个用例，断言用 `stateFieldsOf` / `collectKeys` / 原始响应正文做精确比较。
 * 2. 真实首题 `challenges/ret2win` + 真实 `presets/x86ish.json`（两条用例）：把 D1/D2 记的「验收对象是
 *    真实首题」这一条补上（E02 已交付），并用它钉住「判胜 payload 末尾接执行类动作仍判 won」这条
 *    引擎回归（`isExited()` 才是「已退出」的事实，`status` 在 win+exit 时是 `satisfied`）。
 *    A03 的 `tests/integration/ret2win-end-to-end.test.ts` 是日常集成，**不计入**本组验收（08 §1：前置证据不算验收）。
 *
 * 两个实验台只差 `fail` 谓词：`verdict-lab` 的 `win` 是 `FLAG == 0x1`、`fail` 为空；
 * `fail-first-lab` 的 `fail` 也是 `FLAG == 0x1`。于是同一个 payload 在两个台上分别判 `won` 与 `failed`，
 * 这就是「fail 优先于 win」的可复现证据（`fail-first` 用例里另有结构化自证）。
 *
 * 为什么不沿用「真实首题才叫验收」的 D2 阻塞结论：08 §5 与 README §2 把 S02 的对象定为
 * 「真实 `/submit` + 判题实例（B03 纯回放）」，临时题目包用的是同一套真实服务端与真实引擎，
 * 差别只在题目数据；真实首题两条用例（本文件最后一段）额外覆盖了题目数据这一维。
 * 全文件共 13 条真实用例（临时实验台 11 条 + 真实首题 2 条）。
 */

// ---------------------------------------------------------------------------
// 临时题目包：一条指令就把 FLAG 置 1（但**不退出**），让 satisfied 与 won 分离
// ---------------------------------------------------------------------------

const FLAG_LAB = 'verdict-lab';
const FAIL_LAB = 'fail-first-lab';

/** `buf` 所在地址（非隐藏、可写栈），手工调试与 `write_bytes` 都用它。 */
const BUF_ADDR = '0x500000';
/** 非隐藏栈 VMA 的初态：8 字节 `aa` + 其余全零（0x1000 字节）。 */
const INITIAL_STACK_HEX = 'aa'.repeat(8) + '00'.repeat(4096 - 8);

/**
 * 编码表：`0x0f` → `syscall 99`（本题自定义：置 FLAG=1，**没有 exit 效果**），
 * `0xc3` → `ret` 指令，`0x0e` → `syscall 60`（标准退出）。
 *
 * `0x0f` 不退出是关键：调试实例命中 `win` 后 `lastStop` 不出现，
 * 于是「satisfied 前后投影字段集合完全一致」才是一条可精确断言的条件。
 */
const LAB_ENCODING = [
  { opcode: '0x0f', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall mark' },
  { opcode: '0xc3', op: 'ret', operands: [] },
  { opcode: '0x0e', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
];

/** 判胜谓词就是一个寄存器比较：`syscall mark` 之后它成立。 */
const WIN_PREDICATE = { reg_eq: { reg: 'FLAG', value: '0x1' } } as const;

function labPublic(id: string): PublicChallenge {
  return PublicChallengeSchema.parse({
    id,
    title: '判题边界实验台',
    briefing: '一条指令就能满足成功条件，但它并不等于通过。',
    archBits: 64,
    encoding: LAB_ENCODING,
    syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
    syscalls: [
      {
        nr: 99,
        name: 'mark',
        kind: 'custom',
        doc: '置 FLAG=1，不退出',
        effects: [{ type: 'set_reg', reg: 'FLAG', value: '0x1' }],
      },
      { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
    ],
    labels: [{ name: 'buf', addr: BUF_ADDR, size: 16, kind: 'buffer' }],
    allowedActions: ['step', 'write_bytes', 'pop', 'undo', 'step_back', 'reset'],
    authorBlocks: [
      {
        id: 'poke',
        label: '写 buf(data)',
        tooltip: '固定写到 buf（0x500000）',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: BUF_ADDR, hex: '$data' }],
      },
    ],
    errorNotes: { unknown_action: '这题没有这块积木' },
  });
}

/**
 * 私有包。`fail` 是两个实验台**唯一**的差别：
 * - `verdict-lab`：`fail = []`，于是 `syscall mark` 之后判胜。
 * - `fail-first-lab`：`fail = [FLAG == 0x1]`，与 `win` 同时成立，必须判负（03 §2.1）。
 */
function labPrivate(id: string, fail: PrivateChallenge['fail']): PrivateChallenge {
  return PrivateChallengeSchema.parse({
    registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    initRegisters: { RSP: '0x500010', RBP: '0x500010', RIP: '0x400000' },
    vmas: [
      {
        id: 'text',
        kind: 'code',
        start: '0x400000',
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        // syscall mark（FLAG=1，不退出）; ret（栈槽全是 0 → ip 落到 0，下一步 invalid_ip）。
        init: [{ at: '0x400000', hex: '0fc3' }],
      },
      {
        id: 'stack',
        kind: 'stack',
        start: '0x500000',
        size: '0x1000',
        perm: 'rw',
        hidden: false,
        init: [{ at: BUF_ADDR, hex: 'aa'.repeat(8) }],
      },
    ],
    win: WIN_PREDICATE,
    fail: fail ?? [],
    flag: `env:FLAG_${id.toUpperCase().replace(/-/g, '_')}`,
  });
}

/** 题目包只需要构造一次：服务端加载与用例里的结构化自证共用同一份输入。 */
function labPackages(id: string): { readonly pub: PublicChallenge; readonly priv: PrivateChallenge } {
  const fail = id === FAIL_LAB ? [WIN_PREDICATE] : [];
  return { pub: labPublic(id), priv: labPrivate(id, fail) };
}

/** 「已通过」类字段名：投影 / 会话响应里出现任何一个都算调试实例被记了通过。 */
const FORBIDDEN_VERDICT_KEYS = [
  'flag',
  'won',
  'win',
  'passed',
  'satisfied',
  'cleared',
  'submits',
  'submitCount',
  'passedCount',
] as const;

// ---------------------------------------------------------------------------
// 真实对象：真实 Fastify 实例 + 真实引擎
// ---------------------------------------------------------------------------

type App = ReturnType<typeof buildApp>;

interface ActOutcome {
  /** 原始响应正文：解析会静默剥掉 Schema 未声明的字段，所以「没有 flag 字段」要在正文上断言。 */
  readonly raw: string;
  readonly body: ActionsResponse;
}

interface SubmitOutcome {
  readonly raw: string;
  readonly body: SubmitResponse;
}

/** 一个 app 对应一个客户端：两个 describe 各自持有自己的 app，不共享可变状态。 */
interface Api {
  newSession(challengeId?: string): Promise<string>;
  getState(sessionId: string): Promise<SessionStateResponse>;
  act(sessionId: string, actions: readonly unknown[]): Promise<ActOutcome>;
  submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitOutcome>;
}

function makeApi(instance: App): Api {
  return {
    async newSession(challengeId: string = FLAG_LAB): Promise<string> {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId },
      });
      expect(response.statusCode).toBe(200);
      return CreateSessionResponseSchema.parse(response.json()).sessionId;
    },

    async getState(sessionId: string): Promise<SessionStateResponse> {
      const response = await instance.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      expect(response.statusCode).toBe(200);
      return SessionStateResponseSchema.parse(response.json());
    },

    async act(sessionId: string, actions: readonly unknown[]): Promise<ActOutcome> {
      const response = await instance.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions },
      });
      expect(response.statusCode).toBe(200);
      return { raw: response.body, body: ActionsResponseSchema.parse(response.json()) };
    },

    async submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitOutcome> {
      const response = await instance.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions },
      });
      expect(response.statusCode).toBe(200);
      return { raw: response.body, body: SubmitResponseSchema.parse(response.json()) };
    },
  };
}

/** 某个寄存器的投影值；寄存器缺失是契约违规，不是可以静默跳过的分支。 */
function registerOf(projection: Projection, name: string): string {
  const found = projection.registers.find((item) => item.name === name);
  expect(found).toBeDefined();
  return found?.value ?? '';
}

/** 非隐藏栈 VMA 的完整内容（投影里非隐藏区带 `hex`，这就是真实内存）。 */
function stackHex(projection: Projection): string {
  const vma = projection.vmas.find((item) => item.id === 'stack');
  expect(vma).toBeDefined();
  return vma?.hex ?? '';
}

/** 一批动作后的调试状态（动作级拒绝是正常应答，HTTP 200）。 */
const WINNING_PAYLOAD = [{ type: 'step' }] as const;
const LOSING_PAYLOAD = [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }] as const;

let root: TempChallengeRoot;
let labApp: App;
let labApi: Api;

describe('S02 判题边界 · 临时题目包（真实引擎 + 真实 HTTP）', () => {
  beforeAll(async () => {
    root = makeChallengeRoot({
      [FLAG_LAB]: labPackages(FLAG_LAB),
      [FAIL_LAB]: labPackages(FAIL_LAB),
    });
    const app = buildApp({
      challengeDir: root.challengeDir,
      presetDir: root.presetDir,
      env: {
        FLAG_VERDICT_LAB: TEST_FLAG_SENTINEL,
        FLAG_FAIL_FIRST_LAB: TEST_FLAG_SENTINEL,
      },
    });
    await app.ready();
    labApi = makeApi(app);
    labApp = app;
  });

  afterAll(async () => {
    await labApp.close();
    removeChallengeRoot(root);
  });

  it('调试实例命中成功条件后 status 只变 satisfied，投影里没有 flag 字段（07 §5 第 8 条）', async () => {
    const sessionId = await labApi.newSession();
    const before = await labApi.getState(sessionId);
    expect(before.projection.status).toBe('ready');
    expect(registerOf(before.projection, 'FLAG')).toBe('0x0');

    const hit = await labApi.act(sessionId, WINNING_PAYLOAD);
    expect(hit.body.executed).toBe(1);
    expect(hit.body.results).toEqual([{ ok: true, action: 'step' }]);
    expect(hit.body.projection.status).toBe('satisfied');
    expect(hit.body.projection.steps).toBe(1);
    expect(registerOf(hit.body.projection, 'FLAG')).toBe('0x1');

    // 「没有 flag 字段」断言在**原始响应正文**上：`ActionsResponseSchema` 是宽松对象，
    // 解析会把服务端多塞的字段静默剥掉，只看解析结果就守不住这条。
    const rawActions = JSON.parse(hit.raw) as { readonly projection: Record<string, unknown> };
    expect(Object.keys(rawActions.projection)).not.toContain('flag');
    expect(hit.raw).not.toContain('"flag"');
    expect(hit.raw).not.toContain(TEST_FLAG_SENTINEL);
    expectNoInternalLeak(hit.raw, [TEST_FLAG_SENTINEL]);
    // 顶层响应字段固定：不发 flag，也不发任何「通过」标记。
    expect(Object.keys(hit.body).sort()).toEqual(['executed', 'history', 'projection', 'results']);

    // 刷新恢复（GET）同样只有状态，没有 flag。
    const state = await labApi.getState(sessionId);
    expect(state.projection.status).toBe('satisfied');
    expect(Object.keys(state)).toEqual(['sessionId', 'projection', 'history']);
    expect(jsonOf(state)).not.toContain(TEST_FLAG_SENTINEL);
    expect(jsonOf(state)).not.toContain('"flag"');
  });

  it('调试实例 satisfied 前后的投影字段集合完全一致，不新增任何“已通过”字段（第 9 条）', async () => {
    const sessionId = await labApi.newSession();
    const before = (await labApi.getState(sessionId)).projection;
    const after = (await labApi.act(sessionId, WINNING_PAYLOAD)).body.projection;
    expect(after.status).toBe('satisfied');

    const beforeKeys = [...collectKeys(before)].sort();
    const afterKeys = [...collectKeys(after)].sort();
    expect(afterKeys).toEqual(beforeKeys);
    for (const forbidden of FORBIDDEN_VERDICT_KEYS) expect(afterKeys).not.toContain(forbidden);

    // 值的比较：整份投影里只有这三个字段变了（状态、步数、寄存器）。
    // 没有新字段冒出来，也没有哪个字段从无到有（`lastStop` / `error` 都没出现）。
    const beforeRecord = before as unknown as Record<string, unknown>;
    const afterRecord = after as unknown as Record<string, unknown>;
    const changed = Object.keys(beforeRecord)
      .filter((key) => jsonOf(beforeRecord[key]) !== jsonOf(afterRecord[key]))
      .sort();
    expect(changed).toEqual(['registers', 'status', 'steps']);

    // 正面确认 satisfied 的原因是 FLAG=1，而不是服务端塞了一个“已通过”标记。
    expect(registerOf(before, 'FLAG')).toBe('0x0');
    expect(registerOf(after, 'FLAG')).toBe('0x1');
  });

  it('调试实例 satisfied 不记录通过：后续 GET 与再次提交都查不到通过标记（第 9 条）', async () => {
    const satisfiedSession = await labApi.newSession();
    const freshSession = await labApi.newSession();
    await labApi.act(satisfiedSession, WINNING_PAYLOAD);

    const state = await labApi.getState(satisfiedSession);
    const freshState = await labApi.getState(freshSession);
    expect(state.projection.status).toBe('satisfied');
    // 字段集合与**全新的**会话响应完全一致：没有提交次数、没有通过记录这类新字段。
    expect(Object.keys(state).sort()).toEqual(Object.keys(freshState).sort());
    const stateKeys = [...collectKeys(state)];
    expect(stateKeys.sort()).toEqual([...collectKeys(freshState)].sort());
    for (const forbidden of FORBIDDEN_VERDICT_KEYS) expect(stateKeys).not.toContain(forbidden);

    // 行为证据：调试实例已经 satisfied（FLAG=1），但提交一份赢不了的 payload 仍然判 incomplete ——
    // 判题实例没有借用调试实例的手工状态，调试实例也没有因此被记成通过。
    const incomplete = await labApi.submit(satisfiedSession, LOSING_PAYLOAD);
    expect(incomplete.body.verdict).toBe('incomplete');
    expect(incomplete.body.flag).toBeUndefined();
    expect(incomplete.raw).not.toContain(TEST_FLAG_SENTINEL);

    // 反向对照：真正能赢的 payload 才判 won 并下发 flag（证明上面的 incomplete 不是“提交坏了”）。
    const won = await labApi.submit(satisfiedSession, WINNING_PAYLOAD);
    expect(won.body.verdict).toBe('won');
    expect(won.body.flag).toBe(TEST_FLAG_SENTINEL);

    // 提交之后调试实例仍然只是 satisfied：GET 里没有 flag，也没有通过标记。
    const after = await labApi.getState(satisfiedSession);
    expect(after.projection.status).toBe('satisfied');
    expect(jsonOf(after)).not.toContain(TEST_FLAG_SENTINEL);
    for (const forbidden of FORBIDDEN_VERDICT_KEYS) expect([...collectKeys(after)]).not.toContain(forbidden);

    // 契约缺口（报 A/C）：服务端不暴露提交次数或通过记录（`SessionStore.recordSubmit` 只在内部计数），
    // 所以「不记录通过」的可观察面就是上面这些——字段集合不变 + 提交不借用调试状态。
    // 若 A 在 04 §1.1 要求更强的口径（例如响应里出现可断言的提交记录），需要 C 提供观察点。
  });

  it('调试实例不存在 won 状态：任何动作都不会让它进入 won（04 §1.1）', async () => {
    // 契约层：状态枚举里没有 won（它是提交结果，不是可停留的会话状态）。
    expect([...INSTANCE_STATUSES]).toEqual(['ready', 'satisfied', 'failed', 'exited']);
    expect(InstanceStatusSchema.safeParse('won').success).toBe(false);
    expect(InstanceStatusSchema.safeParse('ready').success).toBe(true);

    // 行为层：从初态走一遍 ready → satisfied → satisfied → failed → ready，全程没有 won。
    const sessionId = await labApi.newSession();
    const seen: string[] = [(await labApi.getState(sessionId)).projection.status];
    seen.push((await labApi.act(sessionId, WINNING_PAYLOAD)).body.projection.status);
    // 第二步执行 `ret` 指令：栈槽是 0，ip 落到 0（尚未取指失败），成功条件仍然成立。
    seen.push((await labApi.act(sessionId, WINNING_PAYLOAD)).body.projection.status);
    // 第三步在 ip=0 取指失败 → 运行期异常 → failed。
    seen.push((await labApi.act(sessionId, WINNING_PAYLOAD)).body.projection.status);
    seen.push((await labApi.act(sessionId, [{ type: 'reset' }])).body.projection.status);

    expect(seen).toEqual(['ready', 'satisfied', 'satisfied', 'failed', 'ready']);
    for (const status of seen) expect([...INSTANCE_STATUSES]).toContain(status);
    expect(seen).not.toContain('won');
  });

  it('手工调试（写字节 / 单步 / 回退）后再提交同一 payload，判题结果与全新会话逐字段一致', async () => {
    const manual = await labApi.newSession();
    await labApi.act(manual, [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }]);
    await labApi.act(manual, WINNING_PAYLOAD);
    // 回退掉刚才那次单步，再重新单步一次：调试实例留下一段手工痕迹 + 一层历史。
    const undone = await labApi.act(manual, [{ type: 'undo' }]);
    expect(undone.body.projection.status).toBe('ready');
    const again = await labApi.act(manual, WINNING_PAYLOAD);
    expect(again.body.projection.status).toBe('satisfied');

    const manualState = await labApi.getState(manual);
    expect(manualState.projection.steps).toBe(1);
    expect(registerOf(manualState.projection, 'FLAG')).toBe('0x1');
    expect(stackHex(manualState.projection).startsWith('4142')).toBe(true);

    const fromManual = await labApi.submit(manual, WINNING_PAYLOAD);
    const fromFresh = await labApi.submit(await labApi.newSession(), WINNING_PAYLOAD);

    expect(fromManual.body.verdict).toBe('won');
    expect(fromManual.body.flag).toBe(TEST_FLAG_SENTINEL);
    expect(fromManual.body.executed).toBe(1);
    // 逐字段一致（整份响应 JSON 相等）：手工写入的字节、历史、failures 一点都没进判题路径。
    expect(jsonOf(fromManual.body)).toBe(jsonOf(fromFresh.body));
  });

  it('submit 的判题实例从题目初态重置回放：录像首帧等于题目初态而不是调试态（B03 纯回放）', async () => {
    const debugSession = await labApi.newSession();
    const reference = await labApi.getState(await labApi.newSession());

    await labApi.act(debugSession, [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }]);
    await labApi.act(debugSession, WINNING_PAYLOAD);
    const debugState = await labApi.getState(debugSession);
    expect(debugState.projection.status).toBe('satisfied');
    expect(registerOf(debugState.projection, 'FLAG')).toBe('0x1');
    expect(stackHex(debugState.projection).startsWith('4142')).toBe(true);

    const submitted = await labApi.submit(debugSession, WINNING_PAYLOAD);
    expect(submitted.body.verdict).toBe('won');

    const initial = submitted.body.replay.initial;
    // 与一份全新会话的初态投影逐字段相等（含录像首帧的 `roles` / `disasm` / 全部 VMA 内容）。
    expect(stateFieldsOf(initial)).toBe(stateFieldsOf(reference.projection));
    expect(initial.status).toBe('ready');
    expect(initial.steps).toBe(0);
    expect(initial.failures).toBe(0);
    expect(registerOf(initial, 'FLAG')).toBe('0x0');
    expect(stackHex(initial)).toBe(INITIAL_STACK_HEX);

    // 反面对照：调试态确实不是初态，否则上面的相等可能只是「两边都是调试态」。
    expect(stackHex(initial)).not.toBe(stackHex(debugState.projection));
    expect(stateFieldsOf(initial)).not.toBe(stateFieldsOf(debugState.projection));
    // 回放里真的执行了 payload（最后一个 action 帧 FLAG=1），不是空跑。
    const lastFrame = submitted.body.replay.frames.at(-1);
    expect(lastFrame?.kind).toBe('action');
    expect(lastFrame?.label).toBe('step');
    expect(lastFrame?.registers.find((item) => item.name === 'FLAG')?.value).toBe('0x1');
  });

  it('submit 前后调试实例投影逐字段相等（含 failures），history 深度不变', async () => {
    const sessionId = await labApi.newSession();
    // 先制造一次被拒的动作，让 `failures` 非零：这样「提交不动调试实例」才不是靠 0 == 0 成立。
    const rejectedAction = await labApi.act(sessionId, [{ type: 'block', id: 'nope', args: {} }]);
    expect(rejectedAction.body.results[0]?.error?.code).toBe('unknown_action');
    await labApi.act(sessionId, [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }]);
    await labApi.act(sessionId, WINNING_PAYLOAD);

    const before = await labApi.getState(sessionId);
    expect(before.projection.status).toBe('satisfied');
    expect(before.projection.failures).toBe(1);
    expect(before.history).toEqual({ undo: 2, stepBack: 1 });

    const won = await labApi.submit(sessionId, WINNING_PAYLOAD);
    expect(won.body.verdict).toBe('won');

    const afterWon = await labApi.getState(sessionId);
    expect(stateFieldsOf(afterWon.projection)).toBe(stateFieldsOf(before.projection));
    // `failures` 含在「逐字段相等」里（它属于调试实例，不因提交变化）。
    expect(afterWon.projection.failures).toBe(before.projection.failures);
    expect(afterWon.history).toEqual(before.history);

    // 判题侧被拒（rejected）同样不动调试实例：`failures` 不 +1。
    const rejectedSubmit = await labApi.submit(sessionId, [{ type: 'block', id: 'nope', args: {} }]);
    expect(rejectedSubmit.body.verdict).toBe('rejected');
    expect(rejectedSubmit.body.executed).toBe(0);
    expect(rejectedSubmit.body.replay.frames.at(-1)?.error?.code).toBe('unknown_action');

    const afterRejected = await labApi.getState(sessionId);
    expect(stateFieldsOf(afterRejected.projection)).toBe(stateFieldsOf(before.projection));
    expect(afterRejected.projection.failures).toBe(1);
    expect(afterRejected.history).toEqual(before.history);
  });

  it('submit 后调试实例 history 深度不变，undo 仍回退到提交前的手工请求', async () => {
    const sessionId = await labApi.newSession();
    await labApi.act(sessionId, [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }]);
    await labApi.act(sessionId, WINNING_PAYLOAD);

    const before = await labApi.getState(sessionId);
    expect(before.history).toEqual({ undo: 2, stepBack: 1 });

    expect((await labApi.submit(sessionId, WINNING_PAYLOAD)).body.verdict).toBe('won');
    expect((await labApi.getState(sessionId)).history).toEqual(before.history);

    // 第一次 undo：退掉「单步」那次请求，但保留「写字节」那次请求的内存。
    const undoStep = await labApi.act(sessionId, [{ type: 'undo' }]);
    expect(undoStep.body.results[0]?.ok).toBe(true);
    expect(undoStep.body.projection.status).toBe('ready');
    expect(undoStep.body.projection.steps).toBe(0);
    expect(registerOf(undoStep.body.projection, 'FLAG')).toBe('0x0');
    expect(stackHex(undoStep.body.projection).startsWith('4142')).toBe(true);
    expect(undoStep.body.history).toEqual({ undo: 1, stepBack: 0 });

    // 第二次 undo：退掉「写字节」，回到题目初态。
    const undoWrite = await labApi.act(sessionId, [{ type: 'undo' }]);
    expect(undoWrite.body.results[0]?.ok).toBe(true);
    expect(stackHex(undoWrite.body.projection)).toBe(INITIAL_STACK_HEX);
    expect(undoWrite.body.history).toEqual({ undo: 0, stepBack: 0 });

    // 历史清空后回退被拒：提交没有在调试实例上留下任何可回退位置。
    const emptyUndo = await labApi.act(sessionId, [{ type: 'undo' }]);
    expect(emptyUndo.body.executed).toBe(0);
    expect(emptyUndo.body.results[0]?.ok).toBe(false);
    expect(emptyUndo.body.results[0]?.error?.code).toBe('empty_history');
  });

  it('verdict 四态完整：仅 won 带 flag，failed / rejected / incomplete 都不带（04 §5.1）', async () => {
    const won = await labApi.submit(await labApi.newSession(), WINNING_PAYLOAD);
    const incomplete = await labApi.submit(await labApi.newSession(), LOSING_PAYLOAD);
    const rejected = await labApi.submit(await labApi.newSession(), [{ type: 'block', id: 'nope', args: {} }]);
    const failed = await labApi.submit(await labApi.newSession(FAIL_LAB), WINNING_PAYLOAD);

    expect(won.body.verdict).toBe('won');
    expect(incomplete.body.verdict).toBe('incomplete');
    expect(rejected.body.verdict).toBe('rejected');
    expect(failed.body.verdict).toBe('failed');
    expect(
      new Set([won.body.verdict, incomplete.body.verdict, rejected.body.verdict, failed.body.verdict]).size,
    ).toBe(4);

    expect(won.body.flag).toBe(TEST_FLAG_SENTINEL);
    for (const outcome of [incomplete, rejected, failed]) {
      expect(outcome.body.flag).toBeUndefined();
      expect(Object.keys(outcome.body)).not.toContain('flag');
      expect(outcome.raw).not.toContain('"flag"');
      expect(outcome.raw).not.toContain(TEST_FLAG_SENTINEL);
      expectNoInternalLeak(outcome.raw, [TEST_FLAG_SENTINEL]);
    }

    // 四种 verdict 的录像首帧都还在题目初态：判题实例不借用调试实例。
    for (const outcome of [won, incomplete, rejected, failed]) {
      expect(outcome.body.replay.initial.status).toBe('ready');
      expect(outcome.body.replay.initial.steps).toBe(0);
      expect(outcome.body.replay.initial.failures).toBe(0);
    }

    // 四种结果的成因各自可辨：
    expect(incomplete.body.executed).toBe(1);
    expect(incomplete.body.results[0]).toEqual({ ok: true, action: 'write_bytes' });
    expect(rejected.body.executed).toBe(0);
    expect(rejected.body.results[0]?.ok).toBe(false);
    expect(rejected.body.results[0]?.error?.code).toBe('unknown_action');
    expect(failed.body.executed).toBe(1);
    expect(failed.body.results[0]).toEqual({ ok: true, action: 'step' });
  });

  it('命中 fail 时即使 win 也成立，仍判 failed（fail 优先，03 §2.1 / 04 §5.1）', async () => {
    // 结构化自证：两个实验台只差 `fail` 谓词（外加随题目 id 派生的 flag 环境变量名），
    // 寄存器、初态、VMA、win 谓词逐字相同。
    const flagLab = labPackages(FLAG_LAB).priv;
    const failLab = labPackages(FAIL_LAB).priv;
    expect(flagLab.fail).toEqual([]);
    expect(failLab.fail).toEqual([WIN_PREDICATE]);
    expect(jsonOf({ ...failLab, fail: flagLab.fail, flag: flagLab.flag })).toBe(jsonOf(flagLab));

    const won = await labApi.submit(await labApi.newSession(FLAG_LAB), WINNING_PAYLOAD);
    const failed = await labApi.submit(await labApi.newSession(FAIL_LAB), WINNING_PAYLOAD);

    // 同一份 payload、同一份初态：win 条件在两边都成立，只有判负谓词不同。
    expect(won.body.verdict).toBe('won');
    expect(failed.body.verdict).toBe('failed');
    expect(failed.body.flag).toBeUndefined();
    expect(failed.raw).not.toContain(TEST_FLAG_SENTINEL);

    // 判负那一刻 FLAG 确实是 1（win 条件就是 FLAG == 0x1）：不是“没赢所以判负”，而是 fail 压过 win。
    const lastFrame = failed.body.replay.frames.at(-1);
    expect(lastFrame?.status).toBe('failed');
    expect(lastFrame?.registers.find((item) => item.name === 'FLAG')?.value).toBe('0x1');
    // 判负不是运行期异常：动作本身执行成功（executed=1、ok=true），没有 error。
    expect(failed.body.executed).toBe(1);
    expect(failed.body.results[0]).toEqual({ ok: true, action: 'step' });
    expect(lastFrame?.error).toBeUndefined();
  });

  it('提交次数不限：连续多次 submit 的结果互相独立，不因上一次判胜而改变', async () => {
    const sessionId = await labApi.newSession();
    const before = await labApi.getState(sessionId);

    const first = await labApi.submit(sessionId, WINNING_PAYLOAD);
    const second = await labApi.submit(sessionId, WINNING_PAYLOAD);
    expect(second.body.verdict).toBe('won');
    expect(jsonOf(second.body)).toBe(jsonOf(first.body));

    const incomplete = await labApi.submit(sessionId, LOSING_PAYLOAD);
    expect(incomplete.body.verdict).toBe('incomplete');
    expect(incomplete.body.flag).toBeUndefined();

    const third = await labApi.submit(sessionId, WINNING_PAYLOAD);
    expect(jsonOf(third.body)).toBe(jsonOf(first.body));

    // 调试实例从头到尾没有被提交影响（也不因判胜被记成通过）。
    const after = await labApi.getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(after.projection.failures).toBe(0);
    expect(after.history).toEqual(before.history);
    expect(after.projection.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// 真实首题：`challenges/ret2win` + 真实 `presets/x86ish.json`
// ---------------------------------------------------------------------------

/** 仓库根下的真实题目目录与预设目录（只读，不写）。 */
const REAL_CHALLENGE_DIR = fileURLToPath(new URL('../../challenges', import.meta.url));
const REAL_PRESET_DIR = fileURLToPath(new URL('../../presets', import.meta.url));

let realApp: App;

describe('S02 判题边界 · 真实首题 challenges/ret2win（真实 preset + 真实引擎 + 真实 HTTP）', () => {
  beforeAll(async () => {
    realApp = buildApp({
      challengeDir: REAL_CHALLENGE_DIR,
      presetDir: REAL_PRESET_DIR,
      // flag 真值只由环境变量注入，测试用哨兵值（08 §5 S05）。
      env: { FLAG_RET2WIN: TEST_FLAG_SENTINEL },
    });
    await realApp.ready();
  });

  afterAll(async () => {
    await realApp.close();
  });

  it('调试到 satisfied 不发 flag；submit 从初态回放判胜下发 flag，且调试实例逐字段不变', async () => {
    const api = makeApi(realApp);
    const sessionId = await api.newSession('ret2win');

    // 参考解法：`gets(buf)` 覆盖到 ret addr，再单步三次走到 win。
    const debug = await api.act(sessionId, ret2winSolutionActions);
    expect(debug.body.executed).toBe(2);
    expect(debug.body.results.map((item) => item.ok)).toEqual([true, true]);
    expect(debug.body.projection.status).toBe('satisfied');
    expect(debug.body.projection.steps).toBe(3);
    expect(debug.raw).not.toContain(TEST_FLAG_SENTINEL);
    expect(debug.raw).not.toContain('"flag"');

    const debugState = await api.getState(sessionId);
    expect(debugState.projection.status).toBe('satisfied');

    // 一份全新会话的初态投影：用来证明录像首帧是题目初态。
    const initialReference = await api.getState(await api.newSession('ret2win'));

    const submitted = await api.submit(sessionId, ret2winSolutionActions);
    expect(submitted.body.verdict).toBe('won');
    expect(submitted.body.flag).toBe(TEST_FLAG_SENTINEL);
    expect(stateFieldsOf(submitted.body.replay.initial)).toBe(stateFieldsOf(initialReference.projection));
    expect(submitted.body.replay.initial.status).toBe('ready');
    expect(submitted.body.replay.initial.steps).toBe(0);
    // 调试态确实不是初态（否则上面的相等可能只是「两边都是调试态」）。
    expect(stateFieldsOf(submitted.body.replay.initial)).not.toBe(stateFieldsOf(debugState.projection));

    // 提交不改动调试实例：投影（含 failures）与两层历史深度都不变。
    const after = await api.getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(debugState.projection));
    expect(after.projection.failures).toBe(debugState.projection.failures);
    expect(after.history).toEqual(debugState.history);
    expect(after.projection.status).toBe('satisfied');
  });

  it('判胜 payload 末尾接执行类动作仍判 won：程序退出后判题实例不再执行动作（引擎 isExited 口径的回归）', async () => {
    const api = makeApi(realApp);

    // 参考解法的写入字节里最后 8 字节是返回地址；换成 0x400003（syscall exit）就走向判负路径。
    const loseData = '41'.repeat(16) + '42'.repeat(8) + '0300400000000000';

    // 同一份判胜 payload，只在末尾追加执行类动作：三者必须都判 won 并下发 flag。
    const withTrailing = [
      [...ret2winSolutionActions],
      [...ret2winSolutionActions, { type: 'step', count: 1 }],
      [...ret2winSolutionActions, { type: 'step', count: 1 }, { type: 'step', count: 1 }],
    ];
    for (const payload of withTrailing) {
      const outcome = await api.submit(await api.newSession('ret2win'), payload);
      expect(outcome.body.verdict).toBe('won');
      expect(outcome.body.flag).toBe(TEST_FLAG_SENTINEL);
      expect(outcome.body.replay.initial.status).toBe('ready');
    }

    // 尾随动作根本没有执行：`ret` + `syscall 99`（win，不退出）+ `syscall 60`（exit）之后程序已经结束
    // ——`status` 显示 `satisfied`（成功条件成立），但「已退出」这个事实由 `lastStop.reason='exit'` /
    // `isExited()` 表达。判题实例不能交互，所以后续 action 一律不执行（04 §5.1）。
    const longest = await api.submit(await api.newSession('ret2win'), [
      ...ret2winSolutionActions,
      { type: 'step', count: 1 },
      { type: 'step', count: 1 },
    ]);
    expect(longest.body.executed).toBe(2);
    expect(longest.body.results).toHaveLength(2);
    expect(longest.body.results.map((item) => item.ok)).toEqual([true, true]);
    const lastFrame = longest.body.replay.frames.at(-1);
    expect(lastFrame?.kind).toBe('action');
    expect(lastFrame?.label).toBe('step');
    expect(lastFrame?.status).toBe('satisfied');
    expect(lastFrame?.registers.find((item) => item.name === 'FLAG')?.value).toBe('0x1');

    // 对照：返回地址指向退出路径（lose）的 payload 判 failed，且**不下发** flag。
    const lose = await api.submit(await api.newSession('ret2win'), [
      { type: 'block', id: 'gets', args: { data: loseData } },
      { type: 'step', count: 3 },
    ]);
    expect(lose.body.verdict).toBe('failed');
    expect(lose.body.flag).toBeUndefined();
    expect(Object.keys(lose.body)).not.toContain('flag');
    expect(lose.raw).not.toContain(TEST_FLAG_SENTINEL);
    expect(lose.body.replay.initial.status).toBe('ready');
    // `won` 之外不出现 flag：这里与上面「verdict 四态完整」那条互为补充（那条覆盖另外两态）。
  });
});
