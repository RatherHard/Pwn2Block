import { bigIntToHexLE } from '@pwn2block/shared';
import type {
  ArchBits,
  AuthorBlock,
  ChallengeVma,
  EncodingItem,
  MemoryApi,
  Predicate,
  PrivateChallenge,
  PublicChallenge,
  Roles,
  Syscall,
  SyscallAbi,
  VmState,
} from '@pwn2block/shared';
import type { EngineEnv, EngineLimits } from '../../src/env';
import { buildEnvironment } from '../../src/env';
import type { SyscallIo } from '../../src/syscall';
import { writeRegister } from '../../src/state';
import { createFakeMemory } from './fake-memory';

/**
 * 测试题包与运行环境（只用于 engine 单测）。
 *
 * 地址布局固定，方便断言精确值：
 * - `code`   0x1000 r-x
 * - `data`   0x2000 rw-
 * - `stack`  0x3000 rw-（初始 RSP/RBP = 0x3800）
 * - `hidden` 0x4000 rw- hidden（初始内容 aa bb）
 * - `rodata` 0x5000 r--（写它必然 `memory_fault` / 拒绝）
 */

export const CODE_START = 0x1000n;
export const DATA_START = 0x2000n;
export const STACK_START = 0x3000n;
export const STACK_TOP = 0x3800n;
export const HIDDEN_START = 0x4000n;
export const RODATA_START = 0x5000n;

export const TEST_REGISTERS = ['RAX', 'RBX', 'RCX', 'RSP', 'RBP', 'RIP', 'FLAG'] as const;
export const TEST_ROLES: Roles = { sp: 'RSP', bp: 'RBP', ip: 'RIP' };

