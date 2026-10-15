import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  describeError,
  ret2winPublic,
} from '@pwn2block/shared';
import type { Projection } from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
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
 * 请求边界（C02 · 08 §5 S03、01 §6 第 3 条）：
 *
 * - 请求体一律 `strictObject`：伪造快照、客户端提交的成功标记、未知动作、多余字段都必须被拒，
 *   而且**拒绝不改变状态**（回退动作按契约仍可用）。
 * - `allowedActions` 只有**一个判定点**，在引擎里（09 §3.3）：服务端不重复判定、不预展开积木。
 *   所以「不在允许集里的动作」照样原样进引擎；服务端自己判一遍就等于有了第二份实现。
 */

const CHALLENGE_ID = ret2winPublic.id;

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

async function createSession(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: CHALLENGE_ID },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

/** 读当前调试实例投影，用于「拒绝不改变状态」的前后比对。 */
async function currentProjection(app: FastifyInstance, sessionId: string): Promise<Projection> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  expect(response.statusCode).toBe(200);
  return SessionStateResponseSchema.parse(response.json()).projection;
}

describe('请求边界：伪造状态与成功标记一律被拒（S03）', () => {
  it('伪造快照 / 成功标记被 strictObject 拒绝，且调试实例逐字段不变', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      // 先做一个合法动作，让状态离开初态——否则「状态没变」是平凡成立。
      const stepped = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'step' }] },
      });
      expect(ActionsResponseSchema.parse(stepped.json()).projection.steps).toBe(1);
      const before = await currentProjection(app, sessionId);
      const url = `/api/sessions/${sessionId}/actions`;

      const forged: readonly Record<string, unknown>[] = [
        { actions: [{ type: 'step' }], projection: before },
        { actions: [{ type: 'step' }], snapshot: { registers: { RIP: '0x400000' } } },
        { actions: [{ type: 'step' }], registers: [{ name: 'RIP', value: '0x0' }] },
        { actions: [{ type: 'step' }], won: true },
        { actions: [{ type: 'step' }], win: true },
        { actions: [{ type: 'step' }], satisfied: true },
        { actions: [{ type: 'step' }], verdict: 'won' },
        { actions: [{ type: 'step' }], status: 'exited' },
        { actions: [{ type: 'step' }], flag: 'flag{客户端伪造}' },
      ];
      for (const payload of forged) {
        expectApiError(await app.inject({ method: 'POST', url, payload }), 'invalid_request');
      }

      // 一个被拒请求都不许落到引擎上：calls 里只有第一次那个合法的 step。
      expect(fake.calls).toEqual(['step']);
      expect(await currentProjection(app, sessionId)).toEqual(before);
    });
  });

  it('提交路径同样拒收伪造快照，且不影响调试实例', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const before = await currentProjection(app, sessionId);
      const url = `/api/sessions/${sessionId}/submit`;

      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [{ type: 'step' }], won: true } }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [{ type: 'step' }], snapshot: {} } }),
        'invalid_request',
      );

      expect(await currentProjection(app, sessionId)).toEqual(before);
    });
  });

  it('未知动作类型与空数组被 Schema 拒；已拒绝的请求不改变状态', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const before = await currentProjection(app, sessionId);
      const url = `/api/sessions/${sessionId}/actions`;

      for (const payload of [
        { actions: [{ type: 'win' }] },
        { actions: [{ type: 'nope' }] },
        { actions: [] },
        { actions: [{ type: 'step', count: 0 }] },
        { actions: [{ type: 'step' }], extra: 1 },
      ]) {
        expectApiError(await app.inject({ method: 'POST', url, payload }), 'invalid_request');
      }

      expect(fake.calls).toEqual([]);
      expect(await currentProjection(app, sessionId)).toEqual(before);
    });
  });
});

