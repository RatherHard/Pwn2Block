import { z } from 'zod';
import type { EncodingItemSchema} from './encoding';
import { EncodingSchema, OpNameSchema, OperandSchema } from './encoding';
import { ErrorCodeSchema } from './errors';
import { HexBytesSchema, HexSchema } from './hex';
import {
  MAX_CONTAINS_BYTES,
  MAX_FILE_BYTES,
  MAX_PREDICATE_DEPTH,
  MAX_REGISTERS,
  MAX_SYSCALL_COUNT,
} from './limits';
import {
  ArchBitsSchema,
  FdKindSchema,
  LabelSchema,
  PermSchema,
  RegisterNameSchema,
  VmaIdSchema,
  VmaKindSchema,
} from './primitives';

/**
 * 题目包格式（03）。公开包 `public.json` 原样下发给浏览器；私有包 `private.json` 只在服务端读取。
 * 这里只做形状与字段级约束；跨字段、跨包的语义校验在 `validate.ts`。
 */

export const CHALLENGE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ChallengeIdSchema = z
  .string()
  .regex(CHALLENGE_ID_RE, '题目 id 必须小写字母开头，可含数字和连字符，不超过 32 位');

// ---------------------------------------------------------------------------
// syscall（02 §5）
// ---------------------------------------------------------------------------

export const SyscallAbiSchema = z.object({
  nr: RegisterNameSchema,
  args: z.array(RegisterNameSchema).max(3),
  ret: RegisterNameSchema,
});
export type SyscallAbi = z.infer<typeof SyscallAbiSchema>;

/** `custom` 的效果原语，封闭四件套（02 §5.2）。 */
export const SyscallEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_reg'), reg: RegisterNameSchema, value: HexSchema }),
  z.object({ type: z.literal('reveal'), vma: VmaIdSchema }),
  z.object({
    type: z.literal('copy'),
    src: HexSchema,
    dst: HexSchema,
    len: z.number().int().min(1).max(MAX_SYSCALL_COUNT),
  }),
  z.object({ type: z.literal('exit'), code: HexSchema.optional() }),
]);
export type SyscallEffect = z.infer<typeof SyscallEffectSchema>;

export const SyscallSchema = z.discriminatedUnion('kind', [
  z.object({
    nr: z.number().int().min(0).max(0xffff),
    name: z.string().min(1).max(32),
    doc: z.string().max(200).optional(),
    kind: z.literal('read'),
  }),
  z.object({
    nr: z.number().int().min(0).max(0xffff),
    name: z.string().min(1).max(32),
    doc: z.string().max(200).optional(),
    kind: z.literal('write'),
  }),
  z.object({
    nr: z.number().int().min(0).max(0xffff),
    name: z.string().min(1).max(32),
    doc: z.string().max(200).optional(),
    kind: z.literal('exit'),
  }),
  z.object({
    nr: z.number().int().min(0).max(0xffff),
    name: z.string().min(1).max(32),
    doc: z.string().max(200).optional(),
    kind: z.literal('custom'),
    effects: z.array(SyscallEffectSchema).min(1).max(16),
  }),
]);
export type Syscall = z.infer<typeof SyscallSchema>;

/** fd 表：开局就已打开，MVP 不做 open / close（02 §5.3）。 */
export const FdSchema = z.object({
  fd: z.number().int().min(0).max(255),
  name: z.string().min(1).max(64),
  kind: FdKindSchema,
  size: z.number().int().positive().max(MAX_FILE_BYTES).optional(),
});
export type Fd = z.infer<typeof FdSchema>;

// ---------------------------------------------------------------------------
// 出题人积木（03 §3）
// ---------------------------------------------------------------------------

export const AUTHOR_PARAM_TYPES = ['bytes', 'int', 'addr'] as const;
export const AuthorParamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, '参数名小写字母开头，不超过 16 位'),
  type: z.enum(AUTHOR_PARAM_TYPES),
});
export type AuthorParam = z.infer<typeof AuthorParamSchema>;

/** 模板里的参数占位符：`$data`，定义在 `placeholders.ts`，避免与展开器互相 import 成环。 */
import { PlaceholderSchema } from './placeholders';

const TemplateHexSchema = z.union([HexSchema, PlaceholderSchema]);
const TemplateBytesSchema = z.union([HexBytesSchema, PlaceholderSchema]);
const TemplateIntSchema = z.union([z.number().int().min(0), PlaceholderSchema]);

