import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@pwn2block/shared';
import type {
  EncodingItem,
  EngineRuntime,
  PrivateChallenge,
  PublicChallenge,
  Syscall,
} from '@pwn2block/shared';
import { createRuntime } from '../src/index';
import { readRegister } from '../src/state';
import { memoryHex } from './helpers/fake-memory';

/**
 * G02 接线（本轮 B 的交付点）：`createRuntime` 注入 fd 宿主、`feed` 动作委托 I/O 层、
 * 历史快照走 `SnapshotApi`。
 *
 * 这里**不 mock G 的实现**：接线是否真的生效，只有在真实实现下才成立。三条接线各自的证伪方式：
 * - 没有注入 `io` 时 `dispatchSyscall` 会显式抛「需要 fd 宿主」，所以任何 `read` / `write`
 *   跑通就证明注入生效；
 * - `feed` 与 `read` 串起来（feed 进 stdin → 程序 read 出来）证明动作层与 syscall 层用的是
 *   同一份 stdin 状态；
 * - 跨程序退出的 `step_back`、reveal 之后的 `undo` 证明快照 + 编排层字段一起回退。
 */

const ENCODING: EncodingItem[] = [
  { opcode: '0x1a', op: 'syscall', operands: [], mnemonic: 'syscall' },
  { opcode: '0x10', op: 'syscall', operands: ['const:0'], mnemonic: 'syscall read' },
  { opcode: '0x11', op: 'syscall', operands: ['const:1'], mnemonic: 'syscall write' },
  { opcode: '0x1c', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
];

const SYSCALLS: Syscall[] = [
  { nr: 0, name: 'read', kind: 'read', doc: 'read(fd, buf, count)' },
  { nr: 1, name: 'write', kind: 'write', doc: 'write(fd, buf, count)' },
  { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
  {
    nr: 7,
    name: 'peek',
    kind: 'custom',
    doc: '揭示隐藏区',
    effects: [{ type: 'reveal', vma: 'hidden' }],
  },
];

interface FixtureOptions {
  /** code VMA 开头一条指令的机器码。 */
  readonly code: string;
  readonly initRegisters?: Readonly<Record<string, string>>;
}

/** 一道只有一条指令的小题：`code` 放在 0x1000，data 在 0x2000（初始 `41424344`）。 */
function fixture(options: FixtureOptions): EngineRuntime {
  const pub: PublicChallenge = {
    id: 'io-wiring',
    title: 'I/O 接线',
    briefing: 'read / write 走 G 的 fd 宿主。',
    archBits: 64,
    encoding: [...ENCODING],
    syscallAbi: { nr: 'RAX', args: ['RDI', 'RSI', 'RDX'], ret: 'RAX' },
    syscalls: [...SYSCALLS],
    fds: [
      { fd: 0, name: 'stdin', kind: 'stdin' },
      { fd: 1, name: 'stdout', kind: 'stdout' },
      { fd: 3, name: 'secret.txt', kind: 'file', size: 4 },
    ],
    allowedActions: ['feed', 'step', 'run', 'reset', 'write_bytes'],
    authorBlocks: [],
  };

  const priv: PrivateChallenge = {
    registers: ['RAX', 'RDI', 'RSI', 'RDX', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    initRegisters: { RSP: '0x3800', RBP: '0x3800', RIP: '0x1000', ...options.initRegisters },
    vmas: [
      {
        id: 'code',
        kind: 'code',
        start: '0x1000',
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        init: [{ at: '0x1000', hex: options.code }],
      },
      {
        id: 'data',
        kind: 'global',
        start: '0x2000',
        size: '0x1000',
        perm: 'rw',
        hidden: false,
        init: [{ at: '0x2000', hex: '41424344' }],
      },
      { id: 'stack', kind: 'stack', start: '0x3000', size: '0x1000', perm: 'rw', hidden: false },
      {
        id: 'hidden',
        kind: 'key',
        label: '关键区',
        start: '0x4000',
        size: '0x1000',
        perm: 'rw',
        hidden: true,
      },
    ],
    files: { '3': { hex: 'deadbeef' } },
    win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
    // 没有判负谓词：退出就是 exited，便于断言跨退出的回退。
    fail: [],
    flag: 'env:FLAG_IO_WIRING',
  };

  return createRuntime(pub, priv);
}

describe('createRuntime：read / write 的 fd 宿主由 G02 注入', () => {
  it('write(1, buf, 4) 把可见内存追加进 stdout，并把字节数写回 ret 寄存器', () => {
    const runtime = fixture({
      code: '11',
      initRegisters: { RDI: '0x1', RSI: '0x2000', RDX: '0x4' },
    });
    const outcome = runtime.step(runtime.initialState(), 1);

    expect(outcome.state.error).toBeUndefined();
    expect(outcome.executed).toBe(1);
    expect(bytesToHex(outcome.state.stdout)).toBe('41424344');
    expect(readRegister(outcome.state, 'RAX')).toBe(4n);
  });

  it('read(0, buf, 2) 取 feed 进 stdin 的字节写进内存并推进读位置', () => {
    const runtime = fixture({
      code: '10',
      initRegisters: { RDI: '0x0', RSI: '0x2000', RDX: '0x2' },
    });
    const instance = runtime.createDebugInstance();
    const outcome = instance.applyRequest([
      { type: 'feed', hex: '4142' },
      { type: 'step', count: 1 },
    ]);

    expect(outcome.results.map((result) => result.ok)).toEqual([true, true]);
    expect(memoryHex(runtime.memory, outcome.state.memory, 0x2000n, 2)).toBe('4142');
    expect(readRegister(outcome.state, 'RAX')).toBe(2n);
    expect(outcome.state.stdin.pos).toBe(2);
  });

  it('read(3, buf, 4) 读私有包里的虚拟文件（fd 表来自运行环境）', () => {
    const runtime = fixture({
      code: '10',
      initRegisters: { RDI: '0x3', RSI: '0x2000', RDX: '0x4' },
    });
    const outcome = runtime.step(runtime.initialState(), 1);

    expect(outcome.state.error).toBeUndefined();
    expect(memoryHex(runtime.memory, outcome.state.memory, 0x2000n, 4)).toBe('deadbeef');
    expect(readRegister(outcome.state, 'RAX')).toBe(4n);
  });

  it('fd 方向不对（写 stdin）回 -1，不触发异常也不改 stdout', () => {
    const runtime = fixture({
      code: '11',
      initRegisters: { RDI: '0x0', RSI: '0x2000', RDX: '0x4' },
    });
    const outcome = runtime.step(runtime.initialState(), 1);

    expect(outcome.state.error).toBeUndefined();
    expect(outcome.state.status).toBe('ready');
    expect(readRegister(outcome.state, 'RAX')).toBe(0xffffffffffffffffn);
    expect(outcome.state.stdout).toHaveLength(0);
  });
});

describe('历史快照：跨退出的 step_back 与 reveal 后的 undo', () => {
  it('step_back 跨过一次程序退出：状态、步数与退出码一起回到退出前', () => {
    const runtime = fixture({ code: '1c', initRegisters: { RDI: '0x5' } });
    const instance = runtime.createDebugInstance();

    const exited = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(exited.state.status).toBe('exited');
    expect(exited.state.exitCode).toBe(5n);
    expect(exited.state.steps).toBe(1);
    expect(exited.state.lastStop).toEqual({ reason: 'exit', addr: 0x1000n });

    const back = instance.applyRequest([{ type: 'step_back' }]);
    expect(back.results).toEqual([{ ok: true, action: 'step_back' }]);
    expect(back.state.status).toBe('ready');
    expect(back.state.steps).toBe(0);
    expect(back.state.exitCode).toBeUndefined();
    expect(back.state.lastStop).toBeUndefined();

    // 回退过的指令可以重新执行，结果与第一次一致。
    expect(instance.applyRequest([{ type: 'step', count: 1 }]).state.exitCode).toBe(5n);
  });

  it('undo 回到 reveal 之前：隐藏区重新隐藏', () => {
    const runtime = fixture({ code: '1a', initRegisters: { RAX: '0x7' } });
    const instance = runtime.createDebugInstance();

    const revealed = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(revealed.state.revealed).toEqual(['hidden']);
    expect(revealed.state.status).toBe('ready');

    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(undone.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.state.revealed).toEqual([]);
    expect(undone.state.steps).toBe(0);
  });

  it('历史位置之间不共享内存句柄：后续写入不会污染旧快照', () => {
    const runtime = fixture({ code: '11' });
    const instance = runtime.createDebugInstance();

    instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'ff' }]);
    instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'ee' }]);

    // 第一次 undo 回到「写入 ff 之后」：条目存的是那一刻的页表，不是活句柄。
    const afterFirst = instance.applyRequest([{ type: 'undo' }]);
    expect(memoryHex(runtime.memory, afterFirst.state.memory, 0x2000n, 1)).toBe('ff');

    // 第二次 undo 回到最初：更早的条目没有被后面的写入污染。
    const origin = instance.applyRequest([{ type: 'undo' }]);
    expect(memoryHex(runtime.memory, origin.state.memory, 0x2000n, 1)).toBe('41');

    // 取出的历史状态可以长期持有：之后的写入不影响它。
    instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'aa' }]);
    expect(memoryHex(runtime.memory, origin.state.memory, 0x2000n, 1)).toBe('41');
    expect(memoryHex(runtime.memory, instance.state().memory, 0x2000n, 1)).toBe('aa');
  });
});