describe('唯一判定点：服务端不预筛 allowedActions、不预展开积木（09 §3.3）', () => {
  it('不在允许集里的动作照样原样交给引擎', async () => {
    // ret2win 的 allowedActions 只有 step / run / undo / reset；push 不在里面。
    // 真实引擎会在这里回 action_not_allowed（engine/src/actions.ts 的 screenAction 用 shared 的
    // isAllowedByChallenge）。服务端若自己再判一遍，就成了第二份实现。
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'push', value: '0x1' }] },
      });

      expect(response.statusCode).toBe(200);
      expect(ActionsResponseSchema.parse(response.json()).results).toEqual([
        { ok: true, action: 'push' },
      ]);
      expect(fake.calls).toEqual(['push']);
    });
  });

  it('block 原样转交，服务端不展开成原子动作', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'block', id: 'gets', args: { data: '4142' } }] },
      });

      expect(response.statusCode).toBe(200);
      expect(ActionsResponseSchema.parse(response.json()).results).toEqual([
        { ok: true, action: 'block' },
      ]);
      // 展开只发生在引擎里：服务端收到的调用序列就是客户端提交的动作类型。
      expect(fake.calls).toEqual(['block']);
    });
  });
});

describe('引擎拒绝路径与错误码（04 §5）', () => {
  it('未允许的动作：引擎回 action_not_allowed，200 + 拒绝行，executed 为 0', async () => {
    const fake = makeFakeRuntime({
      rejectActions: ['feed'],
      rejectResult: { code: 'action_not_allowed', detail: '动作 feed 不在本题的 allowedActions 里' },
    });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const before = await currentProjection(app, sessionId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'feed', hex: '41' }] },
      });
      const body = ActionsResponseSchema.parse(response.json());

      expect(response.statusCode).toBe(200);
      expect(body.executed).toBe(0);
      expect(body.results).toEqual([
        {
          ok: false,
          action: 'feed',
          error: { code: 'action_not_allowed', message: describeError('action_not_allowed') },
        },
      ]);
      // 被拒绝的动作不改变 VM 状态；只有 failures 单调递增（04 §3）。
      const after = body.projection;
      expect(after.steps).toBe(before.steps);
      expect(after.registers).toEqual(before.registers);
      expect(after.vmas).toEqual(before.vmas);
      expect(after.status).toBe(before.status);
      expect(after.failures).toBe(before.failures + 1);
      // 错误行里没有引擎的 detail，也没有任何隐藏内容（04 §4：`VmError.detail` 永不下发）。
      expect(response.body).not.toContain('不在本题的 allowedActions 里');
    });
  });

  it('未声明的积木 id：引擎回 unknown_action，错误码原样进响应', async () => {
    const fake = makeFakeRuntime({
      rejectActions: ['block'],
      rejectResult: { code: 'unknown_action', detail: '未声明的出题人积木：nope' },
    });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'block', id: 'nope', args: {} }] },
      });
      const body = ActionsResponseSchema.parse(response.json());

      expect(response.statusCode).toBe(200);
      expect(body.executed).toBe(0);
      expect(body.results[0]?.error?.code).toBe('unknown_action');
      expect(response.body).not.toContain('未声明的出题人积木');
    });
  });

  it('拒绝之后回退类动作仍可用（undo / reset / step_back 不受 allowedActions 约束）', async () => {
    const fake = makeFakeRuntime({ rejectActions: ['feed'] });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const url = `/api/sessions/${sessionId}/actions`;

      const rejected = await app.inject({
        method: 'POST',
        url,
        payload: { actions: [{ type: 'feed', hex: '41' }] },
      });
      expect(ActionsResponseSchema.parse(rejected.json()).executed).toBe(0);

      for (const type of ['undo', 'reset', 'step_back'] as const) {
        const response = await app.inject({
          method: 'POST',
          url,
          payload: { actions: [{ type }] },
        });
        expect(response.statusCode).toBe(200);
        expect(ActionsResponseSchema.parse(response.json()).results).toEqual([
          { ok: true, action: type },
        ]);
      }
      expect(fake.calls).toEqual(['feed', 'undo', 'reset', 'step_back']);
    });
  });
});
