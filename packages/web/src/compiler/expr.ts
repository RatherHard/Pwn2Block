import { isHex, parseHex } from '@pwn2block/shared';
import type { Endian } from './bytes';
import { ByteBuildError, addr, concat, int, padding, raw, string } from './bytes';
import type { CompileContext, Env, Eval } from './context';
import { consumeEvalStep, fail, ok, reportError, unknownBlockError } from './context';
import { hasField, inputBlock, readNumberField, readStringField, variadicInputs } from './fields';
import type { NormalizedBlock } from './types';
import { ARITHMETIC_OPS, BLOCK_TYPES, FIELDS, INPUTS, LOGIC_OPS } from './types';

/**
 * 表达式求值（编译期常量）。
 *
 * 两类表达式：
 * - **数值**（`evalValue`）：整数 / 地址 / 算术 / 变量，结果是 `bigint`。
 * - **字节**（`evalBytes`）：`padding` / `string` / `int` / `addr` / `raw` / `concat`，结果是字节串。
 *
 * 求值一律在编译期完成：payload 是扁平的原子动作序列，运行期没有计算能力，
 * 也**不允许**从运行状态取值（05 §4 的理由见 `types.ts`）。
 */

/** 数值表达式积木类型（用于"这里要数值却给了字节积木"这类精确报错）。 */
export const VALUE_EXPRESSION_TYPES: readonly string[] = [
  BLOCK_TYPES.mathNumber,
  BLOCK_TYPES.mathArithmetic,
  BLOCK_TYPES.logicCompare,
  BLOCK_TYPES.valueAddr,
  BLOCK_TYPES.varsGet,
];

/** 字节表达式积木类型。 */
export const BYTES_EXPRESSION_TYPES: readonly string[] = [
  BLOCK_TYPES.bytesPadding,
  BLOCK_TYPES.bytesString,
  BLOCK_TYPES.bytesInt,
  BLOCK_TYPES.bytesAddr,
  BLOCK_TYPES.bytesRaw,
  BLOCK_TYPES.bytesConcat,
];

// ---------------------------------------------------------------------------
// 求值入口
// ---------------------------------------------------------------------------

