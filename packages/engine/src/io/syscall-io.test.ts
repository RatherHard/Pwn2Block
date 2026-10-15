import { describe, expect, it } from 'vitest';
import { MAX_IO_BYTES, MAX_SYSCALL_COUNT, bytesToHex, hexToBytes } from '@pwn2block/shared';
import type {
  ChallengeVma,
  MemoryState,
  PrivateChallenge,
  PublicChallenge,
  Syscall,
  VmState,
} from '@pwn2block/shared';
import type { EngineEnv } from '../env';
import { buildEnvironment, createInitialState } from '../env';
import { createMemory } from '../memory/index';
import { readRegister } from '../state';
import type { SyscallIo } from '../syscall';
import { dispatchSyscall } from '../syscall';
import { createSyscallIo } from './index';

/**
 * `createSyscallIo`：syscall `read` / `write` 的 fd 宿主（G02，02 §5.2、§5.3）。
 *
 * 布局（地址与权限都是公开信息，等于“拿到 binary 就知道”的部分）：
 * - `data`   0x2000 rw  可见
 * - `hidden` 0x4000 rw  隐藏（内容 aa bb cc dd；程序照常读写，这正是获取隐藏内容的通道）
 * - `rodata` 0x5000 r-- 只读
 * - fd 0 stdin / fd 1 stdout / fd 3 secret.txt（16 字节，来自私有包）
 */

const DATA = 0x2000n;
const HIDDEN = 0x4000n;
const RODATA = 0x5000n;
const UNMAPPED = 0x9000n;

const FILE_FD = 3;
const SECRET_HEX = '00112233445566778899aabbccddeeff';

const READ: Syscall = { nr: 0, name: 'read', kind: 'read' };
const WRITE: Syscall = { nr: 1, name: 'write', kind: 'write' };
const EXIT: Syscall = { nr: 60, name: 'exit', kind: 'exit' };

const VMAS: ChallengeVma[] = [
  { id: 'data', kind: 'global', start: '0x2000', size: '0x1000', perm: 'rw', hidden: false },
  {
    id: 'hidden',
    kind: 'key',
    label: '关键区',
    start: '0x4000',
    size: '0x1000',
    perm: 'rw',
    hidden: true,
    init: [{ at: '0x4000', hex: 'aabbccdd' }],
  },
  {
    id: 'rodata',
    kind: 'custom',
    label: '只读区',
    start: '0x5000',
    size: '0x1000',
    perm: 'r',
    hidden: false,
  },
];

const PUB: PublicChallenge = {
  id: 'io-syscall-test',
  title: 'syscall I/O 单测',
  briefing: '只用于 engine 单测。',
  archBits: 64,
  encoding: [{ opcode: '0x90', op: 'nop', operands: [] }],
  syscallAbi: { nr: 'RAX', args: ['RDI', 'RSI', 'RDX'], ret: 'RAX' },
  syscalls: [
    { nr: 0, name: 'read', kind: 'read' },
    { nr: 1, name: 'write', kind: 'write' },
    { nr: 60, name: 'exit', kind: 'exit' },
  ],
  fds: [
    { fd: 0, name: 'stdin', kind: 'stdin' },
    { fd: 1, name: 'stdout', kind: 'stdout' },
    { fd: 3, name: 'secret.txt', kind: 'file', size: 16 },
  ],
  allowedActions: ['feed', 'step', 'run'],
};

const PRIV: PrivateChallenge = {
  registers: ['RAX', 'RDI', 'RSI', 'RDX', 'RSP', 'RBP', 'RIP', 'FLAG'],
  roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
  initRegisters: { RSP: '0x3800', RBP: '0x3800', RIP: '0x1000' },
  vmas: VMAS,
  files: { [String(FILE_FD)]: { hex: SECRET_HEX } },
  win: { exited: {} },
  flag: 'env:FLAG_IO_SYSCALL_TEST',
};

interface Fixture {
  readonly env: EngineEnv;
  readonly io: SyscallIo;
}

/**
 * 装配文件所需的运行环境。
 *
 * 装配顺序：先 `buildEnvironment` 得到 env，再 `createSyscallIo(env)`，最后把 io 注入再装配一次
 * （`env.io` 必须在装配时给出，而 `createSyscallIo` 又需要一个 env）。两次装配只共享不可变的
 * 题目数据与 `MemoryApi`，没有跨实例状态。
 */
function fixture(pub: PublicChallenge = PUB, priv: PrivateChallenge = PRIV): Fixture {
  const probe = buildEnvironment(pub, priv, createMemory);
  const io = createSyscallIo(probe);
  const env = buildEnvironment(pub, priv, createMemory, { io });
  return { env, io };
}