/**
 * 出题人积木的展开模板：只能由参数化的原子动作组成，没有控制流、没有回调（01 §6 第 4 条）。
 * `Custom` 效果与这里都只收常量，题目包是数据不是脚本。
 */
export const AuthorTemplateActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('write_bytes'), addr: TemplateHexSchema, hex: TemplateBytesSchema }),
  z.object({ type: z.literal('push'), value: TemplateHexSchema }),
  z.object({ type: z.literal('pop') }),
  z.object({ type: z.literal('call'), addr: TemplateHexSchema }),
  z.object({ type: z.literal('ret') }),
  z.object({ type: z.literal('feed'), hex: TemplateBytesSchema }),
  z.object({ type: z.literal('step'), count: TemplateIntSchema.optional() }),
  z.object({ type: z.literal('run'), maxSteps: TemplateIntSchema.optional() }),
]);
export type AuthorTemplateAction = z.infer<typeof AuthorTemplateActionSchema>;

export const AuthorBlockSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, '积木 id 小写字母开头，不超过 32 位'),
  label: z.string().min(1).max(64),
  tooltip: z.string().max(200).optional(),
  params: z.array(AuthorParamSchema).max(8),
  expand: z.array(AuthorTemplateActionSchema).min(1).max(32),
});
export type AuthorBlock = z.infer<typeof AuthorBlockSchema>;

export const HintSchema = z.object({
  text: z.string().min(1).max(500),
  unlockAfterFailures: z.number().int().min(1).max(1000).optional(),
});
export type Hint = z.infer<typeof HintSchema>;

// ---------------------------------------------------------------------------
// 判题谓词（03 §2.1）
// ---------------------------------------------------------------------------

export type Predicate =
  | { reg_eq: { reg: string; value: string } }
  | { mem_eq: { addr: string; hex: string } }
  | { mem_contains: { vma: string; hex: string } }
  | { stdout_contains: { hex: string } }
  | { exited: { code?: string } }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

const containsBytesSchema = HexBytesSchema.refine(
  (hex) => hex.length / 2 <= MAX_CONTAINS_BYTES,
  `最多 ${MAX_CONTAINS_BYTES} 字节`,
);

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ reg_eq: z.object({ reg: RegisterNameSchema, value: HexSchema }) }),
    z.object({ mem_eq: z.object({ addr: HexSchema, hex: HexBytesSchema }) }),
    z.object({ mem_contains: z.object({ vma: VmaIdSchema, hex: containsBytesSchema }) }),
    z.object({ stdout_contains: z.object({ hex: containsBytesSchema }) }),
    z.object({ exited: z.object({ code: HexSchema.optional() }) }),
    z.object({ all: z.array(PredicateSchema).min(1).max(16) }),
    z.object({ any: z.array(PredicateSchema).min(1).max(16) }),
    z.object({ not: PredicateSchema }),
  ]),
) as unknown as z.ZodType<Predicate>;

export function predicateDepth(predicate: Predicate): number {
  if ('all' in predicate) return 1 + Math.max(0, ...predicate.all.map(predicateDepth));
  if ('any' in predicate) return 1 + Math.max(0, ...predicate.any.map(predicateDepth));
  if ('not' in predicate) return 1 + predicateDepth(predicate.not);
  return 1;
}

export function predicateRegisters(predicate: Predicate, out: string[] = []): string[] {
  if ('reg_eq' in predicate) out.push(predicate.reg_eq.reg);
  else if ('all' in predicate) predicate.all.forEach((p) => predicateRegisters(p, out));
  else if ('any' in predicate) predicate.any.forEach((p) => predicateRegisters(p, out));
  else if ('not' in predicate) predicateRegisters(predicate.not, out);
  return out;
}

export function predicateVmas(predicate: Predicate, out: string[] = []): string[] {
  if ('mem_contains' in predicate) out.push(predicate.mem_contains.vma);
  else if ('all' in predicate) predicate.all.forEach((p) => predicateVmas(p, out));
  else if ('any' in predicate) predicate.any.forEach((p) => predicateVmas(p, out));
  else if ('not' in predicate) predicateVmas(predicate.not, out);
  return out;
}

export function predicateDepthExceeds(predicate: Predicate): boolean {
  return predicateDepth(predicate) > MAX_PREDICATE_DEPTH;
}

// ---------------------------------------------------------------------------
// 公开包（03 §1）
// ---------------------------------------------------------------------------