/** 求值一个数值表达式。 */
export function evalValue(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<bigint> {
  if (!consumeEvalStep(ctx, block.id)) return fail();
  switch (block.type) {
    case BLOCK_TYPES.mathNumber:
      return numberLiteral(ctx, block);
    case BLOCK_TYPES.valueAddr:
      return addressLiteral(ctx, block);
    case BLOCK_TYPES.mathArithmetic:
      return arithmetic(ctx, block, env);
    case BLOCK_TYPES.logicCompare:
      return comparison(ctx, block, env);
    case BLOCK_TYPES.varsGet:
      return variableRead(ctx, block, env);
    default:
      if (BYTES_EXPRESSION_TYPES.includes(block.type)) {
        return reportError(
          ctx,
          block.id,
          `这里需要数值表达式（整数 / 地址 / 算术 / 变量），收到字节积木 ${block.type}`,
        );
      }
      return unknownBlockError(ctx, block);
  }
}

/** 求值一个字节表达式。 */
export function evalBytes(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Uint8Array> {
  if (!consumeEvalStep(ctx, block.id)) return fail();
  switch (block.type) {
    case BLOCK_TYPES.bytesPadding:
      return bytesPadding(ctx, block, env);
    case BLOCK_TYPES.bytesString:
      return bytesString(ctx, block);
    case BLOCK_TYPES.bytesInt:
      return bytesInt(ctx, block, env);
    case BLOCK_TYPES.bytesAddr:
      return bytesAddress(ctx, block, env);
    case BLOCK_TYPES.bytesRaw:
      return bytesRaw(ctx, block);
    case BLOCK_TYPES.bytesConcat:
      return bytesConcat(ctx, block, env);
    default:
      if (VALUE_EXPRESSION_TYPES.includes(block.type)) {
        return reportError(
          ctx,
          block.id,
          `这里需要字节表达式（padding / string / int / addr / raw / concat），收到数值积木 ${block.type}`,
        );
      }
      return unknownBlockError(ctx, block);
  }
}

// ---------------------------------------------------------------------------
// 输入取用（带中文错误文案）
// ---------------------------------------------------------------------------

/** 必需的值输入。 */
export function requireValueInput(
  ctx: CompileContext,
  block: NormalizedBlock,
  input: string,
  env: Env,
  label: string,
): Eval<bigint> {
  const child = inputBlock(block, input);
  if (!child) return reportError(ctx, block.id, `缺少输入：${label}（${input}）`);
  return evalValue(ctx, child, env);
}

/** 可选的值输入：未连接时返回 `undefined`（`step` / `run` 用）。 */
export function optionalValueInput(
  ctx: CompileContext,
  block: NormalizedBlock,
  input: string,
  env: Env,
): Eval<bigint | undefined> {
  const child = inputBlock(block, input);
  if (!child) return ok(undefined);
  const value = evalValue(ctx, child, env);
  if (!value.ok) return fail();
  return ok(value.value);
}

/** 必需的字节输入。 */
export function requireBytesInput(
  ctx: CompileContext,
  block: NormalizedBlock,
  input: string,
  env: Env,
  label: string,
): Eval<Uint8Array> {
  const child = inputBlock(block, input);
  if (!child) return reportError(ctx, block.id, `缺少输入：${label}（${input}）`);
  return evalBytes(ctx, child, env);
}

/** 用于 `push` / `call` / `write_bytes` 的值：payload 只有无符号字，负值显式报错。 */
export function asNonNegative(
  ctx: CompileContext,
  block: NormalizedBlock,
  value: bigint,
  label: string,
): Eval<bigint> {
  if (value < 0n) {
    return reportError(ctx, block.id, `${label}不能为负（payload 使用无符号字）：${value.toString()}`);
  }
  return ok(value);
}

/** 非负安全整数（次数、步数、宽度这类要交给 JS 数字的量）。 */
export function asCount(
  ctx: CompileContext,
  block: NormalizedBlock,
  value: bigint,
  label: string,
): Eval<number> {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return reportError(ctx, block.id, `${label}必须是 0..${Number.MAX_SAFE_INTEGER} 之间的整数`);
  }
  return ok(Number(value));
}

// ---------------------------------------------------------------------------
// 数值表达式
// ---------------------------------------------------------------------------

function numberLiteral(ctx: CompileContext, block: NormalizedBlock): Eval<bigint> {
  const value = readNumberField(block, FIELDS.num);
  if (value === undefined || !Number.isSafeInteger(value)) {
    return reportError(ctx, block.id, `数字积木的 ${FIELDS.num} 需要整数，收到 ${String(block.fields[FIELDS.num])}`);
  }
  return ok(BigInt(value));
}

function addressLiteral(ctx: CompileContext, block: NormalizedBlock): Eval<bigint> {
  const text = readStringField(block, FIELDS.addr);
  if (text === undefined) {
    return reportError(ctx, block.id, `地址积木需要 ${FIELDS.addr} 字段（0x 前缀的十六进制）`);
  }
  const trimmed = text.trim();
  if (!isHex(trimmed)) {
    return reportError(ctx, block.id, `地址必须是 0x 前缀的十六进制，收到 ${JSON.stringify(text)}`);
  }
  return ok(parseHex(trimmed));
}

function variableRead(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<bigint> {
  const name = readStringField(block, FIELDS.variable);
  if (name === undefined || name === '') {
    return reportError(ctx, block.id, `变量积木需要 ${FIELDS.variable} 字段（变量名）`);
  }
  const value = env.get(name);
  if (value === undefined) {
    return reportError(
      ctx,
      block.id,
      `变量 ${name} 还没有被赋值：变量在编译期求值（05 §4）`,
    );
  }
  return ok(value);
}

function arithmetic(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<bigint> {
  const op = readStringField(block, FIELDS.op);
  if (op === undefined || !(ARITHMETIC_OPS as readonly string[]).includes(op)) {
    return reportError(
      ctx,
      block.id,
      `算术积木的 ${FIELDS.op} 只能是 ${ARITHMETIC_OPS.join(' / ')}，收到 ${String(op)}`,
    );
  }
  const left = requireValueInput(ctx, block, INPUTS.a, env, '左操作数');
  if (!left.ok) return left;
  const right = requireValueInput(ctx, block, INPUTS.b, env, '右操作数');
  if (!right.ok) return right;

  switch (op) {
    case 'ADD':
      return ok(left.value + right.value);
    case 'MINUS':
      return ok(left.value - right.value);
    case 'MULTIPLY':
      return ok(left.value * right.value);
    case 'DIVIDE':
      if (right.value === 0n) return reportError(ctx, block.id, '除数不能是 0');
      return ok(left.value / right.value);
    default:
      return reportError(ctx, block.id, `不支持的运算符：${op}`);
  }
}

/** `logic_compare`：编译期比较，真为 1、假为 0（条件槽按非 0 为真判断）。 */
function comparison(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<bigint> {
  const op = readStringField(block, FIELDS.op);
  if (op === undefined || !(LOGIC_OPS as readonly string[]).includes(op)) {
    return reportError(
      ctx,
      block.id,
      `比较积木的 ${FIELDS.op} 只能是 ${LOGIC_OPS.join(' / ')}，收到 ${String(op)}`,
    );
  }
  const left = requireValueInput(ctx, block, INPUTS.a, env, '左操作数');
  if (!left.ok) return left;
  const right = requireValueInput(ctx, block, INPUTS.b, env, '右操作数');
  if (!right.ok) return right;

  switch (op) {
    case 'EQ':
      return ok(left.value === right.value ? 1n : 0n);
    case 'NEQ':
      return ok(left.value !== right.value ? 1n : 0n);
    case 'LT':
      return ok(left.value < right.value ? 1n : 0n);
    case 'LTE':
      return ok(left.value <= right.value ? 1n : 0n);
    case 'GT':
      return ok(left.value > right.value ? 1n : 0n);
    case 'GTE':
      return ok(left.value >= right.value ? 1n : 0n);
    default:
      return reportError(ctx, block.id, `不支持的比较符：${op}`);
  }
}

// ---------------------------------------------------------------------------
// 字节表达式
// ---------------------------------------------------------------------------
/** 把字节原语抛出的 `ByteBuildError` 转成带积木 id 的编译错误。 */
function guarded(
  ctx: CompileContext,
  block: NormalizedBlock,
  build: () => Uint8Array,
): Eval<Uint8Array> {
  try {
    return ok(build());
  } catch (error) {
    if (error instanceof ByteBuildError) return reportError(ctx, block.id, error.message);
    throw error;
  }
}

function bytesPadding(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Uint8Array> {
  const byte = requireValueInput(ctx, block, INPUTS.byte, env, '填充字节');
  if (!byte.ok) return byte;
  const count = requireValueInput(ctx, block, INPUTS.count, env, '重复次数');
  if (!count.ok) return count;
  const fill = asCount(ctx, block, byte.value, '填充字节');
  if (!fill.ok) return fail();
  const times = asCount(ctx, block, count.value, '重复次数');
  if (!times.ok) return fail();
  return guarded(ctx, block, () => padding(fill.value, times.value));
}

function bytesString(ctx: CompileContext, block: NormalizedBlock): Eval<Uint8Array> {
  const text = readStringField(block, FIELDS.text);
  if (text === undefined) {
    return reportError(ctx, block.id, `字符串积木需要 ${FIELDS.text} 字段`);
  }
  return guarded(ctx, block, () => string(text));
}

function bytesInt(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Uint8Array> {
  const value = requireValueInput(ctx, block, INPUTS.value, env, '整数');
  if (!value.ok) return value;
  const unsigned = asNonNegative(ctx, block, value.value, '整数');
  if (!unsigned.ok) return fail();
  const width = readWidth(ctx, block);
  if (!width.ok) return fail();
  const endian = readEndian(ctx, block);
  if (!endian.ok) return fail();
  return guarded(ctx, block, () => int(unsigned.value, width.value, endian.value));
}

function bytesAddress(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Uint8Array> {
  const value = requireValueInput(ctx, block, INPUTS.value, env, '地址');
  if (!value.ok) return value;
  const unsigned = asNonNegative(ctx, block, value.value, '地址');
  if (!unsigned.ok) return fail();
  return guarded(ctx, block, () => addr(unsigned.value, ctx.wordBytes));
}

function bytesRaw(ctx: CompileContext, block: NormalizedBlock): Eval<Uint8Array> {
  const hex = readStringField(block, FIELDS.hex);
  if (hex === undefined) {
    return reportError(ctx, block.id, `raw 积木需要 ${FIELDS.hex} 字段（偶数个十六进制字符）`);
  }
  return guarded(ctx, block, () => raw(hex));
}

function bytesConcat(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Uint8Array> {
  const items = variadicInputs(block);
  if (items.length === 0) {
    return reportError(ctx, block.id, '拼接积木至少需要一个字节表达式');
  }
  const parts: Uint8Array[] = [];
  for (const item of items) {
    const part = evalBytes(ctx, item, env);
    if (!part.ok) return fail();
    parts.push(part.value);
  }
  return guarded(ctx, block, () => concat(...parts));
}

/** 宽度字段：缺省就是字长 W（05 §3.1 "宽度默认 W"）；写了就必须是 1..8 的整数。 */
function readWidth(ctx: CompileContext, block: NormalizedBlock): Eval<number> {
  if (!hasField(block, FIELDS.width)) return ok(ctx.wordBytes);
  const width = readNumberField(block, FIELDS.width);
  if (width === undefined || !Number.isInteger(width)) {
    return reportError(ctx, block.id, `宽度字段 ${FIELDS.width} 需要整数，收到 ${String(block.fields[FIELDS.width])}`);
  }
  return ok(width);
}

/** 端序字段：缺省 little（05 §3.1 默认小端）。 */
function readEndian(ctx: CompileContext, block: NormalizedBlock): Eval<Endian> {
  if (!hasField(block, FIELDS.endian)) return ok('little');
  const raw = readStringField(block, FIELDS.endian)?.toUpperCase();
  if (raw === 'LITTLE') return ok('little');
  if (raw === 'BIG') return ok('big');
  return reportError(ctx, block.id, `端序只能是 LITTLE 或 BIG，收到 ${String(block.fields[FIELDS.endian])}`);
}
