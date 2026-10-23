import { CANVAS_MAX_INT_BITS } from '../limits';
import { lengthOf } from './collection';
import {
  binaryOperatorSpec,
  unaryOperatorSpec,
  type BinaryOperator,
  type BinaryOperatorSpec,
  type UnaryOperator,
  type UnaryOperatorSpec,
} from './operators';
import { fail, ok, type CanvasResult } from './result';
import {
  VALUE_KIND_LABELS,
  boolValue,
  checkValue,
  doubleValue,
  intValue,
  valueTypeName,
  type Value,
  type ValueKind,
} from './value';

/**
 * 二元 / 一元运算的求值（需求 §2.3、§4.2）。
 *
 * 目录（`operators.ts`）说「有哪些运算、吃什么类型」，这里只负责算：
 *
 * - **不做隐式转换**：整数配浮点、整数配文本一律报错，要混用必须显式经过转换节点。
 *   错误文案带上运算中文名与左右实际类型，学习者能直接看到是哪一边接错了。
 * - **整数是 `bigint`**：整除向零截断、取余的符号跟着被除数（与 Python 的 `//`、`%` 不同，
 *   但与 C 语义一致）；位运算按无限宽二补码，负数允许。
 * - **移位量必须在 `0..CANVAS_MAX_INT_BITS` 内**：先验上限再算，不让大 bigint 撑爆内存；
 *   左移的结果若超位宽，由 `checkValue` 报错而不是悄悄截断。
 * - **浮点除零与溢出都报错**，不产生 `Infinity`／`NaN`：值域里只有有限浮点数。
 * - 所有结果在返回前都过 `checkValue`，失败返回 `fail(reason)`。
 *
 * `decidedByLeft` 单独给短路用：左侧足以决定结果时返回那个布尔值，否则返回 `undefined`
 * 表示「右侧还得算」。它**不**替调用方报类型错——类型不对就走正常求值路径报错。
 */

// ---------------------------------------------------------------------------
// 二元运算
// ---------------------------------------------------------------------------

export function applyBinary(op: BinaryOperator, left: Value, right: Value): CanvasResult<Value> {
  const spec = binaryOperatorSpec(op);
  // 目录里每个运算只吃一种值种类，按接收类型分派；具体运算在各自家族里再 switch。
  switch (spec.left) {
    case 'int':
      return applyIntBinary(spec, left, right);
    case 'double':
      return applyDoubleBinary(spec, left, right);
    case 'bool':
      return applyBoolBinary(spec, left, right);
    default:
      return fail(`「${spec.label}」不支持${VALUE_KIND_LABELS[spec.left]}运算`);
  }
}

/** 类型不匹配的文案：`「整数加」需要两边都是整数，左边是文本`。 */
function operandMismatch(spec: BinaryOperatorSpec, side: string, value: Value): string {
  return `「${spec.label}」需要两边都是${VALUE_KIND_LABELS[spec.left]}，${side}是${valueTypeName(value)}`;
}

function applyIntBinary(spec: BinaryOperatorSpec, left: Value, right: Value): CanvasResult<Value> {
  if (left.kind !== 'int') return fail(operandMismatch(spec, '左边', left));
  if (right.kind !== 'int') return fail(operandMismatch(spec, '右边', right));
  return applyIntValues(spec, left.value, right.value);
}

function applyDoubleBinary(spec: BinaryOperatorSpec, left: Value, right: Value): CanvasResult<Value> {
  if (left.kind !== 'double') return fail(operandMismatch(spec, '左边', left));
  if (right.kind !== 'double') return fail(operandMismatch(spec, '右边', right));
  return applyDoubleValues(spec, left.value, right.value);
}

function applyBoolBinary(spec: BinaryOperatorSpec, left: Value, right: Value): CanvasResult<Value> {
  if (left.kind !== 'bool') return fail(operandMismatch(spec, '左边', left));
  if (right.kind !== 'bool') return fail(operandMismatch(spec, '右边', right));
  return applyBoolValues(spec, left.value, right.value);
}

/**
 * 整数运算：`/` 与 `%` 直接沿用 bigint 的语义。
 *
 * JS 的 bigint 除以零会抛 `RangeError`，所以先判零再算——求值只能返回 `fail`，不能抛异常
 * 把整张图的求值打断。
 */
function applyIntValues(spec: BinaryOperatorSpec, left: bigint, right: bigint): CanvasResult<Value> {
  switch (spec.op) {
    case 'int.add':
      return finishInt(left + right);
    case 'int.sub':
      return finishInt(left - right);
    case 'int.mul':
      return finishInt(left * right);
    case 'int.div':
      if (right === 0n) return fail(`「${spec.label}」的除数不能为 0`);
      // bigint 的 `/` 就是向零截断：-7n / 2n === -3n。
      return finishInt(left / right);
    case 'int.mod':
      if (right === 0n) return fail(`「${spec.label}」的除数不能为 0`);
      // bigint 的 `%` 余数符号跟着被除数：-7n % 2n === -1n。
      return finishInt(left % right);
    case 'int.and':
      return finishInt(left & right);
    case 'int.or':
      return finishInt(left | right);
    case 'int.xor':
      return finishInt(left ^ right);
    case 'int.shl':
    case 'int.shr':
      return shiftInt(spec, left, right);
    case 'int.eq':
      return finish(boolValue(left === right));
    case 'int.ne':
      return finish(boolValue(left !== right));
    case 'int.lt':
      return finish(boolValue(left < right));
    case 'int.le':
      return finish(boolValue(left <= right));
    case 'int.gt':
      return finish(boolValue(left > right));
    case 'int.ge':
      return finish(boolValue(left >= right));
    default:
      return fail(`「${spec.label}」不是整数运算`);
  }
}

