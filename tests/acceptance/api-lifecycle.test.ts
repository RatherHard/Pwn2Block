import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
} from '@pwn2block/shared';
import type {
  ActionsResponse,
  Predicate,
  PrivateChallenge,
  Projection,
  PublicChallenge,
  SessionStateResponse,
  SubmitResponse,
} from '@pwn2block/shared';
import type { BuildAppOptions } from '@pwn2block/server';
import {
  expectApiError,
  expectProjectionFieldsUnchanged,
  makeChallengeRoot,
  removeChallengeRoot,
} from './support';
import type { TempChallengeRoot } from './support';

/**
 * API 生命周期与终态 — owner F（C 配合）
 *
 * 依据 `docs/archive/mvp-2026-10-16/08-Agent并行开发日程.md` §3 的 **D4 行**：F 的验收项是「API 生命周期/终态；核心检查 S01–S05」，
 * 对应关卡 **G2 · D4**（真实 API 全部终态、调试/判题隔离、回退按契约工作）。本文件**不属于** S01–S06
 * 六组核心检查，是它们之外的 D4 验收面，所以单独成文件、单独在本目录 README §3.2 里登记。
 *
 * 契约依据：
 * - 04 §1/§1.1：一次会话两个实例、动作串行、空闲 30 分钟回收；`failed` 或**程序已退出**时执行类动作被拒、
 *   回退类仍可用；「已退出」看 `lastStop.reason === 'exit'` 而不是 `status`（09 §7 第 5 条、§8 第 9 条）。
 * - 04 §3：三层回退（`reset` 永远可用、`undo` 一次请求一层、`step_back` 指令层环形缓冲）；
 *   `undo` / `step_back` 自身不压栈，`reset` 压栈所以可被 undo；`failures` 不随回退减少，
 *   回退类动作自身不计入（09 §8 第 1 条）。
 * - 04 §5/§5.1/§6：会话 CRUD 的状态码与错误码；四种 verdict；提交是纯回放且不影响调试实例；
 *   存活会话上限与 `Retry-After` 的口径（09 §8 第 2 条、D3 限流口径）。
 * - 09 §8 第 10 条：退出后单发执行类动作仍计一次 `failures`（`not_executable`），本文件正面钉住它。
 *
 * **真实对象**：真实 `@pwn2block/server` 的 `buildApp` + `inject`（真实 HTTP 路径、真实请求 Schema、
 * 真实限流与会话表）加真实 `@pwn2block/engine`（真实解码/执行/回退/`replaySubmit`）。没有任何 mock
 * 的 runtime —— mock 通过不算真实接口验收（08 §1）。四个实验台用真实 `PublicChallengeSchema` /
 * `PrivateChallengeSchema` 构造后写进临时目录，不落进仓库的 `challenges/`。
 */

// ---------------------------------------------------------------------------
// 四个实验台：每个只钉住一种终态，避免用例之间互相污染语义
// ---------------------------------------------------------------------------

const LIFE_LAB = 'life-lab';
const WIN_LAB = 'win-lab';
const MARK_LAB = 'mark-lab';
const FAIL_LAB = 'fail-lab';

/** `buf` / 栈 VMA 的起始地址（非隐藏、可读写）。 */
const BUF_ADDR = '0x500000';
/** 代码 VMA 的起始地址。 */
const TEXT_ADDR = '0x400000';
/** 非隐藏栈 VMA 的初态：8 字节 `aa` + 其余全零；`ret` 动作会把这个字吃成 ip。 */
const INITIAL_STACK_HEAD = 'aa'.repeat(8);

/** 判胜谓词：所有实验台共用（只有 `mark` / `win` 两个 syscall 能置它）。 */
const WIN_PREDICATE = { reg_eq: { reg: 'FLAG', value: '0x1' } } as const;

/** `fail` 谓词：正常退出且没满足成功条件即判负（03 §2.1）。 */
const EXIT_FAIL: Predicate = { all: [{ exited: {} }, { not: WIN_PREDICATE }] };

function labPackages(spec: {
  readonly id: string;
  /** 代码 VMA 的初始字节。 */
  readonly code: string;
  readonly encoding: PublicChallenge['encoding'];
  readonly syscalls: PublicChallenge['syscalls'];
  readonly fail: PrivateChallenge['fail'];
}): { readonly pub: PublicChallenge; readonly priv: PrivateChallenge } {
  const pub = PublicChallengeSchema.parse({
    id: spec.id,
    title: 'API 生命周期实验台',
    briefing: '用于验收会话生命周期、三层回退与四种终态。',
    archBits: 64,
    encoding: spec.encoding,
    syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
    syscalls: spec.syscalls,
    labels: [{ name: 'buf', addr: BUF_ADDR, size: 16, kind: 'buffer' }],
    allowedActions: ['step', 'run', 'write_bytes', 'pop', 'ret'],
  });

  const priv = PrivateChallengeSchema.parse({
    registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    initRegisters: { RSP: BUF_ADDR, RBP: BUF_ADDR, RIP: TEXT_ADDR },
    vmas: [
      {
        id: 'text',
        kind: 'code',
        start: TEXT_ADDR,
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        init: [{ at: TEXT_ADDR, hex: spec.code }],
      },
      {
        id: 'stack',
        kind: 'stack',
        start: BUF_ADDR,
        size: '0x1000',
        perm: 'rw',
        hidden: false,
        init: [{ at: BUF_ADDR, hex: INITIAL_STACK_HEAD }],
      },
    ],
    win: WIN_PREDICATE,
    fail: spec.fail,
    flag: `env:FLAG_${spec.id.toUpperCase().replace(/-/g, '_')}`,
  });

  return { pub, priv };
}

