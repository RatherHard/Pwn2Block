import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionsResponseSchema,
  ApiErrorSchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  ret2winPublic,
} from '@pwn2block/shared';
import type { EngineRuntime, HistoryDepth, Projection } from '@pwn2block/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import {
  TEST_ENV,
  expectApiError,
  makeChallengeDir,
  makeFakeRuntime,
  testPrivate,
  testPublic,
  writeChallenge,
} from './support';

/**
 * 按 IP 限流与存活会话上限（04 §6「必须的防护」，D4/D6 的 P0 缺口）。
 *
 * 口径：
 * - 时间一律注入假时钟（`rateLimit.now` / `sessions.now`），窗口推进靠 `clock.advance`，
 *   **不用 `setTimeout` 等真实时间**。每次 `buildApp()` 一份限流器，测试之间互不影响。
 * - 429 的响应体只有 `{code, message}`：不含堆栈、文件路径、私有包字段（04 §6）。
 * - 限流拒绝发生在路由处理之前，所以「不修改会话状态」是可以逐字段断言的。
 */

const CHALLENGE_ID = ret2winPublic.id;
const IP_A = '10.0.0.1';
const IP_B = '10.0.0.2';
const IP_C = '10.0.0.3';

type Method = 'GET' | 'POST' | 'DELETE';

interface Clock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