const base = fixture();

/** 每个用例一份全新的初态（内存句柄互不影响）。 */
function fresh(overrides: Partial<VmState> = {}): VmState {
  return { ...createInitialState(base.env), ...overrides };
}

function fill(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

/** 从某个内存句柄精确读一段并回 hex，读失败直接抛（测试里不该出现）。 */
function memHex(mem: MemoryState, addr: bigint, len: number): string {
  const read = createMemory.read(mem, addr, len);
  if (!read.ok) throw new Error(`测试读内存失败：${addr.toString(16)} +${len}`);
  return bytesToHex(read.bytes);
}

describe('read(fd=0)：从 stdin 读', () => {
  it('写 min(count, 剩余) 字节进 buf，ret 是字节数，读位置推进', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('010203040506070809'), pos: 0 } });
    const result = base.io.transfer(state, READ, [0n, DATA, 8n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(8n);
    expect(result.state.stdin.pos).toBe(8);
    expect(bytesToHex(result.state.stdin.bytes)).toBe('010203040506070809');
    expect(memHex(result.state.memory, DATA, 8)).toBe('0102030405060708');
    // 传入的状态对象不被原地修改（只换新对象）。
    expect(state.stdin.pos).toBe(0);
  });

  it('剩余不足 count 时只读到 EOF 前那一截', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('010203040506070809'), pos: 8 } });
    const result = base.io.transfer(state, READ, [0n, DATA + 8n, 8n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(1n);
    expect(result.state.stdin.pos).toBe(9);
    expect(memHex(result.state.memory, DATA + 8n, 8)).toBe('0900000000000000');
  });

  it('EOF：返回 0 字节、读位置不动，buf 一个字节都不写（未映射也不报错）', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('0102'), pos: 2 } });
    const result = base.io.transfer(state, READ, [0n, UNMAPPED, 8n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(0n);
    expect(result.state.stdin.pos).toBe(2);
    expect(memHex(state.memory, DATA, 2)).toBe('0000');
  });

  it('count 超过 0x1000 时截断到 0x1000（否则会越出 VMA 造成假 fault）', () => {
    const state = fresh({ stdin: { bytes: fill(0x2000, 0xab), pos: 0 } });
    const result = base.io.transfer(state, READ, [0n, DATA, BigInt(0x2000)]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(MAX_SYSCALL_COUNT).toBe(0x1000);
    expect(result.ret).toBe(4096n);
    expect(result.state.stdin.pos).toBe(4096);
    expect(memHex(result.state.memory, DATA + 0xff0n, 16)).toBe('abababababababababababababababab');
  });

  it('count = 0 通过且不触碰 buf（未映射地址也不报错）', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('0102'), pos: 1 } });
    const result = base.io.transfer(state, READ, [0n, UNMAPPED, 0n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(0n);
    expect(result.state.stdin.pos).toBe(1);
  });

  it('buf 未映射：memory_fault，且读位置不动、无部分写入', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('01020304'), pos: 0 } });
    const result = base.io.transfer(state, READ, [0n, UNMAPPED, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('memory_fault');
    expect(result.error.addr).toBe(UNMAPPED);
    expect(state.stdin.pos).toBe(0);
  });

  it('buf 只读：memory_fault，且读位置不动', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('01020304'), pos: 0 } });
    const result = base.io.transfer(state, READ, [0n, RODATA, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('memory_fault');
    expect(state.stdin.pos).toBe(0);
  });

  it('隐藏 VMA 可以当 buf：程序读隐藏区是“获取”隐藏数据的通道（02 §3）', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('0102'), pos: 0 } });
    const result = base.io.transfer(state, READ, [0n, HIDDEN, 2n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(2n);
    expect(memHex(result.state.memory, HIDDEN, 4)).toBe('0102ccdd');
  });
});

