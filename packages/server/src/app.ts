import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
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
import { SlidingWindowLimiter, resolveRateLimit } from './limits';
import type { RateLimitOptions, SessionLimits } from './limits';
import { mapActionResults, projectReplay, projectState, projectionContextOf } from './projection';
import { engineRuntimeFactory } from './runtime';
import { SessionStore } from './sessions';
import type { Session, SessionStoreOptions } from './sessions';
import { registerStatic } from './static';
import { requestIssueMessage } from './validation';

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
  /** Fastify 原生日志配置；stream 可采集真实日志，启动入口默认开启。 */
  readonly logger?: FastifyServerOptions['logger'];
  /** 引擎装配工厂，默认 `@pwn2block/engine` 的 `createRuntime`。 */
  readonly createRuntime?: CreateRuntime;
  readonly sessions?: SessionStoreOptions;
  /** 限流与并发会话上限（04 §6）。缺省即开启，默认值与依据见 `limits.ts`。 */
  readonly rateLimit?: RateLimitOptions;
  /** 前端构建产物的静态根，默认仓库根的 `packages/web/dist`；不存在不算启动错误（见 `static.ts`）。 */
  readonly staticRoot?: string;
  /** 是否注册静态托管，默认 `true`；关掉后非 `/api/**` 的路径全部 404。 */
  readonly serveStatic?: boolean;
}

/** 限流的对外文案：固定字符串，不回显请求内容，也不含任何内部信息（04 §6）。 */
const RATE_LIMITED_MESSAGE = '请求过于频繁，请稍后再试';
const SESSION_LIMIT_MESSAGES: Readonly<Record<'per-ip' | 'global', string>> = {
  'per-ip': '同一来源的会话数已达上限，请先结束旧会话或稍后再试',
  global: '服务器会话数已达上限，请稍后再试',
};

function fail(reply: FastifyReply, code: ApiErrorCode, message: string): FastifyReply {
  return reply.code(API_ERROR_STATUS[code]).send(ApiErrorSchema.parse({ code, message }));
}

/** 请求 URL 的路径部分（去掉查询串）。 */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** 路径是否落在 API 面：`/api` 与 `/api/**`。用于 404 文案，不用于限流判定。 */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * 限流只作用于 API（04 §6）。
 * - 静态资源不算：一次页面加载要取几十个文件，计入配额会把正常浏览打成 429。
 * - `/api/health` 不算：它是给部署探针用的，被限流只会制造假故障。
 */
function isRateLimitedRequest(request: FastifyRequest): boolean {
  if (!request.url.startsWith('/api/')) return false;
  return pathOf(request.url) !== '/api/health';
}

/** 提交接口用**独立**的桶：它每次都要跑一遍完整回放，代价与普通请求不同量级（04 §6）。 */
function isSubmitRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return route === undefined ? request.url.includes('/submit') : route.endsWith('/submit');
}

/**
 * 会话容量的判定（04 §6）：全局与每 IP 都按**存活**会话数算。
 * 先按空闲时间惰性回收一轮，所以空闲回收掉下去的会话当场把配额还回来。
 */
function sessionLimitReason(
  sessions: SessionStore,
  limits: SessionLimits,
  ownerKey: string,
): 'per-ip' | 'global' | undefined {
  sessions.reap();
  if (sessions.countByOwner(ownerKey) >= limits.perIp) return 'per-ip';
  if (sessions.size() >= limits.global) return 'global';
  return undefined;
}

