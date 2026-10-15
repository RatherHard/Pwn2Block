import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { EncodingItem, Syscall } from '@pwn2block/shared';
import { createInitialState } from '../src/env';
import type { EngineEnv } from '../src/env';
import { stepOnce } from '../src/execute';
import { readVisible } from '../src/visibility';
import { readRegister } from '../src/state';
import type { SyscallIo } from '../src/syscall';
import type { TestChallengeOptions } from './helpers/challenge';
import { code, DATA_START, HIDDEN_START, p64, TEST_ENCODING, testKit } from './helpers/challenge';

/** 追加 `syscall const:1`（write）：调用号不依赖寄存器，便于测“没有 abi”的分支。 */
const TEST_ENCODING_EXTRA: EncodingItem[] = [
  ...TEST_ENCODING,
  { opcode: '0x1f', op: 'syscall', operands: ['const:1'] },
];

const CUSTOM: Syscall[] = [
  {
    nr: 7,
    name: 'peek',
    kind: 'custom',
    effects: [
      { type: 'copy', src: '0x4000', dst: '0x2000', len: 2 },
      { type: 'reveal', vma: 'hidden' },
    ],
  },
  { nr: 8, name: 'boom', kind: 'custom', effects: [{ type: 'exit', code: '0x5' }] },
];

function start(options: TestChallengeOptions): EngineEnv {
  return testKit({ code: code(0x1a), ...options }).env;
}

describe('custom syscall 效果', () => {
  it('copy 把隐藏区字节搬到可见区，reveal 让隐藏区进投影', () => {
    const env = start({ initRegisters: { RAX: '0x7' }, syscalls: CUSTOM, fail: [] });
    const state = createInitialState(env);
    const outcome = stepOnce(env, state);

    expect(outcome.state.error).toBeUndefined();
    expect(bytesToHex(readVisible(env, outcome.state, DATA_START, 2).ok ? (readVisible(env, outcome.state, DATA_START, 2) as { bytes: Uint8Array }).bytes : new Uint8Array(0))).toBe('aabb');
    expect(outcome.state.revealed).toEqual(['hidden']);
    expect(outcome.state.status).toBe('ready');
  });

  it('copy 越权时整体回退：已生效的 set_reg 也不留痕', () => {
    const env = testKit({
      code: code(0x1a),
      initRegisters: { RAX: '0x7' },
      fail: [],
      syscalls: [
        {
          nr: 7,
          name: 'boom',
          kind: 'custom',
          effects: [
            { type: 'set_reg', reg: 'RBX', value: '0x99' },
            { type: 'copy', src: '0x4000', dst: '0x5000', len: 2 },
          ],
        },
      ],
    }).env;
    const state = createInitialState(env);
    const outcome = stepOnce(env, state);

    expect(outcome.state.error?.code).toBe('memory_fault');
    expect(outcome.state.status).toBe('failed');
    expect(readRegister(outcome.state, 'RBX')).toBe(0n);
    expect(outcome.state.steps).toBe(0);
  });

  it('exit 效果可以带退出码', () => {
    const env = start({ initRegisters: { RAX: '0x8' }, syscalls: CUSTOM, fail: [] });
    const outcome = stepOnce(env, createInitialState(env));
    expect(outcome.state.status).toBe('exited');
    expect(outcome.stop).toBe('exit');
    expect(outcome.state.exitCode).toBe(5n);
  });

  it('reveal 不会重复添加同一个 vma', () => {
    const env = testKit({
      code: code(0x1a),
      initRegisters: { RAX: '0x7' },
      fail: [],
      syscalls: [
        { nr: 7, name: 'twice', kind: 'custom', effects: [{ type: 'reveal', vma: 'hidden' }, { type: 'reveal', vma: 'hidden' }] },
      ],
    }).env;
    const revealedState = { ...createInitialState(env), revealed: ['hidden'] };
    const outcome = stepOnce(env, revealedState);
    expect(outcome.state.revealed).toEqual(['hidden']);
  });

  it('无 abi 且无 const 操作数时无法确定调用号 → invalid_instruction', () => {
    const env = start({ initRegisters: { RAX: '0x7' }, abi: null, fail: [] });
    const outcome = stepOnce(env, createInitialState(env));
    expect(outcome.state.error?.code).toBe('invalid_instruction');
    expect(outcome.state.error?.detail).toContain('调用号');
  });

  it('调用号超过 16 位 → invalid_instruction（不出越界调用）', () => {
    const env = start({ initRegisters: { RAX: '0x10000' }, fail: [] });
    const outcome = stepOnce(env, createInitialState(env));
    expect(outcome.state.error?.code).toBe('invalid_instruction');
  });
});

