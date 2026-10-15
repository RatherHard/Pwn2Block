/**
 * I/O 视图行投影（05 §2.6）。纯函数：输入投影 + 公开包 + 差分，输出可直接渲染的模型。
 *
 * - **stdout**：全部字节、ASCII 文本，以及**本次响应新增**的字节区间（供高亮）；
 * - **stdin**：全部已 `feed` 的字节，`pos` 之前的置灰（已读）；
 * - **速查**：`syscallAbi`、`syscalls`（调用号 / 名字 / 说明 / 效果）、`fds` 的公开布局。
 *
 * 只能读投影与公开包：隐藏 VMA 与**虚拟文件的内容永远不在这里**（01 §6 第 2 条、05 §2.6），
 * 前端也不做任何猜测性读取。
 */
import {
  hexToBytes,
  type Fd,
  type Projection,
  type PublicChallenge,
  type Syscall,
  type SyscallEffect,
} from '@pwn2block/shared';
import { EMPTY_DIFF, type ProjectionDiff } from './diff';
import { dumpAsciiOfBytes, formatByte, formatHexSpaced, formatSize } from './format';

export const SYSCALL_KIND_NAMES: Readonly<Record<Syscall['kind'], string>> = {
  read: '读',
  write: '写',
  exit: '退出',
  custom: '自定义',
};

export const FD_KIND_NAMES: Readonly<Record<Fd['kind'], string>> = {
  stdin: '标准输入',
  stdout: '标准输出',
  file: '虚拟文件',
};

export interface StdoutByteModel {
  readonly index: number;
  readonly hex: string;
  readonly char: string;
  /** 本次响应新写入的字节（ASCII / hex 两种显示方式都要高亮这一位）。 */
  readonly isNew: boolean;
}

export interface StdinByteModel {
  readonly index: number;
  readonly hex: string;
  readonly char: string;
  /** 已经被读走（`index < pos`）：置灰。 */
  readonly isRead: boolean;
}

export interface StdoutModel {
  readonly hex: string;
  readonly spaced: string;
  readonly ascii: string;
  readonly bytes: readonly StdoutByteModel[];
  /** 本次响应新增的字节区间 `[from, to)`；没有新增时省略。 */
  readonly newRange?: { readonly from: number; readonly to: number };
}

export interface StdinModel {
  readonly hex: string;
  readonly spaced: string;
  readonly ascii: string;
  readonly bytes: readonly StdinByteModel[];
  readonly pos: number;
  readonly total: number;
  /** 还没被读走的字节数。 */
  readonly unread: number;
}

export interface SyscallAbiModel {
  readonly nr: string;
  readonly args: readonly string[];
  readonly ret: string;
}

export interface SyscallRowModel {
  readonly nr: number;
  /** `60 (0x3c)`：十进制与十六进制都给，免得学习者自己换算。 */
  readonly nrText: string;
  readonly name: string;
  readonly kind: Syscall['kind'];
  readonly kindName: string;
  readonly doc?: string;
  /** `custom` 的效果摘要，例如 `FLAG ← 0x1；退出`；其余种类为空串。 */
  readonly effectsText: string;
}

export interface FdRowModel {
  readonly fd: number;
  readonly name: string;
  readonly kind: Fd['kind'];
  readonly kindName: string;
  /** 只有声明了 `size` 的 fd 才有；**这是布局，不是内容**。 */
  readonly sizeText?: string;
}

export interface IoViewModel {
  readonly stdout?: StdoutModel;
  readonly stdin?: StdinModel;
  readonly abi?: SyscallAbiModel;
  readonly syscalls: readonly SyscallRowModel[];
  readonly fds: readonly FdRowModel[];
}

export interface IoViewInput {
  readonly projection: Projection;
  /** 公开包：速查表唯一来源，也是 I/O 视图出现条件的判定输入（05 §2.6）。 */
  readonly challenge: PublicChallenge;
  /** 上一份投影：只用来算 stdout 的新增区间长度。 */
  readonly previous?: Projection;
  readonly diff?: ProjectionDiff;
}

interface StreamByte {
  readonly index: number;
  readonly hex: string;
  readonly char: string;
}

/**
 * 字节流的逐字节模型。
 *
 * `hexToBytes` 给的是 `Uint8Array`，但**不能**在它上面直接 `.map`：`Uint8Array.prototype.map`
 * 会把回调结果按 ToNumber 写回 `Uint8Array`（返回对象会变成 `NaN` → 0，类型上也不成立），
 * 所以先展开成普通数组再映射。
 */
