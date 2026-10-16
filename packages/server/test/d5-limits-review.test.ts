import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ACTIONS_PER_REQUEST,
  MAX_SUBMIT_ACTIONS,
  SESSION_IDLE_MS,
  SubmitResponseSchema,
  ret2winPublic,
} from '@pwn2block/shared';
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
 * D5 交付物 2 · 请求与资源限制的**逐条复核**（04 §6）。
 *
 * 只补 `rate-limit.test.ts` / `c03-limits-errors.test.ts` / `c04-static.test.ts` 里
 * **没有真实断言**的那几条，不重复已有用例（复核表见报告）：
 * 1. `Retry-After` 是**向上取整的秒数**（已有断言只校验「是正整数」）。
 * 2. 会话容量型 429 **不带** `Retry-After`（已有断言只覆盖每 IP 分支；这里补全局分支，
 *    并在同一个 app 里放时间窗口型的正对照）。
 * 3. 存活会话**按存活计**：一个「建完就没再碰过」的空闲会话照样占配额；空闲满
 *    `SESSION_IDLE_MS`（30 分钟，**用真实常量、不注入 idleMs**）后由惰性回收释放。
 * 4. `/actions` 的 512 与 `/submit` 的 4096 **故意不一致**：同一份 513 动作的请求体，
 *    `/actions` 拒、`/submit` 收。
 * 5. 「换题 / 重新开始先释放旧会话」（04 §1/§6）在服务端侧的语义：客户端先 `DELETE`
 *    再建，配额不泄漏（同一 IP 在 `perIp = 1` 下反复换题仍能建）。
 *
 * 全部是真实 `inject`；时间一律注入假时钟，不用 `setTimeout` 等真实时间。
 */

const CHALLENGE_ID = ret2winPublic.id;
const OTHER_ID = 'other-lab';
const IP_A = '10.0.0.1';
const IP_B = '10.0.0.2';

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
  writeChallenge(
    challengeDir,
    OTHER_ID,
    testPublic({ id: OTHER_ID }),
    testPrivate({ flag: 'env:FLAG_OTHER_LAB' }),
  );
});

afterAll(() => {
  rmSync(challengeDir, { recursive: true, force: true });
});

const env = { ...TEST_ENV, FLAG_OTHER_LAB: 'flag{other-lab-sentinel}' };

function optionsWith(overrides: Partial<BuildAppOptions> = {}): BuildAppOptions {
  return { challengeDir, env, ...overrides };
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

async function createSessionOk(
  app: FastifyInstance,
  ip: string,
  challengeId = CHALLENGE_ID,
): Promise<string> {
  const response = await inject(app, ip, 'POST', '/api/sessions', { challengeId });
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessionId: string }).sessionId;
}

function stepActions(count: number): readonly { readonly type: 'step' }[] {
  return Array.from({ length: count }, () => ({ type: 'step' }) as const);
}

describe('D5 复核 · 限流：Retry-After 的口径（04 §6）', () => {
  it('时间窗口型 429 的 Retry-After 是**向上取整的秒数**，窗口一过立刻恢复', async () => {
    const clock = makeClock();
    await withApp(
      optionsWith({ rateLimit: { request: { limit: 2, windowMs: 3000 }, now: clock.now } }),
      async (app) => {
        for (let i = 0; i < 2; i += 1) {
          expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
        }

        const blocked = await inject(app, IP_A, 'GET', '/api/challenges');
        expectApiError(blocked, 'rate_limited');
        // 最早一次命中还差整 3000ms 过期：3000ms → 3 秒，不是「正整数字符串」而已。
        expect(blocked.headers['retry-after']).toBe('3');

        clock.advance(1000);
        const later = await inject(app, IP_A, 'GET', '/api/challenges');
        expectApiError(later, 'rate_limited');
        expect(later.headers['retry-after']).toBe('2');

        clock.advance(1999);
        const almost = await inject(app, IP_A, 'GET', '/api/challenges');
        expectApiError(almost, 'rate_limited');
        // 只剩 1ms 也报 1 秒：不允许出现 `Retry-After: 0`（那等于叫客户端立刻重试）。
        expect(almost.headers['retry-after']).toBe('1');

        clock.advance(1);
        expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);
      },
    );
  });

  it('会话容量型 429 一律不带 Retry-After（每 IP 与全局两个分支），时间窗口型作为正对照', async () => {
    await withApp(
      optionsWith({
        // 普通请求留出 3 次配额：第 2 次用来验证「会话容量型不带 Retry-After」，
        // 第 4 次用来验证「时间窗口型带 Retry-After」（同一条 `onRequest` 钩子的两种来源）。
        rateLimit: {
          request: { limit: 3, windowMs: 60_000 },
          sessions: { perIp: 1, global: 8 },
        },
      }),
      async (app) => {
        await createSessionOk(app, IP_A);

        const perIp = await inject(app, IP_A, 'POST', '/api/sessions', { challengeId: CHALLENGE_ID });
        expectApiError(perIp, 'rate_limited');
        // 何时能再建取决于调用方何时 DELETE（或空闲回收），不是确定时间点 → 不给 Retry-After。
        expect(perIp.headers['retry-after']).toBeUndefined();
        expect((await inject(app, IP_A, 'GET', '/api/challenges')).statusCode).toBe(200);

        // 正对照：同一个 app 里时间窗口型 429 **带** Retry-After，证明上面的 undefined 不是「这个 app 不给头」。
        const windowed = await inject(app, IP_A, 'GET', '/api/challenges');
        expectApiError(windowed, 'rate_limited');
        expect(String(windowed.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);
      },
    );

    await withApp(
      optionsWith({ rateLimit: { sessions: { perIp: 8, global: 1 } } }),
      async (app) => {
        await createSessionOk(app, IP_A);
        // 另一个来源：自己的每 IP 配额还空着，但全局满了。
        const global = await inject(app, IP_B, 'POST', '/api/sessions', { challengeId: CHALLENGE_ID });
        expectApiError(global, 'rate_limited');
        expect(global.headers['retry-after']).toBeUndefined();
      },
    );
  });
});

