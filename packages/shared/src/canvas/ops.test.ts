import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_INT_BITS } from '../limits';
import { applyBinary, applyUnary, decidedByLeft } from './ops';
import type { CanvasResult } from './result';
import {
  boolValue,
  byteValue,
  dictValue,
  doubleValue,
  intValue,
  listValue,
  stringKey,
  stringValue,
  valueTypeName,
  type Value,
} from './value';

/**
 * 运算求值的契约测试（需求 §2.3、§4.2）。
 *
 * 断言取**精确值**：整数比较 bigint、浮点比较 `number`（含 0.1 + 0.2 这种不精确结果，
 * 说明求值不做任何四舍五入）、字节与列表比较结构。错误只断言关键中文片段，
 * 不锁死整句文案，免得改一个字就红一片。
 */

// ---------------------------------------------------------------------------
// 断言辅助：把 CanvasResult 收窄成具体值，失败时抛出可读原因
// ---------------------------------------------------------------------------

function valueOf(result: CanvasResult<Value>): Value {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.message}`);
  return result.value;
}

function failureMessage(result: CanvasResult<Value>): string {
  if (result.ok) throw new Error(`期望失败，实际得到${valueTypeName(result.value)}`);
  return result.message;
}

function intOf(result: CanvasResult<Value>): bigint {
  const value = valueOf(result);
  if (value.kind !== 'int') throw new Error(`期望整数，实际是${valueTypeName(value)}`);
  return value.value;
}

function doubleOf(result: CanvasResult<Value>): number {
  const value = valueOf(result);
  if (value.kind !== 'double') throw new Error(`期望浮点数，实际是${valueTypeName(value)}`);
  return value.value;
}

function boolOf(result: CanvasResult<Value>): boolean {
  const value = valueOf(result);
  if (value.kind !== 'bool') throw new Error(`期望布尔，实际是${valueTypeName(value)}`);
  return value.value;
}

function sampleDict(): Value {
  const built = dictValue([{ key: stringKey('a'), value: intValue(1n) }]);
  if (!built.ok) throw new Error(`构造字典失败：${built.message}`);
  return built.value;
}

// ---------------------------------------------------------------------------
// 整数算术
// ---------------------------------------------------------------------------

describe('二元：整数算术', () => {
  it('整数加：2 + 3 = 5', () => {
    expect(intOf(applyBinary('int.add', intValue(2n), intValue(3n)))).toBe(5n);
  });

  it('整数减：2 - 5 = -3', () => {
    expect(intOf(applyBinary('int.sub', intValue(2n), intValue(5n)))).toBe(-3n);
  });

  it('整数乘：-4 × 3 = -12', () => {
    expect(intOf(applyBinary('int.mul', intValue(-4n), intValue(3n)))).toBe(-12n);
  });

  it('整数整除向零截断：-7 div 2 = -3', () => {
    expect(intOf(applyBinary('int.div', intValue(-7n), intValue(2n)))).toBe(-3n);
  });

  it('整数整除向零截断：7 div -2 = -3', () => {
    expect(intOf(applyBinary('int.div', intValue(7n), intValue(-2n)))).toBe(-3n);
  });

  it('整数取余的符号跟着被除数：-7 mod 2 = -1', () => {
    expect(intOf(applyBinary('int.mod', intValue(-7n), intValue(2n)))).toBe(-1n);
  });

  it('整数取余的符号跟着被除数：7 mod -2 = 1', () => {
    expect(intOf(applyBinary('int.mod', intValue(7n), intValue(-2n)))).toBe(1n);
  });

  it('整数整除的除数为 0 时失败', () => {
    const message = failureMessage(applyBinary('int.div', intValue(1n), intValue(0n)));
    expect(message).toContain('整数整除');
    expect(message).toContain('除数不能为 0');
  });

  it('整数取余的除数为 0 时失败', () => {
    const message = failureMessage(applyBinary('int.mod', intValue(1n), intValue(0n)));
    expect(message).toContain('整数取余');
    expect(message).toContain('除数不能为 0');
  });
});

// ---------------------------------------------------------------------------
// 位运算与移位
// ---------------------------------------------------------------------------

describe('二元：位运算与移位', () => {
  it('按位与允许负数：-1 and 0xff = 255', () => {
    expect(intOf(applyBinary('int.and', intValue(-1n), intValue(0xffn)))).toBe(255n);
  });

  it('按位或：0b1010 or 0b0101 = 0b1111', () => {
    expect(intOf(applyBinary('int.or', intValue(0b1010n), intValue(0b0101n)))).toBe(0b1111n);
  });

  it('按位异或：0b1100 xor 0b1010 = 0b0110', () => {
    expect(intOf(applyBinary('int.xor', intValue(0b1100n), intValue(0b1010n)))).toBe(0b0110n);
  });

  it('左移：1 << 10 = 1024', () => {
    expect(intOf(applyBinary('int.shl', intValue(1n), intValue(10n)))).toBe(1024n);
  });

  it('右移对负数向下取整：-7 >> 1 = -4', () => {
    expect(intOf(applyBinary('int.shr', intValue(-7n), intValue(1n)))).toBe(-4n);
  });

  it('右移正数：1024 >> 4 = 64', () => {
    expect(intOf(applyBinary('int.shr', intValue(1024n), intValue(4n)))).toBe(64n);
  });

  it('左移移位量为负时失败', () => {
    const message = failureMessage(applyBinary('int.shl', intValue(1n), intValue(-1n)));
    expect(message).toContain('左移');
    expect(message).toContain('移位量不能为负');
  });

  it('右移移位量超过上限时失败', () => {
    const over = BigInt(CANVAS_MAX_INT_BITS) + 1n;
    const message = failureMessage(applyBinary('int.shr', intValue(1n), intValue(over)));
    expect(message).toContain('右移');
    expect(message).toContain('超过上限');
  });

  it('左移结果超过 CANVAS_MAX_INT_BITS 位时失败', () => {
    const message = failureMessage(applyBinary('int.shl', intValue(1n), intValue(BigInt(CANVAS_MAX_INT_BITS))));
    expect(message).toContain('超过上限');
    expect(message).toContain(String(CANVAS_MAX_INT_BITS));
  });
});

// ---------------------------------------------------------------------------
// 类型校验：不做隐式转换
// ---------------------------------------------------------------------------

describe('二元：类型校验', () => {
  it('整数加遇到文本右操作数时失败并点明类型', () => {
    const message = failureMessage(applyBinary('int.add', intValue(1n), stringValue('abc')));
    expect(message).toContain('「整数加」需要两边都是整数');
    expect(message).toContain('右边是文本');
  });

  it('整数加遇到文本左操作数时失败并点明类型', () => {
    const message = failureMessage(applyBinary('int.add', stringValue('abc'), intValue(1n)));
    expect(message).toContain('「整数加」需要两边都是整数');
    expect(message).toContain('左边是文本');
  });

  it('整数与浮点混用直接失败，不做隐式转换', () => {
    const message = failureMessage(applyBinary('int.add', intValue(1n), doubleValue(1.5)));
    expect(message).toContain('「整数加」需要两边都是整数');
    expect(message).toContain('右边是浮点数');
  });

  it('浮点加遇到整数右操作数时失败', () => {
    const message = failureMessage(applyBinary('double.add', doubleValue(1.5), intValue(1n)));
    expect(message).toContain('「浮点加」需要两边都是浮点数');
    expect(message).toContain('右边是整数');
  });

  it('布尔与遇到整数左操作数时失败', () => {
    const message = failureMessage(applyBinary('bool.and', intValue(1n), boolValue(true)));
    expect(message).toContain('「布尔与」需要两边都是布尔');
    expect(message).toContain('左边是整数');
  });
});

// ---------------------------------------------------------------------------
// 浮点算术
// ---------------------------------------------------------------------------

describe('二元：浮点算术', () => {
  it('浮点加：1.5 + 2.25 = 3.75', () => {
    expect(doubleOf(applyBinary('double.add', doubleValue(1.5), doubleValue(2.25)))).toBe(3.75);
  });

  it('浮点加不修正二进制误差：0.1 + 0.2 = 0.30000000000000004', () => {
    expect(doubleOf(applyBinary('double.add', doubleValue(0.1), doubleValue(0.2)))).toBe(0.30000000000000004);
  });

  it('浮点减：5.5 - 2.25 = 3.25', () => {
    expect(doubleOf(applyBinary('double.sub', doubleValue(5.5), doubleValue(2.25)))).toBe(3.25);
  });

  it('浮点乘：-2.5 × 4 = -10', () => {
    expect(doubleOf(applyBinary('double.mul', doubleValue(-2.5), doubleValue(4)))).toBe(-10);
  });

  it('浮点除：7 ÷ 2 = 3.5', () => {
    expect(doubleOf(applyBinary('double.div', doubleValue(7), doubleValue(2)))).toBe(3.5);
  });

  it('浮点除的除数为 0 时失败，不产生 Infinity', () => {
    const message = failureMessage(applyBinary('double.div', doubleValue(1), doubleValue(0)));
    expect(message).toContain('「浮点除」的除数不能为 0');
  });

  it('浮点乘溢出成 Infinity 时失败', () => {
    const message = failureMessage(applyBinary('double.mul', doubleValue(1e308), doubleValue(1e308)));
    expect(message).toContain('浮点数');
    expect(message).toContain('有限');
  });
});

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

describe('二元：整数比较', () => {
  it('整数等于：2 = 2 为真，2 = 3 为假', () => {
    expect(boolOf(applyBinary('int.eq', intValue(2n), intValue(2n)))).toBe(true);
    expect(boolOf(applyBinary('int.eq', intValue(2n), intValue(3n)))).toBe(false);
  });

  it('整数不等于：2 ≠ 3 为真，2 ≠ 2 为假', () => {
    expect(boolOf(applyBinary('int.ne', intValue(2n), intValue(3n)))).toBe(true);
    expect(boolOf(applyBinary('int.ne', intValue(2n), intValue(2n)))).toBe(false);
  });

  it('整数小于：2 < 3 为真，3 < 3 为假', () => {
    expect(boolOf(applyBinary('int.lt', intValue(2n), intValue(3n)))).toBe(true);
    expect(boolOf(applyBinary('int.lt', intValue(3n), intValue(3n)))).toBe(false);
  });

  it('整数小于等于：3 ≤ 3 在边界上为真', () => {
    expect(boolOf(applyBinary('int.le', intValue(3n), intValue(3n)))).toBe(true);
    expect(boolOf(applyBinary('int.le', intValue(4n), intValue(3n)))).toBe(false);
  });

  it('整数大于：3 > 2 为真，3 > 3 为假', () => {
    expect(boolOf(applyBinary('int.gt', intValue(3n), intValue(2n)))).toBe(true);
    expect(boolOf(applyBinary('int.gt', intValue(3n), intValue(3n)))).toBe(false);
  });

  it('整数大于等于：3 ≥ 3 在边界上为真', () => {
    expect(boolOf(applyBinary('int.ge', intValue(3n), intValue(3n)))).toBe(true);
    expect(boolOf(applyBinary('int.ge', intValue(2n), intValue(3n)))).toBe(false);
  });
});

describe('二元：浮点比较', () => {
  it('浮点等于：2.5 = 2.5 为真', () => {
    expect(boolOf(applyBinary('double.eq', doubleValue(2.5), doubleValue(2.5)))).toBe(true);
  });

  it('浮点不等于：2.5 ≠ 2.5001 为真', () => {
    expect(boolOf(applyBinary('double.ne', doubleValue(2.5), doubleValue(2.5001)))).toBe(true);
  });

  it('浮点小于：2.5 < 2.75 为真', () => {
    expect(boolOf(applyBinary('double.lt', doubleValue(2.5), doubleValue(2.75)))).toBe(true);
  });

  it('浮点小于等于：2.5 ≤ 2.5 在边界上为真', () => {
    expect(boolOf(applyBinary('double.le', doubleValue(2.5), doubleValue(2.5)))).toBe(true);
  });

  it('浮点大于：2.75 > 2.5 为真', () => {
    expect(boolOf(applyBinary('double.gt', doubleValue(2.75), doubleValue(2.5)))).toBe(true);
  });

  it('浮点大于等于：2.5 ≥ 2.5 在边界上为真', () => {
    expect(boolOf(applyBinary('double.ge', doubleValue(2.5), doubleValue(2.5)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 布尔与短路
// ---------------------------------------------------------------------------

describe('二元：布尔与、或', () => {
  it('布尔与：真且真 = 真，真且假 = 假', () => {
    expect(boolOf(applyBinary('bool.and', boolValue(true), boolValue(true)))).toBe(true);
    expect(boolOf(applyBinary('bool.and', boolValue(true), boolValue(false)))).toBe(false);
  });

  it('布尔或：假或真 = 真，假或假 = 假', () => {
    expect(boolOf(applyBinary('bool.or', boolValue(false), boolValue(true)))).toBe(true);
    expect(boolOf(applyBinary('bool.or', boolValue(false), boolValue(false)))).toBe(false);
  });
});

describe('布尔短路：decidedByLeft', () => {
  it('布尔与的左操作数为假时直接给出假', () => {
    expect(decidedByLeft('bool.and', boolValue(false))).toEqual(boolValue(false));
  });

  it('布尔与的左操作数为真时必须继续求值右侧', () => {
    expect(decidedByLeft('bool.and', boolValue(true))).toBeUndefined();
  });

  it('布尔或的左操作数为真时直接给出真', () => {
    expect(decidedByLeft('bool.or', boolValue(true))).toEqual(boolValue(true));
  });

  it('布尔或的左操作数为假时必须继续求值右侧', () => {
    expect(decidedByLeft('bool.or', boolValue(false))).toBeUndefined();
  });

  it('左操作数不是布尔时不报错，返回 undefined 交给正常求值路径', () => {
    expect(decidedByLeft('bool.and', intValue(1n))).toBeUndefined();
    expect(decidedByLeft('bool.or', stringValue('x'))).toBeUndefined();
  });

  it('非短路运算一律返回 undefined', () => {
    expect(decidedByLeft('int.add', intValue(1n))).toBeUndefined();
    expect(decidedByLeft('int.eq', intValue(1n))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 一元运算
// ---------------------------------------------------------------------------

describe('一元：取反', () => {
  it('真取反为假，假取反为真', () => {
    expect(boolOf(applyUnary('bool.not', boolValue(true)))).toBe(false);
    expect(boolOf(applyUnary('bool.not', boolValue(false)))).toBe(true);
  });

  it('取反只接受布尔，收到整数时报错', () => {
    const message = failureMessage(applyUnary('bool.not', intValue(1n)));
    expect(message).toContain('「取反」只接受布尔');
    expect(message).toContain('收到整数');
  });
});

describe('一元：长度', () => {
  it('文本按码点数：A😀B 的长度是 3，不是 4', () => {
    expect(intOf(applyUnary('length', stringValue('A😀B')))).toBe(3n);
  });

  it('空文本长度为 0', () => {
    expect(intOf(applyUnary('length', stringValue('')))).toBe(0n);
  });

  it('字节串按字节数：0xdeadbeef 的长度是 4', () => {
    const bytes = byteValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(intOf(applyUnary('length', bytes))).toBe(4n);
  });

  it('列表按元素数', () => {
    const list = listValue([intValue(1n), stringValue('x'), boolValue(true)]);
    expect(intOf(applyUnary('length', list))).toBe(3n);
  });

  it('字典不接受长度，报错点明类型', () => {
    const message = failureMessage(applyUnary('length', sampleDict()));
    expect(message).toContain('「长度」只接受字节串、文本和列表，收到字典');
  });

  it('整数不接受长度', () => {
    const message = failureMessage(applyUnary('length', intValue(1n)));
    expect(message).toContain('「长度」只接受字节串、文本和列表，收到整数');
  });
});