export const PublicChallengeSchema = z.strictObject({
  id: ChallengeIdSchema,
  title: z.string().min(1).max(80),
  briefing: z.string().min(1).max(20_000),
  archBits: ArchBitsSchema,
  encoding: EncodingSchema,
  syscallAbi: SyscallAbiSchema.optional(),
  syscalls: z.array(SyscallSchema).max(64).optional(),
  fds: z.array(FdSchema).max(16).optional(),
  labels: z.array(LabelSchema).max(256).optional(),
  allowedActions: z.array(z.string().min(1)).min(1).max(16),
  authorBlocks: z.array(AuthorBlockSchema).max(32).optional(),
  hints: z.array(HintSchema).max(16).optional(),
  errorNotes: z.record(z.string(), z.string().min(1).max(500)).optional(),
});
export type PublicChallenge = z.infer<typeof PublicChallengeSchema>;

// ---------------------------------------------------------------------------
// 私有包（03 §2）
// ---------------------------------------------------------------------------

export const RolesSchema = z.object({
  sp: RegisterNameSchema,
  bp: RegisterNameSchema,
  ip: RegisterNameSchema,
});
export type Roles = z.infer<typeof RolesSchema>;

export const InitPatchSchema = z.object({ at: HexSchema, hex: HexBytesSchema });
export type InitPatch = z.infer<typeof InitPatchSchema>;

/**
 * VMA 用 strictObject：`hidden` 之类的字段写错名字会被静默忽略，
 * 结果就是“本该藏起来的内容进了投影”，所以这里必须报错而不是容忍。
 */
export const VmaSchema = z.strictObject({
  id: VmaIdSchema,
  kind: VmaKindSchema,
  label: z.string().min(1).max(32).optional(),
  start: HexSchema,
  size: HexSchema,
  perm: PermSchema,
  hidden: z.boolean(),
  init: z.array(InitPatchSchema).max(256).optional(),
});
export type ChallengeVma = z.infer<typeof VmaSchema>;

export const PrivateChallengeSchema = z.strictObject({
  registers: z.array(RegisterNameSchema).min(1).max(MAX_REGISTERS),
  roles: RolesSchema,
  initRegisters: z.record(z.string(), HexSchema).optional(),
  vmas: z.array(VmaSchema).min(1).max(32),
  files: z.record(z.string(), z.object({ hex: HexBytesSchema })).optional(),
  win: PredicateSchema,
  fail: z.array(PredicateSchema).max(16).optional(),
  /** 固定 flag 值，或 `env:FLAG_<ID>` 引用环境变量（06 §6）。 */
  flag: z.string().min(1).max(256),
});
export type PrivateChallenge = z.infer<typeof PrivateChallengeSchema>;

// ---------------------------------------------------------------------------
// 公开包里被引用的寄存器（跨包校验用，03 §2.2）
// ---------------------------------------------------------------------------

/** 公开包中提到的所有寄存器名：调用约定、custom 效果、编码表操作数。 */
export function publicReferencedRegisters(pub: PublicChallenge): string[] {
  const out = new Set<string>();
  if (pub.syscallAbi) {
    out.add(pub.syscallAbi.nr);
    out.add(pub.syscallAbi.ret);
    for (const arg of pub.syscallAbi.args) out.add(arg);
  }
  for (const syscall of pub.syscalls ?? []) {
    if (syscall.kind !== 'custom') continue;
    for (const effect of syscall.effects) {
      if (effect.type === 'set_reg') out.add(effect.reg);
    }
  }
  const items = Array.isArray(pub.encoding) ? pub.encoding : (pub.encoding.add ?? []);
  for (const item of items) {
    for (const operand of item.operands) {
      if (operand.startsWith('reg:')) out.add(operand.slice(4));
      else if (operand.startsWith('mem:')) out.add(operand.slice(4, operand.indexOf('+disp')));
    }
  }
  return [...out];
}

export function isSyscallOp(item: z.infer<typeof EncodingItemSchema>): boolean {
  return item.op === 'syscall';
}

export function isKnownOpName(op: string): boolean {
  return OpNameSchema.safeParse(op).success;
}

export function isKnownOperand(operand: string): boolean {
  return OperandSchema.safeParse(operand).success;
}

export function isKnownErrorCode(code: string): boolean {
  return ErrorCodeSchema.safeParse(code).success;
}
