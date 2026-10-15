import { z } from 'zod';
import { RolesSchema } from './challenge';
import { ErrorCodeSchema, InstanceStatusSchema, StopReasonSchema } from './errors';
import { HexBytesSchema, HexSchema } from './hex';
import {
  LabelKindSchema,
  PermSchema,
  RegisterNameSchema,
  VmaIdSchema,
  VmaKindSchema,
} from './primitives';

/**
 * 公开投影（04 §4）：每次响应返回**完整投影**，前端对相邻两次做差分做高亮。
 *
 * 投影里永远没有：隐藏 VMA 的内容、虚拟文件内容、`win` / `fail`、`flag`。
 * 被 `reveal` 的 VMA 变成 `hidden: false` 并带上 `hex`。
 */

export const RegisterViewSchema = z.object({
  name: RegisterNameSchema,
  value: HexSchema,
});
export type RegisterView = z.infer<typeof RegisterViewSchema>;

export const FlagsViewSchema = z.object({
  ZF: z.boolean(),
  CF: z.boolean(),
  SF: z.boolean(),
});
export type FlagsView = z.infer<typeof FlagsViewSchema>;

export const VmaViewSchema = z.object({
  id: VmaIdSchema,
  kind: VmaKindSchema,
  label: z.string().optional(),
  start: HexSchema,
  size: HexSchema,
  perm: PermSchema,
  hidden: z.boolean(),
  /** 仅非隐藏 VMA 出现；隐藏区只公开布局。 */
  hex: HexBytesSchema.optional(),
});
export type VmaView = z.infer<typeof VmaViewSchema>;

export const StdinViewSchema = z.object({ hex: HexBytesSchema, pos: z.number().int().min(0) });
export type StdinView = z.infer<typeof StdinViewSchema>;

export const StdoutViewSchema = z.object({ hex: HexBytesSchema });
export type StdoutView = z.infer<typeof StdoutViewSchema>;

export const DisasmEntrySchema = z.object({
  addr: HexSchema,
  bytes: HexBytesSchema,
  text: z.string(),
  target: HexSchema.optional(),
});
export type DisasmEntry = z.infer<typeof DisasmEntrySchema>;

export const LastStopViewSchema = z.object({
  reason: StopReasonSchema,
  addr: HexSchema.optional(),
});
export type LastStopView = z.infer<typeof LastStopViewSchema>;

export const ErrorInfoSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  note: z.string().optional(),
});
export type ErrorInfoView = z.infer<typeof ErrorInfoSchema>;

export const ProjectionSchema = z.object({
  status: InstanceStatusSchema,
  steps: z.number().int().min(0),
  /** 被拒绝 + 失败的动作计数，单调递增，用于解锁提示（04 §3）。 */
  failures: z.number().int().min(0),
  registers: z.array(RegisterViewSchema),
  /**
   * 角色寄存器（`sp` / `bp` / `ip`）**随投影下发**（D1 契约决策，08 §9.2）。
   *
   * 它来自私有包的 `roles`，但它是「固定的东西」而不是运行时未知量（01 §6 第 2 条）：
   * 布局与命名公开、内容隐藏。不下发的话前端只能自己猜 `RSP` / `RBP` / `RIP`，
   * 32 位题目（`ESP / EBP / EIP`）与自定义命名的题目就标不出栈指针、帧指针和指令指针。
   *
   * 它**不放进 `public.json`**：出题人已经在私有包里声明一次，公开包再声明一次只会漂移。
   * 服务端从私有包取值后随投影下发，前端不读私有包。
   */
  roles: RolesSchema,
  flags: FlagsViewSchema,
  vmas: z.array(VmaViewSchema),
  /** 题目未声明 stdin 时省略（04 §4）。 */
  stdin: StdinViewSchema.optional(),
  stdout: StdoutViewSchema.optional(),
  disasm: z.array(DisasmEntrySchema),
  lastStop: LastStopViewSchema.optional(),
  error: ErrorInfoSchema.optional(),
});
export type Projection = z.infer<typeof ProjectionSchema>;

export const HistoryDepthSchema = z.object({
  undo: z.number().int().min(0),
  stepBack: z.number().int().min(0),
});
export type HistoryDepthView = z.infer<typeof HistoryDepthSchema>;

/**
 * 回放录像（04 §5.1）：首份完整投影 + 逐动作 diff。
 * 每帧都带寄存器与标志位（很小），VMA 只带发生变化的那些，避免几十份 256KB 投影撑爆响应。
 * 录像只含公开投影，不泄露任何新东西。
 */
export const ReplayFrameSchema = z.object({
  index: z.number().int().min(0),
  label: z.string(),
  kind: z.enum(['init', 'action', 'instruction']),
  status: InstanceStatusSchema,
  steps: z.number().int().min(0),
  failures: z.number().int().min(0),
  registers: z.array(RegisterViewSchema),
  flags: FlagsViewSchema,
  changedVmas: z.array(VmaViewSchema),
  stdin: StdinViewSchema.optional(),
  stdout: StdoutViewSchema.optional(),
  lastStop: LastStopViewSchema.optional(),
  error: ErrorInfoSchema.optional(),
});
export type ReplayFrameView = z.infer<typeof ReplayFrameSchema>;

export const ReplaySchema = z.object({
  initial: ProjectionSchema,
  frames: z.array(ReplayFrameSchema),
});
export type ReplayView = z.infer<typeof ReplaySchema>;

/** 栈视图 / 指令视图用的语义标注（03 §1）。 */
export const LabelViewSchema = z.object({
  name: z.string(),
  addr: HexSchema,
  size: z.number().int().positive(),
  kind: LabelKindSchema,
});
export type LabelView = z.infer<typeof LabelViewSchema>;
