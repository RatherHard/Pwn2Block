import type { Flags } from '@pwn2block/shared';

/**
 * 算术与位运算的标志位语义（02 §2）。
 *
 * - `add / sub / cmp` 设置全部三个标志；`cmp` 与 `sub` 的区别只在“不写回”。
 * - 逻辑运算（`and / or / xor`）与移位只设置 `ZF / SF`，`CF` 保持原值。
 * - `CF` 是**无符号**进位 / 借位：`add` 看出位，`sub / cmp` 看 `a < b`。
 * - 所有值都在掩蔽域内计算，溢出按 2^archBits 回绕（02 §1）。
 */

export interface ValueAndFlags {
  readonly value: bigint;
  /** 本操作是否写回通用寄存器（`cmp` 为 false）。 */
  readonly writeBack: boolean;
  readonly flags: Flags;
}

/** 有符号位：`1 << (archBits - 1)`。 */
export function signBit(archBits: number): bigint {
  return 1n << BigInt(archBits - 1);
}

function flagsOf(value: bigint, archBits: number, carry: boolean): Flags {
  return { ZF: value === 0n, CF: carry, SF: (value & signBit(archBits)) !== 0n };
}

/** `add`：写回结果并设置三标志。 */
export function addValues(a: bigint, b: bigint, mask: bigint, archBits: number): ValueAndFlags {
  const sum = a + b;
  const value = sum & mask;
  return { value, writeBack: true, flags: flagsOf(value, archBits, sum > mask) };
}

/** `sub`：写回结果并设置三标志（借位即 `a < b`）。 */
export function subValues(a: bigint, b: bigint, mask: bigint, archBits: number): ValueAndFlags {
  const value = (a - b) & mask;
  return { value, writeBack: true, flags: flagsOf(value, archBits, a < b) };
}

/** `cmp`：只设置标志，不写回。 */
export function cmpValues(a: bigint, b: bigint, mask: bigint, archBits: number): ValueAndFlags {
  const result = subValues(a, b, mask, archBits);
  return { ...result, writeBack: false };
}

/** 逻辑运算：只改 `ZF / SF`，`CF` 沿用旧值。 */
export function logicValues(
  value: bigint,
  mask: bigint,
  archBits: number,
  previous: Flags,
): ValueAndFlags {
  const masked = value & mask;
  return {
    value: masked,
    writeBack: true,
    flags: { ZF: masked === 0n, CF: previous.CF, SF: (masked & signBit(archBits)) !== 0n },
  };
}

/**
 * 移位：移位量对 `archBits` 取模（02 §4.1），只改 `ZF / SF`。
 * `shr` 是逻辑右移（无符号），`shl` 溢出位丢弃。
 */
export function shiftValues(
  value: bigint,
  amount: bigint,
  direction: 'left' | 'right',
  mask: bigint,
  archBits: number,
  previous: Flags,
): ValueAndFlags {
  const shift = amount % BigInt(archBits);
  const shifted = direction === 'left' ? (value << shift) & mask : (value & mask) >> shift;
  return logicValues(shifted, mask, archBits, previous);
}
