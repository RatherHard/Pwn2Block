import { describe, expect, it } from 'vitest';
import { MAX_IO_BYTES, NO_FLAGS, bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { MemorySnapshot, MemoryState, VmState, VmaInit } from '@pwn2block/shared';
import { createMemory } from '../memory/index';
import { createSnapshotApi } from './index';

/**
 * `createSnapshotApi`：快照覆盖 02 §7 列出的全部 VM 状态字段（G02，D2）。
 *
 * 断言口径：
 * - `capture` 是 O(1)：内存只抓页表引用，其余字段共享不可变值（用引用相等证明没有复制）；
 * - `restore` 派生新值：内存拿新句柄，数组 / 对象复制一份，不与被回退掉的历史别名耦合；
 * - 快照覆盖 `revealed` / `exitCode` / stdin 读位置 / stdout / fileOffsets，全部精确回退。
 */

const DATA = 0x2000n;
const HIDDEN = 0x4000n;
const FILE_FD = 3;

const VMAS: VmaInit[] = [
  {
    id: 'data',
    kind: 'global',
    start: DATA,
    size: 0x1000,
    perm: 'rw',
    hidden: false,
    init: [{ at: DATA, bytes: hexToBytes('0102') }],
  },
  {
    id: 'hidden',
    kind: 'key',
    label: '关键区',
    start: HIDDEN,
    size: 0x1000,
    perm: 'rw',
    hidden: true,
    init: [{ at: HIDDEN, bytes: hexToBytes('aabb') }],
  },
];

const memory = createMemory;
const api = createSnapshotApi(memory);

/** 一个字段齐全的 VM 状态；每个用例都拿到自己的内存句柄。 */
function baseState(overrides: Partial<VmState> = {}): VmState {
  return {
    archBits: 64,
    registers: { RAX: 0x1n, RSP: 0x3000n, RIP: 0x1000n },
    flags: NO_FLAGS,
    memory: memory.create(VMAS, 64),
    revealed: [],
    stdin: { bytes: hexToBytes('01020304'), pos: 1 },
    stdout: hexToBytes('41'),
    fileOffsets: { [FILE_FD]: 4 },
    status: 'ready',
    steps: 7,
    ...overrides,
  };
}

function memHex(mem: MemoryState, addr: bigint, len: number): string {
  const read = memory.read(mem, addr, len);
  if (!read.ok) throw new Error(`测试读内存失败：${addr.toString(16)} +${len}`);
  return bytesToHex(read.bytes);
}

/**
 * `restore` 返回片段里的 `memory` 已经是活句柄，但冻结的字段类型沿用
 * `VmStateSnapshot.memory: MemorySnapshot`（B 在 `instance.ts` 也窄化一次，契约缺口已报 A）。
 */
function live(snapshotMemory: MemorySnapshot): MemoryState {
  return snapshotMemory as unknown as MemoryState;
}

describe('capture：O(1) 快照，内存只抓页表引用', () => {
  it('其余字段共享不可变值，不做任何复制', () => {
    const state = baseState({ stdout: new Uint8Array(MAX_IO_BYTES).fill(0x41) });
    const snap = api.capture(state);

    expect(snap.kind).toBe('vm-snapshot');
    expect(snap.memory.kind).toBe('cow-memory-snapshot');
    expect(snap.memory).not.toBe(state.memory);
    expect(snap.registers).toBe(state.registers);
    expect(snap.flags).toBe(state.flags);
    expect(snap.revealed).toBe(state.revealed);
    expect(snap.stdin).toBe(state.stdin);
    expect(snap.stdout).toBe(state.stdout);
    expect(snap.fileOffsets).toBe(state.fileOffsets);
  });

  it('字段集恰好是 02 §7 的那 8 个 VM 字段（含 exitCode 槽位，不含实例层字段）', () => {
    const snap = api.capture(baseState());

    expect(Object.keys(snap).sort()).toEqual(
      ['exitCode', 'fileOffsets', 'flags', 'kind', 'memory', 'registers', 'revealed', 'stdin', 'stdout'].sort(),
    );
    // 槽位必填：没有退出码时也显式写下 undefined，回退才不会继承回退前那一刻的值。
    expect('exitCode' in snap).toBe(true);
    expect(snap.exitCode).toBeUndefined();

    const exited = api.capture(baseState({ status: 'exited', exitCode: 5n, lastStop: { reason: 'exit' } }));
    expect(exited.exitCode).toBe(5n);
  });

  it('capture 之后的写入不会污染旧快照', () => {
    const state = baseState();
    const snap = api.capture(state);

    const written = memory.write(state.memory, DATA, hexToBytes('ffff'));
    expect(written.ok).toBe(true);
    expect(memHex(state.memory, DATA, 2)).toBe('ffff');
    expect(memHex(memory.restore(snap.memory), DATA, 2)).toBe('0102');
  });
});

describe('restore：派生新值，不与被回退掉的历史别名耦合', () => {
  it('内存换新句柄，数组与对象复制一份（改副本不影响快照）', () => {
    const snap = api.capture(baseState());
    const restored = api.restore(snap);

    expect(restored.kind).toBe('vm-snapshot');
    expect(restored.registers).not.toBe(snap.registers);
    expect(restored.registers).toEqual(snap.registers);
    expect(restored.flags).not.toBe(snap.flags);
    expect(restored.flags).toEqual(snap.flags);
    expect(restored.revealed).not.toBe(snap.revealed);
    expect(restored.revealed).toEqual(snap.revealed);
    expect(restored.stdin).not.toBe(snap.stdin);
    expect(restored.stdin.bytes).not.toBe(snap.stdin.bytes);
    expect(restored.stdin.pos).toBe(snap.stdin.pos);
    expect(restored.stdout).not.toBe(snap.stdout);
    expect(restored.fileOffsets).not.toBe(snap.fileOffsets);
    expect(restored.fileOffsets).toEqual(snap.fileOffsets);
    expect(restored.memory).not.toBe(snap.memory);

    restored.stdout[0] = 0xff;
    restored.stdin.bytes[0] = 0xff;
    expect(bytesToHex(snap.stdout)).toBe('41');
    expect(bytesToHex(snap.stdin.bytes)).toBe('01020304');
  });

  it('回退后继续写入不会改动快照里的内存', () => {
    const state = baseState();
    const snap = api.capture(state);
    const restored = api.restore(snap);

    const written = memory.write(live(restored.memory), DATA, hexToBytes('eeee'));
    expect(written.ok).toBe(true);
    expect(memHex(live(restored.memory), DATA, 2)).toBe('eeee');
    expect(memHex(memory.restore(snap.memory), DATA, 2)).toBe('0102');
  });

  it('同一个快照恢复两次得到互不影响的两个状态', () => {
    const snap = api.capture(baseState());
    const first = api.restore(snap);
    const second = api.restore(snap);

    expect(first.memory).not.toBe(second.memory);
    memory.write(live(first.memory), DATA, hexToBytes('9999'));
    expect(memHex(live(first.memory), DATA, 2)).toBe('9999');
    expect(memHex(live(second.memory), DATA, 2)).toBe('0102');
    expect(memHex(memory.restore(snap.memory), DATA, 2)).toBe('0102');
  });

  it('覆盖 reveal / exitCode / stdin 位置 / stdout / fileOffsets / 寄存器 / 标志 / 内存', () => {
    const before = baseState();
    const snap = api.capture(before);

    // 之后的状态：隐藏区被 reveal、程序已退出、stdin 读位置推进、stdout 追加、文件偏移推进。
    const after: VmState = {
      ...before,
      registers: { ...before.registers, RAX: 0x42n },
      flags: { ZF: true, CF: true, SF: true },
      revealed: ['hidden'],
      stdin: { bytes: before.stdin.bytes, pos: 4 },
      stdout: hexToBytes('4142'),
      fileOffsets: { [FILE_FD]: 12 },
      status: 'exited',
      steps: 9,
      exitCode: 0n,
    };
    memory.write(after.memory, DATA, hexToBytes('ffff'));

    const restored = api.restore(snap);
    expect(restored.revealed).toEqual([]);
    expect('exitCode' in restored).toBe(true);
    expect(restored.exitCode).toBeUndefined();
    expect(restored.stdin.pos).toBe(1);
    expect(bytesToHex(restored.stdin.bytes)).toBe('01020304');
    expect(bytesToHex(restored.stdout)).toBe('41');
    expect(restored.fileOffsets).toEqual({ [FILE_FD]: 4 });
    expect(restored.registers).toEqual({ RAX: 0x1n, RSP: 0x3000n, RIP: 0x1000n });
    expect(restored.flags).toEqual(NO_FLAGS);
    expect(memHex(live(restored.memory), DATA, 2)).toBe('0102');

    // 回退不改动被回退掉的那段历史。
    expect(after.revealed).toEqual(['hidden']);
    expect(after.exitCode).toBe(0n);
    expect(after.stdin.pos).toBe(4);
    expect(bytesToHex(after.stdout)).toBe('4142');
    expect(after.fileOffsets[FILE_FD]).toBe(12);
  });

  it('带退出码的快照回退后仍带同一个退出码', () => {
    const exited = baseState({ status: 'exited', exitCode: 5n, lastStop: { reason: 'exit' } });
    const restored = api.restore(api.capture(exited));

    expect(restored.exitCode).toBe(5n);
    expect(restored.revealed).toEqual([]);
  });
});