describe('read / write 的宿主（G02 接缝）', () => {
  it('注入 SyscallIo 后 write 的返回值和 stdout 都生效', () => {
    const io: SyscallIo = {
      transfer(state, syscall, args) {
        expect(syscall.kind).toBe('write');
        expect(args).toEqual([0n]);
        return { state: { ...state, stdout: hexToBytes('4142') }, ret: 2n };
      },
    };
    const kit = testKit({ code: code(0x1a), initRegisters: { RAX: '0x1' }, io });
    const outcome = stepOnce(kit.env, createInitialState(kit.env));

    expect(outcome.state.error).toBeUndefined();
    expect(bytesToHex(outcome.state.stdout)).toBe('4142');
    expect(readRegister(outcome.state, 'RAX')).toBe(2n);
  });

  it('宿主返回错误时状态不变并进入 failed', () => {
    const io: SyscallIo = {
      transfer: () => ({ error: { code: 'invalid_arguments', detail: '读越界' } }),
    };
    const kit = testKit({ code: code(0x1a), initRegisters: { RAX: '0x1' }, io });
    const outcome = stepOnce(kit.env, createInitialState(kit.env));

    expect(outcome.state.error?.code).toBe('invalid_arguments');
    expect(outcome.state.error?.detail).toBe('读越界');
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.stdout).toHaveLength(0);
  });

  it('宿主存在但题目没有 syscallAbi → 显式报错，不假装成功', () => {
    const io: SyscallIo = { transfer: (state) => ({ state, ret: 0n }) };
    const kit = testKit({
      code: code(0x1f),
      abi: null,
      io,
      fail: [],
      encoding: [...TEST_ENCODING_EXTRA],
    });
    const outcome = stepOnce(kit.env, createInitialState(kit.env));
    expect(outcome.state.error?.code).toBe('invalid_instruction');
    expect(outcome.state.error?.detail).toContain('syscallAbi');
  });

  it('宿主缺失时显式抛错，不静默成功', () => {
    const kit = testKit({ code: code(0x1a), initRegisters: { RAX: '0x1' } });
    expect(() => stepOnce(kit.env, createInitialState(kit.env))).toThrow(/G02/);
  });
});

describe('syscall 与隐藏内容的边界', () => {
  it('copy 把隐藏内容搬进可见区是允许的（这正是题目的解法）', () => {
    const env = start({ initRegisters: { RAX: '0x7' }, syscalls: CUSTOM, fail: [] });
    const outcome = stepOnce(env, createInitialState(env));
    const visible = readVisible(env, outcome.state, DATA_START, 2);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(bytesToHex(visible.bytes)).toBe('aabb');
    expect(bytesToHex(visible.bytes)).not.toBe(bytesToHex(hexToBytes(p64(0n)).subarray(0, 2)));
  });

  it('隐藏区内容在 reveal 前不会出现在任何状态字段里', () => {
    const env = start({ initRegisters: { RAX: '0x7' }, syscalls: CUSTOM, fail: [] });
    const state = createInitialState(env);
    const serialized = JSON.stringify(state, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain('aabb');
    expect(bytesToHex(hexToBytes('aabb'))).toBe('aabb');
    expect(HIDDEN_START).toBe(0x4000n);
  });
});
