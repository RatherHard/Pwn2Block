import { CANVAS_MAX_BYTES, CANVAS_MAX_INT_BITS, CANVAS_MAX_TEXT_CHARS } from '../limits';
import {
  CONVERSION_LABELS,
  conversionInputKind,
  type ConversionSpec,
  type IntBytesOptions,
  type IntTextBase,
  type RoundingMode,
} from './operators';
import { fail, ok, type CanvasResult } from './result';
import {
  VALUE_KIND_LABELS,
  byteValue,
  checkValue,
  codePointLength,
  doubleValue,
  formatDouble,
  hexOf,
  intValue,
  stringValue,
  valueTypeName,
  type Value,
  type ValueKind,
} from './value';

/**
 * 转换节点的求值（需求 §4.2）。
 * 转换是**显式**的：跨类型用法都要经过这个节点，运算自身不做隐式转换（见 `operators.ts`）。
 * 三条约定：先验后算（类型、范围、编码合法性都在分配结果之前检查）、错误带具体值（整数、字节数、码位、前几个字节）、失败一律 `fail(...)` 而不抛异常，成功结果统一过 `checkValue`。
 */

/** 字典没有转换语义：键值要取出来再单独转换（需求 §4.2）。 */
const DICT_MESSAGE = '字典不参与类型转换：先把要用的值取出来再转换';

/** 错误文案里最多展示的字符数与字节数：一条错误不该把整份 payload 复制进来。 */
const PREVIEW_CHARS = 16;
const PREVIEW_BYTES = 16;

/** 位数上限：309 是 2^1024 的十进制位数，256 是 1024 位的十六进制位数。只做规模预判，位数由 `checkValue` 兜底。 */
const MAX_DECIMAL_DIGITS = 309;
const MAX_HEX_DIGITS = 256;

/** 文本解析三条口径：十进制整数无前导零、十六进制剥掉前缀后只剩数字、浮点是严格十进制/指数。 */
const DECIMAL_INT_RE = /^-?(?:0|[1-9][0-9]*)$/;
const HEX_DIGITS_RE = /^[0-9a-fA-F]+$/;
const DOUBLE_TEXT_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** 按转换目录执行一次转换；输入类型不匹配、无法表示、格式错误都返回失败。 */
export function applyConversion(input: Value, spec: ConversionSpec): CanvasResult<Value> {
  const converted = convertValue(input, spec);
  if (!converted.ok) return converted;
  const reason = checkValue(converted.value);
  return reason === undefined ? converted : fail(reason);
}

/** 先按输入种类分派：字典优先报「不参与转换」，其余种类不匹配时给出通用文案。 */
function convertValue(input: Value, spec: ConversionSpec): CanvasResult<Value> {
  switch (input.kind) {
    case 'dict':
      return fail(DICT_MESSAGE);
    case 'string':
      return fromText(input.value, spec);
    case 'byte':
      return fromBytes(input.bytes, spec);
    case 'int':
      return fromInt(input.value, spec);
    case 'double':
      return fromDouble(input.value, spec);
    case 'list':
      return fromList(input.items, spec);
    case 'bool':
      return mismatch(spec, 'bool');
  }
}

/** 「`整数转字节串`需要整数，收到文本」。 */
function mismatch(spec: ConversionSpec, actual: ValueKind): CanvasResult<Value> {
  const expected = VALUE_KIND_LABELS[conversionInputKind(spec)];
  return fail(`「${CONVERSION_LABELS[spec.kind]}」需要${expected}，收到${VALUE_KIND_LABELS[actual]}`);
}

// ---------------------------------------------------------------------------
// 文本 ↔ 字节串
// ---------------------------------------------------------------------------

function fromText(text: string, spec: ConversionSpec): CanvasResult<Value> {
  switch (spec.kind) {
    case 'text-to-bytes':
      return spec.encoding === 'ascii' ? asciiToBytes(text) : utf8ToBytes(text);
    case 'text-to-int':
      return textToInt(text, spec.base);
    case 'text-to-double':
      return textToDouble(text);
    default:
      return mismatch(spec, 'string');
  }
}

