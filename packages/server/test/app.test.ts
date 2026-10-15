import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '@pwn2block/engine';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  MAX_BODY_BYTES,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  describeError,
  ret2winPrivate,
  ret2winPublic,
} from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import type { RuntimeOptions } from '@pwn2block/shared';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import { engineRuntimeFactory } from '../src/runtime';
import {
  HIDDEN_KEY_HEX,
  TEST_ENV,
  TEST_FLAG_VALUE,
  expectApiError,
  makeChallengeDir,
  makeFakeRuntime,
  makePresetDir,
  testPrivate,
  testPublic,
  writeChallenge,
} from './support';

/**
 * REST 契约（04 §5）：用 `fastify.inject` 打真实路由，引擎用可注入的 fake runtime。
 * 真实引擎由 B 并行开发，服务端只依赖可注入工厂这条缝：装配失败必须落成 503。
 */

const CHALLENGE_ID = ret2winPublic.id;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

async function createSession(app: FastifyInstance, challengeId = CHALLENGE_ID): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

describe('题目（04 §5）', () => {
  it('题目目录不存在时列表为空，而不是报错', async () => {
    await withApp(optionsWith({ challengeDir: join(challengeDir, '不存在的目录') }), async (app) => {
      const list = await app.inject({ method: 'GET', url: '/api/challenges' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);

      expectApiError(
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: CHALLENGE_ID },
        }),
        'not_found',
      );
    });
  });

  it('加载成功的题目出现在列表里，公开包原样下发且不含私有字段', async () => {
    await withApp(optionsWith(), async (app) => {
      const list = await app.inject({ method: 'GET', url: '/api/challenges' });
      expect(list.json()).toEqual([{ id: CHALLENGE_ID, title: ret2winPublic.title }]);

      const detail = await app.inject({ method: 'GET', url: `/api/challenges/${CHALLENGE_ID}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(testPublic());
      expect(detail.json()).not.toHaveProperty('vmas');
      expect(detail.json()).not.toHaveProperty('win');
      expect(detail.json()).not.toHaveProperty('flag');
      expect(detail.body).not.toContain(HIDDEN_KEY_HEX);
    });
  });

  it('加载失败的题目不出现在列表里，请求它回 503；未知 id 回 404', async () => {
    // 缺 flag 环境变量 → 该题拒绝加载（06 §6）。
    await withApp(optionsWith({ env: {} }), async (app) => {
      const list = await app.inject({ method: 'GET', url: '/api/challenges' });
      expect(list.json()).toEqual([]);

      expectApiError(
        await app.inject({ method: 'GET', url: `/api/challenges/${CHALLENGE_ID}` }),
        'challenge_unavailable',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: CHALLENGE_ID },
        }),
        'challenge_unavailable',
      );
      expectApiError(
        await app.inject({ method: 'GET', url: '/api/challenges/never-existed' }),
        'not_found',
      );
    });
  });

  it('校验不通过的题目也不出现在列表里', async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'pwn2block-broken-'));
    try {
      // id 与目录名不一致：本地看着像能用，加载时必须挡住。
      writeChallenge(brokenDir, 'wrong-name', testPublic(), testPrivate());
      await withApp(optionsWith({ challengeDir: brokenDir }), async (app) => {
        const list = await app.inject({ method: 'GET', url: '/api/challenges' });
        expect(list.json()).toEqual([]);
        expectApiError(
          await app.inject({ method: 'GET', url: `/api/challenges/${CHALLENGE_ID}` }),
          'challenge_unavailable',
        );
      });
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });
});

describe('会话生命周期（04 §1、§5）', () => {
  it('创建 / 读取 / 删除会话', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: CHALLENGE_ID },
      });
      expect(created.statusCode).toBe(200);
      const body = CreateSessionResponseSchema.parse(created.json());
      expect(body.sessionId).toMatch(/^[0-9a-f]{32}$/);
      expect(body.projection.status).toBe('ready');
      expect(body.projection.steps).toBe(0);
      expect(body.history).toEqual({ undo: 0, stepBack: 0 });

      const state = await app.inject({ method: 'GET', url: `/api/sessions/${body.sessionId}` });
      expect(state.statusCode).toBe(200);
      const stateBody = SessionStateResponseSchema.parse(state.json());
      expect(stateBody.sessionId).toBe(body.sessionId);
      expect(stateBody.projection).toEqual(body.projection);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${body.sessionId}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ ok: true });

      expectApiError(
        await app.inject({ method: 'GET', url: `/api/sessions/${body.sessionId}` }),
        'not_found',
      );
      expectApiError(
        await app.inject({ method: 'DELETE', url: `/api/sessions/${body.sessionId}` }),
        'not_found',
      );
    });
  });

  it('未知会话 id 回 404 not_found', async () => {
    await withApp(optionsWith({ createRuntime: () => makeFakeRuntime().runtime }), async (app) => {
      expectApiError(
        await app.inject({ method: 'GET', url: `/api/sessions/${'f'.repeat(32)}` }),
        'not_found',
      );
    });
  });

  it('空闲超时回收后回 404 session_expired', async () => {
    const fake = makeFakeRuntime();
    // idleMs = 0：定时清理的下一个周期就会回收，不用等真实 30 分钟。
    await withApp(
      optionsWith({
        createRuntime: () => fake.runtime,
        sessions: { idleMs: 0, sweepIntervalMs: 5 },
      }),
      async (app) => {
        const sessionId = await createSession(app);
        await delay(60);

        expectApiError(
          await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` }),
          'session_expired',
        );
      },
    );
  });

  it('请求体必须精确匹配：多余字段与非法 id 都被拒', async () => {
    await withApp(optionsWith({ createRuntime: () => makeFakeRuntime().runtime }), async (app) => {
      const extra = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: CHALLENGE_ID, extra: true },
      });
      expectApiError(extra, 'invalid_request');

      expectApiError(
        await app.inject({ method: 'POST', url: '/api/sessions', payload: {} }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: 'Not-Lowercase' },
        }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: '{',
          headers: { 'content-type': 'application/json' },
        }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: CHALLENGE_ID },
          headers: { 'content-type': 'text/plain' },
        }),
        'invalid_request',
      );
    });
  });

  it('引擎装配失败时回 503 challenge_unavailable，绝不返回假成功', async () => {
    await withApp(
      optionsWith({
        createRuntime: () => {
          throw new Error('引擎尚未实现：内部细节不该下发');
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: CHALLENGE_ID },
        });
        expectApiError(response, 'challenge_unavailable');
        expect(response.body).not.toContain('内部细节');
        expect(response.body).not.toContain('.ts');
      },
    );
  });

  it('默认装配工厂就是引擎的 createRuntime（真实引擎接得上）', () => {
    expect(engineRuntimeFactory).toBe(createRuntime);
  });

  it('引用 {preset} 的题目：展开好的编码表与查询表一并交给引擎（vm.ts RuntimeOptions）', async () => {
    // 引擎不读文件，所以 preset 必须在服务端展开后转交；否则这类题目一装配就失败。
    const presetItems = Array.isArray(ret2winPublic.encoding) ? ret2winPublic.encoding : [];
    const presetDir = makePresetDir('mini', presetItems);
    const dir = makeChallengeDir();
    writeChallenge(
      dir,
      CHALLENGE_ID,
      testPublic({
        encoding: { preset: 'mini', add: [{ opcode: '0x90', op: 'nop', operands: [] }] },
      }),
      testPrivate(),
    );

    const seen: RuntimeOptions[] = [];
    const fake = makeFakeRuntime();
    try {
      await withApp(
        optionsWith({
          challengeDir: dir,
          presetDir,
          createRuntime: (_pub, _priv, options) => {
            seen.push(options ?? {});
            return fake.runtime;
          },
        }),
        async (app) => {
          const sessionId = await createSession(app);
          // 首次请求同样不该因为编码表缺席而失败。
          const state = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
          expect(SessionStateResponseSchema.parse(state.json()).sessionId).toBe(sessionId);
        },
      );

      expect(seen).toHaveLength(1);
      // preset 的 4 条 + add 的 nop，而且是同一份展开结果（不是重新拼的空表）。
      expect(seen[0]?.encoding).toHaveLength(presetItems.length + 1);
      expect(seen[0]?.encoding?.some((item) => item.op === 'leave')).toBe(true);
      expect(seen[0]?.encoding?.some((item) => item.op === 'nop')).toBe(true);
      expect(seen[0]?.lookup?.byOpcode(0xc9)?.op).toBe('leave');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetDir, { recursive: true, force: true });
    }
  });

  it('引擎契约违规时回 500 internal，响应里不带内部细节', async () => {
    const brokenPriv = testPrivate({
      registers: [...ret2winPrivate.registers, 'R9'],
    });
    const fake = makeFakeRuntime({ privatePkg: brokenPriv });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: CHALLENGE_ID },
      });
      expectApiError(response, 'internal');
      expect(response.body).not.toContain('R9');
    });
  });
});