/** `life-lab`：5 条 `nop` + 一条 `syscall exit`。用于步数、回退与「退出终态」。 */
const lifeLab = labPackages({
  id: LIFE_LAB,
  code: `${'90'.repeat(5)}0e`,
  encoding: [
    { opcode: '0x90', op: 'nop', operands: [] },
    { opcode: '0x0e', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
  ],
  syscalls: [{ nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' }],
  // 没有 `fail`：正常退出就是 `exited`，不判负（判负优先只对声明了 fail 的题目成立）。
  fail: [],
});

/**
 * `win-lab`：一条 `syscall win`。
 * 它**同时**置 `FLAG=1` 并退出，所以 `status` 会是 `satisfied` 而 `lastStop.reason` 是 `exit`——
 * 这正是 09 §8 第 9 条钉住的边界（只看 `status` 会让退出后的动作继续执行）。
 */
const winLab = labPackages({
  id: WIN_LAB,
  code: '0f',
  encoding: [{ opcode: '0x0f', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall win' }],
  syscalls: [
    {
      nr: 99,
      name: 'win',
      kind: 'custom',
      doc: '置 FLAG=1 并退出',
      effects: [
        { type: 'set_reg', reg: 'FLAG', value: '0x1' },
        { type: 'exit' },
      ],
    },
  ],
  fail: [],
});

/** `mark-lab`：一条 `syscall mark`（只置 `FLAG=1`，**不退出**）+ 一条 `nop`。 */
const markLab = labPackages({
  id: MARK_LAB,
  code: '0f90',
  encoding: [
    { opcode: '0x0f', op: 'syscall', operands: ['const:98'], mnemonic: 'syscall mark' },
    { opcode: '0x90', op: 'nop', operands: [] },
  ],
  syscalls: [
    {
      nr: 98,
      name: 'mark',
      kind: 'custom',
      doc: '置 FLAG=1，不退出',
      effects: [{ type: 'set_reg', reg: 'FLAG', value: '0x1' }],
    },
  ],
  fail: [],
});

/** `fail-lab`：一条 `syscall exit` + `fail` 谓词。退出且未满足成功条件 → `failed`。 */
const failLab = labPackages({
  id: FAIL_LAB,
  code: '0e',
  encoding: [{ opcode: '0x0e', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' }],
  syscalls: [{ nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' }],
  fail: [EXIT_FAIL],
});

const LAB_ENV = {
  FLAG_LIFE_LAB: TEST_FLAG_SENTINEL,
  FLAG_WIN_LAB: TEST_FLAG_SENTINEL,
  FLAG_MARK_LAB: TEST_FLAG_SENTINEL,
  FLAG_FAIL_LAB: TEST_FLAG_SENTINEL,
};

// ---------------------------------------------------------------------------
// 真实对象：真实 Fastify 实例 + 真实引擎
// ---------------------------------------------------------------------------

type App = ReturnType<typeof buildApp>;

let root: TempChallengeRoot;

beforeAll(() => {
  root = makeChallengeRoot({
    [LIFE_LAB]: lifeLab,
    [WIN_LAB]: winLab,
    [MARK_LAB]: markLab,
    [FAIL_LAB]: failLab,
  });
});

afterAll(() => {
  removeChallengeRoot(root);
});

/** 一个 app 一份临时实例：用完即关，不把会话/限流计数留给下一个用例。 */
async function withApp<T>(options: BuildAppOptions, fn: (app: App) => Promise<T>): Promise<T> {
  const app = buildApp(options);
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

/** 共享的真实 app：绝大多数用例只关心会话语义，不需要独立时钟。 */
let app: App;

beforeAll(async () => {
  app = buildApp({ challengeDir: root.challengeDir, presetDir: root.presetDir, env: LAB_ENV });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface Api {
  create(challengeId?: string): Promise<{ readonly sessionId: string; readonly projection: Projection }>;
  getState(sessionId: string): Promise<SessionStateResponse>;
  act(sessionId: string, actions: readonly unknown[]): Promise<ActionsResponse>;
  submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitResponse>;
  raw(method: InjectMethod, url: string, payload?: unknown): Promise<InjectedResponse>;
}

type InjectMethod = 'GET' | 'POST' | 'DELETE';

/**
 * 注入响应的最小形状：只断言用到的四个字段。
 *
 * 这里不 import `fastify` 的类型（理由同 `support.ts`：根 tsconfig 的可见范围里没有它），
 * 返回值要窄化成结构类型，所以用一次显式断言，而不是把整棵 fastify 类型树引进来。
 */
interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, unknown>>;
  json(): unknown;
}

/** 一次真实注入；`payload` 缺省表示不带请求体（GET / DELETE）。 */
function injectRaw(
  instance: App,
  method: InjectMethod,
  url: string,
  payload?: unknown,
): Promise<InjectedResponse> {
  if (payload === undefined) return instance.inject({ method, url });
  return instance.inject({ method, url, payload: payload as Record<string, unknown> });
}

/** 只包真实 `inject`：不做任何结果兜底，状态码与 Schema 都由调用方断言。 */
function makeApi(instance: App): Api {
  return {
    async create(challengeId: string = LIFE_LAB) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId },
      });
      expect(response.statusCode).toBe(200);
      const parsed = CreateSessionResponseSchema.parse(response.json());
      return { sessionId: parsed.sessionId, projection: parsed.projection };
    },

    async getState(sessionId: string): Promise<SessionStateResponse> {
      const response = await instance.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      expect(response.statusCode).toBe(200);
      return SessionStateResponseSchema.parse(response.json());
    },

    async act(sessionId: string, actions: readonly unknown[]): Promise<ActionsResponse> {
      const response = await instance.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions },
      });
      expect(response.statusCode).toBe(200);
      return ActionsResponseSchema.parse(response.json());
    },

    async submit(sessionId: string, actions: readonly unknown[]): Promise<SubmitResponse> {
      const response = await instance.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions },
      });
      expect(response.statusCode).toBe(200);
      return SubmitResponseSchema.parse(response.json());
    },

    async raw(method, url, payload) {
      return injectRaw(instance, method, url, payload);
    },
  };
}

let api: Api;

beforeAll(() => {
  api = makeApi(app);
});

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

/** 提交录像里最后一个 `action` 帧（每个动作一帧；`instruction` 帧归属后一个动作帧，09 §3.4）。 */
function lastActionFrame(body: SubmitResponse) {
  return [...body.replay.frames].reverse().find((frame) => frame.kind === 'action');
}

// ---------------------------------------------------------------------------
// 一、会话创建 / 过期 / 回收（04 §1、§5、§6）
// ---------------------------------------------------------------------------

describe('API 生命周期 · 会话创建 / 过期 / 回收（04 §1 / §5 / §6）', () => {
  it('POST /api/sessions：sessionId 是 128 位随机十六进制，投影是题目初态，history 为空', async () => {
    const first = await api.create(LIFE_LAB);
    const second = await api.create(LIFE_LAB);

    // 04 §6：128 位随机值、持有即凭证、不可枚举。
    expect(first.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.sessionId).not.toBe(first.sessionId);

    expect(first.projection.status).toBe('ready');
    expect(first.projection.steps).toBe(0);
    expect(first.projection.failures).toBe(0);
    // 初态就是题目包声明的初值（04 §1：判题实例从同一份初态回放）。
    expect(registerOf(first.projection, 'RIP')).toBe(TEXT_ADDR);
    expect(registerOf(first.projection, 'RSP')).toBe(BUF_ADDR);
    expect(registerOf(first.projection, 'FLAG')).toBe('0x0');
    expect(first.projection.roles).toEqual({ sp: 'RSP', bp: 'RBP', ip: 'RIP' });
    expect(stackHex(first.projection).startsWith(INITIAL_STACK_HEAD)).toBe(true);
    expect(first.projection.vmas.find((vma) => vma.id === 'text')?.hex?.startsWith('9090909090')).toBe(
      true,
    );

    // 两次创建拿到的初态逐字段一致（同一道题的初态是确定的，不读时间、不用随机数）。
    expectProjectionFieldsUnchanged(first.projection, second.projection);

    // 未知题目：404 not_found（不是 503 —— 那是「加载失败」，见 S05）。
    expectApiError(
      await api.raw('POST', '/api/sessions', { challengeId: 'no-such-lab' }),
      'not_found',
    );
  });

  it('未知 / 伪造的会话 id：GET、actions、submit、DELETE 一律 404 not_found', async () => {
    const unknown = 'ffffffffffffffffffffffffffffffff';
    const calls = [
      api.raw('GET', `/api/sessions/${unknown}`),
      api.raw('POST', `/api/sessions/${unknown}/actions`, { actions: [{ type: 'step' }] }),
      api.raw('POST', `/api/sessions/${unknown}/submit`, { actions: [{ type: 'step' }] }),
      api.raw('DELETE', `/api/sessions/${unknown}`),
      // 客户端自选的短 id 同样不存在：服务端只用自己发的 128 位随机值。
      api.raw('GET', '/api/sessions/self-chosen'),
    ];
    for (const response of await Promise.all(calls)) {
      expectApiError(await response, 'not_found');
    }
  });

  it('DELETE 主动结束会话：首次 200 {ok:true}，之后（含重复删除）一律 404 not_found', async () => {
    const { sessionId } = await api.create(LIFE_LAB);

    const deleted = await api.raw('DELETE', `/api/sessions/${sessionId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    // 04 §5：重复删除回 404 not_found；已被**空闲回收**的才回 session_expired（见下一条）。
    expectApiError(await api.raw('DELETE', `/api/sessions/${sessionId}`), 'not_found');
    expectApiError(await api.raw('GET', `/api/sessions/${sessionId}`), 'not_found');
    expectApiError(
      await api.raw('POST', `/api/sessions/${sessionId}/actions`, { actions: [{ type: 'step' }] }),
      'not_found',
    );
  });

  it('空闲回收：活动会刷新活跃时间，超时后 GET / actions / submit / DELETE 都回 session_expired', async () => {
    let now = 1_000_000;
    const clock = (): number => now;

    await withApp(
      {
        challengeDir: root.challengeDir,
        presetDir: root.presetDir,
        env: LAB_ENV,
        // 假时钟：回收判定只可能来自显式的惰性回收（定时清理周期调到 1 小时，测试期间不触发）。
        sessions: { now: clock, idleMs: 30_000, sweepIntervalMs: 3_600_000 },
        rateLimit: { now: clock },
      },
      async (expiring) => {
        const local: Api = makeApi(expiring);
        const first = await local.create(LIFE_LAB);
        expect((await local.getState(first.sessionId)).projection.steps).toBe(0);

        // 20 秒后活动一次：`GET` 会刷新活跃时间（04 §1「空闲」按最后一次活动算）。
        now += 20_000;
        expect((await local.getState(first.sessionId)).sessionId).toBe(first.sessionId);

        // 再过 20 秒（距创建 40 秒、距上次活动 20 秒）：建新会话触发惰性回收，两个都还活着。
        now += 20_000;
        const second = await local.create(LIFE_LAB);
        expect((await local.getState(second.sessionId)).projection.status).toBe('ready');
        expect((await local.getState(first.sessionId)).sessionId).toBe(first.sessionId);

        // 再空转超过 idleMs：下一次建会话把它与第二个一起回收。
        now += 30_001;
        const third = await local.create(LIFE_LAB);
        expect(third.sessionId).not.toBe(first.sessionId);

        for (const response of [
          await local.raw('GET', `/api/sessions/${first.sessionId}`),
          await local.raw('POST', `/api/sessions/${first.sessionId}/actions`, {
            actions: [{ type: 'step' }],
          }),
          await local.raw('POST', `/api/sessions/${first.sessionId}/submit`, {
            actions: [{ type: 'step' }],
          }),
          await local.raw('DELETE', `/api/sessions/${first.sessionId}`),
        ]) {
          expectApiError(response, 'session_expired');
        }

        // 反向对照：刚建的第三个会话照常可用，不是「这个 app 坏了」。
        expect((await local.getState(third.sessionId)).projection.status).toBe('ready');
      },
    );
  });

  it('存活会话上限：每 IP 与全局各挡一次；会话容量型 429 不带 Retry-After；回收后配额释放', async () => {
    const base = { challengeDir: root.challengeDir, presetDir: root.presetDir, env: LAB_ENV };

    let perIpMessage = '';
    await withApp({ ...base, rateLimit: { sessions: { perIp: 1, global: 8 } } }, async (limited) => {
      const local = makeApi(limited);
      await local.create(LIFE_LAB);
      const blocked = await local.raw('POST', '/api/sessions', { challengeId: LIFE_LAB });
      expectApiError(blocked, 'rate_limited');
      perIpMessage = (blocked.json() as { message: string }).message;
      // 会话容量型不是时间窗口型：调用方何时 DELETE 由自己决定，没有确定的 Retry-After（D3 限流口径）。
      expect(blocked.headers['retry-after']).toBeUndefined();
    });

    let globalMessage = '';
    await withApp({ ...base, rateLimit: { sessions: { perIp: 8, global: 1 } } }, async (limited) => {
      const local = makeApi(limited);
      await local.create(LIFE_LAB);
      const blocked = await local.raw('POST', '/api/sessions', { challengeId: LIFE_LAB });
      expectApiError(blocked, 'rate_limited');
      globalMessage = (blocked.json() as { message: string }).message;
      expect(blocked.headers['retry-after']).toBeUndefined();
    });

    // 两个上限说的是两件事，文案必须不同（同一句话说明其中一个分支没被走到）。
    expect(perIpMessage.length).toBeGreaterThan(0);
    expect(globalMessage.length).toBeGreaterThan(0);
    expect(globalMessage).not.toBe(perIpMessage);

    // 回收后配额释放：回收掉下去的会话当场把名额还回来（04 §6 按**存活**计）。
    let now = 5_000_000;
    const clock = (): number => now;
    await withApp(
      {
        ...base,
        sessions: { now: clock, idleMs: 1_000, sweepIntervalMs: 3_600_000 },
        rateLimit: { now: clock, sessions: { perIp: 1, global: 8 } },
      },
      async (limited) => {
        const local = makeApi(limited);
        const first = await local.create(LIFE_LAB);
        expectApiError(
          await local.raw('POST', '/api/sessions', { challengeId: LIFE_LAB }),
          'rate_limited',
        );

        now += 1_001;
        const second = await local.create(LIFE_LAB);
        expect(second.sessionId).not.toBe(first.sessionId);
        expectApiError(await local.raw('GET', `/api/sessions/${first.sessionId}`), 'session_expired');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 二、三层回退与调试实例状态（04 §3）
// ---------------------------------------------------------------------------

describe('API 生命周期 · 三层回退与调试实例状态（04 §3）', () => {
  it('reset 回到题目初态：投影逐字段等于全新会话的初态；reset 自身压栈（可被 undo）', async () => {
    const fresh = await api.create(LIFE_LAB);
    const sessionId = fresh.sessionId;

    const written = await api.act(sessionId, [{ type: 'write_bytes', addr: BUF_ADDR, hex: '4142' }]);
    expect(written.results[0]?.ok).toBe(true);
    const stepped = await api.act(sessionId, [{ type: 'step', count: 2 }]);
    expect(stepped.projection.steps).toBe(2);
    expect(registerOf(stepped.projection, 'RIP')).toBe('0x400002');
    expect(stackHex(stepped.projection).startsWith('4142')).toBe(true);
    expect(stepped.history).toEqual({ undo: 2, stepBack: 2 });

    const reset = await api.act(sessionId, [{ type: 'reset' }]);
    expect(reset.results[0]).toEqual({ ok: true, action: 'reset' });

    // 逐字段等于全新会话的初态（含非隐藏栈的 hex）。
    expectProjectionFieldsUnchanged(fresh.projection, reset.projection);
    expect(reset.projection.steps).toBe(0);
    expect(registerOf(reset.projection, 'RIP')).toBe(TEXT_ADDR);
    expect(stackHex(reset.projection).startsWith(INITIAL_STACK_HEAD)).toBe(true);
    // `reset` 不是失败，不计 `failures`（09 §8 第 1 条）。
    expect(reset.projection.failures).toBe(0);
    // `reset` 压栈：它的入口是「reset 之前那一刻」，且指令层缓冲已作废。
    expect(reset.history).toEqual({ undo: 3, stepBack: 0 });
  });

  it('reset 可被 undo：撤销 reset 后回到 reset 之前的状态（逐字段）', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;

    await api.act(sessionId, [{ type: 'step', count: 3 }]);
    const beforeReset = await api.getState(sessionId);
    expect(beforeReset.projection.steps).toBe(3);

    const reset = await api.act(sessionId, [{ type: 'reset' }]);
    expect(reset.projection.steps).toBe(0);

    const undone = await api.act(sessionId, [{ type: 'undo' }]);
    expect(undone.results[0]).toEqual({ ok: true, action: 'undo' });
    expectProjectionFieldsUnchanged(beforeReset.projection, undone.projection);
    expect(undone.projection.steps).toBe(3);
    expect(registerOf(undone.projection, 'RIP')).toBe('0x400003');
    expect(undone.projection.failures).toBe(0);
    // `undo` 自身不压栈：撤销的是 reset 那条，剩下的仍是「step 请求之前」那一层。
    expect(undone.history.undo).toBe(1);
  });

  it('undo 回退整批请求：一批两个动作，一次 undo 全部退回（04 §3 请求层）', async () => {
    const fresh = await api.create(LIFE_LAB);
    const sessionId = fresh.sessionId;

    const batch = await api.act(sessionId, [
      { type: 'write_bytes', addr: BUF_ADDR, hex: '4142' },
      { type: 'step', count: 1 },
    ]);
    expect(batch.executed).toBe(2);
    expect(batch.projection.steps).toBe(1);
    expect(registerOf(batch.projection, 'RIP')).toBe('0x400001');
    expect(stackHex(batch.projection).startsWith('4142')).toBe(true);
    expect(batch.history).toEqual({ undo: 1, stepBack: 1 });

    const undone = await api.act(sessionId, [{ type: 'undo' }]);
    expect(undone.results[0]?.ok).toBe(true);
    // 整批一次退回：写字节、单步、RIP 全部回到请求前。
    expectProjectionFieldsUnchanged(fresh.projection, undone.projection);
    expect(undone.projection.steps).toBe(0);
    expect(stackHex(undone.projection).startsWith(INITIAL_STACK_HEAD)).toBe(true);
    expect(undone.history).toEqual({ undo: 0, stepBack: 0 });
  });

  it('step_back 逐条回退指令：窗口内可连续后退（04 §3 指令层）', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;

    const stepped = await api.act(sessionId, [{ type: 'step', count: 3 }]);
    expect(stepped.projection.steps).toBe(3);
    expect(registerOf(stepped.projection, 'RIP')).toBe('0x400003');
    expect(stepped.history).toEqual({ undo: 1, stepBack: 3 });

    const oneBack = await api.act(sessionId, [{ type: 'step_back' }]);
    expect(oneBack.results[0]).toEqual({ ok: true, action: 'step_back' });
    expect(oneBack.projection.steps).toBe(2);
    expect(registerOf(oneBack.projection, 'RIP')).toBe('0x400002');
    expect(oneBack.history).toEqual({ undo: 1, stepBack: 2 });

    const allBack = await api.act(sessionId, [{ type: 'step_back' }, { type: 'step_back' }]);
    expect(allBack.executed).toBe(2);
    expect(allBack.projection.steps).toBe(0);
    expect(registerOf(allBack.projection, 'RIP')).toBe(TEXT_ADDR);
    expect(allBack.history).toEqual({ undo: 1, stepBack: 0 });

    // 退到窗口为空之后再退就是 `empty_history`，不静默成功（04 §3）。
    const empty = await api.act(sessionId, [{ type: 'step_back' }]);
    expect(empty.executed).toBe(0);
    expect(empty.results[0]?.error?.code).toBe('empty_history');
  });

  it('跨请求 step_back：上一条请求里执行的指令仍可逐条回退（真实使用路径）', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;

    const first = await api.act(sessionId, [{ type: 'step' }, { type: 'step' }]);
    expect(first.projection.steps).toBe(2);
    expect(first.history).toEqual({ undo: 1, stepBack: 2 });

    const second = await api.act(sessionId, [{ type: 'step_back' }]);
    expect(second.results[0]?.ok).toBe(true);
    expect(second.projection.steps).toBe(1);
    expect(registerOf(second.projection, 'RIP')).toBe('0x400001');
    expect(second.history).toEqual({ undo: 1, stepBack: 1 });
  });

  it('回退类动作自身不压栈：undo / step_back 都不增加回退深度（04 §3）', async () => {
    // step_back 不压栈。
    const byStepBack = (await api.create(LIFE_LAB)).sessionId;
    await api.act(byStepBack, [{ type: 'step', count: 2 }]);
    const back = await api.act(byStepBack, [{ type: 'step_back' }]);
    expect(back.history.undo).toBe(1);
    expect(back.history.stepBack).toBe(1);

    // undo 不压栈：连续两次 undo 各退一层（否则第二次会退到「上一次 undo」）。
    const byUndo = (await api.create(LIFE_LAB)).sessionId;
    const first = await api.act(byUndo, [{ type: 'step', count: 1 }]);
    expect(first.history.undo).toBe(1);
    const second = await api.act(byUndo, [{ type: 'step', count: 1 }]);
    expect(second.history.undo).toBe(2);
    expect(second.projection.steps).toBe(2);

    const undoOnce = await api.act(byUndo, [{ type: 'undo' }]);
    expect(undoOnce.projection.steps).toBe(1);
    expect(undoOnce.history.undo).toBe(1);
    const undoTwice = await api.act(byUndo, [{ type: 'undo' }]);
    expect(undoTwice.projection.steps).toBe(0);
    expect(undoTwice.history.undo).toBe(0);
    // 历史清空后仍可回退失败，且失败本身不改状态（04 §3）。
    const undoEmpty = await api.act(byUndo, [{ type: 'undo' }]);
    expect(undoEmpty.results[0]?.error?.code).toBe('empty_history');
    expect(undoEmpty.projection.steps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 三、四种 verdict 的终态（04 §5.1）
// ---------------------------------------------------------------------------

describe('API 生命周期 · 四种 verdict 的终态（04 §5.1）', () => {
  it('won：下发 flag，末帧 status=satisfied 且 lastStop.reason=exit，调试实例逐字段不变', async () => {
    const sessionId = (await api.create(WIN_LAB)).sessionId;
    const before = await api.getState(sessionId);

    const body = await api.submit(sessionId, [{ type: 'step' }]);
    expect(body.verdict).toBe('won');
    expect(body.flag).toBe(TEST_FLAG_SENTINEL);
    expect(body.executed).toBe(1);
    expect(body.results).toEqual([{ ok: true, action: 'step' }]);
    expect(body.replay.initial.status).toBe('ready');

    const last = lastActionFrame(body);
    expect(last?.kind).toBe('action');
    expect(last?.label).toBe('step');
    // `win` 同时置 FLAG 并退出：`status` 是 `satisfied`，但「已退出」由 lastStop 表达（09 §8 第 9 条）。
    expect(last?.status).toBe('satisfied');
    expect(last?.lastStop?.reason).toBe('exit');

    // 04 §1 / §5.1：提交是纯回放，不修改调试实例（含 failures 与历史）。
    const after = await api.getState(sessionId);
    expectProjectionFieldsUnchanged(before.projection, after.projection);
    expect(after.projection.status).toBe('ready');
    expect(after.projection.failures).toBe(0);
    expect(after.history).toEqual(before.history);
  });

  it('failed（命中 fail 谓词）：不下发 flag，末帧 reason=exception 且不带 error（判负不是异常）', async () => {
    const sessionId = (await api.create(FAIL_LAB)).sessionId;
    const before = await api.getState(sessionId);

    const body = await api.submit(sessionId, [{ type: 'step' }]);
    expect(body.verdict).toBe('failed');
    expect(body.flag).toBeUndefined();
    expect(body.executed).toBe(1);
    expect(body.results).toEqual([{ ok: true, action: 'step' }]);

    const last = lastActionFrame(body);
    expect(last?.status).toBe('failed');
    expect(last?.lastStop?.reason).toBe('exception');
    // 09 §7 第 3 条：命中 fail 是判负，不是运行期异常，所以没有 `error`。
    expect(last?.error).toBeUndefined();

    expectProjectionFieldsUnchanged(before.projection, (await api.getState(sessionId)).projection);
  });

  it('failed（运行期异常）：invalid_ip 判负、无 flag，末帧带 error', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;

    // `ret` 动作把栈顶的 `aa`×8 吃成 ip（0xaaaa…），下一步取指即 invalid_ip。
    const body = await api.submit(sessionId, [{ type: 'ret' }, { type: 'step' }]);
    expect(body.verdict).toBe('failed');
    expect(body.flag).toBeUndefined();
    expect(body.executed).toBe(2);
    expect(body.results[0]).toEqual({ ok: true, action: 'ret' });
    expect(body.results[1]?.ok).toBe(true);
    expect(body.results[1]?.error?.code).toBe('invalid_ip');

    const last = lastActionFrame(body);
    expect(last?.label).toBe('step');
    expect(last?.status).toBe('failed');
    expect(last?.lastStop?.reason).toBe('exception');
    expect(last?.error?.code).toBe('invalid_ip');
  });

  it('rejected：判题实例没有回退、未知积木被拒；被拒动作占一帧且后续动作不执行', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;
    const before = await api.getState(sessionId);

    // 04 §3：判题实例没有回退，payload 里出现回退类动作即 `rejected`。
    const withControl = await api.submit(sessionId, [{ type: 'undo' }, { type: 'step' }]);
    expect(withControl.verdict).toBe('rejected');
    expect(withControl.flag).toBeUndefined();
    expect(withControl.executed).toBe(0);
    expect(withControl.results).toHaveLength(1);
    expect(withControl.results[0]?.error?.code).toBe('action_not_allowed');
    expect(lastActionFrame(withControl)?.error?.code).toBe('action_not_allowed');

    // 未声明的积木 id 在判题实例里同样是 `rejected`，且后续动作不执行。
    const unknownBlock = await api.submit(sessionId, [
      { type: 'block', id: 'nope', args: {} },
      { type: 'step' },
    ]);
    expect(unknownBlock.verdict).toBe('rejected');
    expect(unknownBlock.executed).toBe(0);
    expect(unknownBlock.results).toHaveLength(1);
    expect(unknownBlock.results[0]?.action).toBe('block');
    expect(unknownBlock.results[0]?.error?.code).toBe('unknown_action');
    expect(unknownBlock.replay.frames).toHaveLength(1);

    // 两次被拒的提交都不动调试实例（含 failures —— 判题实例的失败不记在调试实例上）。
    const after = await api.getState(sessionId);
    expectProjectionFieldsUnchanged(before.projection, after.projection);
    expect(after.projection.failures).toBe(before.projection.failures);
    expect(after.history).toEqual(before.history);
  });

  it('incomplete：回放跑完未满足成功条件，诊断出「payload 不够」且不影响调试实例', async () => {
    const sessionId = (await api.create(LIFE_LAB)).sessionId;
    const before = await api.getState(sessionId);

    const body = await api.submit(sessionId, [{ type: 'step' }]);
    expect(body.verdict).toBe('incomplete');
    expect(body.flag).toBeUndefined();
    expect(body.executed).toBe(1);
    expect(lastActionFrame(body)?.status).toBe('ready');

    const after = await api.getState(sessionId);
    expectProjectionFieldsUnchanged(before.projection, after.projection);
    expect(after.projection.steps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 四、exited 与 failed 的边界（04 §1.1、09 §7 第 5 条、§8 第 9/10 条）
// ---------------------------------------------------------------------------

describe('API 生命周期 · exited / failed 边界（04 §1.1、09 §8 第 9/10 条）', () => {
  it('satisfied + exit：status=satisfied 但 lastStop.reason=exit —— 执行类动作被拒且状态逐字段不变', async () => {
    const sessionId = (await api.create(WIN_LAB)).sessionId;

    const exited = await api.act(sessionId, [{ type: 'step' }]);
    expect(exited.results[0]).toEqual({ ok: true, action: 'step' });
    // 只满足成功条件不算通过（调试实例不发 flag），但退出这件事必须被表达出来。
    expect(exited.projection.status).toBe('satisfied');
    expect(exited.projection.lastStop).toEqual({ reason: 'exit', addr: TEXT_ADDR });
    expect(registerOf(exited.projection, 'FLAG')).toBe('0x1');
    expect(exited.projection.steps).toBe(1);

    const before = exited.projection;
    const executions: readonly { readonly why: string; readonly action: Record<string, unknown> }[] = [
      { why: 'step', action: { type: 'step' } },
      { why: 'run', action: { type: 'run' } },
      { why: 'write_bytes', action: { type: 'write_bytes', addr: BUF_ADDR, hex: '41' } },
    ];

    let expectedFailures = 0;
    for (const item of executions) {
      const outcome = await api.act(sessionId, [item.action]);
      expect(outcome.executed, item.why).toBe(0);
      expect(outcome.results[0]?.ok, item.why).toBe(false);
      expect(outcome.results[0]?.error?.code, item.why).toBe('not_executable');

      const after = await api.getState(sessionId);
      // 关键回归：判据必须是 isExited()。只看 `status` 的话 `satisfied` 不是终态，动作会照跑。
      expectProjectionFieldsUnchanged(before, after.projection);
      expect(after.projection.status, item.why).toBe('satisfied');
      expect(after.projection.lastStop?.reason, item.why).toBe('exit');
      // 09 §8 第 10 条：退出后单发执行类动作仍计一次 failures（不为 not_executable 开免计特例）。
      expectedFailures += 1;
      expect(after.projection.failures, item.why).toBe(expectedFailures);
      expect(after.history, item.why).toEqual(exited.history);
    }
  });

  it('satisfied + exit 的回退出口：undo / step_back / reset 都能把实例退回 ready 并恢复可执行', async () => {
    // undo 出口。
    const byUndo = (await api.create(WIN_LAB)).sessionId;
    await api.act(byUndo, [{ type: 'step' }]);
    const undone = await api.act(byUndo, [{ type: 'undo' }]);
    expect(undone.results[0]).toEqual({ ok: true, action: 'undo' });
    expect(undone.projection.status).toBe('ready');
    expect(undone.projection.steps).toBe(0);
    expect(registerOf(undone.projection, 'FLAG')).toBe('0x0');
    expect(undone.projection.lastStop).toBeUndefined();
    // 恢复之后执行类动作重新可用（回退不是死路）。
    const again = await api.act(byUndo, [{ type: 'step' }]);
    expect(again.results[0]?.ok).toBe(true);
    expect(again.projection.status).toBe('satisfied');

    // step_back 出口。
    const byStepBack = (await api.create(WIN_LAB)).sessionId;
    await api.act(byStepBack, [{ type: 'step' }]);
    const back = await api.act(byStepBack, [{ type: 'step_back' }]);
    expect(back.results[0]).toEqual({ ok: true, action: 'step_back' });
    expect(back.projection.status).toBe('ready');
    expect(back.projection.steps).toBe(0);
    expect(registerOf(back.projection, 'FLAG')).toBe('0x0');

    // reset 出口。
    const byReset = (await api.create(WIN_LAB)).sessionId;
    await api.act(byReset, [{ type: 'step' }]);
    const reset = await api.act(byReset, [{ type: 'reset' }]);
    expect(reset.results[0]).toEqual({ ok: true, action: 'reset' });
    expect(reset.projection.status).toBe('ready');
    expect(reset.projection.steps).toBe(0);
    expect(registerOf(reset.projection, 'FLAG')).toBe('0x0');
  });

  it('satisfied 但未退出（反面对照）：执行类动作照常可用，状态保持 satisfied（04 §1.1）', async () => {
    const sessionId = (await api.create(MARK_LAB)).sessionId;

    const marked = await api.act(sessionId, [{ type: 'step' }]);
    expect(marked.projection.status).toBe('satisfied');
    expect(registerOf(marked.projection, 'FLAG')).toBe('0x1');
    // 没退出：投影里没有「已退出」的证据。
    expect(marked.projection.lastStop?.reason).not.toBe('exit');
    expect(marked.projection.lastStop).toBeUndefined();

    // `satisfied` 本身不限制动作：第二条指令照跑，仍然 satisfied，且不计 failures。
    const again = await api.act(sessionId, [{ type: 'step' }]);
    expect(again.executed).toBe(1);
    expect(again.results[0]?.ok).toBe(true);
    expect(again.projection.status).toBe('satisfied');
    expect(again.projection.steps).toBe(2);
    expect(registerOf(again.projection, 'RIP')).toBe('0x400002');
    expect(again.projection.failures).toBe(0);
  });

  it('failed 是终止态：执行类动作被拒，reset / undo 可用且恢复出 failed 不重复计 failures', async () => {
    const sessionId = (await api.create(FAIL_LAB)).sessionId;

    const failed = await api.act(sessionId, [{ type: 'step' }]);
    expect(failed.projection.status).toBe('failed');
    expect(failed.projection.lastStop?.reason).toBe('exception');
    // 把实例推进 `failed` 的执行类动作计一次（09 §8 第 1 条）。
    expect(failed.projection.failures).toBe(1);

    const blocked = await api.act(sessionId, [{ type: 'step' }]);
    expect(blocked.executed).toBe(0);
    expect(blocked.results[0]?.error?.code).toBe('not_executable');
    expect(blocked.projection.failures).toBe(2);
    expect(blocked.projection.status).toBe('failed');

    // reset：回到 ready，失败计数只增不减。
    const reset = await api.act(sessionId, [{ type: 'reset' }]);
    expect(reset.results[0]).toEqual({ ok: true, action: 'reset' });
    expect(reset.projection.status).toBe('ready');
    expect(reset.projection.failures).toBe(2);

    // undo：把 `failed` 搬回来也不重复计（回退类动作自身不计入）。
    const undone = await api.act(sessionId, [{ type: 'undo' }]);
    expect(undone.results[0]?.ok).toBe(true);
    expect(undone.projection.status).toBe('failed');
    expect(undone.projection.failures).toBe(2);
    expect(undone.projection.lastStop?.reason).toBe('exception');
  });
});
