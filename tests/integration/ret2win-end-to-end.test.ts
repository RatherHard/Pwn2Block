import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  ChallengeSummarySchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  ret2winPrivate,
  ret2winPublic,
  ret2winSolutionActions,
  type PrivateChallenge,
} from '@pwn2block/shared';

/**
 * 真实引擎 + 真实 HTTP 的端到端集成（A 的 A03 日常集成，也是 S02 的种子）。
 *
 * 用 03 §4 的 ret2win 样例包跑通：创建会话 → 用 `gets` 积木溢出 → 单步三次到 satisfied →
 * 提交参考解法判胜并拿到 flag。全程只有公开投影，隐藏 VMA 与 flag 真值不得出现在响应里。
 *
 * 这里刻意**不注入 fake runtime**：走的就是 `@pwn2block/engine` 的真实实现。
 * 题目包写在临时目录里，不落进仓库的 `challenges/`（那是 E 的地盘，且会被 CI 的 `--all` 扫到）。
 */

const flagEnvVar = 'FLAG_RET2WIN';
const env = { [flagEnvVar]: TEST_FLAG_SENTINEL };

const hiddenBytes = Buffer.from('hidden-key-material', 'ascii');
const hiddenHex = hiddenBytes.toString('hex');

/** ret2win + 一个隐藏的 key VMA，用来验证"隐藏即不下发"。 */
const privateWithHiddenKey: PrivateChallenge = {
  ...ret2winPrivate,
  vmas: [
    ...ret2winPrivate.vmas,
    {
      id: 'key',
      kind: 'key',
      start: '0x600000',
      size: '0x1000',
      perm: 'r',
      hidden: true,
      init: [{ at: '0x600000', hex: hiddenHex }],
    },
  ],
};

let app: FastifyInstance;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pwn2block-int-'));
  const challengeRoot = join(workDir, 'challenges');
  const challengeDir = join(challengeRoot, 'ret2win');
  mkdirSync(challengeDir, { recursive: true });
  mkdirSync(join(workDir, 'presets'), { recursive: true });
  writeFileSync(join(challengeDir, 'public.json'), JSON.stringify(ret2winPublic, null, 2));
  writeFileSync(join(challengeDir, 'private.json'), JSON.stringify(privateWithHiddenKey, null, 2));

  app = buildApp({ challengeDir: challengeRoot, presetDir: join(workDir, 'presets'), env });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(workDir, { recursive: true, force: true });
});

interface SessionFixture {
  readonly sessionId: string;
}

async function createSession(): Promise<SessionFixture> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: 'ret2win' },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json());
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

describe('ret2win 端到端（真实引擎 + 真实 HTTP）', () => {
  it('题目列表只暴露公开信息', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/challenges' });
    expect(response.statusCode).toBe(200);
    const list = ChallengeSummarySchema.array().parse(response.json());
    expect(list.map((item) => item.id)).toEqual(['ret2win']);
    expect(jsonOf(list)).not.toContain(TEST_FLAG_SENTINEL);
    expect(jsonOf(list)).not.toContain(hiddenHex);
  });

  it('创建会话：拿到公开投影，隐藏 VMA 只有布局', async () => {
    const session = await createSession();
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.sessionId}` });
    expect(response.statusCode).toBe(200);
    const state = SessionStateResponseSchema.parse(response.json());
    const { projection } = state;

    expect(projection.status).toBe('ready');
    expect(projection.registers.find((item) => item.name === 'RSP')?.value).toBe('0x7fffff00');
    expect(projection.registers.find((item) => item.name === 'RIP')?.value).toBe('0x400000');

    const text = projection.vmas.find((item) => item.id === 'text');
    expect(text?.hex).toContain('c9c30f0e');
    const key = projection.vmas.find((item) => item.id === 'key');
    expect(key?.hidden).toBe(true);
    expect(key?.hex).toBeUndefined();
    expect(key?.start).toBe('0x600000');

    // 反汇编只覆盖可见可执行区，隐藏数据区不出现。
    expect(projection.disasm.every((entry) => entry.addr.startsWith('0x400'))).toBe(true);

    expect(jsonOf(state)).not.toContain(TEST_FLAG_SENTINEL);
    expect(jsonOf(state)).not.toContain(hiddenHex);
    expect(jsonOf(state)).not.toContain(hiddenBytes.toString('ascii'));
  });

  it('调试实例：gets 溢出 + 单步三次到 satisfied，且不下发 flag', async () => {
    const session = await createSession();
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/actions`,
      payload: { actions: ret2winSolutionActions },
    });
    expect(response.statusCode).toBe(200);
    const body = ActionsResponseSchema.parse(response.json());

    expect(body.executed).toBe(2);
    expect(body.results.map((item) => item.ok)).toEqual([true, true]);
    expect(body.projection.status).toBe('satisfied');
    expect(body.projection.steps).toBe(3);
    // 调试实例满足成功条件也只回状态：没有 flag 字段，也没有真值。
    expect(jsonOf(body)).not.toContain(TEST_FLAG_SENTINEL);
    expect(Object.keys(body)).not.toContain('flag');
  });

  it('提交参考解法判胜并下发 flag，且不改动调试实例', async () => {
    const session = await createSession();
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/actions`,
      payload: { actions: ret2winSolutionActions },
    });
    const before = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${session.sessionId}` })).json(),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/submit`,
      payload: { actions: ret2winSolutionActions },
    });
    expect(response.statusCode).toBe(200);
    const body = SubmitResponseSchema.parse(response.json());

    expect(body.verdict).toBe('won');
    expect(body.flag).toBe(TEST_FLAG_SENTINEL);
    expect(body.executed).toBe(2);
    expect(body.replay.frames.length).toBeGreaterThan(0);

    // 录像只有公开投影：除了顶层 flag 字段，任何地方都不许出现真值。
    const { flag: _flag, ...withoutFlag } = body;
    expect(jsonOf(withoutFlag)).not.toContain(TEST_FLAG_SENTINEL);
    expect(jsonOf(withoutFlag)).not.toContain(hiddenHex);

    // 提交跑在判题实例上：调试实例的状态一个字节都不许变（S02）。
    const after = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${session.sessionId}` })).json(),
    );
    expect(after.projection.status).toBe(before.projection.status);
    expect(after.projection.steps).toBe(before.projection.steps);
    expect(jsonOf(after.projection.registers)).toBe(jsonOf(before.projection.registers));
  });

  it('未声明的积木与未允许的动作都被拒，且不改状态', async () => {
    const session = await createSession();
    const unknownBlock = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/actions`,
      payload: { actions: [{ type: 'block', id: 'nope', args: {} }] },
    });
    expect(unknownBlock.statusCode).toBe(200);
    const unknownBody = ActionsResponseSchema.parse(unknownBlock.json());
    expect(unknownBody.results[0]?.ok).toBe(false);
    expect(unknownBody.results[0]?.error?.code).toBe('unknown_action');

    const notAllowed = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/actions`,
      payload: { actions: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '41' }] },
    });
    const notAllowedBody = ActionsResponseSchema.parse(notAllowed.json());
    expect(notAllowedBody.results[0]?.error?.code).toBe('action_not_allowed');

    const after = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${session.sessionId}` })).json(),
    );
    expect(after.projection.steps).toBe(0);
    expect(after.projection.status).toBe('ready');
  });
});
