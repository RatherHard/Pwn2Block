import { z } from 'zod';
import type { AuthorBlock, AuthorParam, AuthorTemplateAction, PublicChallenge } from './challenge';
import { isPlaceholder } from './placeholders';
import { HexBytesSchema, HexSchema, formatHex, hexToBytes, parseHex } from './hex';
import { MAX_RUN_MAX_STEPS, MAX_STEP_COUNT } from './limits';

/**
 * 动作集合（04 §2）。
 *
 * 三类：
 * - **原子写 / 执行原语**：`write_bytes / push / pop / call / ret / feed / step / run`，也是客户端编译产物（05 §4）。
 * - **出题人积木**：`block`，客户端只发 `{id, args}`，展开在服务端完成（03 §3）。
 * - **回退类**：`undo / step_back / reset`，始终可用，不受 `allowedActions` 约束（04 §2）。
 */

export const ACTION_NAMES = [
  'write_bytes',
  'push',
  'pop',
  'call',
  'ret',
  'feed',
  'block',
  'step',
  'run',
  'undo',
  'step_back',
  'reset',
] as const;
export const ActionNameSchema = z.enum(ACTION_NAMES);
export type ActionName = (typeof ACTION_NAMES)[number];

export const PRIMITIVE_ACTION_TYPES = [
  'write_bytes',
  'push',
  'pop',
  'call',
  'ret',
  'feed',
  'step',
  'run',
] as const;
export type PrimitiveActionType = (typeof PRIMITIVE_ACTION_TYPES)[number];

export const CONTROL_ACTION_TYPES = ['undo', 'step_back', 'reset'] as const;
export type ControlActionType = (typeof CONTROL_ACTION_TYPES)[number];

export const BlockArgsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type BlockArgs = z.infer<typeof BlockArgsSchema>;

/**
 * 动作一律用 strictObject：客户端提交的一切都不可信，多出来的字段必须报错而不是被静默丢弃（01 §6 第 3 条）。
 */
export const WriteBytesActionSchema = z.strictObject({
  type: z.literal('write_bytes'),
  addr: HexSchema,
  hex: HexBytesSchema,
});
export const PushActionSchema = z.strictObject({ type: z.literal('push'), value: HexSchema });
export const PopActionSchema = z.strictObject({ type: z.literal('pop') });
export const CallActionSchema = z.strictObject({ type: z.literal('call'), addr: HexSchema });
export const RetActionSchema = z.strictObject({ type: z.literal('ret') });
export const FeedActionSchema = z.strictObject({ type: z.literal('feed'), hex: HexBytesSchema });
export const StepActionSchema = z.strictObject({
  type: z.literal('step'),
  count: z.number().int().min(1).max(MAX_STEP_COUNT).optional(),
});
export const RunActionSchema = z.strictObject({
  type: z.literal('run'),
  maxSteps: z.number().int().min(1).max(MAX_RUN_MAX_STEPS).optional(),
});
export const BlockActionSchema = z.strictObject({
  type: z.literal('block'),
  id: z.string().min(1).max(32),
  args: BlockArgsSchema.default({}),
});
export const UndoActionSchema = z.strictObject({ type: z.literal('undo') });
export const StepBackActionSchema = z.strictObject({ type: z.literal('step_back') });
export const ResetActionSchema = z.strictObject({ type: z.literal('reset') });

export const PrimitiveActionSchema = z.discriminatedUnion('type', [
  WriteBytesActionSchema,
  PushActionSchema,
  PopActionSchema,
  CallActionSchema,
  RetActionSchema,
  FeedActionSchema,
  StepActionSchema,
  RunActionSchema,
]);

export const ActionSchema = z.discriminatedUnion('type', [
  WriteBytesActionSchema,
  PushActionSchema,
  PopActionSchema,
  CallActionSchema,
  RetActionSchema,
  FeedActionSchema,
  StepActionSchema,
  RunActionSchema,
  BlockActionSchema,
  UndoActionSchema,
  StepBackActionSchema,
  ResetActionSchema,
]);

