import {
  CANVAS_MAX_BYTES,
  CANVAS_MAX_COLLECTION_ITEMS,
  CANVAS_MAX_INT_BITS,
  CANVAS_MAX_KEY_CHARS,
  CANVAS_MAX_TEXT_CHARS,
  CANVAS_MAX_VALUE_DEPTH,
} from '../limits';
import { fail, ok, type CanvasResult } from './result';

/**
 * 新画布的值模型（需求 §2.1）。
 *
 * 七种值：字节串、整数、浮点数、文本、布尔、列表、字典。三条建模决定：
 *
 * - **整数用 `bigint`**：地址与任意精度整数是同一类型，不经 `number`，64 位地址不丢精度。
 * - **字节串用 `Uint8Array`**，构造时复制：值一旦产生就不再被外部改写（仓库的不可变约定）。
 * - **列表与字典是值**：能连接、能存档、能整体转换。字典用「条目数组」而不是
 *   `Map`，因为要保留插入顺序、而且要允许整数键 `1` 与字符串键 `"1"` 并存。
 *
 * 容量上限（字节数、整数位数、元素个数、嵌套深度）统一读 `limits.ts` 的 `CANVAS_*`，
 * 由 `checkValue` 集中检查；构造器只做局部、无歧义的检查（字典重复键）。
 */

/** 值种类。顺序进下拉框与文档，改动等于改存档语义。 */
export const VALUE_KINDS = ['byte', 'int', 'double', 'string', 'bool', 'list', 'dict'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** 标量种类：可以被字面值节点直接承载，也是「合并为串」允许的成员类型。 */
export const SCALAR_VALUE_KINDS = ['byte', 'int', 'double', 'string', 'bool'] as const;
export type ScalarKind = (typeof SCALAR_VALUE_KINDS)[number];

/** 中文名：界面、错误文案与预览共用同一份，避免各处各写一遍。 */
export const VALUE_KIND_LABELS: Readonly<Record<ValueKind, string>> = {
  byte: '字节串',
  int: '整数',
  double: '浮点数',
  string: '文本',
  bool: '布尔',
  list: '列表',
  dict: '字典',
};

export interface ByteValue {
  readonly kind: 'byte';
  readonly bytes: Uint8Array;
}

export interface IntValue {
  readonly kind: 'int';
  readonly value: bigint;
}

export interface DoubleValue {
  readonly kind: 'double';
  readonly value: number;
}

export interface StringValue {
  readonly kind: 'string';
  readonly value: string;
}

export interface BoolValue {
  readonly kind: 'bool';
  readonly value: boolean;
}

export interface ListValue {
  readonly kind: 'list';
  readonly items: readonly Value[];
}

/** 字典键：整数与字符串互不相等，`1` 和 `"1"` 是两个键（需求 §2.1）。 */
export type DictKey =
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'string'; readonly value: string };

export interface DictEntry {
  readonly key: DictKey;
  readonly value: Value;
}

export interface DictValue {
  readonly kind: 'dict';
  /** 保留插入顺序；键唯一（重复键在构造时报错，不静默覆盖）。 */
  readonly entries: readonly DictEntry[];
}

export type ScalarValue = ByteValue | IntValue | DoubleValue | StringValue | BoolValue;
export type Value = ScalarValue | ListValue | DictValue;

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 复制一份字节：调用方之后再改原数组，不会影响已经产生的结果。 */
export function byteValue(bytes: Uint8Array): ByteValue {
  return { kind: 'byte', bytes: new Uint8Array(bytes) };
}

export function intValue(value: bigint): IntValue {
  return { kind: 'int', value };
}

export function doubleValue(value: number): DoubleValue {
  return { kind: 'double', value };
}

export function stringValue(value: string): StringValue {
  return { kind: 'string', value };
}

export function boolValue(value: boolean): BoolValue {
  return { kind: 'bool', value };
}

export function listValue(items: readonly Value[]): ListValue {
  return { kind: 'list', items: [...items] };
}

export function intKey(value: bigint): DictKey {
  return { kind: 'int', value };
}

export function stringKey(value: string): DictKey {
  return { kind: 'string', value };
}

/** 建字典：重复键报错，不静默覆盖（需求 §2.1）。 */
export function dictValue(entries: readonly DictEntry[]): CanvasResult<DictValue> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = keyIdentity(entry.key);
    if (seen.has(id)) return fail(`字典键 ${keyLabel(entry.key)} 重复，必须唯一`);
    seen.add(id);
  }
  return ok({ kind: 'dict', entries: [...entries] });
}

