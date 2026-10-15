import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  ret2winPublic,
} from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import {
  TEST_ENV,
  makeChallengeDir,
  makeFakeRuntime,
  testPrivate,
  testPublic,
  writeChallenge,
} from './support';

/**
 * `roles` 随投影下发（04 §4、09 §4、08 §9.2）。
 *
 * 角色寄存器名来自私有包的 `roles`，但它是**固定的已知信息**（布局与命名公开、内容隐藏，01 §6 第 2 条）：
 * 服务端从私有包取值后随投影下发，前端据此标栈指针 / 帧指针 / 指令指针，不硬编码 `RSP`/`RBP`/`RIP`，
 * 也不读私有包。它**不回填 `public.json`**：出题人已在私有包声明一次，公开包再声明一次只会漂移。
 *
 * 这里走真实 HTTP（`fastify.inject`），断言的是响应体的实际形状，不是内部函数。
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

describe('roles 随投影下发（04 §4、09 §4）', () => {
  it('创建 / 刷新 / actions / 录像初态都带 roles，值与私有包声明一致', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const expected = testPrivate().roles;
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: CHALLENGE_ID },
      });
      const createdBody = CreateSessionResponseSchema.parse(created.json());
      expect(createdBody.projection.roles).toEqual(expected);
      expect(createdBody.projection.roles).toEqual(fake.runtime.privatePkg.roles);
      // 私有包对象的引用不该被带出去（投影是逐字段构造的副本）。
      expect(createdBody.projection.roles).not.toBe(fake.runtime.privatePkg.roles);
      expect(Object.keys(createdBody.projection.roles).sort()).toEqual(['bp', 'ip', 'sp']);

      const state = await app.inject({
        method: 'GET',
        url: `/api/sessions/${createdBody.sessionId}`,
      });
      expect(SessionStateResponseSchema.parse(state.json()).projection.roles).toEqual(expected);

      const actions = await app.inject({
        method: 'POST',
        url: `/api/sessions/${createdBody.sessionId}/actions`,
        payload: { actions: [{ type: 'step' }] },
      });
      expect(ActionsResponseSchema.parse(actions.json()).projection.roles).toEqual(expected);

      const submit = await app.inject({
        method: 'POST',
        url: `/api/sessions/${createdBody.sessionId}/submit`,
        payload: { actions: [{ type: 'step' }] },
      });
      const submitBody = SubmitResponseSchema.parse(submit.json());
      expect(submitBody.replay.initial.roles).toEqual(expected);
      // 录像帧只带寄存器与标志位，roles 只在初态出现一次（ReplayFrameSchema）。
      for (const frame of submitBody.replay.frames) {
        expect(frame).not.toHaveProperty('roles');
      }
    });
  });

  it('自定义角色命名原样透传，不做 RSP / RBP / RIP 硬编码', async () => {
    const priv = testPrivate({
      registers: ['ESP', 'EBP', 'EIP', 'FLAG'],
      roles: { sp: 'ESP', bp: 'EBP', ip: 'EIP' },
    });
    const fake = makeFakeRuntime({
      privatePkg: priv,
      registers: { ESP: 0x7fffff00n, EBP: 0x7fffff10n, EIP: 0x400000n },
    });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const state = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      const projection = SessionStateResponseSchema.parse(state.json()).projection;

      expect(projection.roles).toEqual({ sp: 'ESP', bp: 'EBP', ip: 'EIP' });
      expect(projection.registers.map((item) => item.name)).toEqual(['ESP', 'EBP', 'EIP', 'FLAG']);
    });
  });

  it('public.json 里没有 roles：公开包原样下发，Schema 拒收该字段', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const detail = await app.inject({ method: 'GET', url: `/api/challenges/${CHALLENGE_ID}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(testPublic());
      expect(detail.json()).not.toHaveProperty('roles');
      const parsed = JSON.parse(detail.body) as Record<string, unknown>;
      expect(Object.keys(parsed)).not.toContain('roles');
    });
  });
});
