import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import {
  API_ERROR_STATUS,
  ActionsRequestSchema,
  ActionsResponseSchema,
  ApiErrorSchema,
  ChallengeSummarySchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  MAX_BODY_BYTES,
  SessionStateResponseSchema,
  SubmitRequestSchema,
  SubmitResponseSchema,
} from '@pwn2block/shared';
import type {
  ActionsResponse,
  ApiErrorCode,
  CreateRuntime,
  EngineRuntime,
  Projection,
  SessionStateResponse,
  SubmitResponse,
} from '@pwn2block/shared';
import { defaultChallengeDir, loadChallengeDir, resolveFlag } from './challenges';
import { mapActionResults, projectReplay, projectState, projectionContextOf } from './projection';
import { engineRuntimeFactory } from './runtime';
import { SessionStore } from './sessions';
import type { Session, SessionStoreOptions } from './sessions';

/**
 * Fastify 应用（04 §5）。引擎、API、静态托管同进程（07 §7）。
 *
 * D1 的范围：题目列表与公开包、会话 CRUD、`actions`、`submit` 的路由与错误映射。
 * 引擎装配走可注入工厂，测试注入 fake runtime；真实引擎尚未实现时返回 503，不返回假成功。
 */

export interface BuildAppOptions {
  /** 题目包目录，默认仓库根的 `challenges/`。 */
  readonly challengeDir?: string;
  /** 默认编码表目录，默认题目目录的兄弟目录 `presets/`。 */
  readonly presetDir?: string;
  /** 环境变量表，默认 `process.env`；flag 真值由部署时注入（06 §6）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: boolean;
  /** 引擎装配工厂，默认 `@pwn2block/engine` 的 `createRuntime`。 */
  readonly createRuntime?: CreateRuntime;
  readonly sessions?: SessionStoreOptions;
}

function fail(reply: FastifyReply, code: ApiErrorCode, message: string): FastifyReply {
  return reply.code(API_ERROR_STATUS[code]).send(ApiErrorSchema.parse({ code, message }));
}

/** 会话不存在，或已被空闲回收——两者的 HTTP 状态都是 404，但错误码不同（04 §5）。 */
function missingSession(reply: FastifyReply, expired: boolean): FastifyReply {
  return expired
    ? fail(reply, 'session_expired', '会话因空闲超时已被回收，请重新创建')
    : fail(reply, 'not_found', '会话不存在');
}

/** 校验失败的文案：只报字段路径与原因，不含请求内容以外的任何服务端信息。 */
function issueMessage(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
  const first = error.issues[0];
  if (first === undefined) return '请求体不合法';
  const path = first.path.map(String).join('.');
  return path.length === 0 ? `请求体不合法：${first.message}` : `请求体不合法：${path} ${first.message}`;
}

function currentProjection(session: Session): Projection {
  return projectState(
    projectionContextOf(session.runtime),
    session.debug.state(),
    session.debug.failures(),
  );
}

