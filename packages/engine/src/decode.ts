import {
  bytesToBigIntLE,
  formatHex,
  isMemOperand,
  operandConst,
  operandRegister,
  renderMnemonic,
} from '@pwn2block/shared';
import type { EncodingItem, EncodingLookup, OpName, Operand } from '@pwn2block/shared';

/**
 * 解码器（02 §4）：把 `EncodingLookup` + 一段字节窗口变成结构化的指令。
 *
 * 设计要点：
 * - **纯函数**：字节窗口由调用方从内存取出（执行循环取 `x` 可执行区域，反汇编取
 *   整个可见区域），解码器自己不依赖内存实现，因此可以独立精确测试。
 * - 内联立即数 `imm` 与 `mem:R+disp` 的 `disp` 都按字长 `W = archBits / 8` 小端读取（02 §4）。
 * - 窗口不足 → `truncated`（解码失败，调用方按取指失败处理）；未命中编码表 → `unknown_opcode`。
 * - 解码失败时**不猜**：绝不返回半条指令，也不越过窗口读取。
 */

/** 已解码的操作数：`reg:R` / `imm` / `mem:R+disp` / `const:N`（02 §4）。 */
export type DecodedOperand =
  | { readonly kind: 'reg'; readonly name: string }
  | { readonly kind: 'imm'; readonly value: bigint }
  | { readonly kind: 'mem'; readonly base: string; readonly disp: bigint }
  | { readonly kind: 'const'; readonly nr: number };

export interface DecodedInstruction {
  /** 指令起始地址（取指地址）。 */
  readonly addr: bigint;
  readonly item: EncodingItem;
  readonly op: OpName;
  readonly operands: readonly DecodedOperand[];
  /** 指令总长度（1 + 内联 W 字节的个数）。 */
  readonly length: number;
  /** 该指令占用的字节副本。 */
  readonly bytes: Uint8Array;
  /** 伪汇编文本，见 `renderInstruction`。 */
  readonly text: string;
  /** 跳转 / 调用目标的立即数值；需要读寄存器才能算的形态（`reg` / `mem`）留空。 */
  readonly target?: bigint;
}

export type DecodeFailureReason = 'unknown_opcode' | 'truncated';

export type DecodeResult =
  | { readonly ok: true; readonly instruction: DecodedInstruction }
  | {
      readonly ok: false;
      readonly reason: DecodeFailureReason;
      readonly addr: bigint;
      readonly opcode?: number;
      /** 供错误文案使用的机器可读说明，不含任何隐藏内容。 */
      readonly detail: string;
    };

/** 跳转 / 调用类作用：`target` 字段只对它们有意义。 */
const TRANSFER_OPS: ReadonlySet<OpName> = new Set<OpName>(['jmp', 'je', 'jne', 'jb', 'jae', 'call']);

function decodeOperand(
  operand: Operand,
  bytes: Uint8Array,
  offset: number,
  wordBytes: number,
): { readonly operand: DecodedOperand; readonly offset: number } | undefined {
  const reg = operandRegister(operand);
  if (reg !== undefined) {
    // `reg:R` 与 `mem:R+disp` 都带寄存器名；`mem` 还需要内联位移。
    if (operand.startsWith('reg:')) return { operand: { kind: 'reg', name: reg }, offset };
    if (offset + wordBytes > bytes.length) return undefined;
    const disp = bytesToBigIntLE(bytes.subarray(offset, offset + wordBytes));
    return { operand: { kind: 'mem', base: reg, disp }, offset: offset + wordBytes };
  }

  const nr = operandConst(operand);
  if (nr !== undefined) return { operand: { kind: 'const', nr }, offset };

  if (operand === 'imm') {
    if (offset + wordBytes > bytes.length) return undefined;
    const value = bytesToBigIntLE(bytes.subarray(offset, offset + wordBytes));
    return { operand: { kind: 'imm', value }, offset: offset + wordBytes };
  }

  return undefined;
}

/**
 * 位移 → 伪汇编文本：把 W 字节的无符号位移按**二补数**解读，负位移写成 `-0x…`。
 *
 * 口径（本任务定）：`disp` 由 `bytesToBigIntLE` 读成无符号值，宽度来自 `lookup.wordBytes`
 * （`archBits / 8`），所以最高位为 1 时它就是负数——`base + disp` 靠回绕得到同一地址
 * （`instructions.ts` 的 `effectiveAddress`），**寻址语义不受这里影响**，这里只决定显示。
 * 于是 64 位 `0xfffffffffffffff8` → `-0x8`，32 位 `0xfffffff8` → `-0x8`；32 位
 * `0x80000000` 是二补数最小值（取负仍是自己），按同一约定渲染成 `-0x80000000`。
 * `disp === 0` 仍渲染 `+0x0`，与既有输出逐字一致。
 *
 * 只对 `mem` 的位移这样做：`imm` 既可能是地址也可能是负数，按有符号解释会误导，见
 * `renderInstruction` 的说明。
 */