/** 按键取值：缺失键报错（需求 §2.1）。 */
export function dictLookup(dict: DictValue, key: DictKey): CanvasResult<Value> {
  const wanted = keyIdentity(key);
  for (const entry of dict.entries) {
    if (keyIdentity(entry.key) === wanted) return ok(entry.value);
  }
  return fail(`字典里没有键 ${keyLabel(key)}`);
}

/** 键的身份标识：用种类前缀区分整数 `1` 与字符串 `"1"`。 */
export function keyIdentity(key: DictKey): string {
  return key.kind === 'int' ? `i:${key.value}` : `s:${key.value}`;
}

/** 键的一行显示：整数直接写数字，文本加引号。 */
export function keyLabel(key: DictKey): string {
  if (key.kind === 'int') return key.value.toString(10);
  return JSON.stringify(key.value);
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

export function isScalarValue(value: Value): value is ScalarValue {
  return value.kind !== 'list' && value.kind !== 'dict';
}

export function isCollectionValue(value: Value): value is ListValue | DictValue {
  return value.kind === 'list' || value.kind === 'dict';
}

export function valueTypeName(value: Value): string {
  return VALUE_KIND_LABELS[value.kind];
}

export function valueTypeNameOf(kind: ValueKind): string {
  return VALUE_KIND_LABELS[kind];
}

// ---------------------------------------------------------------------------
// 相等
// ---------------------------------------------------------------------------

/** 结构相等：列表逐项、字典逐条（顺序参与比较），字节串逐字节。 */
export function sameValue(left: Value, right: Value): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'byte':
      return sameBytes(left.bytes, (right as ByteValue).bytes);
    case 'int':
      return left.value === (right as IntValue).value;
    case 'double':
      // 不用 Object.is：值域里没有 NaN（见 checkValue），-0 与 0 按数值相等。
      return left.value === (right as DoubleValue).value;
    case 'string':
      return left.value === (right as StringValue).value;
    case 'bool':
      return left.value === (right as BoolValue).value;
    case 'list': {
      const other = right as ListValue;
      return left.items.length === other.items.length && left.items.every((item, index) => sameValue(item, other.items[index] as Value));
    }
    case 'dict': {
      const other = right as DictValue;
      if (left.entries.length !== other.entries.length) return false;
      return left.entries.every((entry, index) => {
        const pair = other.entries[index] as DictEntry;
        return keyIdentity(entry.key) === keyIdentity(pair.key) && sameValue(entry.value, pair.value);
      });
    }
  }
}