/** 移位：先验移位量范围再算；`>>` 对 bigint 是算术右移（负数向下取整）。 */
function shiftInt(spec: BinaryOperatorSpec, left: bigint, amount: bigint): CanvasResult<Value> {
  if (amount < 0n) return fail(`「${spec.label}」的移位量不能为负，收到 ${amount.toString(10)}`);
  if (amount > BigInt(CANVAS_MAX_INT_BITS)) {
    return fail(`「${spec.label}」的移位量 ${amount.toString(10)} 超过上限 ${CANVAS_MAX_INT_BITS}`);
  }
  return finishInt(spec.op === 'int.shl' ? left << amount : left >> amount);
}

/**
 * 浮点运算与比较。
 *
 * 值域里没有 `NaN`（构造器与 `checkValue` 挡住），所以比较直接用 `===` / `<` 等：
 * 除零与溢出都先于比较报错，不会让 `Infinity` 参与比较。
 */
function applyDoubleValues(spec: BinaryOperatorSpec, left: number, right: number): CanvasResult<Value> {
  switch (spec.op) {
    case 'double.add':
      return finish(doubleValue(left + right));
    case 'double.sub':
      return finish(doubleValue(left - right));
    case 'double.mul':
      return finish(doubleValue(left * right));
    case 'double.div':
      if (right === 0) return fail(`「${spec.label}」的除数不能为 0`);
      return finish(doubleValue(left / right));
    case 'double.eq':
      return finish(boolValue(left === right));
    case 'double.ne':
      return finish(boolValue(left !== right));
    case 'double.lt':
      return finish(boolValue(left < right));
    case 'double.le':
      return finish(boolValue(left <= right));
    case 'double.gt':
      return finish(boolValue(left > right));
    case 'double.ge':
      return finish(boolValue(left >= right));
    default:
      return fail(`「${spec.label}」不是浮点运算`);
  }
}

function applyBoolValues(spec: BinaryOperatorSpec, left: boolean, right: boolean): CanvasResult<Value> {
  switch (spec.op) {
    case 'bool.and':
      return finish(boolValue(left && right));
    case 'bool.or':
      return finish(boolValue(left || right));
    default:
      return fail(`「${spec.label}」不是布尔运算`);
  }
}

/** 布尔短路的左侧判定：返回 undefined 表示必须继续求值右侧。 */
export function decidedByLeft(op: BinaryOperator, left: Value): Value | undefined {
  if (op !== 'bool.and' && op !== 'bool.or') return undefined;
  // 左边不是布尔时不在这里报错：让调用方走正常求值路径，由 applyBinary 给出带类型的错误。
  if (left.kind !== 'bool') return undefined;
  if (op === 'bool.and') return left.value ? undefined : boolValue(false);
  return left.value ? boolValue(true) : undefined;
}

// ---------------------------------------------------------------------------
// 一元运算
// ---------------------------------------------------------------------------

export function applyUnary(op: UnaryOperator, operand: Value): CanvasResult<Value> {
  const spec = unaryOperatorSpec(op);
  switch (op) {
    case 'bool.not':
      return applyNot(spec, operand);
    case 'length':
      return applyLength(operand);
  }
}

function applyNot(spec: UnaryOperatorSpec, operand: Value): CanvasResult<Value> {
  if (operand.kind !== 'bool') return fail(unaryMismatch(spec, operand));
  return finish(boolValue(!operand.value));
}

/**
 * 长度：字节串按字节数、文本按**码点数**、列表按元素数。
 *
 * 实现交给 `collection.lengthOf`，与「长度」作为集合查询的语义只留一份：
 * 文本不能用 `String.length`（那是 UTF-16 码元数，`"😀"` 会被算成 2）。
 */
function applyLength(operand: Value): CanvasResult<Value> {
  return lengthOf(operand);
}

/** 一元类型不匹配的文案：`「长度」只接受字节串、文本和列表，收到字典`。 */
function unaryMismatch(spec: UnaryOperatorSpec, operand: Value): string {
  return `「${spec.label}」只接受${acceptsLabel(spec.accepts)}，收到${valueTypeName(operand)}`;
}

/** 把接受的种类写成中文枚举：`字节串、文本和列表`。 */
function acceptsLabel(accepts: readonly ValueKind[]): string {
  const labels = accepts.map((kind) => VALUE_KIND_LABELS[kind]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join('、')}和${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/** 每个结果都要过容量检查：越界报原因，不静默截断。 */
function finish(value: Value): CanvasResult<Value> {
  const reason = checkValue(value);
  return reason === undefined ? ok(value) : fail(reason);
}

function finishInt(value: bigint): CanvasResult<Value> {
  return finish(intValue(value));
}