type SubmitPlan = { readonly ok: true; readonly response: SubmitResponse } | { readonly ok: false };

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES });

  const env = options.env ?? process.env;
  const challengeDir = options.challengeDir ?? defaultChallengeDir();
  const presetDir = options.presetDir ?? join(challengeDir, '..', 'presets');
  const challenges = loadChallengeDir(challengeDir, { env, presetDir });
  const assembleRuntime = options.createRuntime ?? engineRuntimeFactory;
  const sessions = new SessionStore(options.sessions);
  // 空闲回收：定时清理 unref()，不阻止进程退出（04 §1）。
  sessions.startSweeper();
  app.addHook('onClose', async () => {
    sessions.stopSweeper();
  });

  app.get('/api/health', async () => ({ ok: true }));

  // 题目列表：只含加载成功的题目；目录为空时返回 `[]` 是正确行为。
  app.get('/api/challenges', async () =>
    challenges.list().map((item) => ChallengeSummarySchema.parse(item)),
  );

  // 题目公开部分：原样下发，私有包与 flag 不在这里（01 §6 第 1 条）。
  app.get<{ Params: { id: string } }>('/api/challenges/:id', async (request, reply) => {
    const loaded = challenges.get(request.params.id);
    if (loaded !== undefined) return loaded.definition.pub;
    return challenges.isUnavailable(request.params.id)
      ? fail(reply, 'challenge_unavailable', '题目未通过加载校验，暂时不可用')
      : fail(reply, 'not_found', '题目不存在');
  });

  app.post('/api/sessions', async (request, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'invalid_request', issueMessage(parsed.error));

    const loaded = challenges.get(parsed.data.challengeId);
    if (loaded === undefined) {
      return challenges.isUnavailable(parsed.data.challengeId)
        ? fail(reply, 'challenge_unavailable', '题目未通过加载校验，暂时不可用')
        : fail(reply, 'not_found', '题目不存在');
    }

    let runtime: EngineRuntime;
    try {
      // 引擎不读文件：preset 展开后的编码表由加载器算好，这里连同查询表一起转交
      // （引用 `{preset, add, remove}` 的题目没有它就装配不起来，vm.ts `RuntimeOptions`）。
      runtime = assembleRuntime(loaded.definition.pub, loaded.definition.priv, {
        encoding: loaded.definition.encoding,
        lookup: loaded.definition.lookup,
      });
    } catch (error) {
      // 引擎未实现 / 装配失败：如实回报不可用，不返回假成功（08 §3 D1）。
      request.log.warn({ err: error }, '引擎装配失败，题目暂不可用');
      return fail(reply, 'challenge_unavailable', '引擎暂不可用，无法创建会话');
    }

    const session = sessions.create(runtime);
    return CreateSessionResponseSchema.parse({
      sessionId: session.id,
      projection: currentProjection(session),
      history: session.history(),
    });
  });

  // 刷新页面时恢复当前状态（04 §1.1）。
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const outcome = await sessions.run(request.params.id, (session): SessionStateResponse => ({
      sessionId: session.id,
      projection: currentProjection(session),
      history: session.history(),
    }));
    if (!outcome.ok) return missingSession(reply, outcome.expired);
    return SessionStateResponseSchema.parse(outcome.value);
  });

  // 调试实例：引擎按提交动作逐个返回结果，遇到第一个拒绝或实例结束即停（04 §5）。
  app.post<{ Params: { id: string } }>('/api/sessions/:id/actions', async (request, reply) => {
    const parsed = ActionsRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'invalid_request', issueMessage(parsed.error));

    const outcome = await sessions.run(request.params.id, (session): ActionsResponse => {
      const ctx = projectionContextOf(session.runtime);
      // 积木展开、允许集筛选、整批一份请求层快照都在引擎里（08 §2 规则 2）。
      const engine = session.debug.applyRequest(parsed.data.actions);
      return ActionsResponseSchema.parse({
        results: mapActionResults(ctx, engine.results),
        executed: engine.executed,
        projection: projectState(ctx, session.debug.state(), session.debug.failures()),
        history: session.history(),
      });
    });

    if (!outcome.ok) return missingSession(reply, outcome.expired);
    return outcome.value;
  });

  // 提交判题：判题实例重置到初态纯回放，判定只由服务端做（04 §5.1）。
  app.post<{ Params: { id: string } }>('/api/sessions/:id/submit', async (request, reply) => {
    const parsed = SubmitRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'invalid_request', issueMessage(parsed.error));

    const outcome = await sessions.run(request.params.id, (session): SubmitPlan => {
      sessions.recordSubmit(session.id);
      const ctx = projectionContextOf(session.runtime);
      const replay = session.runtime.replaySubmit(parsed.data.actions);
      // 判胜只由服务端判定并下发 flag；引擎的 `SubmitOutcome` 里没有 flag（04 §5.1）。
      const flag = replay.verdict === 'won' ? resolveFlag(session.runtime.privatePkg, env) : undefined;
      if (replay.verdict === 'won' && flag === undefined) return { ok: false };

      return {
        ok: true,
        response: SubmitResponseSchema.parse({
          verdict: replay.verdict,
          executed: replay.executed,
          results: mapActionResults(ctx, replay.results),
          replay: projectReplay(ctx, replay),
          ...(flag === undefined ? {} : { flag }),
        }),
      };
    });

    if (!outcome.ok) return missingSession(reply, outcome.expired);
    if (!outcome.value.ok) return fail(reply, 'challenge_unavailable', '题目 flag 未注入，无法下发');
    return outcome.value.response;
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const removed = sessions.remove(request.params.id);
    if (removed === 'removed') return { ok: true };
    return missingSession(reply, removed === 'expired');
  });

  app.setNotFoundHandler((_request, reply) => fail(reply, 'not_found', '接口不存在'));

  // 错误响应不含堆栈、文件路径与私有包字段（04 §6）。
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 400) return fail(reply, 'invalid_request', '请求体不是合法 JSON');
    if (status === 413) return fail(reply, 'invalid_request', '请求体超过大小上限');
    if (status === 415) return fail(reply, 'invalid_request', '请求体必须是 application/json');
    request.log.error({ err: error }, '未处理的请求错误');
    return fail(reply, 'internal', '服务端内部错误');
  });

  return app;
}