function renderDisplacement(disp: bigint, wordBytes: number): string {
  if (!Number.isInteger(wordBytes) || wordBytes < 1) {
    throw new Error(`位移渲染需要正的整数字节宽度，实际收到 ${wordBytes}`);
  }
  const bits = BigInt(wordBytes * 8);
  const signBit = 1n << (bits - 1n);
  if (disp >= signBit) return `-${formatHex((1n << bits) - disp)}`;
  return `+${formatHex(disp)}`;
}

/**
 * 伪汇编文本。
 *
 * 规则：操作数里有内联数值（`imm` / `mem:R+disp`）时必须渲染真实值，例如
 * `mov RAX, 0x10`、`mov RAX, [RBP+0x8]`、`mov RAX, [RBP-0x8]`；没有内联数值时优先用
 * 出题人声明的 `mnemonic` 显示名（例如 `syscall const:60` → `syscall exit`，02 §4）。
 *
 * `wordBytes`（= `lookup.wordBytes`）只用于解读 `mem` 位移的符号：位移的宽度信息不在
 * `DecodedOperand` 里，单看 `0xfffffffffffffff8` 无法区分「64 位的 -8」和「一个真的很大的
 * 64 位位移」，必须由调用方从编码表带进来。**`imm` 保持无符号原样渲染**：它是地址还是
 * 负数无法从形态判断，改动会造成新的误导。
 */
export function renderInstruction(
  item: EncodingItem,
  operands: readonly DecodedOperand[],
  wordBytes: number,
): string {
  const hasInline = item.operands.some((operand) => operand === 'imm' || isMemOperand(operand));
  if (item.mnemonic !== undefined && !hasInline) return item.mnemonic;

  const rendered = operands.map((operand) => {
    switch (operand.kind) {
      case 'reg':
        return operand.name;
      case 'imm':
        return formatHex(operand.value);
      case 'mem':
        return `[${operand.base}${renderDisplacement(operand.disp, wordBytes)}]`;
      case 'const':
        return String(operand.nr);
    }
  });
  return renderMnemonic(item, rendered);
}

/** 一条指令里最多能有多少个内联字（编码表最多 3 个操作数）。 */
export function maxInstructionBytes(wordBytes: number): number {
  return 1 + 3 * wordBytes;
}

/**
 * 从字节窗口解出一条指令。
 *
 * `bytes` 是窗口（长度至少 1，调用方保证窗口内的字节已通过取指权限检查），
 * `ip` 是窗口首字节对应的地址，只用于回填 `addr` 与失败信息。
 */
export function decodeAt(bytes: Uint8Array, ip: bigint, lookup: EncodingLookup): DecodeResult {
  const first = bytes[0];
  if (first === undefined) {
    return { ok: false, reason: 'truncated', addr: ip, detail: '取指窗口为空，无法解码' };
  }

  const item = lookup.byOpcode(first);
  if (item === undefined) {
    return {
      ok: false,
      reason: 'unknown_opcode',
      addr: ip,
      opcode: first,
      detail: `未命中编码表的 opcode 0x${first.toString(16).padStart(2, '0')}`,
    };
  }

  const wordBytes = lookup.wordBytes;
  const operands: DecodedOperand[] = [];
  let offset = 1;

  for (const operand of item.operands) {
    const decoded = decodeOperand(operand, bytes, offset, wordBytes);
    if (decoded === undefined) {
      return {
        ok: false,
        reason: 'truncated',
        addr: ip,
        opcode: first,
        detail:
          offset + wordBytes > bytes.length
            ? `指令 ${item.op} 需要 ${wordBytes} 字节内联操作数，窗口只剩 ${bytes.length - offset} 字节`
            : `操作数形态无法解码：${operand}`,
      };
    }
    operands.push(decoded.operand);
    offset = decoded.offset;
  }

  const instruction: DecodedInstruction = {
    addr: ip,
    item,
    op: item.op,
    operands,
    length: offset,
    bytes: bytes.slice(0, offset),
    text: renderInstruction(item, operands, wordBytes),
    target: transferTarget(item.op, operands),
  };
  return { ok: true, instruction };
}

function transferTarget(op: OpName, operands: readonly DecodedOperand[]): bigint | undefined {
  if (!TRANSFER_OPS.has(op)) return undefined;
  const first = operands[0];
  return first !== undefined && first.kind === 'imm' ? first.value : undefined;
}