export function sameKey(left: DictKey, right: DictKey): boolean {
  return keyIdentity(left) === keyIdentity(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 容量检查
// ---------------------------------------------------------------------------

/** 整数的二进制位数（按绝对值算）：0 记 0 位，负数按绝对值。 */
export function intBitLength(value: bigint): number {
  if (value === 0n) return 0;
  const magnitude = value < 0n ? -value : value;
  return magnitude.toString(2).length;
}

/** 文本的码点数：切片与长度都按码点算，不能拿 UTF-16 的 `.length` 冒充。 */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

/**
 * 检查值的容量上限；返回中文原因或 `undefined`。
 *
 * 这里检查的是**结果大小**（字节数、位数、元素数、嵌套深度），不是「值对不对」：
 * 类型错误由运算与转换自己报。求值在每次产生新值后调用它，越界一律失败，
 * 不静默截断（需求 §7「限制集合与重复操作的结果大小」）。
 */
export function checkValue(value: Value, depth = 1): string | undefined {
  if (depth > CANVAS_MAX_VALUE_DEPTH) {
    return `值嵌套超过 ${CANVAS_MAX_VALUE_DEPTH} 层`;
  }
  switch (value.kind) {
    case 'byte':
      return value.bytes.length > CANVAS_MAX_BYTES
        ? `字节串长度 ${value.bytes.length} 超过上限 ${CANVAS_MAX_BYTES}`
        : undefined;
    case 'int': {
      const bits = intBitLength(value.value);
      return bits > CANVAS_MAX_INT_BITS ? `整数 ${bits} 位，超过上限 ${CANVAS_MAX_INT_BITS} 位` : undefined;
    }
    case 'double':
      return Number.isFinite(value.value)
        ? undefined
        : `浮点数只能是有限值，不接受 ${String(value.value)}`;
    case 'string': {
      const chars = codePointLength(value.value);
      return chars > CANVAS_MAX_TEXT_CHARS ? `文本 ${chars} 个码点，超过上限 ${CANVAS_MAX_TEXT_CHARS}` : undefined;
    }
    case 'bool':
      return undefined;
    case 'list': {
      if (value.items.length > CANVAS_MAX_COLLECTION_ITEMS) {
        return `列表元素数 ${value.items.length} 超过上限 ${CANVAS_MAX_COLLECTION_ITEMS}`;
      }
      for (const item of value.items) {
        const reason = checkValue(item, depth + 1);
        if (reason !== undefined) return reason;
      }
      return undefined;
    }
    case 'dict': {
      if (value.entries.length > CANVAS_MAX_COLLECTION_ITEMS) {
        return `字典条目数 ${value.entries.length} 超过上限 ${CANVAS_MAX_COLLECTION_ITEMS}`;
      }
      for (const entry of value.entries) {
        const reason = checkKey(entry.key);
        if (reason !== undefined) return reason;
        const nested = checkValue(entry.value, depth + 1);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }
  }
}

function checkKey(key: DictKey): string | undefined {
  if (key.kind === 'int') {
    const bits = intBitLength(key.value);
    return bits > CANVAS_MAX_INT_BITS ? `字典整数键 ${bits} 位，超过上限 ${CANVAS_MAX_INT_BITS} 位` : undefined;
  }
  const chars = codePointLength(key.value);
  return chars > CANVAS_MAX_KEY_CHARS ? `字典文本键 ${chars} 个码点，超过上限 ${CANVAS_MAX_KEY_CHARS}` : undefined;
}

// ---------------------------------------------------------------------------
// 显示
// ---------------------------------------------------------------------------

/** 浮点数的一行十进制表示：`String` 给出的就是最短往返表示，大数量级用指数记法。 */
export function formatDouble(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0);
  return String(value);
}

/** 摘要里单类值的最大展示宽度：预览是一行，不能把整份 payload 塞进界面。 */
const SUMMARY_ITEMS = 4;
const SUMMARY_BYTES = 16;
const SUMMARY_CHARS = 32;
/** 摘要里允许展开的嵌套层数：再深就只显示类型。 */
const SUMMARY_DEPTH = 2;

/** 一行摘要：列表 / 字典递归展开，超过展示上限用省略号收尾。 */
export function valueSummary(value: Value, depth = 1): string {
  switch (value.kind) {
    case 'byte': {
      const length = value.bytes.length;
      if (length === 0) return '0 字节（空）';
      const head = hexOf(value.bytes.subarray(0, SUMMARY_BYTES));
      return `${length} 字节：${head}${length > SUMMARY_BYTES ? '…' : ''}`;
    }
    case 'int': {
      const big = value.value;
      if (big >= 0n && big < 1n << 64n) return `${big.toString(10)}（0x${big.toString(16)}）`;
      const text = big.toString(10);
      return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
    }
    case 'double':
      return formatDouble(value.value);
    case 'string': {
      const chars = [...value.value];
      const head = chars.slice(0, SUMMARY_CHARS).join('');
      return JSON.stringify(chars.length > SUMMARY_CHARS ? `${head}…` : head);
    }
    case 'bool':
      return value.value ? '真' : '假';
    case 'list': {
      if (depth > SUMMARY_DEPTH) return `列表（${value.items.length} 项）`;
      const head = value.items.slice(0, SUMMARY_ITEMS).map((item) => valueSummary(item, depth + 1));
      const tail = value.items.length > SUMMARY_ITEMS ? ['…'] : [];
      return `[${[...head, ...tail].join(', ')}]`;
    }
    case 'dict': {
      if (depth > SUMMARY_DEPTH) return `字典（${value.entries.length} 条）`;
      const shown = value.entries.slice(0, SUMMARY_ITEMS).map(
        (entry) => `${keyLabel(entry.key)}: ${valueSummary(entry.value, depth + 1)}`,
      );
      const tail = value.entries.length > SUMMARY_ITEMS ? ['…'] : [];
      return `{${[...shown, ...tail].join(', ')}}`;
    }
  }
}

/** 小写十六进制，不带前缀：与仓库里其他「原始字节」同一口径。 */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
