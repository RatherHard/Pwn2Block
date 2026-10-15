import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@pwn2block/shared';
import { DEFAULT_LIMITS, buildEnvironment, createInitialState } from '../src/env';
import type { PrivateChallenge, PublicChallenge } from '@pwn2block/shared';
import { buildVmaLayout, initialFileOffsets, initialRegisters, toVmaInits } from '../src/initial';
import { archMask } from '../src/state';
import { createFakeMemory } from './helpers/fake-memory';
import { CODE_START, HIDDEN_START, TEST_REGISTERS, code, p32, p64, testEnv, testKit } from './helpers/challenge';

describe('toVmaInits / buildVmaLayout', () => {
  const kit = testKit({ code: code(0x90) });

  it('init 补丁解析成整数地址与字节', () => {
    const inits = toVmaInits(kit.priv.vmas);
    const codeVma = inits[0];
    expect(codeVma?.id).toBe('code');
    expect(codeVma?.start).toBe(CODE_START);
    expect(codeVma?.size).toBe(0x1000);
    expect(codeVma?.perm).toBe('rx');
    expect(codeVma?.hidden).toBe(false);
    expect(codeVma?.init).toHaveLength(1);
    expect(codeVma?.init[0]?.at).toBe(CODE_START);
    expect(bytesToHex(codeVma?.init[0]?.bytes ?? new Uint8Array(0))).toBe('90');
  });

  it('隐藏区与无 init 的区域都保留', () => {
    const inits = toVmaInits(kit.priv.vmas);
    expect(inits.map((vma) => vma.id)).toEqual(['code', 'data', 'stack', 'hidden', 'rodata']);
    expect(inits[3]?.hidden).toBe(true);
    expect(inits[3]?.init[0]?.at).toBe(HIDDEN_START);
    expect(inits[1]?.init).toEqual([]);
  });

  it('公开布局按声明顺序给出 hex 形式的 start / size', () => {
    const layout = buildVmaLayout(kit.priv.vmas);
    expect(layout).toHaveLength(5);
    expect(layout[0]).toEqual({
      id: 'code',
      kind: 'code',
      label: undefined,
      start: '0x1000',
      size: '0x1000',
      perm: 'rx',
      hidden: false,
    });
    expect(layout[4]?.label).toBe('只读区');
    expect(layout[3]?.hidden).toBe(true);
  });
});

describe('initialRegisters / initialFileOffsets', () => {
  it('未列出的寄存器为 0，列出的按 initRegisters 取值', () => {
    const kit = testKit({ initRegisters: { RAX: '0x2a' } });
    const registers = initialRegisters(kit.priv, archMask(64));
    expect(Object.keys(registers)).toEqual([...TEST_REGISTERS]);
    expect(registers.RAX).toBe(0x2an);
    expect(registers.RCX).toBe(0n);
    expect(registers.RSP).toBe(0x3800n);
    expect(registers.RIP).toBe(0x1000n);
  });

  it('初始值按位宽掩蔽', () => {
    const kit = testKit({ archBits: 32, initRegisters: { RAX: '0x1ffffffff' } });
    const registers = initialRegisters(kit.priv, archMask(32));
    expect(registers.RAX).toBe(0xffffffffn);
  });

  it('只有 file 类型 fd 记录初始读偏移 0', () => {
    expect(
      initialFileOffsets([
        { fd: 0, name: 'stdin', kind: 'stdin' },
        { fd: 1, name: 'stdout', kind: 'stdout' },
        { fd: 3, name: 'secret.txt', kind: 'file', size: 16 },
      ]),
    ).toEqual({ 3: 0 });
    expect(initialFileOffsets(undefined)).toEqual({});
  });
});

