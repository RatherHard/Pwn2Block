/**
 * API 客户端（04 §5、05 §6）。D1 只搭骨架：真实联调在 D4。
 *
 * 三条职责：
 * 1. 统一 fetch 封装与 URL 拼接；
 * 2. **用 shared 的响应 Schema 校验**每一份响应（字段名错、缺字段都当场报错，不让脏数据进视图）；
 * 3. 会话过期（POST/GET/DELETE 会话接口返回 404）转换成可识别的 `sessionExpired`，
 *    由界面提示「会话已失效」并提供「重新开始」。
 *
 * 请求体同样走 shared 的 `strictObject` 请求 Schema，前端先自检，服务端仍会再校验一次。
 */
import {
  ActionsRequestSchema,
  ActionsResponseSchema,
  ApiErrorSchema,
  ChallengeSummarySchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  PublicChallengeSchema,
  SessionStateResponseSchema,
  SubmitRequestSchema,
  SubmitResponseSchema,
  type Action,
  type ActionsResponse,
  type ApiErrorCode,
  type ChallengeSummary,
  type CreateSessionResponse,
  type PublicChallenge,
  type SessionStateResponse,
  type SubmitResponse,
} from '@pwn2block/shared';

/** shared 的 Schema 与这里只需要的最小能力对齐，避免把 zod 带进 web 的依赖。 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } };
}

export type FetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<Response>;

export interface ApiClientOptions {
  /** 默认同源（生产由 Fastify 托管静态资源）；开发用 vite 代理。 */
  readonly baseUrl?: string;
  /** 注入点：测试里换成假 fetch，不需要 DOM 或真实网络。 */
  readonly fetchImpl?: FetchLike;
}

export interface ApiClient {
  listChallenges(): Promise<readonly ChallengeSummary[]>;
  getChallenge(id: string): Promise<PublicChallenge>;
  createSession(challengeId: string): Promise<CreateSessionResponse>;
  sessionState(sessionId: string): Promise<SessionStateResponse>;
  actions(sessionId: string, actions: readonly Action[]): Promise<ActionsResponse>;
  submit(sessionId: string, actions: readonly Action[]): Promise<SubmitResponse>;
  endSession(sessionId: string): Promise<void>;
}

const DEFAULT_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  invalid_request: '请求不合法',
  not_found: '请求的资源不存在',
  session_expired: '会话已失效，请重新开始',
  challenge_unavailable: '题目当前不可用',
  rate_limited: '请求过于频繁，请稍后再试',
  internal: '服务器内部错误',
};

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly sessionExpired: boolean;
  readonly network: boolean;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { readonly status?: number; readonly sessionExpired?: boolean; readonly network?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiClientError';
    this.code = code;
    this.status = options.status ?? 0;
    this.sessionExpired = options.sessionExpired ?? false;
    this.network = options.network ?? false;
  }
}

/** 界面据此提示「会话已失效」并提供重新开始（05 §6）。 */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiClientError && error.sessionExpired;
}

function firstIssue(error: { readonly issues: readonly { readonly message: string }[] }): string {
  return error.issues[0]?.message ?? '字段不符合契约';
}

function validate<T>(schema: ResponseSchema<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiClientError('invalid_request', `${what}不合法：${firstIssue(parsed.error)}`);
  }
  return parsed.data;
}

interface RequestOptions<T> {
  readonly method: string;
  readonly body?: unknown;
  readonly schema?: ResponseSchema<T>;
  /** 会话作用域的接口：404 表示会话已失效。 */
  readonly sessionScoped?: boolean;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function send<T>(path: string, requestOptions: RequestOptions<T>): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: requestOptions.method,
        headers: requestOptions.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      });
    } catch (cause) {
      throw new ApiClientError('internal', '无法连接服务器，请检查网络后重试', { network: true, cause });
    }

    const text = await response.text();

    if (response.status === 404 && requestOptions.sessionScoped === true) {
      throw new ApiClientError('session_expired', DEFAULT_MESSAGES.session_expired, {
        status: 404,
        sessionExpired: true,
      });
    }
    if (!response.ok) throw describeFailure(response.status, text);
    if (response.status === 204 || text.length === 0) return undefined as T;

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiClientError('internal', '服务器返回的内容不是合法 JSON', { status: response.status });
    }
    if (requestOptions.schema === undefined) return payload as T;
    const parsed = requestOptions.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiClientError('internal', `响应不符合契约：${firstIssue(parsed.error)}`, {
        status: response.status,
      });
    }
    return parsed.data;
  }

  function describeFailure(status: number, text: string): ApiClientError {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const error = ApiErrorSchema.safeParse(parsed);
    if (error.success) {
      return new ApiClientError(error.data.code, error.data.message, { status });
    }
    return new ApiClientError('internal', `请求失败（HTTP ${status}）`, { status });
  }

  return {
    // 全部方法都是 `async`：请求自检失败也走 Promise 拒绝，调用方只需一套 catch（05 §6）。
    listChallenges: async () =>
      send('/api/challenges', {
        method: 'GET',
        schema: { safeParse: (value) => ChallengeSummarySchema.array().safeParse(value) },
      }),

    getChallenge: async (id) =>
      send(`/api/challenges/${encodeURIComponent(id)}`, { method: 'GET', schema: PublicChallengeSchema }),

    createSession: async (challengeId) =>
      send('/api/sessions', {
        method: 'POST',
        body: validate(CreateSessionRequestSchema, { challengeId }, '创建会话请求'),
        schema: CreateSessionResponseSchema,
      }),

    sessionState: async (sessionId) =>
      send(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        schema: SessionStateResponseSchema,
        sessionScoped: true,
      }),

    actions: async (sessionId, actions) =>
      send(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, {
        method: 'POST',
        body: validate(ActionsRequestSchema, { actions }, '动作请求'),
        schema: ActionsResponseSchema,
        sessionScoped: true,
      }),

    submit: async (sessionId, actions) =>
      send(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
        method: 'POST',
        body: validate(SubmitRequestSchema, { actions }, '提交请求'),
        schema: SubmitResponseSchema,
        sessionScoped: true,
      }),

    endSession: async (sessionId) =>
      send<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        sessionScoped: true,
      }),
  };
}
