import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  BlockActionSchema,
  CreateSessionResponseSchema,
  MAX_SUBMIT_ACTIONS,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  describeError,
  expandBlock,
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
  expectApiError,
  expectNoInternalLeak,
  makeChallengeRoot,
  removeChallengeRoot,
  stateFieldsOf,
} from './support';
import type { ResponseLike, TempChallengeRoot } from './support';

/**
 * S04 · payload 边界 — owner F（C/H 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S04 · F，C/H 配合 payload 边界：block 由服务端展开，不相信客户端提供的展开结果；读状态 payload 被
 *     rejected，而不是变成零。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 10 条：客户端提交的 `block` 展开结果被忽略，服务端自己展开。
 *   第 13 条：payload 里出现读状态积木时，提交被 `rejected`，不是静默当成零。
 *
 * 契约依据（03 §3、04 §2/§5.1、05 §4；01 §6 第 3、4 条）：`block` 只发 `{id, args}`，
 * 唯一展开入口是服务端 `expandBlock`；payload 必须自足，不允许含读取当前状态的构造；
 * 客户端编译上限（循环展开 256、表达式求值 4096 步）在服务端复核。
 *
 * **状态（D3 / F01-b）：部分通过。** 本文件没有 `describe.skip`、没有空体用例。
 * 真实对象是真实 `@pwn2block/server` 的 `buildApp` + `inject`（真实 HTTP 路径、真实请求 Schema）
 * 加真实 `@pwn2block/engine`（`expandBlock` 的调用方就是引擎的动作分发），题目包用真实 Schema
 * 构造后写进临时目录；没有任何 mock 的 runtime（mock 通过不算真实接口验收，08 §1）。
 *
 * - 已按原文真实执行：第 10 条（`block` 只接受 `{id, args}`、多字段被 `strictObject` 拒；
 *   客户端提供的展开结果被忽略；未声明的积木 id 回 `unknown_action`；缺参 / 多参 / 类型不符回
 *   `invalid_arguments`；真实内存观测证明执行的是题目包模板的地址与字节），
 *   以及 `submit` 的动作 Schema 同样是 `strictObject`、动作数超 `MAX_SUBMIT_ACTIONS` 被拒。
 * - **仍为 todo（4 条，见文件末尾）**：第 13 条的 `reads_state`（服务端不存在该拒绝路径，
 *   线上动作集也无法表达「读当前状态」）与「编译上限在服务端复核」。理由与 owner 写在各条注释里，
 *   已随验收报告交给 A（契约缺口，不是实现缺陷，也不改产品代码凑绿）。
 *
 * 附加一节「线上格式无法表达读状态，也不会静默当零」：用真实对象验证**可以验证的那一半**，
 * 并在用例里写明它**不替代** `reads_state` 那三条。
 */

// ---------------------------------------------------------------------------
// 题目包：唯一能写内存的途径是出题人积木，地址写死在题目包模板里
// ---------------------------------------------------------------------------

const LAB_ID = 'payload-lab';
/** `buf`：题目包模板里 `gets` 的固定目标地址（非隐藏、可写栈）。 */
const BUF_ADDR = '0x500000';
/** 客户端在伪造请求里“声称”的目标地址：与题目包模板不同，用来观察谁说了算。 */
const CLAIMED_ADDR = '0x500010';
/** 非隐藏栈 VMA 初态：全零（0x1000 字节），任何写入都会在投影的 `hex` 里显形。 */
const ZERO_STACK_HEX = '00'.repeat(4096);

/** 栈 VMA 在写入了 `hex`（偏移 `offset` 字节）之后的完整内容。 */
function stackWith(offset: number, hex: string): string {
  return '00'.repeat(offset) + hex + '00'.repeat(4096 - offset - hex.length / 2);
}

/** 唯一能赢的方式：`0x500000` 处的两个字节是 `4142`（小端序无关，就是两个字面字节）。 */
const WIN_PREDICATE = { mem_eq: { addr: BUF_ADDR, hex: '4142' } } as const;