export type WriteBytesAction = z.infer<typeof WriteBytesActionSchema>;
export type PushAction = z.infer<typeof PushActionSchema>;
export type PopAction = z.infer<typeof PopActionSchema>;
export type CallAction = z.infer<typeof CallActionSchema>;
export type RetAction = z.infer<typeof RetActionSchema>;
export type FeedAction = z.infer<typeof FeedActionSchema>;
export type StepAction = z.infer<typeof StepActionSchema>;
export type RunAction = z.infer<typeof RunActionSchema>;
export type BlockAction = z.infer<typeof BlockActionSchema>;
export type ControlAction = z.infer<
  typeof UndoActionSchema | typeof StepBackActionSchema | typeof ResetActionSchema
>;
export type PrimitiveAction = z.infer<typeof PrimitiveActionSchema>;
export type Action = z.infer<typeof ActionSchema>;

export function isPrimitiveAction(action: Action): action is PrimitiveAction {
  return (PRIMITIVE_ACTION_TYPES as readonly string[]).includes(action.type);
}

export function isControlAction(action: Action): action is ControlAction {
  return (CONTROL_ACTION_TYPES as readonly string[]).includes(action.type);
}

export function isBlockAction(action: Action): action is BlockAction {
  return action.type === 'block';
}

/** `step` 默认执行 1 条指令（04 §2）。 */
export function stepCount(action: StepAction): number {
  return action.count ?? 1;
}

/** `run` 默认最多跑到单次运行步数上限（02 §6）。 */
export function runMaxSteps(action: RunAction): number {
  return action.maxSteps ?? MAX_RUN_MAX_STEPS;
}

/**
 * 回退类动作不受 `allowedActions` 约束（04 §2）。
 *
 * 出题人积木（`block`）同样始终可用：03 §3 明确"出题人积木的展开动作不受 `allowedActions`
 * 限制，这是它存在的意义"——出题人正是靠它做到"禁用裸 `write_bytes`，只允许通过 `gets` 溢出"。
 * 积木本身的合法性由 `expandBlock` 按 `authorBlocks` 校验，未声明的 id 回 `unknown_action`，
 * 所以这里放宽不会开一个后门。
 */
export function isAllowedByChallenge(pub: PublicChallenge, name: ActionName): boolean {
  if ((CONTROL_ACTION_TYPES as readonly string[]).includes(name)) return true;
  if (name === 'block') return true;
  return pub.allowedActions.includes(name);
}

// ---------------------------------------------------------------------------
// 出题人积木的服务端展开（03 §3 / 04 §5.1）
// ---------------------------------------------------------------------------

export type BlockExpansion =
  | { readonly ok: true; readonly actions: readonly PrimitiveAction[] }
  | { readonly ok: false; readonly code: 'unknown_action' | 'invalid_arguments'; readonly detail: string };

type SlotKind = 'addr' | 'value' | 'bytes' | 'int';

/** 每种模板动作里，字段应该被解释成什么（占位符代入时的类型对齐）。 */
const SLOT_KINDS: Readonly<Record<PrimitiveActionType, Readonly<Record<string, SlotKind>>>> = {
  write_bytes: { addr: 'addr', hex: 'bytes' },
  push: { value: 'value' },
  pop: {},
  call: { addr: 'addr' },
  ret: {},
  feed: { hex: 'bytes' },
  step: { count: 'int' },
  run: { maxSteps: 'int' },
};

interface ResolvedArg {
  readonly type: AuthorParam['type'];
  readonly bytes?: string;
  readonly hex?: string;
  readonly value?: bigint;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function resolveArg(param: AuthorParam, raw: string | number): ParseResult<ResolvedArg> {
  switch (param.type) {
    case 'bytes': {
      const parsed = HexBytesSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, detail: `参数 ${param.name} 需要偶数字节的 hex 字符串` };
      return { ok: true, value: { type: 'bytes', bytes: parsed.data } };
    }
    case 'addr': {
      const parsed = HexSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, detail: `参数 ${param.name} 需要 0x 前缀的地址` };
      return { ok: true, value: { type: 'addr', hex: parsed.data } };
    }
    case 'int': {
      if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw) || raw < 0) {
          return { ok: false, detail: `参数 ${param.name} 需要非负安全整数` };
        }
        return { ok: true, value: { type: 'int', value: BigInt(raw) } };
      }
      const parsed = HexSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, detail: `参数 ${param.name} 需要整数或 0x 前缀的十六进制` };
      }
      return { ok: true, value: { type: 'int', value: parseHex(parsed.data) } };
    }
  }
}

