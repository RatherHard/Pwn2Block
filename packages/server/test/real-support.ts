import { expect } from 'vitest';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
} from '@pwn2block/shared';
import type {
  ActionsResponse,
  Projection,
  RegisterView,
  ReplayFrameView,
  SessionStateResponse,
  SubmitResponse,
} from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { makeChallengeDir, writeChallenge } from './support';

/**
 * C03 真实对象测试的公共设施（owner：C，写入范围 `packages/server/**`）。
 *
 * 与 `./support.ts` 的分工：那里提供 fake runtime 与样例包，这里只放
 * **真实引擎 + 真实 HTTP** 需要的题目根目录和响应读取助手。
 *
 * 硬约束：这里没有任何 mock runtime——所有 runtime 都来自 `buildApp` 默认的
 * `@pwn2block/engine` 装配工厂（不注入 `createRuntime`，08 §1「mock 通过不算真实接口验收」）。
 * 本文件不是测试文件（vitest 的 include 只收 `**\/*.test.ts`）。
 */

export interface ChallengePackage {
  readonly pub: unknown;
  readonly priv: unknown;
}

/**
 * 临时题目根目录：每个键是一道题的目录名，必须等于公开包声明的 id
 * （`loadChallengeDir` 与 `checkChallengePair` 都会检查这一条）。
 * 编码表一律写成完整数组，因此不需要 `presets/`。
 */
export function makeRealChallengeRoot(
  packages: Readonly<Record<string, ChallengePackage>>,
): string {
  const root = makeChallengeDir();
  for (const [id, pkg] of Object.entries(packages)) {
    writeChallenge(root, id, pkg.pub, pkg.priv);
  }
  return root;
}

export async function createSession(
  app: FastifyInstance,
  challengeId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

export async function getState(
  app: FastifyInstance,
  sessionId: string,
): Promise<SessionStateResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  expect(response.statusCode).toBe(200);
  return SessionStateResponseSchema.parse(response.json());
}

export async function getProjection(
  app: FastifyInstance,
  sessionId: string,
): Promise<Projection> {
  return (await getState(app, sessionId)).projection;
}

export interface ActionsCall {
  readonly statusCode: number;
  readonly body: string;
  readonly parsed: ActionsResponse;
}

export async function postActions(
  app: FastifyInstance,
  sessionId: string,
  actions: readonly unknown[],
): Promise<ActionsCall> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/actions`,
    payload: { actions },
  });
  expect(response.statusCode).toBe(200);
  return {
    statusCode: response.statusCode,
    body: response.body,
    parsed: ActionsResponseSchema.parse(response.json()),
  };
}

export interface SubmitCall {
  readonly statusCode: number;
  readonly body: string;
  readonly parsed: SubmitResponse;
}

export async function postSubmit(
  app: FastifyInstance,
  sessionId: string,
  actions: readonly unknown[],
): Promise<SubmitCall> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/submit`,
    payload: { actions },
  });
  expect(response.statusCode).toBe(200);
  return {
    statusCode: response.statusCode,
    body: response.body,
    parsed: SubmitResponseSchema.parse(response.json()),
  };
}

/** 投影的字段表：寄存器按题目包声明顺序 → 便于精确断言单个寄存器。 */
export function registersOf(projection: Projection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const register of projection.registers as readonly RegisterView[]) {
    out[register.name] = register.value;
  }
  return out;
}

/** 去掉 `failures` 的投影 JSON：它是唯一按设计会因「拒绝」而变化的字段（04 §3）。 */
export function withoutFailures(projection: Projection): string {
  const { failures: _ignored, ...rest } = projection;
  return JSON.stringify(rest);
}

/**
 * 「被拒绝的动作不修改状态」的比较口径（04 §2、§3）。
 *
 * 逐字段比较整份投影，**只把 `failures` 单列**：它按设计单调递增（04 §3），
 * 所以对它正面断言增量而不是忽略。增量必须由调用方显式给出，默认 0
 * （请求在 Schema 层被拒、根本没进引擎时就是 0）。
 */
export function expectProjectionUnchanged(
  before: Projection,
  after: Projection,
  failuresDelta = 0,
): void {
  expect(after.failures).toBe(before.failures + failuresDelta);
  expect(withoutFailures(after)).toBe(withoutFailures(before));
}

export function actionFrames(frames: readonly ReplayFrameView[]): ReplayFrameView[] {
  return frames.filter((frame) => frame.kind === 'action');
}

/** `kind:label` 序列，用于精确断言录像的帧形状。 */
export function frameShape(frames: readonly ReplayFrameView[]): string[] {
  return frames.map((frame) => `${frame.kind}:${frame.label}`);
}

/** 递归收集对象 / 数组里出现过的字段名（只看键，不看值）。 */
export function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** 响应正文不得夹带内部信息（04 §6）：堆栈、源码路径、私有包文件名。 */
export function expectNoInternalLeak(body: string, extra: readonly string[] = []): void {
  for (const needle of ['private.json', 'at Object.', 'node_modules', 'ZodError', 'bodyLimit']) {
    expect(body).not.toContain(needle);
  }
  for (const needle of extra) {
    if (needle === '') continue;
    expect(body).not.toContain(needle);
  }
}
