import { z } from 'zod';
import { ActionNameSchema, ActionSchema } from './actions';
import { ChallengeIdSchema } from './challenge';
import { VerdictSchema } from './errors';
import { MAX_ACTIONS_PER_REQUEST, MAX_SUBMIT_ACTIONS } from './limits';
import {
  ErrorInfoSchema,
  HistoryDepthSchema,
  ProjectionSchema,
  ReplaySchema,
} from './projection';
import { PythonEvalErrorSchema } from './workflow/python';
import { EncodedValueSchema } from './workflow/values';

/**
 * REST 契约（04 §5）。请求体一律用 Schema 校验，客户端提交的一切都不可信（01 §6 第 3 条）。
 */

export const ChallengeSummarySchema = z.object({
  id: ChallengeIdSchema,
  title: z.string().min(1),
});
export type ChallengeSummary = z.infer<typeof ChallengeSummarySchema>;

/** 客户端请求一律 strictObject：不接受多余字段（04 §6）。 */
export const CreateSessionRequestSchema = z.strictObject({ challengeId: ChallengeIdSchema });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ActionsRequestSchema = z.strictObject({
  actions: z.array(ActionSchema).min(1).max(MAX_ACTIONS_PER_REQUEST),
});
export type ActionsRequest = z.infer<typeof ActionsRequestSchema>;

/** 提交判题的完整动作序列（编译产物，可能含 `block`，由服务端展开）。 */
export const SubmitRequestSchema = z.strictObject({
  actions: z.array(ActionSchema).min(1).max(MAX_SUBMIT_ACTIONS),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  action: ActionNameSchema,
  error: ErrorInfoSchema.optional(),
});
export type ActionResultView = z.infer<typeof ActionResultSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string().min(16),
  projection: ProjectionSchema,
  history: HistoryDepthSchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/** `GET /api/sessions/:id`：刷新页面时恢复当前状态（04 §1.1）。 */
export const SessionStateResponseSchema = z.object({
  sessionId: z.string().min(16),
  projection: ProjectionSchema,
  history: HistoryDepthSchema,
});
export type SessionStateResponse = z.infer<typeof SessionStateResponseSchema>;

export const ActionsResponseSchema = z.object({
  results: z.array(ActionResultSchema),
  executed: z.number().int().min(0),
  projection: ProjectionSchema,
  /** 回退按钮是否可用（05 §6）。 */
  history: HistoryDepthSchema,
});
export type ActionsResponse = z.infer<typeof ActionsResponseSchema>;

export const SubmitResponseSchema = z.object({
  verdict: VerdictSchema,
  executed: z.number().int().min(0),
  results: z.array(ActionResultSchema),
  replay: ReplaySchema,
  /** 仅 `verdict = won` 时出现，取自私有包的 `flag`（04 §5.1）。 */
  flag: z.string().min(1).optional(),
});
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

export const API_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'session_expired',
  'challenge_unavailable',
  'rate_limited',
  'internal',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** 错误响应不含内部堆栈、文件路径或私有包字段（04 §6）。 */
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** HTTP 状态码映射，服务端与前端共用一份。 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  not_found: 404,
  session_expired: 404,
  challenge_unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

// ---------------------------------------------------------------------------
// Python 求值（06 §6、07 §P6）
// ---------------------------------------------------------------------------

/**
 * Python 后端的可用性（`GET /api/capabilities`）。
 *
 * 前端据此**禁用** Python 节点，而不是等用户拼完图再报错。三条语义：
 * - `available === false` 时不该发起求值；`reason` 是给学习者看的中文说明。
 * - `isolated` 只在真正的隔离后端（docker）为真。普通子进程不是隔离证据（07 §2），
 *   所以 `process` 后端这里是 `false`——不要把「能跑」当成「已隔离」。
 * - `backend` 是部署配置的直接反映，前端不猜。
 */
export const PYTHON_BACKENDS = ['docker', 'process', 'none'] as const;
export type PythonBackend = (typeof PYTHON_BACKENDS)[number];

export const PythonCapabilitySchema = z.strictObject({
  available: z.boolean(),
  backend: z.enum(PYTHON_BACKENDS),
  isolated: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});
export type PythonCapability = z.infer<typeof PythonCapabilitySchema>;

/** `GET /api/capabilities`：现有题目/会话接口都不必改形状，能力查询单独一条路径。 */
export const CapabilitiesResponseSchema = z.strictObject({ python: PythonCapabilitySchema });
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

/**
 * `POST /api/python/eval` 的响应（06 §6）。
 *
 * 求值失败是**结果**而不是 HTTP 错误：`ok:false` 携带节点级错误码，前端把它显示在节点上。
 * 只有请求体本身不合法才走 `ApiError` 的 400 信封。`durationMs` 仅供诊断。
 */
export const PythonEvalResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    value: EncodedValueSchema,
    durationMs: z.number().int().min(0).optional(),
  }),
  z.strictObject({ ok: z.literal(false), error: PythonEvalErrorSchema }),
]);
export type PythonEvalResult = z.infer<typeof PythonEvalResultSchema>;
