import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { ChallengeVma, VmState } from '@pwn2block/shared';
import { createInitialState } from '../src/env';
import { disassembleState } from '../src/disasm';
import { readVisible, readVmaVisible } from '../src/visibility';
import { code, DATA_START, HIDDEN_START, p64, testKit } from './helpers/challenge';

describe('readVisible：只读可见字节的边界', () => {
  it('非隐藏可读区间按字节返回', () => {
    const kit = testKit({ code: code(0x01, p64(0x1234n)) });
    const state = createInitialState(kit.env);
    const result = readVisible(kit.env, state, 0x1000n, 2);
    expect(result).toEqual({ ok: true, bytes: Uint8Array.from([0x01, 0x34]) });
  });

  it('隐藏且未 reveal → hidden，连长度都不给', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, HIDDEN_START, 2)).toEqual({ ok: false, reason: 'hidden' });
  });

  it('reveal 之后可以读到隐藏区内容', () => {
    const kit = testKit();
    const base = createInitialState(kit.env);
    const revealed: VmState = { ...base, revealed: ['hidden'] };
    const result = readVisible(kit.env, revealed, HIDDEN_START, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bytesToHex(result.bytes)).toBe('aabb');
  });

  it('未映射 → unmapped', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, 0x9000n, 1)).toEqual({ ok: false, reason: 'unmapped' });
  });

  it('区间跨出所属 VMA → unmapped（不允许跨区拼字节）', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, 0x1fffn, 2).ok).toBe(false);
    expect(readVisible(kit.env, state, DATA_START - 1n, 2).ok).toBe(false);
  });

  it('长度非法 → unmapped', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, DATA_START, -1)).toEqual({ ok: false, reason: 'unmapped' });
    expect(readVisible(kit.env, state, DATA_START, 1.5)).toEqual({ ok: false, reason: 'unmapped' });
  });

  it('长度为 0 且起点可见 → 空字节', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, DATA_START, 0)).toEqual({ ok: true, bytes: new Uint8Array(0) });
    expect(readVisible(kit.env, state, 0x9000n, 0)).toEqual({ ok: false, reason: 'unmapped' });
  });

  it('没有 r 权限的区域 → permission', () => {
    const vmas: ChallengeVma[] = [
      { id: 'code', kind: 'code', start: '0x1000', size: '0x1000', perm: 'x', hidden: false },
    ];
    const kit = testKit({ vmas });
    const state = createInitialState(kit.env);
    expect(readVisible(kit.env, state, 0x1000n, 1)).toEqual({ ok: false, reason: 'permission' });
  });

  it('地址按位宽掩蔽（32 位题目的高位被丢掉）', () => {
    const kit = testKit({ archBits: 32, code: code(0x90) });
    const state = createInitialState(kit.env);
    const wrapped = readVisible(kit.env, state, 0x1_0000_1000n, 1);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(bytesToHex(wrapped.bytes)).toBe('90');
  });
});

describe('readVmaVisible：按 VMA 取内容', () => {
  it('非隐藏区域直接给全文（hex 与 r 权限无关，04 §4）', () => {
    const kit = testKit({ code: code(0x90) });
    const state = createInitialState(kit.env);
    const bytes = readVmaVisible(kit.env, state, 'rodata');
    expect(bytes).toBeDefined();
    expect(bytesToHex(bytes ?? new Uint8Array(0))).toBe('00'.repeat(0x1000));
  });

  it('隐藏区域在 reveal 前是 undefined，reveal 后是真实内容', () => {
    const kit = testKit();
    const state = createInitialState(kit.env);
    expect(readVmaVisible(kit.env, state, 'hidden')).toBeUndefined();
    expect(bytesToHex(readVmaVisible(kit.env, { ...state, revealed: ['hidden'] }, 'hidden') ?? new Uint8Array(0)).slice(0, 4)).toBe('aabb');
  });

  it('未知 id → undefined', () => {
    const kit = testKit();
    expect(readVmaVisible(kit.env, createInitialState(kit.env), 'nope')).toBeUndefined();
  });
});