describe('D5 复核 · 会话：按存活计 + 默认 30 分钟空闲回收（04 §1/§6）', () => {
  it('空闲但未回收的会话照样占配额；满 SESSION_IDLE_MS 后由惰性回收释放', async () => {
    const clock = makeClock();
    await withApp(
      optionsWith({
        // 刻意**不注入** idleMs：这里要验的就是默认的 30 分钟（SESSION_IDLE_MS）。
        sessions: { now: clock.now },
        rateLimit: { sessions: { perIp: 1, global: 8 }, now: clock.now },
      }),
      async (app) => {
        const first = await createSessionOk(app, IP_A);

        // 建完就没再碰过 → 它是「存活但空闲」的会话，仍然占位（04 §6 按**存活**计，不是按活跃计）。
        expectApiError(
          await inject(app, IP_A, 'POST', '/api/sessions', { challengeId: CHALLENGE_ID }),
          'rate_limited',
        );

        // 差 1ms 到 30 分钟：不该提前释放。
        clock.advance(SESSION_IDLE_MS - 1);
        expectApiError(
          await inject(app, IP_A, 'POST', '/api/sessions', { challengeId: CHALLENGE_ID }),
          'rate_limited',
        );

        // 满 30 分钟：容量判定前先惰性回收一轮，配额当场还回来，不需要 DELETE。
        clock.advance(1);
        const second = await createSessionOk(app, IP_A);
        expect(second).not.toBe(first);

        // 旧会话确实是被回收了（404 session_expired），不是「计数被绕过」。
        expectApiError(await inject(app, IP_A, 'GET', `/api/sessions/${first}`), 'session_expired');
        expect((await inject(app, IP_A, 'GET', `/api/sessions/${second}`)).statusCode).toBe(200);
      },
    );
  });

  it('换题 / 重新开始先 DELETE 旧会话：同一 IP 在 perIp = 1 下反复换题不泄漏配额', async () => {
    await withApp(
      optionsWith({ rateLimit: { sessions: { perIp: 1, global: 2 } } }),
      async (app) => {
        // 三轮「建 → 想换题 → DELETE → 再建」：任何一轮泄漏都会在第 3 轮变成 429。
        let previous = await createSessionOk(app, IP_A, CHALLENGE_ID);
        for (const next of [OTHER_ID, CHALLENGE_ID, OTHER_ID]) {
          // 不 DELETE 就换题：配额确实被上一份会话占着（这是客户端必须先 DELETE 的原因）。
          expectApiError(
            await inject(app, IP_A, 'POST', '/api/sessions', { challengeId: next }),
            'rate_limited',
          );

          expect((await inject(app, IP_A, 'DELETE', `/api/sessions/${previous}`)).statusCode).toBe(200);
          previous = await createSessionOk(app, IP_A, next);
        }

        // 最后再收一次尾：DELETE 后配额仍可用。
        expect((await inject(app, IP_A, 'DELETE', `/api/sessions/${previous}`)).statusCode).toBe(200);
        await createSessionOk(app, IP_A, CHALLENGE_ID);
      },
    );
  });
});

describe('D5 复核 · 请求体：两条动作数上限故意不一致（04 §5/§6）', () => {
  it('513 个动作：/actions 被 Schema 拒，/submit 照收（512 ≠ 4096 是有意的）', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSessionOk(app, IP_A);
      const over = stepActions(MAX_ACTIONS_PER_REQUEST + 1);
      expect(over).toHaveLength(513);

      const actionsResponse = await inject(
        app,
        IP_A,
        'POST',
        `/api/sessions/${sessionId}/actions`,
        { actions: over },
      );
      expectApiError(actionsResponse, 'invalid_request');

      // 同一份请求体走提交面却是合法请求：提交面要能放下整份编译产物（最多 4096 个动作）。
      const submitResponse = await inject(
        app,
        IP_A,
        'POST',
        `/api/sessions/${sessionId}/submit`,
        { actions: over },
      );
      expect(submitResponse.statusCode).toBe(200);
      expect(SubmitResponseSchema.parse(submitResponse.json()).executed).toBe(513);

      // 边界内（恰好 512）在动作面上仍然被接受——否则上面的拒绝只是「批量一律被拒」。
      const boundary = await inject(app, IP_A, 'POST', `/api/sessions/${sessionId}/actions`, {
        actions: stepActions(MAX_ACTIONS_PER_REQUEST),
      });
      expect(boundary.statusCode).toBe(200);
    });
  });

  it('上限常量来自 shared：512 / 4096，且动作面严格小于提交面', () => {
    expect(MAX_ACTIONS_PER_REQUEST).toBe(512);
    expect(MAX_SUBMIT_ACTIONS).toBe(4096);
    expect(MAX_ACTIONS_PER_REQUEST).toBeLessThan(MAX_SUBMIT_ACTIONS);
  });
});