describe('read(fd=file)：虚拟文件只读、按 fd 记录偏移', () => {
  it('按偏移取字节并推进偏移，ret 是字节数', () => {
    const result = base.io.transfer(fresh(), READ, [BigInt(FILE_FD), DATA, 8n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(8n);
    expect(result.state.fileOffsets[FILE_FD]).toBe(8);
    expect(memHex(result.state.memory, DATA, 8)).toBe('0011223344556677');
    expect(JSON.stringify(result.state.fileOffsets)).not.toContain(SECRET_HEX);
  });

  it('连续读：第二段读到末尾，再读返回 0 字节且偏移停在末尾', () => {
    const first = fresh({ fileOffsets: { [FILE_FD]: 8 } });
    const result = base.io.transfer(first, READ, [BigInt(FILE_FD), DATA, 8n]);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(8n);
    expect(result.state.fileOffsets[FILE_FD]).toBe(16);
    expect(memHex(result.state.memory, DATA, 8)).toBe('8899aabbccddeeff');

    const atEnd = base.io.transfer(result.state, READ, [BigInt(FILE_FD), RODATA, 8n]);
    expect('error' in atEnd).toBe(false);
    if ('error' in atEnd) return;
    expect(atEnd.ret).toBe(0n);
    expect(atEnd.state.fileOffsets[FILE_FD]).toBe(16);
    expect(memHex(result.state.memory, RODATA, 2)).toBe('0000');
  });

  it('count 超过剩余时只读剩余字节', () => {
    const result = base.io.transfer(fresh({ fileOffsets: { [FILE_FD]: 12 } }), READ, [
      BigInt(FILE_FD),
      DATA,
      8n,
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(4n);
    expect(result.state.fileOffsets[FILE_FD]).toBe(16);
    expect(memHex(result.state.memory, DATA, 4)).toBe('ccddeeff');
  });

  it('buf 越权时整段失败：偏移不动，错误 detail 不含文件内容', () => {
    const state = fresh({ fileOffsets: { [FILE_FD]: 4 } });
    const result = base.io.transfer(state, READ, [BigInt(FILE_FD), UNMAPPED, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('memory_fault');
    expect(state.fileOffsets[FILE_FD]).toBe(4);
    const text = JSON.stringify(result.error, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).not.toContain(SECRET_HEX);
    expect(text).not.toContain('0011');
  });

  it('私有包缺少文件内容时显式报 invalid_arguments，不假装空文件', () => {
    const broken = fixture(PUB, { ...PRIV, files: {} });
    const result = broken.io.transfer(fresh(), READ, [BigInt(FILE_FD), DATA, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('invalid_arguments');
    expect(result.error.detail).toContain(`fd ${FILE_FD}`);
  });

  it('内容长度与公开 size 不一致时显式报 invalid_arguments', () => {
    const broken = fixture(PUB, { ...PRIV, files: { [String(FILE_FD)]: { hex: '0011' } } });
    const result = broken.io.transfer(fresh(), READ, [BigInt(FILE_FD), DATA, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('invalid_arguments');
    expect(result.error.detail).toContain('不一致');
  });
});

describe('write(fd=1)：只可追加的 stdout', () => {
  it('把 buf 起的 count 字节追加到 stdout，ret = count', () => {
    const state = fresh();
    createMemory.write(state.memory, DATA, hexToBytes('41424344'));
    const result = base.io.transfer(state, WRITE, [1n, DATA, 4n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(4n);
    expect(bytesToHex(result.state.stdout)).toBe('41424344');
    expect(state.stdout).toHaveLength(0);
  });

  it('累计到 4KB 边界刚好通过，再超一个字节整段拒绝且已有输出不变', () => {
    const atBoundary = fresh({ stdout: fill(MAX_IO_BYTES - 2, 0x41) });
    createMemory.write(atBoundary.memory, DATA, hexToBytes('4243'));
    const ok = base.io.transfer(atBoundary, WRITE, [1n, DATA, 2n]);

    expect('error' in ok).toBe(false);
    if ('error' in ok) return;
    expect(ok.state.stdout.length).toBe(MAX_IO_BYTES);
    expect(ok.state.stdout[MAX_IO_BYTES - 1]).toBe(0x43);

    createMemory.write(ok.state.memory, DATA, hexToBytes('44'));
    const overflow = base.io.transfer(ok.state, WRITE, [1n, DATA, 1n]);
    expect('error' in overflow).toBe(true);
    if (!('error' in overflow)) return;
    expect(overflow.error.code).toBe('resource_limit');
    expect(ok.state.stdout.length).toBe(MAX_IO_BYTES);
    expect(ok.state.stdout[MAX_IO_BYTES - 1]).toBe(0x43);
  });

  it('count 超过 0x1000 时截断到 0x1000（恰好写满 stdout 上限，不被误拒）', () => {
    const state = fresh();
    createMemory.write(state.memory, DATA, fill(0x1000, 0x5a));
    const result = base.io.transfer(state, WRITE, [1n, DATA, BigInt(0x2000)]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(4096n);
    expect(result.state.stdout.length).toBe(MAX_IO_BYTES);
    expect(result.state.stdout[0]).toBe(0x5a);
    expect(result.state.stdout[MAX_IO_BYTES - 1]).toBe(0x5a);
  });

  it('buf 未映射：memory_fault，stdout 一个字节都不追加', () => {
    const state = fresh({ stdout: hexToBytes('41') });
    const result = base.io.transfer(state, WRITE, [1n, UNMAPPED, 4n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('memory_fault');
    expect(bytesToHex(state.stdout)).toBe('41');
  });

  it('count = 0 通过且不读 buf（未映射地址也不报错）', () => {
    const result = base.io.transfer(fresh(), WRITE, [1n, UNMAPPED, 0n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(0n);
    expect(result.state.stdout).toHaveLength(0);
  });

  it('隐藏 VMA 可以当源：write 把隐藏内容送到 stdout（“获取”语义，02 §3）', () => {
    const result = base.io.transfer(fresh(), WRITE, [1n, HIDDEN, 4n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(4n);
    expect(bytesToHex(result.state.stdout)).toBe('aabbccdd');
  });
});

describe('fd 方向错误与未声明 fd：回 -1，不触发异常、不改状态', () => {
  it('对只读 fd 写（read 的 fd=1 stdout）回 -1', () => {
    const state = fresh();
    const result = base.io.transfer(state, READ, [1n, DATA, 4n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(-1n);
    expect(result.state).toBe(state);
  });

  it('对只写 fd 读（write 的 fd=0 stdin）回 -1', () => {
    const state = fresh({ stdout: hexToBytes('41') });
    const result = base.io.transfer(state, WRITE, [0n, DATA, 4n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(-1n);
    expect(result.state).toBe(state);
    expect(bytesToHex(state.stdout)).toBe('41');
  });

  it('对虚拟文件写回 -1（文件只读）', () => {
    const state = fresh();
    const result = base.io.transfer(state, WRITE, [BigInt(FILE_FD), DATA, 4n]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ret).toBe(-1n);
    expect(state.fileOffsets[FILE_FD]).toBe(0);
  });

  it('未声明 fd 与越界 fd 都回 -1', () => {
    const state = fresh();
    for (const fd of [9n, 0x100n]) {
      const read = base.io.transfer(state, READ, [fd, DATA, 4n]);
      expect('error' in read).toBe(false);
      if ('error' in read) return;
      expect(read.ret).toBe(-1n);

      const write = base.io.transfer(state, WRITE, [fd, DATA, 4n]);
      expect('error' in write).toBe(false);
      if ('error' in write) return;
      expect(write.ret).toBe(-1n);
    }
    expect(state.stdin.pos).toBe(0);
    expect(state.stdout).toHaveLength(0);
    expect(state.fileOffsets[FILE_FD]).toBe(0);
  });

  it('不该交给 fd 宿主的 kind 显式报 invalid_instruction', () => {
    const result = base.io.transfer(fresh(), EXIT, [0n]);

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('invalid_instruction');
  });
});

describe('dispatchSyscall 接线：ret 写回与整段不生效', () => {
  it('read 成功时 ret 写回调用约定的 ret 寄存器', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('01020304'), pos: 0 } });
    const outcome = dispatchSyscall(base.env, state, READ, [0n, DATA, 4n]);

    expect(outcome.error).toBeUndefined();
    expect(readRegister(outcome.state, 'RAX')).toBe(4n);
    expect(outcome.state.stdin.pos).toBe(4);
    expect(memHex(outcome.state.memory, DATA, 4)).toBe('01020304');
  });

  it('read 失败时 state 就是传入的原状态，不做部分生效', () => {
    const state = fresh({ stdin: { bytes: hexToBytes('01020304'), pos: 0 } });
    const outcome = dispatchSyscall(base.env, state, READ, [0n, RODATA, 4n]);

    expect(outcome.error?.code).toBe('memory_fault');
    expect(outcome.state).toBe(state);
    expect(state.stdin.pos).toBe(0);
    expect(readRegister(outcome.state, 'RAX')).toBe(0n);
  });

  it('write 失败时 state 就是传入的原状态，stdout 不追加', () => {
    const state = fresh({ stdout: hexToBytes('41') });
    const outcome = dispatchSyscall(base.env, state, WRITE, [1n, UNMAPPED, 2n]);

    expect(outcome.error?.code).toBe('memory_fault');
    expect(outcome.state).toBe(state);
    expect(bytesToHex(state.stdout)).toBe('41');
  });

  it('方向错误按位宽回绕：ret = -1 变成全 1', () => {
    const state = fresh();
    const outcome = dispatchSyscall(base.env, state, READ, [1n, DATA, 4n]);

    expect(outcome.error).toBeUndefined();
    expect(readRegister(outcome.state, 'RAX')).toBe(0xffffffffffffffffn);
  });
});
