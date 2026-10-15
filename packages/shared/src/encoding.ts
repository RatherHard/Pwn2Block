import { z } from 'zod';
import { REGISTER_NAME_RE } from './primitives';

/**
 * 指令编码表：出题人声明「1 字节 opcode ↔ 内置作用 + 操作数形态」（02 §4）。
 * 表本身公开：学习者要靠它理解机器码、寻找 gadget。
 */

/** 内置指令作用，封闭集（02 §4.1）。 */
export const OP_NAMES = [
  'mov',
  'push',
  'pop',
  'add',
  'sub',
  'cmp',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'jmp',
  'je',
  'jne',
  'jb',
  'jae',
  'call',
  'ret',
  'leave',
  'syscall',
  'nop',
] as const;
export const OpNameSchema = z.enum(OP_NAMES);
export type OpName = (typeof OP_NAMES)[number];

/** 操作数形态：`reg:R` / `const:N` / `imm` / `mem:R+disp`（02 §4）。 */
export const OPERAND_RE = new RegExp(
  `^(reg:${REGISTER_NAME_RE.source.slice(1, -1)}|const:(?:0|[1-9][0-9]*)|imm|mem:${REGISTER_NAME_RE.source.slice(1, -1)}\\+disp)$`,
);

export const OperandSchema = z
  .string()
  .regex(OPERAND_RE, '操作数形态只能是 reg:R / const:N / imm / mem:R+disp');
export type Operand = z.infer<typeof OperandSchema>;

export const OpcodeSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{2}$/, 'opcode 必须是 0x 前缀的两位十六进制')
  .transform((v) => v.toLowerCase());
export type Opcode = z.infer<typeof OpcodeSchema>;

export const EncodingItemSchema = z.object({
  opcode: OpcodeSchema,
  op: OpNameSchema,
  operands: z.array(OperandSchema).max(3),
  /** 显示名，默认取 `op` 加操作数（02 §4）。 */
  mnemonic: z.string().min(1).max(48).optional(),
});
export type EncodingItem = z.infer<typeof EncodingItemSchema>;

/** 引用默认编码表：`{ preset, add, remove }`（06 §2.1）。 */
export const EncodingSpecSchema = z.object({
  preset: z.string().min(1).max(64),
  add: z.array(EncodingItemSchema).optional(),
  remove: z.array(OpcodeSchema).optional(),
});
export type EncodingSpec = z.infer<typeof EncodingSpecSchema>;

/** 公开包里的 `encoding`：完整表或 preset 引用，加载时统一展开成完整表再下发。 */
export const EncodingSchema = z.union([EncodingSpecSchema, z.array(EncodingItemSchema).min(1)]);
export type Encoding = z.infer<typeof EncodingSchema>;

export function isEncodingSpec(encoding: Encoding): encoding is EncodingSpec {
  return !Array.isArray(encoding);
}

export function operandRegister(operand: Operand): string | undefined {
  if (operand.startsWith('reg:')) return operand.slice(4);
  if (operand.startsWith('mem:')) return operand.slice(4, operand.indexOf('+disp'));
  return undefined;
}

export function operandConst(operand: Operand): number | undefined {
  return operand.startsWith('const:') ? Number.parseInt(operand.slice(6), 10) : undefined;
}

export function isImm(operand: Operand): boolean {
  return operand === 'imm';
}

export function isMemOperand(operand: Operand): boolean {
  return operand.startsWith('mem:');
}

export function opcodeToNumber(opcode: Opcode): number {
  return Number.parseInt(opcode.slice(2), 16);
}

/**
 * 展开 `{ preset, add, remove }`：preset 由调用方从 `presets/<name>.json` 读出（shared 不做文件 IO）。
 * 同一 opcode 重复声明视为题目包错误，直接抛出，避免出现两套解码结果。
 */
export function expandEncoding(
  encoding: Encoding,
  presetItems?: readonly EncodingItem[],
): EncodingItem[] {
  if (!isEncodingSpec(encoding)) return [...encoding];

  if (!presetItems) {
    throw new Error(`题目引用了 preset「${encoding.preset}」，但没有提供该编码表内容`);
  }

  const removed = new Set((encoding.remove ?? []).map((op) => op.toLowerCase()));
  const out = presetItems.filter((item) => !removed.has(item.opcode));
  const seen = new Set(out.map((item) => item.opcode));

  for (const item of encoding.add ?? []) {
    if (seen.has(item.opcode)) {
      throw new Error(`编码表里 opcode ${item.opcode} 重复声明（先 remove 再 add）`);
    }
    seen.add(item.opcode);
    out.push(item);
  }
  return out;
}

/** 编码表查询视图：解码器（engine）与汇编器（authoring）共用同一份语义。 */
export interface EncodingLookup {
  readonly items: readonly EncodingItem[];
  byOpcode(opcode: number): EncodingItem | undefined;
  findByOp(op: OpName): readonly EncodingItem[];
  find(op: OpName, operands: readonly Operand[]): EncodingItem | undefined;
  mnemonicFor(item: EncodingItem): string;
  /** 立即数 / 位移的字节宽度：`archBits / 8`（02 §4）。 */
  readonly wordBytes: number;
}

function operandsEqual(a: readonly Operand[], b: readonly Operand[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 默认伪汇编渲染：`const:N`、`reg:R` 按字面显示，立即数用 `imm` 占位（解码器会换成真实值）。 */
export function renderMnemonic(item: EncodingItem, rendered?: readonly string[]): string {
  if (rendered) {
    return rendered.length > 0 ? `${item.op} ${rendered.join(', ')}` : item.op;
  }
  if (item.mnemonic) return item.mnemonic;
  if (item.operands.length === 0) return item.op;
  const text = item.operands
    .map((operand) => {
      if (operand.startsWith('reg:')) return operand.slice(4);
      if (operand.startsWith('const:')) return operand.slice(6);
      if (operand === 'imm') return 'imm';
      return `[${operandRegister(operand)}+disp]`;
    })
    .join(', ');
  return `${item.op} ${text}`;
}

export function buildEncodingLookup(
  items: readonly EncodingItem[],
  wordBytes: number,
): EncodingLookup {
  const byOpcode = new Map<number, EncodingItem>();
  for (const item of items) {
    const code = opcodeToNumber(item.opcode);
    if (byOpcode.has(code)) throw new Error(`编码表里 opcode ${item.opcode} 重复`);
    byOpcode.set(code, item);
  }

  return {
    items,
    wordBytes,
    byOpcode: (opcode) => byOpcode.get(opcode & 0xff),
    findByOp: (op) => items.filter((item) => item.op === op),
    find: (op, operands) =>
      items.find((item) => item.op === op && operandsEqual(item.operands, operands)),
    mnemonicFor: (item) => renderMnemonic(item),
  };
}