/** UTF-8 编码：先算长度，顺带拒绝孤立代理项（`TextEncoder` 会把它静默换成 U+FFFD）。 */
function utf8ToBytes(text: string): CanvasResult<Value> {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) {
      return fail(`文本里的孤立代理项 U+${hexPad(code, 4, true)} 无法用 UTF-8 编码`);
    }
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  if (length > CANVAS_MAX_BYTES) {
    return fail(`文本编码成 UTF-8 需要 ${length} 字节，超过上限 ${CANVAS_MAX_BYTES} 字节`);
  }
  return ok(byteValue(new TextEncoder().encode(text)));
}

/** ASCII 编码：每个码点都必须 ≤ 0x7F，否则报出字符与码位。 */
function asciiToBytes(text: string): CanvasResult<Value> {
  const codes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      return fail(`ASCII 编码不了字符 ${JSON.stringify(char)}（U+${hexPad(code, 4, true)}）`);
    }
    if (codes.length >= CANVAS_MAX_BYTES) {
      return fail(`文本编码成 ASCII 超过上限 ${CANVAS_MAX_BYTES} 字节`);
    }
    codes.push(code);
  }
  return ok(byteValue(Uint8Array.from(codes)));
}

function fromBytes(bytes: Uint8Array, spec: ConversionSpec): CanvasResult<Value> {
  switch (spec.kind) {
    case 'bytes-to-text':
      return spec.encoding === 'ascii' ? asciiToText(bytes) : utf8ToText(bytes);
    case 'bytes-to-int':
      return bytesToInt(bytes, spec);
    default:
      return mismatch(spec, 'byte');
  }
}

/** UTF-8 解码用 `fatal`：非法字节报错，绝不用 U+FFFD 顶替。 */
function utf8ToText(bytes: Uint8Array): CanvasResult<Value> {
  try {
    return ok(stringValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return fail(`字节串不是合法的 UTF-8：${hexPreview(bytes)}`);
  }
}

/** ASCII 解码：不能用 `TextDecoder('ascii')`（它按 windows-1252 解释，会悄悄换掉高位字节）。 */
function asciiToText(bytes: Uint8Array): CanvasResult<Value> {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] > 0x7f) {
      return fail(`ASCII 解码要求每个字节都小于 0x80，第 ${index + 1} 个字节是 0x${hexPad(bytes[index], 2)}`);
    }
  }
  if (bytes.length > CANVAS_MAX_TEXT_CHARS) {
    return fail(`ASCII 解码后 ${bytes.length} 个字符，超过文本上限 ${CANVAS_MAX_TEXT_CHARS}`);
  }
  return ok(stringValue(asciiString(bytes)));
}