function makeClock(start = 1_000_000): Clock {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

let challengeDir = '';

beforeAll(() => {
  challengeDir = makeChallengeDir();
  writeChallenge(challengeDir, CHALLENGE_ID, testPublic(), testPrivate());
});

afterAll(() => {
  rmSync(challengeDir, { recursive: true, force: true });
});

function optionsWith(overrides: Partial<BuildAppOptions> = {}): BuildAppOptions {
  return { challengeDir, env: TEST_ENV, ...overrides };
}

async function withApp(
  options: BuildAppOptions,
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = buildApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

/** 每个请求都显式给出源 IP：`app.inject({ remoteAddress })`（04 §6 按 IP 限流）。 */
function inject(
  app: FastifyInstance,
  ip: string,
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createSessionFrom(
  app: FastifyInstance,
  ip: string,
  challengeId = CHALLENGE_ID,
): Promise<LightMyRequestResponse> {
  return inject(app, ip, 'POST', '/api/sessions', { challengeId });
}

async function createSessionOk(app: FastifyInstance, ip: string): Promise<string> {
  const response = await createSessionFrom(app, ip);
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

/** 读调试实例的投影与回退深度，用于「被限流的请求不修改状态」的前后比对。 */
async function stateOf(
  app: FastifyInstance,
  ip: string,
  sessionId: string,
): Promise<{ readonly projection: Projection; readonly history: HistoryDepth }> {
  const response = await inject(app, ip, 'GET', `/api/sessions/${sessionId}`);
  expect(response.statusCode).toBe(200);
  const parsed = SessionStateResponseSchema.parse(response.json());
  return { projection: parsed.projection, history: parsed.history };
}

/** 429 + `rate_limited` + 响应体形状 + 无内部信息（04 §6）。 */
function expectRateLimited(response: LightMyRequestResponse): void {
  expectApiError(response, 'rate_limited');
  const parsed = ApiErrorSchema.parse(response.json());
  expect(Object.keys(parsed).sort()).toEqual(['code', 'message']);
  expect(parsed.message.length).toBeGreaterThan(0);
  for (const needle of ['node_modules', 'F:\\', 'dist', 'ZodError', 'stack']) {
    expect(response.body).not.toContain(needle);
  }
}

/**
 * 时间窗口型 429 额外带 `Retry-After`（可选做的响应头）：滑动窗口下它就是
 * 「最早一次命中过期」的秒数。会话容量型 429 **不带**：那时能不能建取决于调用方
 * 自己 DELETE 或空闲回收，不是一个确定的时间点（报告里说明）。
 */
function expectWindowRateLimited(response: LightMyRequestResponse): void {
  expectRateLimited(response);
  expect(String(response.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);
}

describe('每 IP 请求限流（04 §6）', () => {
  it('同一 IP 超限 → 429 rate_limited；不同 IP 不受影响；窗口推进后恢复', async () => {
    const clock = makeClock();
    const options = optionsWith({
      rateLimit: { request: { limit: 3, windowMs: 1000 }, now: clock.now },
    });

    await withApp(options, async (app) => {
      for (let i = 0; i < 3; i += 1) {
        expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
      }
      expectWindowRateLimited(await inject(app, IP_A, 'GET', '/api/challenges'));

      // 另一个 IP 有自己的窗口：同一时刻照常服务。
      expect((await inject(app, IP_B, 'GET', '/api/challenges')).statusCode).toBe(200);

      // 窗口是滑动的：离最早一次命中还差 1ms 时仍然拒绝，越过窗口立刻恢复。
      clock.advance(999);
      expectWindowRateLimited(await inject(app, IP_A, 'GET', '/api/challenges'));
      clock.advance(1);
      expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
    });
  });

  it('限流器是每次 buildApp() 一份，不是全局单例：新 app 从零开始计数', async () => {
    const options = optionsWith({ rateLimit: { request: { limit: 1, windowMs: 60_000 } } });

    await withApp(options, async (app) => {
      expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
      expectWindowRateLimited(await inject(app, IP_A, 'GET', '/api/challenges'));
    });
    // 同一个 IP、同一份配置：换一个 app 就重新计数（否则测试之间会互相污染）。
    await withApp(options, async (app) => {
      expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
    });
  });

  it('/api/health 不占普通请求的配额（部署探针不该被限流打假故障）', async () => {
    const options = optionsWith({ rateLimit: { request: { limit: 1, windowMs: 60_000 } } });

    await withApp(options, async (app) => {
      for (let i = 0; i < 5; i += 1) {
        expect((await inject(app, IP_A, 'GET', '/api/health')).statusCode).toBe(200);
      }
      expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
      expectWindowRateLimited(await inject(app, IP_A, 'GET', '/api/challenges'));
    });
  });

  it('被限流的请求不修改会话状态（投影逐字段 / failures / history）', async () => {
    const clock = makeClock();
    const fake = makeFakeRuntime();
    const options = optionsWith({
      createRuntime: () => fake.runtime,
      rateLimit: { request: { limit: 2, windowMs: 1000 }, now: clock.now },
    });

    await withApp(options, async (app) => {
      // 请求 1：建会话；请求 2：做一次动作，让状态离开初态。
      const sessionId = await createSessionOk(app, IP_A);
      const stepped = await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, {
        actions: [{ type: 'step' }],
      });
      const baseline = ActionsResponseSchema.parse(stepped.json());
      expect(baseline.projection.steps).toBe(1);

      // 请求 3：配额已用尽，这一批动作被限流，一个动作都不该进引擎。
      expectWindowRateLimited(
        await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, {
          actions: [{ type: 'step' }],
        }),
      );
      expect(fake.calls).toEqual(['step']);

      // 窗口推进后读回状态：逐字段与基线一致，`failures` 单独也一致（没进引擎就不该 +1）。
      clock.advance(1000);
      const after = await stateOf(app, IP_A, sessionId);
      expect(after.projection).toEqual(baseline.projection);
      expect(after.projection.failures).toBe(baseline.projection.failures);
      expect(after.history).toEqual(baseline.history);
    });
  });
});

describe('存活会话数上限（04 §6）', () => {
  it('每 IP 上限：超限的创建不装配引擎、不分配会话；DELETE 后配额真的释放', async () => {
    const fake = makeFakeRuntime();
    let assembles = 0;
    const createRuntime = (): EngineRuntime => {
      assembles += 1;
      return fake.runtime;
    };
    const options = optionsWith({
      createRuntime,
      rateLimit: { sessions: { perIp: 2, global: 10 } },
    });

    await withApp(options, async (app) => {
      const first = await createSessionOk(app, IP_A);
      await createSessionOk(app, IP_A);
      expect(assembles).toBe(2);

      const rejected = await createSessionFrom(app, IP_A);
      expectRateLimited(rejected);
      // 超限时**没有**分配会话（响应里不该有 sessionId），也**没有**装配引擎。
      expect(rejected.json()).not.toHaveProperty('sessionId');
      expect(assembles).toBe(2);
      // 会话容量型 429 不带 `Retry-After`：能不能再建取决于调用方自己 DELETE 或空闲回收，
      // 不是一个确定的时间点（时间窗口型 429 才带，见 `expectWindowRateLimited`）。
      expect(rejected.headers['retry-after']).toBeUndefined();

      // 每 IP：另一个来源照常建。
      await createSessionOk(app, IP_B);

      // 主动 DELETE：配额立刻还回来（计数派生自存活会话表，不会泄漏）。
      expect((await inject(app, IP_A, 'DELETE', `/api/sessions/${first}`)).statusCode).toBe(200);
      await createSessionOk(app, IP_A);
      expect(assembles).toBe(4);
    });
  });

  it('全局上限：跨 IP 也会被挡住；DELETE 后释放', async () => {
    const options = optionsWith({ rateLimit: { sessions: { perIp: 10, global: 2 } } });

    await withApp(options, async (app) => {
      const first = await createSessionOk(app, IP_A);
      await createSessionOk(app, IP_B);

      // 第三个来源：自己的每 IP 配额还空着，但全局满了。
      expectRateLimited(await createSessionFrom(app, IP_C));
      // 全局满了就是满了，已有会话的来源也建不出新会话。
      expectRateLimited(await createSessionFrom(app, IP_A));

      expect((await inject(app, IP_B, 'DELETE', `/api/sessions/${first}`)).statusCode).toBe(200);
      await createSessionOk(app, IP_C);
    });
  });

  it('空闲回收释放配额：假时钟推进后不需要 DELETE 就能再建', async () => {
    const clock = makeClock();
    const options = optionsWith({
      sessions: { now: clock.now, idleMs: 1000 },
      rateLimit: { sessions: { perIp: 1, global: 1 }, now: clock.now },
    });

    await withApp(options, async (app) => {
      const idle = await createSessionOk(app, IP_A);
      expectRateLimited(await createSessionFrom(app, IP_A));

      clock.advance(1000);
      // 容量判定前先按空闲时间回收一轮，所以这里不需要 DELETE。
      const fresh = await createSessionOk(app, IP_A);
      expect(fresh).not.toBe(idle);
      // 旧会话确实被回收了（404 session_expired），不是「计数被绕过」。
      expectApiError(await inject(app, IP_A, 'GET', `/api/sessions/${idle}`), 'session_expired');
    });
  });
});

describe('提交接口的独立桶（04 §6）', () => {
  it('提交打到超限时普通请求照常；普通请求超限时提交照常', async () => {
    const submitTight = optionsWith({
      rateLimit: {
        request: { limit: 100, windowMs: 60_000 },
        submit: { limit: 1, windowMs: 60_000 },
      },
    });
    await withApp(submitTight, async (app) => {
      const sessionId = await createSessionOk(app, IP_A);
      const payload = { actions: [{ type: 'step' }] };

      expect(
        (await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, payload)).statusCode,
      ).toBe(200);
      expectWindowRateLimited(
        await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, payload),
      );
      // 提交桶满了，普通请求不受牵连（两者配额不共用）。
      expect(
        (await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, payload)).statusCode,
      ).toBe(200);
      expect((await inject(app, IP_A, 'GET', `/api/sessions/${sessionId}`)).statusCode).toBe(200);
      // 另一个 IP 有自己的提交桶。
      expect(
        (await inject(app, IP_B, 'POST', `/api/sessions/${sessionId}/submit`, payload)).statusCode,
      ).toBe(200);
    });

    const requestTight = optionsWith({
      rateLimit: {
        request: { limit: 2, windowMs: 60_000 },
        submit: { limit: 100, windowMs: 60_000 },
      },
    });
    await withApp(requestTight, async (app) => {
      const sessionId = await createSessionOk(app, IP_A); // 普通请求 1
      expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200); // 普通请求 2
      expectWindowRateLimited(await inject(app, IP_A, 'GET', '/api/challenges')); // 普通请求超限
      // 普通请求超限，提交照常。
      expect(
        (
          await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, {
            actions: [{ type: 'step' }],
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  it('被限流的提交不修改任何状态，也不进引擎（replaySubmit 计数不变）', async () => {
    const fake = makeFakeRuntime();
    let replays = 0;
    const runtime: EngineRuntime = {
      ...fake.runtime,
      replaySubmit: (actions) => {
        replays += 1;
        return fake.runtime.replaySubmit(actions);
      },
    };
    const options = optionsWith({
      createRuntime: () => runtime,
      rateLimit: { submit: { limit: 1, windowMs: 60_000 } },
    });

    await withApp(options, async (app) => {
      const sessionId = await createSessionOk(app, IP_A);
      await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, {
        actions: [{ type: 'step' }],
      });
      const before = await stateOf(app, IP_A, sessionId);

      const payload = { actions: [{ type: 'step' }] };
      expect(
        (await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, payload)).statusCode,
      ).toBe(200);
      expect(replays).toBe(1);

      expectWindowRateLimited(
        await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, payload),
      );
      expect(replays).toBe(1);

      const after = await stateOf(app, IP_A, sessionId);
      expect(after.projection).toEqual(before.projection);
      expect(after.projection.failures).toBe(before.projection.failures);
      expect(after.history).toEqual(before.history);

      // 会话仍然可用：被限流不是会话失效。
      expect(
        (await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, payload)).statusCode,
      ).toBe(200);
    });
  });
});

describe('默认配置（04 §6 要求缺省就是开着的）', () => {
  it('默认值足够宽松：一次典型的浏览 + 多次提交不被限流', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessions: string[] = [];
      for (let i = 0; i < 3; i += 1) sessions.push(await createSessionOk(app, IP_A));

      for (const sessionId of sessions) {
        for (let i = 0; i < 10; i += 1) {
          expect((await inject(app, IP_A, 'GET', `/api/sessions/${sessionId}`)).statusCode).toBe(200);
        }
        expect(
          (
            await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/submit`, {
              actions: [{ type: 'step' }],
            })
          ).statusCode,
        ).toBe(200);
      }
    });
  });
});
