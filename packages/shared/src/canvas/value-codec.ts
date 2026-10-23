import { hexToBytes } from '../hex';
import { fail, ok, type CanvasResult } from './result';
import {
  byteValue,
  boolValue,
  checkValue,
  dictValue,
  doubleValue,
  hexOf,
  intKey,
  intValue,
  listValue,
  stringKey,
  stringValue,
  type DictEntry,
  type DictKey,
  type Value,
} from './value';

/**
 * 值的 JSON 编码（需求 §2.1、§8）。
 *
 * 存档来自浏览器、预览要进产物，两处都只能是 JSON：`bigint` 与 `Uint8Array` 不能直接写进去，
 * 所以：
 * - 整数用**十进制字符串**，不经 `number`，64 位地址与超大整数都不丢精度；
 * - 字节串用**无前缀小写 hex**，与仓库里其他「原始字节」同一口径；
 * - 列表与字典按结构展开，字典保留条目顺序（整数键 `1` 与字符串键 `"1"` 各自独立）。
 *
 * 编码是**无损**的：`decodeValue(encodeValue(value))` 与原值结构相等。解码拒绝格式错误与超限，
 * 因为存档是不可信输入；编码失败只可能来自「值本身超限」，所以也返回结果而不是抛异常。
 */

export type EncodedDictKey =
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string };

export interface EncodedListValue {
  readonly kind: 'list';
  readonly items: readonly EncodedValue[];
}

export interface EncodedDictValue {
  readonly kind: 'dict';
  readonly entries: readonly { readonly key: EncodedDictKey; readonly value: EncodedValue }[];
}

export type EncodedScalarValue =
  | { readonly kind: 'byte'; readonly hex: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'double'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean };

export type EncodedValue = EncodedScalarValue | EncodedListValue | EncodedDictValue;

/** 整数文本：无前导零、允许负号。 */
const INT_RE = /^-?(?:0|[1-9][0-9]*)$/;
/** 字节串：无前缀偶数字节 hex。 */
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function encodeValue(value: Value): EncodedValue {
  switch (value.kind) {
    case 'byte':
      return { kind: 'byte', hex: hexOf(value.bytes) };
    case 'int':
      return { kind: 'int', value: value.value.toString(10) };
    case 'double':
      return { kind: 'double', value: value.value };
    case 'string':
      return { kind: 'string', value: value.value };
    case 'bool':
      return { kind: 'bool', value: value.value };
    case 'list':
      return { kind: 'list', items: value.items.map(encodeValue) };
    case 'dict':
      return {
        kind: 'dict',
        entries: value.entries.map((entry) => ({ key: encodeKey(entry.key), value: encodeValue(entry.value) })),
      };
  }
}

export function encodeKey(key: DictKey): EncodedDictKey {
  return key.kind === 'int'
    ? { kind: 'int', value: key.value.toString(10) }
    : { kind: 'string', value: key.value };
}

/**
 * 解码一份编码值。`depth` 只用于递归，顶层调用才做容量检查：
 * 每个子结构各查一次会让深嵌套的检查次数爆炸，而一次全量检查已经覆盖全部节点。
 */
export function decodeValue(encoded: EncodedValue): CanvasResult<Value> {
  const decoded = decodeInner(encoded);
  if (!decoded.ok) return decoded;
  const reason = checkValue(decoded.value);
  return reason === undefined ? decoded : fail(reason);
}

/** 字面值节点只承载标量：列表要由组合产生，字典要由字典节点产生。 */
export function decodeScalarValue(encoded: EncodedScalarValue): CanvasResult<Value> {
  const decoded = decodeScalar(encoded);
  if (!decoded.ok) return decoded;
  const reason = checkValue(decoded.value);
  return reason === undefined ? decoded : fail(reason);
}

function decodeInner(encoded: EncodedValue): CanvasResult<Value> {
  if (encoded.kind === 'list') {
    const items: Value[] = [];
    for (const item of encoded.items) {
      const decoded = decodeInner(item);
      if (!decoded.ok) return decoded;
      items.push(decoded.value);
    }
    return ok(listValue(items));
  }
  if (encoded.kind === 'dict') {
    const entries: DictEntry[] = [];
    for (const entry of encoded.entries) {
      const key = decodeKey(entry.key);
      if (!key.ok) return key;
      const value = decodeInner(entry.value);
      if (!value.ok) return value;
      entries.push({ key: key.value, value: value.value });
    }
    return dictValue(entries);
  }
  return decodeScalar(encoded);
}

function decodeScalar(encoded: EncodedScalarValue): CanvasResult<Value> {
  switch (encoded.kind) {
    case 'byte': {
      if (!HEX_BYTES_RE.test(encoded.hex)) return fail(`字节串格式非法：${encoded.hex}`);
      return ok(byteValue(hexToBytes(encoded.hex)));
    }
    case 'int': {
      if (!INT_RE.test(encoded.value)) return fail(`整数格式非法：${encoded.value}`);
      return ok(intValue(BigInt(encoded.value)));
    }
    case 'double': {
      if (!Number.isFinite(encoded.value)) return fail(`浮点数只能是有限值，收到 ${String(encoded.value)}`);
      return ok(doubleValue(encoded.value));
    }
    case 'string':
      return ok(stringValue(encoded.value));
    case 'bool':
      return ok(boolValue(encoded.value));
  }
}

/** 解码一个字典键：整数键与文本键互不混淆。 */
export function decodeKey(encoded: EncodedDictKey): CanvasResult<DictKey> {
  if (encoded.kind === 'int') {
    if (!INT_RE.test(encoded.value)) return fail(`字典整数键格式非法：${encoded.value}`);
    return ok(intKey(BigInt(encoded.value)));
  }
  return ok(stringKey(encoded.value));
}

/** 编译期用：把一个节点算出的值编成存档形式（预览、追溯、跨进程传递）。 */
export function encodeValueOrThrow(value: Value): EncodedValue {
  const reason = checkValue(value);
  if (reason !== undefined) throw new Error(reason);
  return encodeValue(value);
}