/** 按块拼字符：一次 `fromCharCode(...bytes)` 在大字节串上会打爆调用栈。 */
function asciiString(bytes: Uint8Array): string {
  const CHUNK = 4096;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 整数 ↔ 字节串
// ---------------------------------------------------------------------------

/** 整数 → 字节串：按声明宽度取二补码，负数先加上 2^(8*width)。范围文案写成十六进制。 */
function intToBytes(value: bigint, options: IntBytesOptions): CanvasResult<Value> {
  const limit = 1n << BigInt(8 * options.width);
  const min = options.signed ? -(limit >> 1n) : 0n;
  const max = (options.signed ? limit >> 1n : limit) - 1n;
  if (value < min || value > max) {
    const span = options.signed ? `-0x${(-min).toString(16)}..0x${max.toString(16)}` : `0x0..0x${max.toString(16)}`;
    const sign = options.signed ? '有符号' : '无符号';
    return fail(`整数 ${value} 超出 ${options.width} 字节${sign}范围 ${span}`);
  }
  let magnitude = value < 0n ? value + limit : value;
  const bytes = new Uint8Array(options.width);
  for (let index = 0; index < options.width; index += 1) {
    const at = options.endian === 'little' ? index : options.width - 1 - index;
    bytes[at] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  return ok(byteValue(bytes));
}

/** 字节串 → 整数：长度必须精确等于声明宽度，有符号按二补码解释。 */
function bytesToInt(bytes: Uint8Array, options: IntBytesOptions): CanvasResult<Value> {
  if (bytes.length !== options.width) {
    return fail(`字节串长度 ${bytes.length} 与声明的 ${options.width} 字节不匹配`);
  }
  let magnitude = 0n;
  for (let index = 0; index < options.width; index += 1) {
    const at = options.endian === 'big' ? index : options.width - 1 - index;
    magnitude = (magnitude << 8n) | BigInt(bytes[at]);
  }
  const bits = BigInt(8 * options.width);
  const negative = options.signed && magnitude >= 1n << (bits - 1n);
  return ok(intValue(negative ? magnitude - (1n << bits) : magnitude));
}

// ---------------------------------------------------------------------------
// 整数 ↔ 浮点数 / 浮点数 → 整数
// ---------------------------------------------------------------------------

function fromInt(value: bigint, spec: ConversionSpec): CanvasResult<Value> {
  switch (spec.kind) {
    case 'int-to-bytes':
      return intToBytes(value, spec);
    case 'int-to-double':
      return intToDouble(value);
    case 'int-to-text':
      return intToText(value, spec.base);
    default:
      return mismatch(spec, 'int');
  }
}

/** 整数 → 浮点数：只接受能精确表示的整数，`2^53 + 1` 这类宁可报错也不悄悄丢位。 */
function intToDouble(value: bigint): CanvasResult<Value> {
  const number = Number(value);
  if (!Number.isFinite(number) || BigInt(number) !== value) {
    return fail(`整数 ${value} 不能用 64 位浮点数精确表示`);
  }
  return ok(doubleValue(number));
}

function fromDouble(value: number, spec: ConversionSpec): CanvasResult<Value> {
  switch (spec.kind) {
    case 'double-to-int':
      return doubleToInt(value, spec.rounding);
    case 'double-to-text':
      return doubleToText(value);
    default:
      return mismatch(spec, 'double');
  }
}

function doubleToInt(value: number, rounding: RoundingMode): CanvasResult<Value> {
  if (!Number.isFinite(value)) {
    return fail(`浮点数 ${String(value)} 不是有限值，不能转成整数`);
  }
  return ok(intValue(BigInt(ROUNDERS[rounding](value))));
}

/** 四种舍入方式；`nearest` 让 .5 远离零（`Math.round` 只对正数如此，所以先取绝对值再还原符号）。 */
const ROUNDERS: Readonly<Record<RoundingMode, (value: number) => number>> = {
  trunc: Math.trunc,
  floor: Math.floor,
  ceil: Math.ceil,
  nearest: (value) => (value < 0 ? -Math.round(-value) : Math.round(value)),
};

// ---------------------------------------------------------------------------
// 整数 ↔ 文本 / 浮点数 ↔ 文本
// ---------------------------------------------------------------------------

/** 整数 → 文本：十进制原样，十六进制带 `0x` 前缀（负数写成 `-0x1f`）。 */
function intToText(value: bigint, base: IntTextBase): CanvasResult<Value> {
  if (base === 10) return ok(stringValue(value.toString(10)));
  const digit = (value < 0n ? -value : value).toString(16);
  return ok(stringValue(`${value < 0n ? '-' : ''}0x${digit}`));
}

function textToInt(text: string, base: IntTextBase): CanvasResult<Value> {
  return base === 10 ? decimalToInt(text) : hexToInt(text);
}

function decimalToInt(text: string): CanvasResult<Value> {
  if (!DECIMAL_INT_RE.test(text)) return fail(`文本 ${textPreview(text)} 不是合法的十进制整数`);
  const digits = text.startsWith('-') ? text.slice(1) : text;
  if (digits.length > MAX_DECIMAL_DIGITS) {
    return fail(`文本 ${textPreview(text)} 的位数超过整数上限 ${CANVAS_MAX_INT_BITS} 位`);
  }
  return ok(intValue(BigInt(text)));
}

/** 十六进制文本：可选负号与可选 `0x` / `0X` 前缀，其余字符一律报错。 */
function hexToInt(text: string): CanvasResult<Value> {
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const digits = body.startsWith('0x') || body.startsWith('0X') ? body.slice(2) : body;
  if (!HEX_DIGITS_RE.test(digits)) {
    return fail(`文本 ${textPreview(text)} 不是合法的十六进制整数`);
  }
  const significant = digits.replace(/^0+/, '');
  if (significant.length > MAX_HEX_DIGITS) {
    return fail(`文本 ${textPreview(text)} 的位数超过整数上限 ${CANVAS_MAX_INT_BITS} 位`);
  }
  const magnitude = significant.length === 0 ? 0n : BigInt(`0x${significant}`);
  return ok(intValue(negative ? -magnitude : magnitude));
}

function doubleToText(value: number): CanvasResult<Value> {
  if (!Number.isFinite(value)) {
    return fail(`浮点数 ${String(value)} 不是有限值，不能转成文本`);
  }
  return ok(stringValue(formatDouble(value)));
}

/** 文本 → 浮点数：严格十进制/指数写法，`nan`、`inf`、空白、`1abc` 都拒绝。 */
function textToDouble(text: string): CanvasResult<Value> {
  if (!DOUBLE_TEXT_RE.test(text)) {
    return fail(`文本 ${textPreview(text)} 不是合法的十进制浮点数`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return fail(`文本 ${textPreview(text)} 超出 64 位浮点数范围`);
  }
  return ok(doubleValue(value));
}

// ---------------------------------------------------------------------------
// 列表合并
// ---------------------------------------------------------------------------

function fromList(items: readonly Value[], spec: ConversionSpec): CanvasResult<Value> {
  switch (spec.kind) {
    case 'list-to-bytes':
      return listToBytes(items);
    case 'list-to-text':
      return listToText(items);
    default:
      return mismatch(spec, 'list');
  }
}

/** 字节串列表 → 字节串：先逐项校验并累计长度，超限就在分配之前失败。 */
function listToBytes(items: readonly Value[]): CanvasResult<Value> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'byte') {
      return fail(`第 ${index + 1} 项是${valueTypeName(item)}，字节串列表只能包含字节串；先逐项转换`);
    }
    total += item.bytes.length;
    if (total > CANVAS_MAX_BYTES) {
      return fail(`字节串列表合并后 ${total} 字节，超过上限 ${CANVAS_MAX_BYTES} 字节`);
    }
    parts.push(item.bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return ok(byteValue(out));
}

/** 文本列表 → 文本：按码点累计长度，超限时不拼串。 */
function listToText(items: readonly Value[]): CanvasResult<Value> {
  const parts: string[] = [];
  let chars = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'string') {
      return fail(`第 ${index + 1} 项是${valueTypeName(item)}，文本列表只能包含文本；先逐项转换`);
    }
    chars += codePointLength(item.value);
    if (chars > CANVAS_MAX_TEXT_CHARS) {
      return fail(`文本列表合并后 ${chars} 个码点，超过上限 ${CANVAS_MAX_TEXT_CHARS}`);
    }
    parts.push(item.value);
  }
  return ok(stringValue(parts.join('')));
}

/** 定宽十六进制：码位用大写 `U+D800`，字节用小写 `0x0f`（与 `hexOf` 同口径）。 */
function hexPad(value: number, width: number, upper = false): string {
  const text = value.toString(16).padStart(width, '0');
  return upper ? text.toUpperCase() : text;
}

/** 错误文案里的字节预览：太长就截断，不把整份 payload 复制进错误。 */
function hexPreview(bytes: Uint8Array): string {
  const head = hexOf(bytes.subarray(0, PREVIEW_BYTES));
  return bytes.length > PREVIEW_BYTES ? `${head}…` : head;
}

/** 错误文案里的文本预览：按码点截断，避免切断代理对。 */
function textPreview(text: string): string {
  const chars = [...text];
  const head = chars.slice(0, PREVIEW_CHARS).join('');
  return JSON.stringify(chars.length > PREVIEW_CHARS ? `${head}…` : head);
}
