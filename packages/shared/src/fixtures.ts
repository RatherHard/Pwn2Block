import type { PrivateChallenge, PublicChallenge } from './challenge';

/**
 * 样例题目包（03 §4 的 ret2win，逐字对应文档）。
 *
 * 用途：shared 的 Schema 测试、服务端投影样例、验收骨架的靶子。
 * 约束：**不含 flag 真值**——`flag` 写环境变量引用，和真实题目包一致（06 §6）。
 * 真实题目放在 `challenges/<id>/`，由 E 维护；这里只是样例，不参与 `challenge:check`。
 */

export const ret2winPublic = {
  id: 'ret2win',
  title: '回到胜利',
  archBits: 64,
  briefing: '让程序返回到 win（0x400002）。',
  encoding: [
    { opcode: '0xc9', op: 'leave', operands: [] },
    { opcode: '0xc3', op: 'ret', operands: [] },
    { opcode: '0x0e', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
    { opcode: '0x0f', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall win' },
  ],
  syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
  syscalls: [
    { nr: 60, name: 'exit', kind: 'exit', doc: 'exit(code)' },
    {
      nr: 99,
      name: 'win',
      kind: 'custom',
      doc: '置 FLAG=1 并退出',
      effects: [
        { type: 'set_reg', reg: 'FLAG', value: '0x1' },
        { type: 'exit' },
      ],
    },
  ],
  labels: [
    { name: 'buf', addr: '0x7fffff00', size: 16, kind: 'buffer' },
    { name: 'saved rbp', addr: '0x7fffff10', size: 8, kind: 'saved_bp' },
    { name: 'ret addr', addr: '0x7fffff18', size: 8, kind: 'ret_addr' },
  ],
  allowedActions: ['step', 'run', 'undo', 'reset'],
  authorBlocks: [
    {
      id: 'gets',
      label: 'gets(buf)',
      tooltip: '从 buf 起写入字节，不检查长度',
      params: [{ name: 'data', type: 'bytes' }],
      expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
    },
  ],
  hints: [
    { text: '观察 RBP 与 ret addr 的位置关系。' },
    { text: 'buf 到 ret addr 的距离是多少字节？' },
    { text: '地址按小端序写入。', unlockAfterFailures: 3 },
  ],
} satisfies PublicChallenge;

export const ret2winPrivate = {
  registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
  roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
  initRegisters: { RSP: '0x7fffff00', RBP: '0x7fffff10', RIP: '0x400000' },
  vmas: [
    {
      id: 'text',
      kind: 'code',
      start: '0x400000',
      size: '0x1000',
      perm: 'rx',
      hidden: false,
      init: [{ at: '0x400000', hex: 'c9c30f0e' }],
    },
    {
      id: 'stack',
      kind: 'stack',
      start: '0x7fffe000',
      size: '0x2000',
      perm: 'rw',
      hidden: false,
      init: [{ at: '0x7fffff10', hex: '40ffff7f000000000300400000000000' }],
    },
  ],
  win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
  fail: [{ all: [{ exited: {} }, { not: { reg_eq: { reg: 'FLAG', value: '0x1' } } }] }],
  flag: 'env:FLAG_RET2WIN',
} satisfies PrivateChallenge;

/** ret2win 参考解法：`gets` 写入 padding + 新的返回地址，然后单步三次（03 §4）。 */
export const ret2winSolutionActions = [
  { type: 'block', id: 'gets', args: { data: `${'41'.repeat(16)}${'42'.repeat(8)}0200400000000000` } },
  { type: 'step', count: 3 },
] as const;

/** 本地开发与测试用的 flag 哨兵值，绝不等于任何真实 flag（08 §5 S05）。 */
export const TEST_FLAG_SENTINEL = 'flag{local-test-sentinel}';

/** 默认编码表文件名（06 §2.1）：`presets/x86ish.json`。 */
export const DEFAULT_PRESET_NAME = 'x86ish';
