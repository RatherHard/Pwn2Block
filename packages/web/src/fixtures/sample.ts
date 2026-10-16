/**
 * **仅供测试**：D1 的样例数据（05 §2.2–2.5），保留下来给 `packages/web/test/**` 当夹具用。
 *
 * D02 起生产代码路径不再 import 本文件（首屏走真实 `GET /api/challenges`，
 * 投影来自 `POST /api/sessions`）；页面壳里那条「样例切换条」已经删除。
 * 新增生产代码请直接用真实投影，不要引这里的常量。
 *
 * 用 `ret2win`（`shared/src/fixtures.ts`）的公开包与 VM 布局，
 * 手工构造两份**完整投影**，让四种视图在真实契约（`ProjectionSchema`）下先跑起来。
 *
 * 约定：
 * - 投影里的每个字段都经过 `ProjectionSchema.parse`，形状或类型写错会立刻抛错；
 * - 不含 `win` / `fail` / `flag` / 私有包内容——样例与真实投影遵守同一套“隐藏即不下发”的规则；
 * - 隐藏 VMA（`key`，紧贴栈顶之上）**只有布局、没有 `hex`**，用于演示 `??` 与「隐藏」标记。
 */
import {
  ProjectionSchema,
  bytesToHex,
  hexToBytes,
  ret2winPublic,
  type PublicChallenge,
  type Projection,
} from '@pwn2block/shared';

export const SAMPLE_ARCH_BITS = 64;

export const SAMPLE_PUBLIC_CHALLENGE: PublicChallenge = ret2winPublic;

export const SAMPLE_TEXT_START = 0x400000n;
export const SAMPLE_TEXT_SIZE = 0x1000n;
export const SAMPLE_STACK_START = 0x7fffe000n;
export const SAMPLE_STACK_SIZE = 0x2000n;
/** 紧贴栈顶之上的隐藏关键区：布局公开，内容不下发。 */
export const SAMPLE_KEY_START = 0x80000000n;
export const SAMPLE_KEY_SIZE = 0x1000n;

const BUF = 0x7fffff00n;
const SAVED_BP = 0x7fffff10n;
const RET_ADDR = 0x7fffff18n;
const NEXT_SLOT = 0x7fffff20n;

/** 按 `size` 生成全零内容，再打上补丁；补丁的 `at` 是绝对地址。 */
function vmaHex(
  start: bigint,
  size: number,
  patches: readonly { readonly at: bigint; readonly hex: string }[],
): string {
  const bytes = new Uint8Array(size);
  for (const patch of patches) {
    bytes.set(hexToBytes(patch.hex), Number(patch.at - start));
  }
  return bytesToHex(bytes);
}

/** 小端定宽字：`p64(0x400002)` → `0200400000000000`。 */
function p64(value: bigint): string {
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytesToHex(out);
}

/**
 * `text`：`leave` / `ret` / `syscall win` / `syscall exit` 四条真实指令，
 * 末尾额外放一条 `jmp 0x400000`（带 `target`），用来演示指令视图的目标可点击。
 */
const TEXT_HEX = vmaHex(SAMPLE_TEXT_START, Number(SAMPLE_TEXT_SIZE), [
  { at: SAMPLE_TEXT_START, hex: `c9c30f0ee9${p64(SAMPLE_TEXT_START)}` },
]);

/** 栈：`buf` / `saved rbp` / `ret addr` 三个公开标注所在的字节。 */
function stackHex(payload: boolean): string {
  return vmaHex(SAMPLE_STACK_START, Number(SAMPLE_STACK_SIZE), [
    { at: BUF, hex: payload ? '41'.repeat(16) : '00'.repeat(16) },
    { at: SAVED_BP, hex: payload ? '42'.repeat(8) : p64(0x7fffff40n) },
    { at: RET_ADDR, hex: payload ? p64(0x400002n) : p64(0x400003n) },
    { at: NEXT_SLOT, hex: p64(0x7fffff00n) },
  ]);
}

const TEXT_VMA = {
  id: 'text',
  kind: 'code',
  start: '0x400000',
  size: '0x1000',
  perm: 'rx',
  hidden: false,
  hex: TEXT_HEX,
} as const;

const KEY_VMA = {
  id: 'key',
  kind: 'key',
  label: '密钥',
  start: '0x80000000',
  size: '0x1000',
  perm: 'rw',
  hidden: true,
} as const;

const DISASM = [
  { addr: '0x400000', bytes: 'c9', text: 'leave' },
  { addr: '0x400001', bytes: 'c3', text: 'ret' },
  { addr: '0x400002', bytes: '0f', text: 'syscall win' },
  { addr: '0x400003', bytes: '0e', text: 'syscall exit' },
  { addr: '0x400004', bytes: `e9${p64(SAMPLE_TEXT_START)}`, text: 'jmp 0x400000', target: '0x400000' },
] as const;

/** 题目初始状态：`buf` 为空，返回地址仍指向 `lose`（`syscall exit`）。 */
export const SAMPLE_PROJECTION_START: Projection = ProjectionSchema.parse({
  status: 'ready',
  steps: 0,
  failures: 0,
  registers: [
    { name: 'RAX', value: '0x0' },
    { name: 'RDI', value: '0x0' },
    { name: 'RSP', value: '0x7fffff00' },
    { name: 'RBP', value: '0x7fffff10' },
    { name: 'RIP', value: '0x400000' },
    { name: 'FLAG', value: '0x0' },
  ],
  /** 角色随投影下发（08 §9.2）：样例数据里写一次，视图与测试都从这里取。 */
  roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
  flags: { ZF: false, CF: false, SF: false },
  vmas: [
    TEXT_VMA,
    { id: 'stack', kind: 'stack', start: '0x7fffe000', size: '0x2000', perm: 'rw', hidden: false, hex: stackHex(false) },
    KEY_VMA,
  ],
  disasm: DISASM,
});

/** 写入 payload（`padding + p64(0x400002)`）并执行 `leave`、`ret` 之后：控制流到了 `syscall win` 之前。 */
export const SAMPLE_PROJECTION_AFTER: Projection = ProjectionSchema.parse({
  status: 'ready',
  steps: 2,
  failures: 0,
  registers: [
    { name: 'RAX', value: '0x0' },
    { name: 'RDI', value: '0x0' },
    { name: 'RSP', value: '0x7fffff20' },
    { name: 'RBP', value: '0x4242424242424242' },
    { name: 'RIP', value: '0x400002' },
    { name: 'FLAG', value: '0x0' },
  ],
  /** 角色随投影下发（08 §9.2）：样例数据里写一次，视图与测试都从这里取。 */
  roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
  flags: { ZF: false, CF: false, SF: false },
  vmas: [
    TEXT_VMA,
    { id: 'stack', kind: 'stack', start: '0x7fffe000', size: '0x2000', perm: 'rw', hidden: false, hex: stackHex(true) },
    KEY_VMA,
  ],
  disasm: DISASM,
});

/** 「应用一次变化」样例：初始态 → 执行两步后（差分高亮因此有东西可显示）。 */
export const SAMPLE_PROJECTIONS: readonly Projection[] = [
  SAMPLE_PROJECTION_START,
  SAMPLE_PROJECTION_AFTER,
];