describe('actions（04 §5）', () => {
  it('按顺序执行并回报每个提交动作的结果与回退深度', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'step', count: 2 }, { type: 'block', id: 'gets', args: { data: '4142' } }] },
      });

      expect(response.statusCode).toBe(200);
      const body = ActionsResponseSchema.parse(response.json());
      expect(body.results).toEqual([
        { ok: true, action: 'step' },
        { ok: true, action: 'block' },
      ]);
      expect(body.executed).toBe(2);
      expect(body.projection.steps).toBe(2);
      expect(body.history).toEqual({ undo: 1, stepBack: 0 });
      // 动作原样交给引擎：积木展开、允许集筛选、整批一份快照都是引擎的职责（08 §2 规则 2）。
      expect(fake.calls).toEqual(['step', 'block']);
    });
  });

  it('并发两个请求按到达顺序串行执行，看不到对方的中间状态', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const [first, second] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions: [{ type: 'step' }] },
        }),
        app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions: [{ type: 'run' }] },
        }),
      ]);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // 先到的请求先跑：第二个请求看到的是第一个请求之后的状态。
      expect(ActionsResponseSchema.parse(first.json()).projection.steps).toBe(1);
      expect(ActionsResponseSchema.parse(second.json()).projection.steps).toBe(2);
      expect(fake.calls).toEqual(['step', 'run']);
    });
  });

  it('引擎拒绝即停止，后面的动作不执行', async () => {
    const fake = makeFakeRuntime({ rejectActions: ['step'] });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'step' }, { type: 'step' }] },
      });

      const body = ActionsResponseSchema.parse(response.json());
      expect(body.executed).toBe(0);
      expect(body.results).toEqual([
        {
          ok: false,
          action: 'step',
          error: { code: 'not_executable', message: describeError('not_executable') },
        },
      ]);
      expect(fake.calls).toEqual(['step']);
    });
  });

  it('引擎判定为拒绝的动作回 200 + 拒绝行，executed 与结果都由引擎给', async () => {
    const fake = makeFakeRuntime({
      rejectActions: ['feed'],
      rejectResult: { code: 'action_not_allowed', detail: '动作 feed 不在本题的 allowedActions 里' },
    });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);

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
      expect(fake.calls).toEqual(['feed']);
    });
  });

  it('未声明的积木 id（引擎回 unknown_action）在响应里保持同一码与动作名', async () => {
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
      expect(body.results).toEqual([
        {
          ok: false,
          action: 'block',
          error: { code: 'unknown_action', message: describeError('unknown_action') },
        },
      ]);
      expect(body.executed).toBe(0);
    });
  });

  it('请求体校验：多余字段、未知动作、空数组、超限都被拒', async () => {
    await withApp(optionsWith({ createRuntime: () => makeFakeRuntime().runtime }), async (app) => {
      const sessionId = await createSession(app);
      const url = `/api/sessions/${sessionId}/actions`;

      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [{ type: 'step' }], extra: 1 } }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [{ type: 'nope' }] } }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [] } }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url,
          payload: { actions: [{ type: 'step', count: 0 }] },
        }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({
          method: 'POST',
          url,
          payload: { actions: [{ type: 'feed', hex: 'a'.repeat(MAX_BODY_BYTES + 100) }] },
        }),
        'invalid_request',
      );
      // 会话没被这些坏请求影响。
      const state = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      expect(SessionStateResponseSchema.parse(state.json()).projection.steps).toBe(0);
    });
  });
});

