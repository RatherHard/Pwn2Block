import { CANVAS_MAX_BYTES, CANVAS_MAX_COLLECTION_ITEMS, CANVAS_MAX_TEXT_CHARS } from '../limits';
import { fail, ok, type CanvasResult } from './result';
import {
  byteValue,
  checkValue,
  codePointLength,
  dictLookup,
  intKey,
  intValue,
  listValue,
  stringKey,
  stringValue,
  valueTypeName,
  type Value,
} from './value';

/**
 * 集合操作（需求 §2.3「长度 / 按索引取元素 / 按键取值 / 重复」）。
 *
 * 四条共同约定：
 * - **结果一律过 `checkValue`**：越界、超限都返回失败，不静默截断，也不返回半个结果。
 * - **索引与次数都按整数读**：值域里的整数是 `bigint`，边界判断与折算都在 `bigint` 里做完，
 *   确认落在结果规模内才转成 `number`，避免超大整数丢精度后混进数组下标。
 * - **负数按「倒数」解释**（与切片的负索引一致）：`-1` 是最后一个元素，不是「从头再数一次」。
 * - **先算规模、再分配**：重复可能被要求复制上亿份，规模检查必须在 `Uint8Array` 分配之前，
 *   否则一次学习者输入就能把进程拖死。
 *
 * 字典只能按键取值：它没有「第几个元素」这种顺序语义，长度与索引一律报错。
 */

// ---------------------------------------------------------------------------
// 长度
// ---------------------------------------------------------------------------

/** 长度：字节串按字节、文本按码点、列表按元素；字典报错。 */
export function lengthOf(target: Value): CanvasResult<Value> {
  switch (target.kind) {
    case 'byte':
      return checked(intValue(BigInt(target.bytes.length)));
    case 'string':
      return checked(intValue(BigInt(codePointLength(target.value))));
    case 'list':
      return checked(intValue(BigInt(target.items.length)));
    default:
      return fail(`「长度」只接受字节串、文本和列表，收到${valueTypeName(target)}`);
  }
}

// ---------------------------------------------------------------------------
// 按索引取元素
// ---------------------------------------------------------------------------

/** 按索引取元素：列表/字节串/文本；允许负索引；越界报错。 */
export function indexOf(target: Value, index: Value): CanvasResult<Value> {
  if (index.kind !== 'int') return fail(`索引需要整数，收到${valueTypeName(index)}`);
  switch (target.kind) {
    case 'byte': {
      const position = normalizeIndex(index.value, target.bytes.length);
      if (position === undefined) return fail(indexOutOfRange(index.value, target.bytes.length));
      return checked(byteValue(target.bytes.subarray(position, position + 1)));
    }
    case 'string': {
      const chars = Array.from(target.value);
      const position = normalizeIndex(index.value, chars.length);
      if (position === undefined) return fail(indexOutOfRange(index.value, chars.length));
      return checked(stringValue(chars[position] as string));
    }
    case 'list': {
      const position = normalizeIndex(index.value, target.items.length);
      if (position === undefined) return fail(indexOutOfRange(index.value, target.items.length));
      return checked(target.items[position] as Value);
    }
    default:
      return fail(`「按索引取元素」只接受字节串、文本和列表，收到${valueTypeName(target)}`);
  }
}

/** 把整数索引折成 0 基下标：负索引加长度；越界返回 `undefined`。 */
function normalizeIndex(index: bigint, length: number): number | undefined {
  const position = index < 0n ? index + BigInt(length) : index;
  if (position < 0n || position >= BigInt(length)) return undefined;
  return Number(position);
}

function indexOutOfRange(index: bigint, length: number): string {
  return `索引 ${index} 越界（长度 ${length}）`;
}

// ---------------------------------------------------------------------------
// 字典按键取值
// ---------------------------------------------------------------------------

/** 字典按键取值：键必须是整数或文本；缺失键报错。 */
export function lookupOf(target: Value, key: Value): CanvasResult<Value> {
  if (target.kind !== 'dict') return fail(`「按键取值」需要字典，收到${valueTypeName(target)}`);
  if (key.kind !== 'int' && key.kind !== 'string') {
    return fail(`字典键只能是整数或文本，收到${valueTypeName(key)}`);
  }
  // 整数键 `1` 与文本键 `"1"` 是两个键：种类随原值走，不在这里做字符串化。
  const found = dictLookup(target, key.kind === 'int' ? intKey(key.value) : stringKey(key.value));
  if (!found.ok) return fail(found.message);
  return checked(found.value);
}

