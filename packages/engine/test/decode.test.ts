import { describe, expect, it } from 'vitest';
import { buildEncodingLookup, bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { EncodingItem } from '@pwn2block/shared';
import { decodeAt, maxInstructionBytes, renderInstruction } from '../src/decode';
import type { DecodedInstruction, DecodedOperand } from '../src/decode';
import { p32, p64 } from './helpers/challenge';

const ITEMS: EncodingItem[] = [
  { opcode: '0x90', op: 'nop', operands: [] },
  { opcode: '0x01', op: 'mov', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x02', op: 'mov', operands: ['reg:RAX', 'reg:RBX'] },
  { opcode: '0x03', op: 'mov', operands: ['mem:RBP+disp', 'reg:RAX'] },
  { opcode: '0x04', op: 'mov', operands: ['reg:RAX', 'mem:RBP+disp'], mnemonic: 'mov rax, [rbp+disp]' },
  { opcode: '0x05', op: 'syscall', operands: [] },
  { opcode: '0x06', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
  { opcode: '0x07', op: 'syscall', operands: ['const:99'] },
  { opcode: '0x08', op: 'jmp', operands: ['imm'] },
  { opcode: '0x09', op: 'push', operands: ['imm'] },
];

const lookup = buildEncodingLookup(ITEMS, 8);
const lookup32 = buildEncodingLookup(ITEMS, 4);
const BASE = 0x400000n;

function decodeOk(bytes: Uint8Array, ip = BASE, table = lookup): DecodedInstruction {
  const result = decodeAt(bytes, ip, table);
  if (!result.ok) throw new Error(`期望解码成功，实际失败：${result.detail}`);
  return result.instruction;
}

function operands(instruction: DecodedInstruction): DecodedOperand[] {
  return [...instruction.operands];
}

describe('decodeAt：基本形态', () => {
  it('nop 是单字节指令，无操作数', () => {
    const instruction = decodeOk(Uint8Array.from([0x90]));
    expect(instruction.addr).toBe(BASE);
    expect(instruction.op).toBe('nop');
    expect(instruction.length).toBe(1);
    expect(instruction.bytes).toEqual(Uint8Array.from([0x90]));
    expect(instruction.text).toBe('nop');
    expect(operands(instruction)).toEqual([]);
    expect(instruction.target).toBeUndefined();
  });

  it('mov RAX, imm 按 8 字节小端读立即数', () => {
    const instruction = decodeOk(hexToBytes(`01${p64(0xdeadbeefn)}`));
    expect(instruction.length).toBe(9);
    expect(instruction.operands).toEqual([{ kind: 'reg', name: 'RAX' }, { kind: 'imm', value: 0xdeadbeefn }]);
    expect(instruction.text).toBe('mov RAX, 0xdeadbeef');
  });

  it('立即数按小端解释：01 02 03 04 05 06 07 08 → 0x0807060504030201', () => {
    const instruction = decodeOk(hexToBytes(`01${'0102030405060708'}`));
    expect(instruction.operands[1]).toEqual({ kind: 'imm', value: 0x0807060504030201n });
  });

  it('mov RAX, RBX 没有内联字节', () => {
    const instruction = decodeOk(Uint8Array.from([0x02]));
    expect(instruction.length).toBe(1);
    expect(instruction.operands).toEqual([
      { kind: 'reg', name: 'RAX' },
      { kind: 'reg', name: 'RBX' },
    ]);
    expect(instruction.text).toBe('mov RAX, RBX');
  });

  it('mov mem:RBP+disp, R 读位移并渲染有效地址写法', () => {
    const instruction = decodeOk(hexToBytes(`03${p64(0x10n)}`));
    expect(instruction.length).toBe(9);
    expect(instruction.operands).toEqual([
      { kind: 'mem', base: 'RBP', disp: 0x10n },
      { kind: 'reg', name: 'RAX' },
    ]);
    expect(instruction.text).toBe('mov [RBP+0x10], RAX');
  });

  it('有内联数值时忽略 mnemonic，渲染真实值（显示名只用于无内联数值的指令）', () => {
    const instruction = decodeOk(hexToBytes(`04${p64(0x18n)}`));
    expect(instruction.text).toBe('mov RAX, [RBP+0x18]');
  });

  it('syscall 无操作数形态', () => {
    const instruction = decodeOk(Uint8Array.from([0x05]));
    expect(instruction.op).toBe('syscall');
    expect(instruction.operands).toEqual([]);
    expect(instruction.text).toBe('syscall');
  });

  it('syscall const:N 形态用 mnemonic 作显示名', () => {
    const instruction = decodeOk(Uint8Array.from([0x06]));
    expect(instruction.length).toBe(1);
    expect(instruction.operands).toEqual([{ kind: 'const', nr: 60 }]);
    expect(instruction.text).toBe('syscall exit');
  });

  it('syscall const:N 没有 mnemonic 时渲染常量值', () => {
    expect(decodeOk(Uint8Array.from([0x07])).text).toBe('syscall 99');
  });

  it('jmp imm 给出 target', () => {
    const instruction = decodeOk(hexToBytes(`08${p64(0x401000n)}`));
    expect(instruction.target).toBe(0x401000n);
    expect(instruction.text).toBe('jmp 0x401000');
  });

  it('非跳转指令没有 target', () => {
    expect(decodeOk(hexToBytes(`01${p64(1n)}`)).target).toBeUndefined();
  });
});

describe('decodeAt：32 位题目按 4 字节读内联字', () => {
  it('mov RAX, imm 只消费 4 字节', () => {
    const instruction = decodeOk(hexToBytes(`01${p32(0x11223344n)}ffffff`), BASE, lookup32);
    expect(instruction.length).toBe(5);
    expect(instruction.operands[1]).toEqual({ kind: 'imm', value: 0x11223344n });
    expect(instruction.text).toBe('mov RAX, 0x11223344');
  });

  it('mem disp 也是 4 字节', () => {
    const instruction = decodeOk(hexToBytes(`03${p32(0x20n)}`), BASE, lookup32);
    expect(instruction.length).toBe(5);
    expect(instruction.operands[0]).toEqual({ kind: 'mem', base: 'RBP', disp: 0x20n });
  });

  it('窗口只剩 3 字节时判解码失败', () => {
    const result = decodeAt(hexToBytes('01112233'), BASE, lookup32);
    expect(result.ok).toBe(false);
  });
});

describe('decodeAt：失败路径', () => {
  it('未命中 opcode 回 unknown_opcode 并带 opcode 值', () => {
    const result = decodeAt(Uint8Array.from([0xff]), BASE, lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_opcode');
    expect(result.opcode).toBe(0xff);
    expect(result.addr).toBe(BASE);
    expect(result.detail).toContain('0xff');
  });

  it('窗口不足时回 truncated，且不读出窗口外的字节', () => {
    const result = decodeAt(hexToBytes(`01${p64(1n).slice(0, 8)}`), BASE, lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('truncated');
    expect(result.opcode).toBe(0x01);
    expect(result.detail).toContain('内联操作数');
  });

  it('空窗口回 truncated', () => {
    const result = decodeAt(new Uint8Array(0), BASE, lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('truncated');
    expect(result.addr).toBe(BASE);
  });

  it('只在最末尾差一个字节时也算失败（不猜半个立即数）', () => {
    expect(decodeAt(hexToBytes(`01${'00'.repeat(7)}`), BASE, lookup).ok).toBe(false);
    expect(decodeAt(hexToBytes(`01${'00'.repeat(8)}`), BASE, lookup).ok).toBe(true);
  });
});

describe('decodeAt：边界与不可变性', () => {
  it('多给的字节不进入指令', () => {
    const instruction = decodeOk(Uint8Array.from([0x90, 0xaa, 0xbb]));
    expect(instruction.length).toBe(1);
    expect(bytesToHex(instruction.bytes)).toBe('90');
  });

  it('ip 只影响 addr，不影响解码结果', () => {
    const instruction = decodeOk(Uint8Array.from([0x90]), 0x7ff000n);
    expect(instruction.addr).toBe(0x7ff000n);
  });

  it('instruction.bytes 是副本：改窗口不影响已解码结果', () => {
    const window = hexToBytes(`01${p64(0x2an)}`);
    const instruction = decodeOk(window);
    window[1] = 0xff;
    expect(bytesToHex(instruction.bytes)).toBe(`01${p64(0x2an)}`);
    expect(instruction.operands[1]).toEqual({ kind: 'imm', value: 0x2an });
  });

  it('maxInstructionBytes = 1 + 3 * W', () => {
    expect(maxInstructionBytes(8)).toBe(25);
    expect(maxInstructionBytes(4)).toBe(13);
  });

  it('renderInstruction 在没有操作数时回 op 本身', () => {
    const nop = ITEMS[0] as EncodingItem;
    expect(renderInstruction(nop, [])).toBe('nop');
  });
});
