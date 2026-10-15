import { describe, expect, it } from 'vitest';
import {
  buildEncodingLookup,
  expandEncoding,
  renderMnemonic,
  type EncodingItem,
} from '@pwn2block/shared';

const preset: EncodingItem[] = [
  { opcode: '0x50', op: 'push', operands: ['reg:RBP'] },
  { opcode: '0xc3', op: 'ret', operands: [] },
  { opcode: '0x0f', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall win' },
];

describe('编码表展开', () => {
  it('preset 引用按 add / remove 展开', () => {
    const items = expandEncoding(
      {
        preset: 'x86ish',
        add: [{ opcode: '0xb8', op: 'mov', operands: ['reg:RAX', 'imm'] }],
        remove: ['0xc3'],
      },
      preset,
    );
    expect(items.map((item) => item.opcode)).toEqual(['0x50', '0x0f', '0xb8']);
  });

  it('完整表直接返回，不做预设合并', () => {
    expect(expandEncoding(preset)).toHaveLength(3);
  });

  it('引用 preset 但没提供内容时报错，而不是静默给空表', () => {
    expect(() => expandEncoding({ preset: 'x86ish' })).toThrow(/preset/);
  });

  it('同一 opcode 重复声明直接报错，避免两套解码结果', () => {
    expect(() =>
      expandEncoding({ preset: 'x86ish', add: [{ opcode: '0xc3', op: 'nop', operands: [] }] }, preset),
    ).toThrow(/重复/);
  });
});

describe('编码表查询', () => {
  const lookup = buildEncodingLookup(preset, 8);

  it('按 opcode 取项，只取低 8 位', () => {
    expect(lookup.byOpcode(0x50)?.op).toBe('push');
    expect(lookup.byOpcode(0x150)?.op).toBe('push');
    expect(lookup.byOpcode(0x90)).toBeUndefined();
  });

  it('按作用与操作数形态精确匹配', () => {
    expect(lookup.find('push', ['reg:RBP'])?.opcode).toBe('0x50');
    expect(lookup.find('push', ['reg:RAX'])).toBeUndefined();
    expect(lookup.find('ret', [])?.opcode).toBe('0xc3');
    expect(lookup.find('ret', ['imm'])).toBeUndefined();
  });

  it('伪汇编优先用出题人给的 mnemonic，否则按作用与操作数渲染', () => {
    const win = lookup.byOpcode(0x0f);
    expect(win && renderMnemonic(win)).toBe('syscall win');
    expect(renderMnemonic({ opcode: '0xb8', op: 'mov', operands: ['reg:RAX', 'imm'] })).toBe(
      'mov RAX, imm',
    );
    expect(renderMnemonic({ opcode: '0xc3', op: 'ret', operands: [] })).toBe('ret');
  });
});