function slotValue(slot: SlotKind, arg: ResolvedArg, name: string): ParseResult<string | number> {
  if (slot === 'bytes') {
    if (arg.type !== 'bytes' || arg.bytes === undefined) {
      return { ok: false, detail: `参数 ${name} 的类型与积木模板不匹配（这里需要字节串）` };
    }
    return { ok: true, value: arg.bytes };
  }
  if (slot === 'int') {
    if (arg.type !== 'int' || arg.value === undefined) {
      return { ok: false, detail: `参数 ${name} 的类型与积木模板不匹配（这里需要整数）` };
    }
    return { ok: true, value: Number(arg.value) };
  }
  // addr / value：接受地址与整数两类参数
  if (arg.type === 'addr' && arg.hex !== undefined) return { ok: true, value: arg.hex };
  if (arg.type === 'int' && arg.value !== undefined) return { ok: true, value: formatHex(arg.value) };
  return { ok: false, detail: `参数 ${name} 的类型与积木模板不匹配（这里需要地址或整数）` };
}

function buildTemplateAction(
  template: AuthorTemplateAction,
  args: ReadonlyMap<string, ResolvedArg>,
): ParseResult<PrimitiveAction> {
  const slots = SLOT_KINDS[template.type];
  const built: Record<string, unknown> = { type: template.type };
  const source = template as unknown as Record<string, unknown>;

  for (const [field, slot] of Object.entries(slots)) {
    const raw = source[field];
    if (raw === undefined) continue;
    if (typeof raw === 'string' && isPlaceholder(raw)) {
      const name = raw.slice(1);
      const arg = args.get(name);
      if (!arg) return { ok: false, detail: `模板引用了未声明的参数 $${name}` };
      const value = slotValue(slot, arg, name);
      if (!value.ok) return value;
      built[field] = value.value;
      continue;
    }
    built[field] = raw;
  }

  const parsed = PrimitiveActionSchema.safeParse(built);
  if (!parsed.success) {
    return { ok: false, detail: `展开结果不是合法动作：${parsed.error.issues[0]?.message ?? '未知原因'}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 把一个 `block` 动作展开成原子动作序列。
 *
 * **这是唯一的展开入口**：服务端自己展开，客户端提交的展开结果一律不采信（01 §6 第 3 条）。
 * 出题人积木的展开动作不受 `allowedActions` 限制，这是它存在的意义（03 §3）。
 */
export function expandBlock(pub: PublicChallenge, action: BlockAction): BlockExpansion {
  const block: AuthorBlock | undefined = (pub.authorBlocks ?? []).find((b) => b.id === action.id);
  if (!block) {
    return { ok: false, code: 'unknown_action', detail: `未声明的出题人积木：${action.id}` };
  }

  const declared = new Set(block.params.map((param) => param.name));
  for (const param of block.params) {
    if (!(param.name in action.args)) {
      return { ok: false, code: 'invalid_arguments', detail: `缺少参数 ${param.name}` };
    }
  }
  for (const key of Object.keys(action.args)) {
    if (!declared.has(key)) {
      return { ok: false, code: 'invalid_arguments', detail: `未声明的参数 ${key}` };
    }
  }

  const resolved = new Map<string, ResolvedArg>();
  for (const param of block.params) {
    const resolvedArg = resolveArg(param, action.args[param.name] as string | number);
    if (!resolvedArg.ok) {
      return { ok: false, code: 'invalid_arguments', detail: resolvedArg.detail };
    }
    resolved.set(param.name, resolvedArg.value);
  }

  const actions: PrimitiveAction[] = [];
  for (const template of block.expand) {
    const built = buildTemplateAction(template, resolved);
    if (!built.ok) {
      return { ok: false, code: 'invalid_arguments', detail: built.detail };
    }
    actions.push(built.value);
  }
  return { ok: true, actions };
}

/** `write_bytes` 的字节长度，投影与校验都会用到。 */
export function actionByteLength(action: WriteBytesAction): number {
  return hexToBytes(action.hex).length;
}