/**
 * 编码表：只有一条 `syscall 60`（标准退出）。与本题无关的指令一个都不放，
 * 这样「内存里的字节怎么变的」只能来自积木展开，观察口径干净。
 */
const LAB_ENCODING = [{ opcode: '0x0e', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' }];

function labPackages(): { readonly pub: PublicChallenge; readonly priv: PrivateChallenge } {
  const pub = PublicChallengeSchema.parse({
    id: LAB_ID,
    title: 'payload 边界实验台',
    briefing: '写内存只能靠出题人积木，地址由题目包决定。',
    archBits: 64,
    encoding: LAB_ENCODING,
    syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
    syscalls: [{ nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' }],
    labels: [{ name: 'buf', addr: BUF_ADDR, size: 16, kind: 'buffer' }],
    // 故意**不**允许 `write_bytes`：裸写原语被禁，写内存只能走积木（03 §3 的典型用法）。
    allowedActions: ['step', 'pop', 'reset', 'undo'],
    authorBlocks: [
      {
        id: 'gets',
        label: 'gets(buf, data)',
        tooltip: '写到 buf（0x500000）',
        params: [{ name: 'data', type: 'bytes' }],
        // 地址是**题目包模板里的常量**：客户端无法通过任何字段改它。
        expand: [{ type: 'write_bytes', addr: BUF_ADDR, hex: '$data' }],
      },
      {
        id: 'gets_elsewhere',
        label: '写到 0x500010',
        tooltip: '同一个参数，写到另一个固定地址',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: CLAIMED_ADDR, hex: '$data' }],
      },
      {
        id: 'steps',
        label: '单步 N 次',
        tooltip: '唯一带 int 参数的积木，用来验证参数类型校验',
        params: [{ name: 'n', type: 'int' }],
        expand: [{ type: 'step', count: '$n' }],
      },
    ],
    errorNotes: {
      unknown_action: '本题没有这块积木',
      invalid_arguments: '积木参数不合法',
    },
  });

  const priv = PrivateChallengeSchema.parse({
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
    win: WIN_PREDICATE,
    fail: [],
    flag: 'env:FLAG_PAYLOAD_LAB',
  });

  return { pub, priv };
}

const LAB = labPackages();

// ---------------------------------------------------------------------------
// 真实对象：真实 Fastify 实例 + 真实引擎
// ---------------------------------------------------------------------------

type App = ReturnType<typeof buildApp>;

interface ActOutcome {
  readonly raw: string;
  readonly body: ActionsResponse;
}

interface Api {
  newSession(): Promise<string>;
  getState(sessionId: string): Promise<SessionStateResponse>;
  act(sessionId: string, actions: readonly unknown[]): Promise<ActOutcome>;
  postActions(sessionId: string, actions: readonly unknown[]): Promise<ResponseLike>;
  postSubmit(sessionId: string, body: Record<string, unknown>): Promise<ResponseLike>;
  submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitResponse>;
}

/** 非隐藏栈 VMA 的完整内容（投影里非隐藏区带 `hex`，这就是真实内存）。 */
function stackHex(projection: Projection): string {
  const vma = projection.vmas.find((item) => item.id === 'stack');
  expect(vma).toBeDefined();
  return vma?.hex ?? '';
}

/** 某个积木展开后的动作序列（`shared` 的展开入口：题目包是数据，不是 mock）。 */
function expansionOf(id: string, args: Readonly<Record<string, string | number>>) {
  return expandBlock(LAB.pub, { type: 'block', id, args });
}

let root: TempChallengeRoot;
let labApp: App;
let api: Api;

describe('S04 payload 边界 · 真实引擎 + 真实 HTTP', () => {
  beforeAll(async () => {
    root = makeChallengeRoot({ [LAB_ID]: { pub: LAB.pub, priv: LAB.priv } });
    labApp = buildApp({
      challengeDir: root.challengeDir,
      presetDir: root.presetDir,
      env: { FLAG_PAYLOAD_LAB: TEST_FLAG_SENTINEL },
    });
    await labApp.ready();

    api = {
      async newSession(): Promise<string> {
        const response = await labApp.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: LAB_ID },
        });
        expect(response.statusCode).toBe(200);
        return CreateSessionResponseSchema.parse(response.json()).sessionId;
      },

      async getState(sessionId: string): Promise<SessionStateResponse> {
        const response = await labApp.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
        expect(response.statusCode).toBe(200);
        return SessionStateResponseSchema.parse(response.json());
      },

      async act(sessionId: string, actions: readonly unknown[]): Promise<ActOutcome> {
        const response = await labApp.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions },
        });
        expect(response.statusCode).toBe(200);
        return { raw: response.body, body: ActionsResponseSchema.parse(response.json()) };
      },

      async postActions(sessionId: string, actions: readonly unknown[]): Promise<ResponseLike> {
        const response = await labApp.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions },
        });
        return response;
      },

      async postSubmit(sessionId: string, body: Record<string, unknown>): Promise<ResponseLike> {
        const response = await labApp.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/submit`,
          payload: body,
        });
        return response;
      },

      async submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitResponse> {
        const response = await api.postSubmit(sessionId, { actions });
        expect(response.statusCode).toBe(200);
        return SubmitResponseSchema.parse(response.json());
      },
    };
  });

  afterAll(async () => {
    await labApp.close();
    removeChallengeRoot(root);
  });

  it('block 只接受 {id, args}：带 expand / actions / resolved 等字段的请求被 strictObject 拒绝，状态不变', async () => {
    // 契约层守卫：`block` 动作声明的字段就是这三个。加字段必须同批改这里与 README 的映射表。
    expect(Object.keys(BlockActionSchema.shape).sort()).toEqual(['args', 'id', 'type']);

    const sessionId = await api.newSession();
    const before = await api.getState(sessionId);

    const forged: readonly Record<string, unknown>[] = [
      {
        type: 'block',
        id: 'gets',
        args: { data: '4142' },
        expand: [{ type: 'write_bytes', addr: CLAIMED_ADDR, hex: '4242' }],
      },
      {
        type: 'block',
        id: 'gets',
        args: { data: '4142' },
        actions: [{ type: 'write_bytes', addr: CLAIMED_ADDR, hex: '4242' }],
      },
      { type: 'block', id: 'gets', args: { data: '4142' }, resolved: { data: '4142' } },
      {
        type: 'block',
        id: 'gets',
        args: { data: '4142' },
        template: [{ type: 'write_bytes', addr: CLAIMED_ADDR, hex: '4242' }],
      },
      { type: 'block', id: 'gets', args: { data: '4142' }, bytes: '4242' },
      { type: 'block', id: 'gets', args: { data: '4142' }, originIndex: 0 },
    ];

    for (const action of forged) {
      const response = await api.postActions(sessionId, [action]);
      expectApiError(response, 'invalid_request', [TEST_FLAG_SENTINEL]);
    }

    const after = await api.getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    // 请求体在 Schema 层被拒 → 根本没进引擎，所以 `failures` 也不变（口径同 S03 里的注释，已报 A/C）。
    expect(after.projection.failures).toBe(0);
    expect(after.history).toEqual(before.history);
    // 客户端“声称”的那次写入（0x500010 ← 4242）一个字节都没发生。
    expect(stackHex(after.projection)).toBe(ZERO_STACK_HEX);
  });

  it('客户端提供的展开结果被忽略：展开以题目包 authorBlocks 为准', async () => {
    const sessionId = await api.newSession();

    const accepted = await api.act(sessionId, [{ type: 'block', id: 'gets', args: { data: '4142' } }]);
    expect(accepted.body.executed).toBe(1);
    expect(accepted.body.results).toEqual([{ ok: true, action: 'block' }]);
    // 真实内存观测：唯一的变化就是题目包模板那一条（0x500000 ← 4142）。
    expect(stackHex(accepted.body.projection)).toBe(stackWith(0, '4142'));

    // 展开的**定义**来自题目包：用 shared 的展开入口复算一遍，与观测到的内存变化逐字节对齐。
    expect(expansionOf('gets', { data: '4142' })).toEqual({
      ok: true,
      actions: [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }],
    });
    // 参数只能通过 `args` 影响展开结果：同一个积木换一份字节，展开的动作跟着换。
    expect(expansionOf('gets', { data: 'aabb' })).toEqual({
      ok: true,
      actions: [{ type: 'write_bytes', addr: BUF_ADDR, hex: 'aabb' }],
    });
    const second = await api.act(sessionId, [{ type: 'block', id: 'gets', args: { data: 'aabb' } }]);
    expect(stackHex(second.body.projection)).toBe(stackWith(0, 'aabb'));
  });

  it('客户端给出的地址/字节与题目包不一致时，实际执行的是题目包展开的动作', async () => {
    const sessionId = await api.newSession();

    // 客户端在请求里“声明”自己要写 0x500010 ← 4242，并附上自己的展开结果：
    // `strictObject` 直接拒收，内存里没有这次写入。
    const forged = await api.postActions(sessionId, [
      {
        type: 'block',
        id: 'gets',
        args: { data: '4142' },
        expand: [{ type: 'write_bytes', addr: CLAIMED_ADDR, hex: '4242' }],
      },
    ]);
    expectApiError(forged, 'invalid_request');
    expect(stackHex((await api.getState(sessionId)).projection)).toBe(ZERO_STACK_HEX);

    // 同一份意图只发 `{id, args}`：写的是题目包模板的地址 0x500000，客户端声称的 0x500010 一个字节没动。
    const packet = await api.submit(sessionId, [{ type: 'block', id: 'gets', args: { data: '4142' } }]);
    expect(packet.verdict).toBe('won');
    expect(packet.flag).toBe(TEST_FLAG_SENTINEL);
    const finalFrame = packet.replay.frames.at(-1);
    expect(finalFrame?.label).toBe('block');
    expect(finalFrame?.changedVmas.find((vma) => vma.id === 'stack')?.hex).toBe(stackWith(0, '4142'));

    // 反向对照：另一块题目包积木把**同一个参数**写到 0x500010，同一 payload 判 incomplete ——
    // 判胜看的确实是题目包模板里的地址，而不是客户端声称的地址。
    const elsewhere = await api.submit(await api.newSession(), [
      { type: 'block', id: 'gets_elsewhere', args: { data: '4142' } },
    ]);
    expect(elsewhere.verdict).toBe('incomplete');
    expect(elsewhere.flag).toBeUndefined();
    expect(elsewhere.executed).toBe(1);
    expect(elsewhere.replay.frames.at(-1)?.changedVmas.find((vma) => vma.id === 'stack')?.hex).toBe(
      stackWith(16, '4142'),
    );
  });

  it('未声明的积木 id 回 unknown_action，状态不变', async () => {
    const sessionId = await api.newSession();
    const before = await api.getState(sessionId);

    const outcome = await api.act(sessionId, [{ type: 'block', id: 'nope', args: {} }]);
    expect(outcome.body.executed).toBe(0);
    expect(outcome.body.results).toEqual([
      {
        ok: false,
        action: 'block',
        error: {
          code: 'unknown_action',
          message: describeError('unknown_action'),
          note: '本题没有这块积木',
        },
      },
    ]);
    expectNoInternalLeak(outcome.raw, [TEST_FLAG_SENTINEL]);

    const after = await api.getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    // 进了引擎的被拒动作计入 `failures`（04 §3）；状态本身逐字段不变（含隐藏区）。
    expect(after.projection.failures).toBe(before.projection.failures + 1);
    expect(after.history).toEqual(before.history);
    expect(stackHex(after.projection)).toBe(ZERO_STACK_HEX);
  });

  it('积木缺参数 / 多参数 / 参数类型不符都回 invalid_arguments，状态不变', async () => {
    const cases: readonly { readonly why: string; readonly action: Record<string, unknown> }[] = [
      { why: '缺参数', action: { type: 'block', id: 'gets', args: {} } },
      { why: '多参数', action: { type: 'block', id: 'gets', args: { data: '41', extra: '42' } } },
      { why: 'bytes 位收到数字', action: { type: 'block', id: 'gets', args: { data: 123 } } },
      { why: 'bytes 位收到非 hex 字符串', action: { type: 'block', id: 'gets', args: { data: 'zz' } } },
      { why: 'int 位缺参数', action: { type: 'block', id: 'steps', args: {} } },
      { why: 'int 位收到非整数', action: { type: 'block', id: 'steps', args: { n: 1.5 } } },
    ];

    const sessionId = await api.newSession();
    const before = await api.getState(sessionId);

    for (const [index, item] of cases.entries()) {
      const outcome = await api.act(sessionId, [item.action]);
      expect(outcome.body.executed, item.why).toBe(0);
      expect(outcome.body.results, item.why).toEqual([
        {
          ok: false,
          action: 'block',
          error: {
            code: 'invalid_arguments',
            message: describeError('invalid_arguments'),
            note: '积木参数不合法',
          },
        },
      ]);
      // `failures` 单调递增：每一条被拒一次就 +1（04 §3）。
      expect(outcome.body.projection.failures, item.why).toBe(index + 1);
      // 被拒的积木整体回滚：内存里没有半截写入。
      expect(stackHex(outcome.body.projection), item.why).toBe(ZERO_STACK_HEX);
    }

    const after = await api.getState(sessionId);
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(after.projection.failures).toBe(cases.length);
    expect(after.history).toEqual(before.history);
    expect(stackHex(after.projection)).toBe(ZERO_STACK_HEX);

    // 对照：同两个积木的合法参数照常生效（证明上面不是「这两块积木一律拒绝」）。
    const okBytes = await api.act(sessionId, [{ type: 'block', id: 'gets', args: { data: '4142' } }]);
    expect(okBytes.body.results[0]?.ok).toBe(true);
    expect(stackHex(okBytes.body.projection)).toBe(stackWith(0, '4142'));
    // 换一个干净会话跑 `steps`：`0e` 是 `syscall 60`，一步就退出；此时成功条件还没满足 → `exited`。
    const intSession = await api.newSession();
    const okInt = await api.act(intSession, [{ type: 'block', id: 'steps', args: { n: 1 } }]);
    expect(okInt.body.results[0]?.ok).toBe(true);
    expect(okInt.body.projection.steps).toBe(1);
    expect(okInt.body.projection.status).toBe('exited');
  });

  it('submit 请求体动作数超 MAX_SUBMIT_ACTIONS 被拒，动作 Schema 同样是 strictObject', async () => {
    const sessionId = await api.newSession();

    // 每个动作都过 `ActionSchema`（strictObject）：多一个字段就是 invalid_request，不是被静默丢弃。
    const forgedActions: readonly Record<string, unknown>[] = [
      { type: 'step', count: 1, resolved: true },
      { type: 'block', id: 'gets', args: { data: '41' }, expand: [] },
      { type: 'block', id: 'gets', args: { data: '41' }, resolved: {} },
      { type: 'pop', discarded: '4142' },
    ];
    for (const action of forgedActions) {
      expectApiError(await api.postSubmit(sessionId, { actions: [action] }), 'invalid_request');
    }

    // 动作数超上限（`MAX_ACTIONS_PER_REQUEST` 是 `/actions` 的限额，与 submit 各管一段）。
    const tooMany = await api.postSubmit(sessionId, {
      actions: Array.from({ length: MAX_SUBMIT_ACTIONS + 1 }, () => ({ type: 'step' })),
    });
    expectApiError(tooMany, 'invalid_request');

    // 边界内仍然接受：否则上面的拒绝可能只是「所有大 payload 都被拒」的假阳性。
    const boundary = await api.postSubmit(sessionId, {
      actions: Array.from({ length: MAX_SUBMIT_ACTIONS }, () => ({ type: 'step' })),
    });
    expect(boundary.statusCode).toBe(200);
    const body = SubmitResponseSchema.parse(boundary.json());
    // 第一个 `step` 执行的就是 `syscall 60`：程序退出，回放随即终止，成功条件未满足。
    expect(body.verdict).toBe('incomplete');
    expect(body.executed).toBe(1);
    expect(body.results).toHaveLength(1);

    // 提交被拒 / 被接受都不动调试实例。
    const after = await api.getState(sessionId);
    expect(after.projection.steps).toBe(0);
    expect(after.projection.status).toBe('ready');
    expect(after.projection.failures).toBe(0);
    expect(stackHex(after.projection)).toBe(ZERO_STACK_HEX);
  });

  describe('附加（不替代下面的 reads_state 条件）：线上格式无法表达读状态，也不会静默当零', () => {
    it('把状态引用塞进 payload 的每种写法都被拒，且没有任何「当成零」的写入发生', async () => {
      const sessionId = await api.newSession();
      const before = await api.getState(sessionId);

      // (1) Schema 层：地址与字节位只收十六进制字面量。`RSP+8`、`reg:RSP`、`RSP`、对象引用都进不来。
      const stateRefs: readonly Record<string, unknown>[] = [
        { type: 'write_bytes', addr: 'RSP+8', hex: '4142' },
        { type: 'write_bytes', addr: 'reg:RSP', hex: '4142' },
        { type: 'write_bytes', addr: '0x500000', hex: 'RSP' },
        { type: 'block', id: 'gets', args: { data: { ref: 'RSP' } } },
        { type: 'block', id: 'gets', args: { data: ['0x500000'] } },
      ];
      for (const action of stateRefs) {
        expectApiError(await api.postActions(sessionId, [action]), 'invalid_request');
      }
      // 被拒之后内存一个字节没动：没有把 `RSP` 之类当成 0 / 空串写进去。
      expect(stackHex((await api.getState(sessionId)).projection)).toBe(ZERO_STACK_HEX);

      // (2) 积木参数解析层：字符串进得了 Schema，但 `bytes` 位解析不出来时**拒绝**，不是当零。
      const asZero = await api.act(sessionId, [{ type: 'block', id: 'gets', args: { data: 'RSP' } }]);
      expect(asZero.body.executed).toBe(0);
      expect(asZero.body.results[0]?.ok).toBe(false);
      expect(asZero.body.results[0]?.error?.code).toBe('invalid_arguments');
      expect(asZero.body.results[0]?.error?.message).toBe(describeError('invalid_arguments'));
      expect(stackHex(asZero.body.projection)).toBe(ZERO_STACK_HEX);

      // (3) 两种实例同一条契约：判题实例对同一构造同样拒绝，且 executed 停在它之前。
      const submitted = await api.postSubmit(sessionId, {
        actions: [
          { type: 'block', id: 'gets', args: { data: '4142' } },
          { type: 'block', id: 'gets', args: { data: 'RSP' } },
        ],
      });
      expect(submitted.statusCode).toBe(200);
      const body = SubmitResponseSchema.parse(submitted.json());
      expect(body.verdict).toBe('rejected');
      expect(body.executed).toBe(1);
      expect(body.results).toHaveLength(2);
      expect(body.results[0]?.ok).toBe(true);
      expect(body.results[1]?.ok).toBe(false);
      expect(body.results[1]?.error?.code).toBe('invalid_arguments');
      expect(body.replay.frames.at(-1)?.error?.code).toBe('invalid_arguments');

      // 口径说明：服务端**没有** `reads_state` 拒绝路径（错误码只定义在 `shared/errors.ts`，
      // 真正的守卫在 H 的编译器，编译期就报错）。所以这一节验证的是「线上格式根本无法表达读状态
      // ＋ 伪装写法一律被拒、绝不被当成零」这个更强也更真实可测的性质，
      // **不构成** 07 §5 第 13 条按原文通过（原文要求 `rejected` + `reads_state`）。
      const after = await api.getState(sessionId);
      expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    });
  });

  // -------------------------------------------------------------------------
  // 以下 4 条按当前契约无法真实验证，如实保留 todo（不写假断言、不改产品代码凑绿）
  // -------------------------------------------------------------------------

  /**
   * `reads_state` 三条为什么现在验证不了（D3 复核结论，与 D2 一致）：
   *
   * 1. **服务端不存在这条拒绝路径**：全仓搜索 `reads_state` 只有 `shared/src/errors.ts` 的
   *    错误码定义与 `web/src/compiler/types.ts` 的注释/文案，`packages/server/src/**` 与
   *    `packages/engine/src/**` 里没有任何地方会产出该错误码。要在 HTTP 层断言 `reads_state`，
   *    先得有实现——而按现在的契约，**线上动作集根本无法表达「读当前状态」**（04 §2 的 12 个动作
   *    里，地址与值都是客户端给的十六进制字面量），所以这个错误码在服务端没有可触发的输入。
   * 2. **真正会在编译期拒绝它的是 H 的编译器**：`web/src/compiler` 的
   *    `FORBIDDEN_STATE_BLOCK_TYPES` + `MESSAGE_READS_STATE`（05 §4），它是**前端编译错误**，
   *    不是 REST 响应；`packages/web/src/compiler/*.test.ts` 已覆盖。
   * 3. **验收测试目前无法直接消费它**：根 `tsconfig.json` 的 `exclude` 含 `packages/web/**`，
   *    `tests/acceptance/**` 一旦 import 编译器就会破坏 `pnpm typecheck`（F 的写入范围只有
   *    `tests/acceptance/**`，不能自己加 tsconfig / paths）。
   *
   * 结论与 owner：这是**契约缺口**而不是实现缺陷。需要 A 在 04 §5.1 / 08 §5 写明第 13 条在
   * 候选版的验证口径（例如「以编译器编译期拒绝 + 线上格式不可表达」为准），或由 A 决定给验收测试
   * 开一条能 import 编译器的通道（独立 tsconfig 或额外 paths）；C 若要保留服务端兜底拒绝，
   * 需要先定义一种能表达读状态的请求形状（当前没有）。在口径落定之前，这三条继续 todo。
   */
  it.todo('读状态构造（如按当前 RSP 求偏移）在 payload 里被判 rejected，错误码 reads_state（H/C）');
  it.todo('reads_state 不是静默当零：results 里该动作 ok=false 并带错误信息，executed 停在它之前（C）');
  it.todo('同一读状态构造在调试实例与判题实例里按同一契约被拒绝（04 §2/§5.1，B/C）');

  /**
   * 「客户端编译上限在服务端复核」为什么验证不了：
   *
   * 循环展开 256 次与表达式求值 4096 步都是**编译器内部的常量折叠 / 展开预算**
   * （`limits.LOOP_UNROLL_LIMIT` / `EXPR_EVAL_STEP_LIMIT`，消费者是 H 的编译器）。
   * 到达服务端的请求体只有**扁平的已经展开的**动作数组——服务端看不到循环结构，也没有
   * 「这次编译做了多少次表达式求值」这个信息，因此无从复核。服务端真正能守住的量是
   * 「产物动作数 ≤ `MAX_SUBMIT_ACTIONS`」，那一条已在上面真实执行。
   *
   * owner：H 在 `packages/web/src/compiler/*.test.ts` 证明编译期限流（已有用例），D4 接线时
   * D 负责「超限产物不允许提交」的界面行为；若要把它升级为**服务端**条件，需要 A 先改契约
   * （例如请求体带上编译摘要并让服务端复核），本轮不做。
   */
  it.todo('客户端编译上限（循环展开 256、表达式 4096 步）在服务端复核，超限被拒绝（05 §4，C/H）');
});