/** 会话不存在，或已被空闲回收——两者的 HTTP 状态都是 404，但错误码不同（04 §5）。 */
function missingSession(reply: FastifyReply, expired: boolean): FastifyReply {
  return expired
    ? fail(reply, 'session_expired', '会话因空闲超时已被回收，请重新创建')
    : fail(reply, 'not_found', '会话不存在');
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
  const challenges = loadChallengeDir(challengeDir, {
    env,
    presetDir,
    onLoadFailure: (failure) => app.log.warn(
      { event: 'challenge_load_failed', ...failure },
      '题目加载失败，已停用；请运行 pnpm challenge:check --all 排查',
    ),
  });
  const assembleRuntime = options.createRuntime ?? engineRuntimeFactory;
  const sessions = new SessionStore(options.sessions);
  const limits = resolveRateLimit(options.rateLimit);
  // 每次 buildApp() 各一份，不做全局单例：测试之间互不影响（04 §6）。
  const requestLimiter = new SlidingWindowLimiter(
    limits.request,
    limits.now,
    limits.maxTrackedKeys,
  );
  const submitLimiter = new SlidingWindowLimiter(limits.submit, limits.now, limits.maxTrackedKeys);

  // 按 IP 限流（04 §6）。钩子必须早于路由注册，否则只对之后注册的路由生效。
  // 拒绝发生在路由处理之前：不进引擎、不动 `failures`、不压快照、不分配会话。
  app.addHook('onRequest', async (request, reply) => {
    if (!isRateLimitedRequest(request)) return;
    const decision = (isSubmitRequest(request) ? submitLimiter : requestLimiter).hit(request.ip);
    if (decision.allowed) return;
    // `Retry-After` 按秒向上取整；窗口是滑动的，所以它是「最早一次命中过期」的那一刻。
    reply.header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
    return fail(reply, 'rate_limited', RATE_LIMITED_MESSAGE);
  });

  // 空闲回收：定时清理 unref()，不阻止进程退出（04 §1）。
  sessions.startSweeper();
  app.addHook('onClose', async () => {
    sessions.stopSweeper();
    // 关闭即释放：会话与限流计数一并归零，不留给下一次 buildApp（04 §6）。
    sessions.clear();
    requestLimiter.clear();
    submitLimiter.clear();
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
    if (!parsed.success) {
      return fail(reply, 'invalid_request', requestIssueMessage(parsed.error, request.body));
    }

    const loaded = challenges.get(parsed.data.challengeId);
    if (loaded === undefined) {
      return challenges.isUnavailable(parsed.data.challengeId)
        ? fail(reply, 'challenge_unavailable', '题目未通过加载校验，暂时不可用')
        : fail(reply, 'not_found', '题目不存在');
    }

    // 容量检查必须在装配引擎**之前**（04 §6）：超限时既不分配会话，也不装配引擎。
    const overLimit = sessionLimitReason(sessions, limits.sessions, request.ip);
    if (overLimit !== undefined) return fail(reply, 'rate_limited', SESSION_LIMIT_MESSAGES[overLimit]);

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

    const session = sessions.create(runtime, request.ip);
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
    if (!parsed.success) {
      return fail(reply, 'invalid_request', requestIssueMessage(parsed.error, request.body));
    }

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
    if (!parsed.success) {
      return fail(reply, 'invalid_request', requestIssueMessage(parsed.error, request.body));
    }

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

  // 静态托管（07 §7）：它注册的是最低优先级的通配路由，真实 API 路由永远先匹配（04 §5）。
  // 放在 API 路由之后只是可读性考虑；命中优先级由路由具体程度决定，与注册顺序无关。
  if (options.serveStatic ?? true) registerStatic(app, options.staticRoot);

  /**
   * `/api/**` 的未命中必须在 API 面落成 404（04 §5）。
   * 静态托管注册了 `/*` 通配路由，若不挡一层，产物目录里恰好有 `api/xxx` 文件时未知接口
   * 会被静态面接走（01 §6 第 1 条）。`/api/*` 比 `/*` 更具体，优先级更高。
   */
  const apiNotFound = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    fail(reply, 'not_found', '接口不存在');
  app.all('/api', apiNotFound);
  app.all('/api/*', apiNotFound);

  // 其余未命中一律 404，且是固定形状的 `ApiError`：不做 SPA 回退（`static.ts` 的说明），
  // 也不回显请求路径（01 §6：不泄露服务端目录结构）。
  app.setNotFoundHandler((request, reply) =>
    fail(reply, 'not_found', isApiPath(pathOf(request.url)) ? '接口不存在' : '资源不存在'),
  );

  // 错误响应不含堆栈、文件路径与私有包字段（04 §6）。
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    // 解析期的 400 分两种：「body 为空」与「不是合法 JSON」给学习者的动作不同，文案分开说。
    if (status === 400) {
      return fail(
        reply,
        'invalid_request',
        error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? '请求体不能为空' : '请求体不是合法 JSON',
      );
    }
    if (status === 413) return fail(reply, 'invalid_request', '请求体超过大小上限');
    if (status === 415) return fail(reply, 'invalid_request', '请求体必须是 application/json');
    // 静态层对穿越 / 非规范路径的拒绝是 403（`@fastify/static` 的 forbiddenPathError）。
    // 对外统一成 404：既不区分「不存在」与「被判定为穿越」，也不把这类探测记成 500 内部错误。
    if (status === 403) return fail(reply, 'not_found', '资源不存在');
    request.log.error({ err: error }, '未处理的请求错误');
    return fail(reply, 'internal', '服务端内部错误');
  });

  return app;
}