/** 测试编码表：opcode → 作用 + 操作数形态（02 §4）。 */
export const TEST_ENCODING: EncodingItem[] = [
  { opcode: '0x90', op: 'nop', operands: [] },
  { opcode: '0x01', op: 'mov', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x02', op: 'mov', operands: ['reg:RAX', 'reg:RBX'] },
  { opcode: '0x03', op: 'mov', operands: ['reg:RAX', 'mem:RBP+disp'] },
  { opcode: '0x04', op: 'mov', operands: ['mem:RBP+disp', 'reg:RAX'] },
  { opcode: '0x05', op: 'push', operands: ['reg:RAX'] },
  { opcode: '0x06', op: 'push', operands: ['imm'] },
  { opcode: '0x07', op: 'pop', operands: ['reg:RAX'] },
  { opcode: '0x08', op: 'add', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x09', op: 'add', operands: ['reg:RAX', 'reg:RBX'] },
  { opcode: '0x0a', op: 'sub', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x0b', op: 'cmp', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x0c', op: 'and', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x0d', op: 'xor', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x0e', op: 'or', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x0f', op: 'shl', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x10', op: 'shr', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x11', op: 'jmp', operands: ['imm'] },
  { opcode: '0x12', op: 'jmp', operands: ['reg:RAX'] },
  { opcode: '0x13', op: 'je', operands: ['imm'] },
  { opcode: '0x14', op: 'jne', operands: ['imm'] },
  { opcode: '0x15', op: 'jb', operands: ['imm'] },
  { opcode: '0x16', op: 'jae', operands: ['imm'] },
  { opcode: '0x17', op: 'call', operands: ['imm'] },
  { opcode: '0x18', op: 'ret', operands: [] },
  { opcode: '0x19', op: 'leave', operands: [] },
  { opcode: '0x1a', op: 'syscall', operands: [] },
  { opcode: '0x1b', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall win' },
  { opcode: '0x1c', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
  { opcode: '0x1d', op: 'mov', operands: ['reg:RBX', 'imm'] },
  { opcode: '0x1e', op: 'add', operands: ['reg:RAX', 'mem:RBP+disp'] },
];

export const TEST_SYSCALLS: Syscall[] = [
  { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
  {
    nr: 99,
    name: 'win',
    kind: 'custom',
    doc: '置 FLAG=1 并退出',
    effects: [{ type: 'set_reg', reg: 'FLAG', value: '0x1' }, { type: 'exit' }],
  },
  { nr: 1, name: 'write', kind: 'write', doc: 'write(fd, buf, count)' },
];

export const TEST_ABI: SyscallAbi = { nr: 'RAX', args: ['RBX'], ret: 'RAX' };

export const TEST_AUTHOR_BLOCKS: AuthorBlock[] = [
  {
    id: 'setip',
    label: '跳到 addr',
    params: [{ name: 'addr', type: 'addr' }],
    expand: [{ type: 'call', addr: '$addr' }],
  },
  {
    id: 'leak',
    label: '写隐藏区',
    params: [{ name: 'data', type: 'bytes' }],
    expand: [{ type: 'write_bytes', addr: '0x4000', hex: '$data' }],
  },
];

/** `code(0x90, p64(0x10n))` → `"901000000000000000"`。 */
export function code(...parts: readonly (number | string)[]): string {
  return parts
    .map((part) => (typeof part === 'number' ? part.toString(16).padStart(2, '0') : part))
    .join('');
}

export function p64(value: bigint): string {
  return bigIntToHexLE(value, 8);
}

export function p32(value: bigint): string {
  return bigIntToHexLE(value, 4);
}

function defaultVmas(codeHex: string, codeAt: string): ChallengeVma[] {
  return [
    {
      id: 'code',
      kind: 'code',
      start: '0x1000',
      size: '0x1000',
      perm: 'rx',
      hidden: false,
      init: codeHex.length === 0 ? [] : [{ at: codeAt, hex: codeHex }],
    },
    { id: 'data', kind: 'global', start: '0x2000', size: '0x1000', perm: 'rw', hidden: false },
    { id: 'stack', kind: 'stack', start: '0x3000', size: '0x1000', perm: 'rw', hidden: false },
    {
      id: 'hidden',
      kind: 'key',
      label: '关键区',
      start: '0x4000',
      size: '0x1000',
      perm: 'rw',
      hidden: true,
      init: [{ at: '0x4000', hex: 'aabb' }],
    },
    { id: 'rodata', kind: 'custom', label: '只读区', start: '0x5000', size: '0x1000', perm: 'r', hidden: false },
  ];
}

export interface TestChallengeOptions {
  readonly archBits?: ArchBits;
  readonly code?: string;
  /** 机器码 init 补丁的起始地址，默认 `0x1000`（测 VMA 边界截断时用）。 */
  readonly codeAt?: string;
  readonly registers?: readonly string[];
  readonly roles?: Roles;
  readonly initRegisters?: Record<string, string>;
  readonly vmas?: readonly ChallengeVma[];
  readonly encoding?: readonly EncodingItem[];
  readonly syscalls?: readonly Syscall[];
  /** 传 `null` 表示题目没有 syscallAbi。 */
  readonly abi?: SyscallAbi | null;
  readonly authorBlocks?: readonly AuthorBlock[];
  readonly win?: Predicate;
  readonly fail?: readonly Predicate[];
  readonly allowedActions?: readonly string[];
  readonly limits?: Partial<EngineLimits>;
  /** 注入 read / write 的宿主（G02 落地前测接缝用）。 */
  readonly io?: SyscallIo;
}

export interface TestKit {
  readonly pub: PublicChallenge;
  readonly priv: PrivateChallenge;
  readonly env: EngineEnv;
  readonly memory: MemoryApi;
}

/** 默认判胜：`FLAG == 1`；默认判负：已退出但没有置 FLAG（与 ret2win 同构）。 */
const DEFAULT_WIN: Predicate = { reg_eq: { reg: 'FLAG', value: '0x1' } };
const DEFAULT_FAIL: Predicate[] = [
  { all: [{ exited: {} }, { not: { reg_eq: { reg: 'FLAG', value: '0x1' } } }] },
];

export function testKit(options: TestChallengeOptions = {}): TestKit {
  const codeHex = options.code ?? '';
  const registers = options.registers ?? TEST_REGISTERS;
  const roles = options.roles ?? TEST_ROLES;
  const abi = options.abi === undefined ? TEST_ABI : options.abi;

  const pub: PublicChallenge = {
    id: 'test-challenge',
    title: '引擎单测题',
    briefing: '只用于 engine 单测。',
    archBits: options.archBits ?? 64,
    encoding: [...(options.encoding ?? TEST_ENCODING)],
    ...(abi === null ? {} : { syscallAbi: abi }),
    syscalls: [...(options.syscalls ?? TEST_SYSCALLS)],
    fds: [
      { fd: 0, name: 'stdin', kind: 'stdin' },
      { fd: 1, name: 'stdout', kind: 'stdout' },
    ],
    allowedActions: [...(options.allowedActions ?? ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run', 'block'])],
    authorBlocks: [...(options.authorBlocks ?? TEST_AUTHOR_BLOCKS)],
  };

  const priv: PrivateChallenge = {
    registers: [...registers],
    roles,
    initRegisters: {
      RSP: '0x3800',
      RBP: '0x3800',
      RIP: '0x1000',
      ...options.initRegisters,
    },
    vmas: [...(options.vmas ?? defaultVmas(codeHex, options.codeAt ?? '0x1000'))],
    win: options.win ?? DEFAULT_WIN,
    fail: [...(options.fail ?? DEFAULT_FAIL)],
    flag: 'env:FLAG_TEST',
  };

  const memory = createFakeMemory();
  const env = buildEnvironment(pub, priv, memory, { limits: options.limits, io: options.io });
  return { pub, priv, env, memory };
}

/** 只取环境，多数测试用不到 pub / priv。 */
export function testEnv(options: TestChallengeOptions = {}): EngineEnv {
  return testKit(options).env;
}

/** 一次写多个寄存器（测试里摆初始状态用）。 */
export function setRegisters(env: EngineEnv, state: VmState, values: Record<string, bigint>): VmState {
  let next = state;
  for (const [name, value] of Object.entries(values)) {
    next = writeRegister(next, name, value, env.mask);
  }
  return next;
}