describe('createInitialState', () => {
  it('寄存器、标志、revealed、stdin、stdout、偏移与状态都是初值', () => {
    const kit = testKit({ code: code(0x90) });
    const state = createInitialState(kit.env);
    expect(state.archBits).toBe(64);
    expect(state.registers).toEqual({
      RAX: 0n,
      RBX: 0n,
      RCX: 0n,
      RSP: 0x3800n,
      RBP: 0x3800n,
      RIP: 0x1000n,
      FLAG: 0n,
    });
    expect(state.flags).toEqual({ ZF: false, CF: false, SF: false });
    expect(state.revealed).toEqual([]);
    expect(state.stdin.bytes).toHaveLength(0);
    expect(state.stdin.pos).toBe(0);
    expect(state.stdout).toHaveLength(0);
    expect(state.fileOffsets).toEqual({});
    expect(state.status).toBe('ready');
    expect(state.steps).toBe(0);
    expect(state.lastStop).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it('init 补丁真的写进内存，未覆盖部分为 0', () => {
    const kit = testKit({ code: code(0x90, p64(0x1234n)) });
    const state = createInitialState(kit.env);
    const codeBytes = kit.memory.read(state.memory, CODE_START, 9);
    expect(codeBytes.ok).toBe(true);
    if (!codeBytes.ok) return;
    expect(bytesToHex(codeBytes.bytes)).toBe(code(0x90, p64(0x1234n)));

    const hidden = kit.memory.readVma(state.memory, 'hidden');
    expect(hidden).toBeDefined();
    expect(bytesToHex((hidden ?? new Uint8Array(0)).subarray(0, 4))).toBe('aabb0000');
  });

  it('每次调用都独立建内存：两次初态互不影响', () => {
    const kit = testKit({ code: code(0x90) });
    const first = createInitialState(kit.env);
    const second = createInitialState(kit.env);
    const written = kit.memory.write(first.memory, 0x2000n, hexToBytes('deadbeef'));
    expect(written.ok).toBe(true);

    const secondBytes = kit.memory.read(second.memory, 0x2000n, 4);
    expect(secondBytes.ok).toBe(true);
    if (!secondBytes.ok) return;
    expect(bytesToHex(secondBytes.bytes)).toBe('00000000');
  });
});

describe('buildEnvironment', () => {
  it('装配位宽、布局、syscall 表与默认上限', () => {
    const kit = testKit({ code: code(0x90) });
    expect(kit.env.challengeId).toBe('test-challenge');
    expect(kit.env.archBits).toBe(64);
    expect(kit.env.wordBytes).toBe(8);
    expect(kit.env.mask).toBe(0xffffffffffffffffn);
    expect(kit.env.layout).toHaveLength(5);
    expect(kit.env.layoutIndex.regions).toHaveLength(5);
    expect(kit.env.syscalls.get(99)?.name).toBe('win');
    expect(kit.env.syscalls.get(60)?.kind).toBe('exit');
    expect(kit.env.abi).toEqual({ nr: 'RAX', args: ['RBX'], ret: 'RAX' });
    expect(kit.env.win).toEqual({ reg_eq: { reg: 'FLAG', value: '0x1' } });
    expect(kit.env.fail).toHaveLength(1);
    expect(kit.env.limits).toEqual(DEFAULT_LIMITS);
  });

  it('32 位题目的字长与掩码', () => {
    const env = testEnv({ archBits: 32, code: code(0x90) });
    expect(env.wordBytes).toBe(4);
    expect(env.mask).toBe(0xffffffffn);
  });

  it('测试可以注入更小的上限', () => {
    const env = testEnv({ limits: { stepBackWindow: 2 } });
    expect(env.limits.stepBackWindow).toBe(2);
    expect(env.limits.maxStepsPerRun).toBe(10000);
  });

  it('encoding 引用 preset 时显式报错（引擎不做文件 IO）', () => {
    const kit = testKit();
    const pub: PublicChallenge = { ...kit.pub, encoding: { preset: 'x86ish' } };
    expect(() => buildEnvironment(pub, kit.priv as PrivateChallenge, createFakeMemory())).toThrow(
      /preset/,
    );
  });

  it('没有 fail 谓词时按空列表处理', () => {
    const kit = testKit({ fail: [] });
    expect(kit.env.fail).toEqual([]);
  });

  it('p32 生成 4 字节小端（供 32 位用例复用）', () => {
    expect(p32(0x11223344n)).toBe('44332211');
  });
});