function streamBytes(hex: string): readonly StreamByte[] {
  const bytes = [...hexToBytes(hex)];
  // ASCII 展示与字节一一对应（不可打印字符是 `.`），所以用同一个下标取字符。
  const chars = dumpAsciiOfBytes(Uint8Array.from(bytes));
  return bytes.map((byte, index) => ({ index, hex: formatByte(byte), char: chars[index] ?? '.' }));
}

/**
 * stdout 模型。
 *
 * 高亮规则（与差分配合）：`changed` 表示这次响应的 stdout 变了；若**有上一份可对比**
 * 且长度变长，新增区间就是 `[上一份长度, 本次长度)`——前缀一定没变，所以只高亮增量。
 * 没有上一份（首份投影）或长度没有变长（reset 变短）时不高亮任何字节。
 */
export function buildStdoutModel(
  hex: string,
  options: { readonly previousHex?: string; readonly changed?: boolean } = {},
): StdoutModel {
  const bytes = streamBytes(hex);
  const previousLength = options.previousHex === undefined ? 0 : Math.floor(options.previousHex.length / 2);
  const grew = options.changed === true && options.previousHex !== undefined && previousLength < bytes.length;
  const newRange = grew ? { from: previousLength, to: bytes.length } : undefined;
  const isNew = (index: number): boolean => newRange !== undefined && index >= newRange.from && index < newRange.to;
  return {
    hex,
    spaced: formatHexSpaced(hex),
    ascii: dumpAsciiOfBytes(hexToBytes(hex)),
    bytes: bytes.map((byte) => ({ ...byte, isNew: isNew(byte.index) })),
    ...(newRange === undefined ? {} : { newRange }),
  };
}

/** stdin 模型：`pos` 之前的字节是已读（置灰），`pos` 之后是尚未读走的部分。 */
export function buildStdinModel(hex: string, pos: number): StdinModel {
  const bytes = streamBytes(hex);
  const clamped = Math.min(Math.max(0, Math.floor(pos)), bytes.length);
  return {
    hex,
    spaced: formatHexSpaced(hex),
    ascii: dumpAsciiOfBytes(hexToBytes(hex)),
    bytes: bytes.map((byte) => ({ ...byte, isRead: byte.index < clamped })),
    pos: clamped,
    total: bytes.length,
    unread: bytes.length - clamped,
  };
}

function effectText(effect: SyscallEffect): string {
  switch (effect.type) {
    case 'set_reg':
      return `${effect.reg} ← ${effect.value}`;
    case 'reveal':
      return `揭示 VMA「${effect.vma}」`;
    case 'copy':
      return `复制 ${effect.src} → ${effect.dst}（${effect.len} 字节）`;
    case 'exit':
      return effect.code === undefined ? '退出' : `退出（code ${effect.code}）`;
  }
}

export function buildSyscallRows(challenge: PublicChallenge): readonly SyscallRowModel[] {
  return (challenge.syscalls ?? []).map((syscall) => ({
    nr: syscall.nr,
    nrText: `${syscall.nr} (0x${syscall.nr.toString(16)})`,
    name: syscall.name,
    kind: syscall.kind,
    kindName: SYSCALL_KIND_NAMES[syscall.kind],
    ...(syscall.doc === undefined ? {} : { doc: syscall.doc }),
    effectsText: syscall.kind === 'custom' ? syscall.effects.map(effectText).join('；') : '',
  }));
}

export function buildFdRows(challenge: PublicChallenge): readonly FdRowModel[] {
  return (challenge.fds ?? []).map((fd) => ({
    fd: fd.fd,
    name: fd.name,
    kind: fd.kind,
    kindName: FD_KIND_NAMES[fd.kind],
    ...(fd.size === undefined ? {} : { sizeText: formatSize(BigInt(fd.size)) }),
  }));
}

export function buildSyscallAbi(challenge: PublicChallenge): SyscallAbiModel | undefined {
  const abi = challenge.syscallAbi;
  if (abi === undefined) return undefined;
  return { nr: abi.nr, args: [...abi.args], ret: abi.ret };
}

export function buildIoView(input: IoViewInput): IoViewModel {
  const diff = input.diff ?? EMPTY_DIFF;
  const previousStdout = input.previous?.stdout?.hex;
  const stdout =
    input.projection.stdout === undefined
      ? undefined
      : buildStdoutModel(input.projection.stdout.hex, {
          changed: diff.stdoutChanged,
          ...(previousStdout === undefined ? {} : { previousHex: previousStdout }),
        });
  const stdin =
    input.projection.stdin === undefined
      ? undefined
      : buildStdinModel(input.projection.stdin.hex, input.projection.stdin.pos);
  const abi = buildSyscallAbi(input.challenge);
  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(abi === undefined ? {} : { abi }),
    syscalls: buildSyscallRows(input.challenge),
    fds: buildFdRows(input.challenge),
  };
}