// ---------------------------------------------------------------------------
// 重复
// ---------------------------------------------------------------------------

/** 重复：列表/字节串/文本；次数必须是非负整数；结果超限报错且不得先分配巨大内存。 */
export function repeatOf(target: Value, count: Value): CanvasResult<Value> {
  if (count.kind !== 'int') return fail(`重复次数需要整数，收到${valueTypeName(count)}`);
  if (count.value < 0n) return fail(`重复次数不能为负，收到 ${count.value}`);
  switch (target.kind) {
    case 'byte':
      return repeatBytes(target.bytes, count.value);
    case 'string':
      return repeatText(target.value, count.value);
    case 'list':
      return repeatList(target.items, count.value);
    default:
      return fail(`「重复」只接受字节串、文本和列表，收到${valueTypeName(target)}`);
  }
}

function repeatBytes(bytes: Uint8Array, count: bigint): CanvasResult<Value> {
  const total = BigInt(bytes.length) * count;
  if (total > BigInt(CANVAS_MAX_BYTES)) {
    return fail(`重复后字节串长度 ${total} 超过上限 ${CANVAS_MAX_BYTES}`);
  }
  // 空串乘任意次仍是空：先挡住 0，下面对 `total` 的 `Number()` 就只在上限内发生，不会丢精度。
  if (total === 0n) return checked(byteValue(new Uint8Array(0)));
  const size = Number(total);
  const out = new Uint8Array(size);
  out.set(bytes, 0);
  fillByDoubling(size, bytes.length, (offset, chunk) => {
    out.set(out.subarray(0, chunk), offset);
  });
  return checked(byteValue(out));
}

function repeatText(text: string, count: bigint): CanvasResult<Value> {
  const chars = Array.from(text);
  const total = BigInt(chars.length) * count;
  if (total > BigInt(CANVAS_MAX_TEXT_CHARS)) {
    return fail(`重复后文本 ${total} 个码点，超过上限 ${CANVAS_MAX_TEXT_CHARS}`);
  }
  // 空文本同上：`total` 为 0 时提前返回，`Number(total)` 只在上限内执行。
  if (total === 0n) return checked(stringValue(''));
  return checked(stringValue(repeatArray(chars, Number(total)).join('')));
}

function repeatList(items: readonly Value[], count: bigint): CanvasResult<Value> {
  const total = BigInt(items.length) * count;
  if (total > BigInt(CANVAS_MAX_COLLECTION_ITEMS)) {
    return fail(`重复后列表元素数 ${total} 超过上限 ${CANVAS_MAX_COLLECTION_ITEMS}`);
  }
  if (total === 0n) return checked(listValue([]));
  return checked(listValue(repeatArray(items, Number(total))));
}

/**
 * 把已写入的前缀整段抄到后面，直到填满 `size`。
 *
 * 逐项循环在「1 字节 × 50 万次」这类输入下要多跑几十万轮；整段复制每轮翻倍，次数是 `log2`。
 * 调用方负责保证 `unitLength > 0` 且 `size` 是它的整数倍。
 */
function fillByDoubling(size: number, unitLength: number, copyPrefix: (offset: number, chunk: number) => void): void {
  let filled = unitLength;
  while (filled < size) {
    const chunk = Math.min(filled, size - filled);
    copyPrefix(filled, chunk);
    filled += chunk;
  }
}

/** 与 `fillByDoubling` 同一套倍增思路，作用在不可变元素上（列表项与文本码点共用）。 */
function repeatArray<T>(items: readonly T[], total: number): readonly T[] {
  const out: T[] = [];
  for (let index = 0; index < items.length; index += 1) out.push(items[index] as T);
  while (out.length < total) {
    const chunk = Math.min(out.length, total - out.length);
    for (let index = 0; index < chunk; index += 1) out.push(out[index] as T);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/** 统一收尾：结果一律过容量检查，超限报错而不是截断。 */
function checked(value: Value): CanvasResult<Value> {
  const reason = checkValue(value);
  return reason === undefined ? ok(value) : fail(reason);
}