describe('submit（04 §5.1）', () => {
  it('判胜时下发环境变量里的 flag，录像只含公开投影', async () => {
    const fake = makeFakeRuntime({ verdict: 'won' });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: [{ type: 'step' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = SubmitResponseSchema.parse(response.json());
      expect(body.verdict).toBe('won');
      expect(body.flag).toBe(TEST_FLAG_VALUE);
      expect(body.executed).toBe(1);
      expect(body.replay.initial.status).toBe('ready');
      expect(body.replay.frames).toHaveLength(1);
      expect(response.body).not.toContain(HIDDEN_KEY_HEX);
      expect(response.body.toLowerCase()).not.toContain('flag{local-test-sentinel}');
    });
  });

  it('判胜但 flag 未注入时回 503，不返回「通过」', async () => {
    const env: Record<string, string | undefined> = { ...TEST_ENV };
    const fake = makeFakeRuntime({ verdict: 'won' });
    await withApp(optionsWith({ env, createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      delete env.FLAG_RET2WIN;

      expectApiError(
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/submit`,
          payload: { actions: [{ type: 'step' }] },
        }),
        'challenge_unavailable',
      );
    });
  });

  it('引擎判 rejected 时不下发 flag，即使同一会话此前判胜过', async () => {
    const fake = makeFakeRuntime({
      verdict: 'won',
      rejectActions: ['feed'],
      rejectResult: { code: 'action_not_allowed', detail: '动作 feed 不在本题的 allowedActions 里' },
    });
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: [{ type: 'feed', hex: '41' }] },
      });

      const body = SubmitResponseSchema.parse(response.json());
      expect(body.verdict).toBe('rejected');
      expect(body.flag).toBeUndefined();
      expect(body.executed).toBe(0);
      expect(body.results[0]?.error?.code).toBe('action_not_allowed');
    });
  });

  it('提交请求体同样是 strictObject', async () => {
    await withApp(optionsWith({ createRuntime: () => makeFakeRuntime().runtime }), async (app) => {
      const sessionId = await createSession(app);
      const url = `/api/sessions/${sessionId}/submit`;

      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [{ type: 'step' }], extra: 1 } }),
        'invalid_request',
      );
      expectApiError(
        await app.inject({ method: 'POST', url, payload: { actions: [] } }),
        'invalid_request',
      );
    });
  });
});

describe('投影不出现在任何响应里的东西（01 §6）', () => {
  it('会话响应里没有隐藏 VMA 内容、flag、win / fail', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const sessionId = await createSession(app);

      const state = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      const body = SessionStateResponseSchema.parse(state.json());
      const key = body.projection.vmas.find((vma) => vma.id === 'key');

      expect(key).toEqual({
        id: 'key',
        kind: 'key',
        start: '0x600000',
        size: '0x1000',
        perm: 'r',
        hidden: true,
      });
      expect(key).not.toHaveProperty('hex');
      expect(state.body).not.toContain(HIDDEN_KEY_HEX);
      expect(state.body.toLowerCase()).not.toContain('flag{');
      expect(state.body).not.toContain(TEST_FLAG_VALUE);

      const actions = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: [{ type: 'step' }] },
      });
      expect(ActionsResponseSchema.parse(actions.json()).projection.vmas).toHaveLength(3);
      expect(actions.body).not.toContain(HIDDEN_KEY_HEX);
    });
  });
});

describe('通用错误处理（04 §6）', () => {
  it('未知接口回 404 且形状是 ApiError', async () => {
    await withApp(optionsWith(), async (app) => {
      expectApiError(await app.inject({ method: 'GET', url: '/api/nope' }), 'not_found');
      expectApiError(await app.inject({ method: 'GET', url: '/api/sessions' }), 'not_found');
    });
  });

  it('健康检查只回 ok', async () => {
    await withApp(optionsWith(), async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.json()).toEqual({ ok: true });
    });
  });

  it('包入口可以直接 import：导出 buildApp，且不会顺带起服务', async () => {
    // 集成测试从 `@pwn2block/server` 取 buildApp；入口的 isDirectRun 守卫必须挡住 listen。
    const entry = await import('../src/index');
    expect(entry.buildApp).toBe(buildApp);
  });
});