describe('disassembleState：可见可执行区域的线性扫描', () => {
  it('反汇编非隐藏 x 区域，逐条给出 addr / bytes / text', () => {
    const kit = testKit({ code: code(0x90, 0x01, p64(0x10n)) });
    const state = createInitialState(kit.env);
    const entries = disassembleState(kit.env, state);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ addr: '0x1000', bytes: '90', text: 'nop' });
    expect(entries[1]?.addr).toBe('0x1001');
    expect(entries[1]?.bytes).toBe(`01${p64(0x10n)}`);
    expect(entries[1]?.text).toBe('mov RAX, 0x10');
  });

  it('运行期写进可写可执行区的非零字节也进入反汇编（先写 shellcode 再跳过去）', () => {
    const vmas: ChallengeVma[] = [
      {
        id: 'code',
        kind: 'code',
        start: '0x1000',
        size: '0x1000',
        perm: 'rwx',
        hidden: false,
        init: [{ at: '0x1000', hex: code(0x90) }],
      },
    ];
    const kit = testKit({ vmas });
    const state = createInitialState(kit.env);
    expect(kit.memory.write(state.memory, 0x1010n, hexToBytes('18')).ok).toBe(true);
    const entries = disassembleState(kit.env, state);
    // 0x1000 nop，中间 15 个未初始化字节，0x1010 是运行期写进去的 ret
    expect(entries).toHaveLength(17);
    expect(entries[0]).toEqual({ addr: '0x1000', bytes: '90', text: 'nop' });
    expect(entries[1]).toEqual({ addr: '0x1001', bytes: '00', text: 'db 0x00' });
    expect(entries.at(-1)).toEqual({ addr: '0x1010', bytes: '18', text: 'ret' });
  });

  it('带上跳转目标', () => {
    const kit = testKit({ code: code(0x11, p64(0x1500n)) });
    const entries = disassembleState(kit.env, createInitialState(kit.env));
    expect(entries[0]?.target).toBe('0x1500');
    expect(entries[0]?.text).toBe('jmp 0x1500');
  });

  it('未命中编码表的字节显示为 db，一次前进一字节', () => {
    const kit = testKit({ code: code(0xee, 0xee, 0x90) });
    const entries = disassembleState(kit.env, createInitialState(kit.env));
    expect(entries.map((entry) => entry.text)).toEqual(['db 0xee', 'db 0xee', 'nop']);
    expect(entries.map((entry) => entry.addr)).toEqual(['0x1000', '0x1001', '0x1002']);
  });

  it('隐藏且未 reveal 的区域不进反汇编', () => {
    const vmas: ChallengeVma[] = [
      { id: 'code', kind: 'code', start: '0x1000', size: '0x1000', perm: 'rx', hidden: false, init: [{ at: '0x1000', hex: code(0x90) }] },
      { id: 'secret', kind: 'code', start: '0x2000', size: '0x1000', perm: 'rx', hidden: true, init: [{ at: '0x2000', hex: code(0xc3) }] },
    ];
    const kit = testKit({ vmas });
    const state = createInitialState(kit.env);
    expect(disassembleState(kit.env, state).map((entry) => entry.addr)).toEqual(['0x1000']);
    expect(
      disassembleState(kit.env, { ...state, revealed: ['secret'] }).map((entry) => entry.addr),
    ).toEqual(['0x1000', '0x2000']);
  });

  it('不可执行的区域不出现', () => {
    const kit = testKit({ code: code(0x90) });
    const entries = disassembleState(kit.env, createInitialState(kit.env));
    expect(entries.every((entry) => entry.addr === '0x1000')).toBe(true);
  });

  it('区域末尾截断的指令按 db 逐字节给出，不越界', () => {
    // init 补丁落在 code 区最后一字节，所以有效前缀就是整页：前面全是未初始化的 0
    const kit = testKit({ code: code(0x01), codeAt: '0x1fff' });
    const entries = disassembleState(kit.env, createInitialState(kit.env));
    expect(entries).toHaveLength(0x1000);
    expect(entries.at(-2)).toEqual({ addr: '0x1ffe', bytes: '00', text: 'db 0x00' });
    expect(entries.at(-1)).toEqual({ addr: '0x1fff', bytes: '01', text: 'db 0x01' });
  });

  it('活动范围按 init 补丁裁剪：空区域不下发 db 0x00 填充', () => {
    const kit = testKit({ code: code(0x90) });
    expect(disassembleState(kit.env, createInitialState(kit.env))).toEqual([
      { addr: '0x1000', bytes: '90', text: 'nop' },
    ]);
  });

  it('反汇编不改内存（可重复调用）', () => {
    const kit = testKit({ code: code(0x90) });
    const state = createInitialState(kit.env);
    const first = disassembleState(kit.env, state);
    const second = disassembleState(kit.env, state);
    expect(second).toEqual(first);
    expect(bytesToHex(hexToBytes('90'))).toBe(first[0]?.bytes);
  });
});
