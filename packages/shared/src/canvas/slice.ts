import { fail, ok, type CanvasResult } from './result';
import { byteValue, checkValue, listValue, stringValue, valueTypeName, type Value } from './value';

/**
 * 切片 `[开始:结束:步长]`（需求 §2.3）。
 *
 * 语义**照 Python 的切片算法**（`slice.indices()`）实现，不自创规则：
 * - 从 0 编号，含开始不含结束；三段都可省略，省略即用该方向的默认值。
 * - 负索引表示倒数；步长为负时从后往前取，默认起点是最后一个元素、默认终点是「越过开头」。
 * - 越界边界裁剪到有效区间；步长为 0 报错。
 * - 三个边界都是值域里的 `bigint`：超出安全整数范围的先折成 `±Infinity`，
 *   再走同一套夹取逻辑，绝不能 `Number(bigint)` 丢精度后夹出一个错误区间。
 *
 * 单位按类型走：**文本按 Unicode 码点**（不能按 UTF-16 码元，否则 `"A😀B"[1:2]` 会切出半个代理对）、
 * 字节串按字节、列表按元素；结果一律保留原类型并过 `checkValue`。
 */

/** 三段边界：缺省表示省略该段（对应 Python 里不写）。 */
export interface SliceBounds {
  readonly start?: Value; // 缺省表示省略该段
  readonly end?: Value;
  readonly step?: Value;
}

/** 切片：文本按码点、字节串按字节、列表按元素；结果保留原类型。 */
export function sliceOf(target: Value, bounds: SliceBounds): CanvasResult<Value> {
  if (target.kind !== 'byte' && target.kind !== 'string' && target.kind !== 'list') {
    return fail(`「切片」只接受字节串、文本和列表，收到${valueTypeName(target)}`);
  }
  const start = readBound(bounds.start, '起点');
  if (!start.ok) return fail(start.message);
  const end = readBound(bounds.end, '终点');
  if (!end.ok) return fail(end.message);
  const step = readBound(bounds.step, '步长');
  if (!step.ok) return fail(step.message);
  const stride = step.value ?? 1;
  if (stride === 0) return fail('切片步长不能为 0');

  switch (target.kind) {
    case 'byte': {
      const indices = sliceIndices(target.bytes.length, start.value, end.value, stride);
      const out = new Uint8Array(indices.length);
      indices.forEach((source, at) => {
        out[at] = target.bytes[source] as number;
      });
      return checked(byteValue(out));
    }
    case 'string': {
      const chars = Array.from(target.value);
      const indices = sliceIndices(chars.length, start.value, end.value, stride);
      return checked(stringValue(indices.map((index) => chars[index] as string).join('')));
    }
    case 'list': {
      const indices = sliceIndices(target.items.length, start.value, end.value, stride);
      return checked(listValue(indices.map((index) => target.items[index] as Value)));
    }
  }
}

// ---------------------------------------------------------------------------
// 边界读取
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIG = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * 读一段边界：缺省返回 `undefined`；不是整数报错。
 *
 * 超出安全整数范围的边界折成 `±Infinity`：夹取时它与「无穷大」同义，
 * 而 `Number(10n ** 30n)` 这种转换会丢掉量级，让超大起点被误当成一个普通下标。
 */
function readBound(bound: Value | undefined, label: string): CanvasResult<number | undefined> {
  if (bound === undefined) return ok(undefined);
  if (bound.kind !== 'int') return fail(`切片${label}需要整数，收到${valueTypeName(bound)}`);
  if (bound.value > MAX_SAFE_INTEGER_BIG) return ok(Number.POSITIVE_INFINITY);
  if (bound.value < MIN_SAFE_INTEGER_BIG) return ok(Number.NEGATIVE_INFINITY);
  return ok(Number(bound.value));
}

// ---------------------------------------------------------------------------
// Python 口径的下标序列
// ---------------------------------------------------------------------------

function sliceIndices(
  length: number,
  start: number | undefined,
  end: number | undefined,
  step: number,
): readonly number[] {
  return step > 0 ? forwardIndices(length, start, end, step) : backwardIndices(length, start, end, step);
}

/** 正步长：start 缺省 0、end 缺省长度，两边都夹到 `[0, length]`，从左往右取。 */
function forwardIndices(
  length: number,
  start: number | undefined,
  end: number | undefined,
  step: number,
): readonly number[] {
  const from = start === undefined ? 0 : clampForward(start, length);
  const to = end === undefined ? length : clampForward(end, length);
  const indices: number[] = [];
  for (let index = from; index < to; index += step) indices.push(index);
  return indices;
}

/** 负步长：start 缺省 `length-1`、end 缺省「-1 即越过开头」，两边都夹到 `[-1, length-1]`，从右往左取。 */
function backwardIndices(
  length: number,
  start: number | undefined,
  end: number | undefined,
  step: number,
): readonly number[] {
  const from = start === undefined ? length - 1 : clampBackward(start, length);
  const to = end === undefined ? -1 : clampBackward(end, length);
  const indices: number[] = [];
  for (let index = from; index > to; index += step) indices.push(index);
  return indices;
}

/** 正步长的夹取：负索引加长度，再夹到 `[0, length]`（`±Infinity` 自然也落在端点）。 */
function clampForward(bound: number, length: number): number {
  const shifted = bound < 0 ? bound + length : bound;
  if (shifted < 0) return 0;
  return shifted > length ? length : shifted;
}

/** 负步长的夹取：负索引加长度，再夹到 `[-1, length-1]`；`-1` 表示「越过开头」。 */
function clampBackward(bound: number, length: number): number {
  const shifted = bound < 0 ? bound + length : bound;
  const highest = length - 1;
  if (shifted < -1) return -1;
  return shifted > highest ? highest : shifted;
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/** 统一收尾：结果一律过容量检查，超限报错而不是截断。 */
function checked(value: Value): CanvasResult<Value> {
  const reason = checkValue(value);
  return reason === undefined ? ok(value) : fail(reason);
}
