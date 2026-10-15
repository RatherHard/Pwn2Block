import { MAX_IO_BYTES, MAX_SYSCALL_COUNT, hexToBytes } from '@pwn2block/shared';
import type { ErrorCode, InputState, VmError, VmState } from '@pwn2block/shared';
import type { EngineEnv } from '../env';
import type { SyscallIo } from '../syscall';
import { memFaultError, rejectError, resourceLimitError } from '../vm-errors';

/**
 * G 的 I/O 接口（G02，D2 实现）：stdin / stdout / 虚拟文件（02 §5.3）。
 *
 * D1 冻结接口形状，G02 在这里落地实现：
 * - `createIo()` 是 `IoApi` 的纯实现，供 `feed` 动作与快照存取调用；
 * - `createSyscallIo(env)` 把 `IoApi` 与 `MemoryApi` 拼成 syscall 派发层要的 `SyscallIo`
 *   （`../syscall.ts`），实现 `read` / `write` 两种 kind 的完整语义。
 *
 * 本层的三条硬约束：
 * - **stdin**：一个输入缓冲，上限 `MAX_IO_BYTES`（4KB）。学习者用 `feed` 动作追加字节，
 *   超过上限整个动作被拒绝（`stdin_overflow`）且状态不变。
 *   `read` 从当前读位置取 `min(count, 剩余)`，读完返回 0 字节，和 Linux 的 EOF 一样；
 *   不存在“等待输入”的状态。
 * - **stdout**：只能追加的字节流，累计超过 `MAX_IO_BYTES` 时报 `resource_limit`。
 * - **虚拟文件**：只读，内容在私有包的 `files`，按 fd 记录读偏移；内容绝不进入投影。
 *
 * 失败一律是“整段不生效”：本层不产生部分写入，调用方（B 的 syscall 派发）据此决定
 * 是回 `-1` 还是把实例置为 `failed`。
 */

/** I/O 失败原因：全部取自 shared 的封闭错误码集，不新增文案（02 §6、04 §6）。 */
export type IoErrorCode = Extract<
  ErrorCode,
  'stdin_overflow' | 'resource_limit' | 'memory_fault' | 'invalid_arguments'
>;

/** 一次 I/O 调用的结果：成功带新值，失败带机器可读原因且不产生副作用。 */
export type IoOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: IoErrorCode };

/** `feed` 动作：追加 stdin 字节；超过 4KB 整体拒绝。 */
export type FeedOutcome = IoOutcome<{ readonly stdin: InputState }>;

/** `read(0, …)`：取出字节与新的读位置；读到结尾时 `bytes` 为空、`ret` = 0。 */
export type StdinReadOutcome = IoOutcome<{
  readonly bytes: Uint8Array;
  readonly stdin: InputState;
}>;

/** `write(1, …)`：追加 stdout；超限时 `resource_limit`，且一个字节都不追加。 */
export type StdoutAppendOutcome = IoOutcome<{ readonly stdout: Uint8Array }>;

/** 读虚拟文件：只读，返回字节与新的 fd 读偏移。 */
export type FileReadOutcome = IoOutcome<{
  readonly bytes: Uint8Array;
  readonly offset: number;
}>;

/** fd 方向：`stdin` / `file` 只读，`stdout` 只写；方向不对时回 `-1`，不触发异常。 */
export type IoFdKind = 'stdin' | 'stdout' | 'file';

/** 一个已打开 fd 的静态信息（来自公开包的 `fds`，布局公开、内容私密）。 */
export interface IoFdInfo {
  readonly fd: number;
  readonly kind: IoFdKind;
  /** 虚拟文件的公开大小；必须等于私有包内容长度（02 §5.3）。 */
  readonly size?: number;
}

/**
 * I/O 状态存取接口（G02 实现）。
 *
 * 方法全是纯函数：入参是当前状态片段，出参是新片段（新数组、新对象），
 * 调用方负责把它们拼回 `VmState`。本层不读时间、不用随机数（02 §7）。
 */
export interface IoApi {
  /** `feed`：追加 stdin 字节，超过 4KB 报 `stdin_overflow`。 */
  feed(stdin: InputState, bytes: Uint8Array): FeedOutcome;
  /** `read(fd=stdin)`：取 `min(count, 剩余)` 字节并推进读位置。 */
  readStdin(stdin: InputState, count: number): StdinReadOutcome;
  /** `write(fd=stdout)`：只可追加，累计超过 4KB 报 `resource_limit`。 */
  appendStdout(stdout: Uint8Array, bytes: Uint8Array): StdoutAppendOutcome;
  /** `read(fd=file)`：只读，按 fd 的读偏移取字节并推进偏移。 */
  readFile(content: Uint8Array, offset: number, count: number): FileReadOutcome;
}

// ---------------------------------------------------------------------------
// IoApi 的纯实现（02 §5.3）
// ---------------------------------------------------------------------------

/** `read` 的 count 规范化：非安全整数或非正数一律当 0（零长度不触碰任何字节）。 */
function normalizeCount(count: number): number {
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** 读位置规范化：非法值回到 0；越界钳到 `length`，于是读到末尾时位置停在末尾。 */
function clampOffset(offset: number, length: number): number {
  if (!Number.isSafeInteger(offset) || offset <= 0) return 0;
  return offset > length ? length : offset;
}

/** `feed`：追加 stdin 字节；累计超过 `MAX_IO_BYTES` 时整段拒绝，原状态不动。 */
function feed(stdin: InputState, bytes: Uint8Array): FeedOutcome {
  const total = stdin.bytes.length + bytes.length;
  if (total > MAX_IO_BYTES) return { ok: false, code: 'stdin_overflow' };
  const merged = new Uint8Array(total);
  merged.set(stdin.bytes, 0);
  merged.set(bytes, stdin.bytes.length);
  return { ok: true, stdin: { bytes: merged, pos: stdin.pos } };
}

/** `read(0, …)`：取 `min(count, 剩余)`；EOF 返回 0 字节且读位置不动。 */
function readStdin(stdin: InputState, count: number): StdinReadOutcome {
  const pos = clampOffset(stdin.pos, stdin.bytes.length);
  const size = Math.min(normalizeCount(count), stdin.bytes.length - pos);
  if (size <= 0) return { ok: true, bytes: new Uint8Array(0), stdin };
  return {
    ok: true,
    // 返回副本，不与缓冲别名：调用方可能把这段字节交给内存层，缓冲必须保持不变。
    bytes: stdin.bytes.slice(pos, pos + size),
    stdin: { bytes: stdin.bytes, pos: pos + size },
  };
}

/** `write(1, …)`：只可追加；累计超过 `MAX_IO_BYTES` 时一个字节都不追加。 */
function appendStdout(stdout: Uint8Array, bytes: Uint8Array): StdoutAppendOutcome {
  const total = stdout.length + bytes.length;
  if (total > MAX_IO_BYTES) return { ok: false, code: 'resource_limit' };
  const merged = new Uint8Array(total);
  merged.set(stdout, 0);
  merged.set(bytes, stdout.length);
  return { ok: true, stdout: merged };
}

/** `read(fd=file)`：只读，按偏移取 `min(count, 剩余)` 并推进偏移；EOF 返回 0 字节。 */
function readFile(content: Uint8Array, offset: number, count: number): FileReadOutcome {
  const start = clampOffset(offset, content.length);
  const size = Math.min(normalizeCount(count), content.length - start);
  if (size <= 0) return { ok: true, bytes: new Uint8Array(0), offset: start };
  return { ok: true, bytes: content.slice(start, start + size), offset: start + size };
}

/**
 * `IoApi` 的实现。
 *
 * 四个方法都是纯函数：只读入参、返回新值，不原地改传入的缓冲或偏移。
 * 本层不读时间、不用随机数、不读文件系统与环境变量（02 §7）。
 */
export function createIo(): IoApi {
  return { feed, readStdin, appendStdout, readFile };
}

// ---------------------------------------------------------------------------
// syscall 的 fd 宿主（02 §5.2、§5.3）
// ---------------------------------------------------------------------------

/** `read` / `write` 的一次调用结果；与 `SyscallIo` 的内联返回形状一致。 */
type TransferResult =
  | { readonly state: VmState; readonly ret: bigint }
  | { readonly error: VmError };

/** 虚拟文件的静态视图：内容，以及题目包不一致时的机器可读说明（03 §2.2）。 */
interface FileView {
  readonly bytes: Uint8Array;
  readonly problem?: string;
}

/** fd 参数 → fd 号；超出公开表的取值范围（0–255）时视为未声明。 */
function argFd(raw: bigint | undefined): number | undefined {
  if (raw === undefined || raw < 0n || raw > 0xffn) return undefined;
  return Number(raw);
}

/** `count` 超过 0x1000 时按 0x1000 截断（02 §5.2）。 */
function clampSyscallCount(raw: bigint | undefined): number {
  if (raw === undefined || raw <= 0n) return 0;
  return raw >= BigInt(MAX_SYSCALL_COUNT) ? MAX_SYSCALL_COUNT : Number(raw);
}

/**
 * 构造 syscall 的 fd 宿主（G02）。
 *
 * 分工（08 §2 规则 2）：调用号解析、调用约定寄存器、`ret` 写回都在 `../syscall.ts`；
 * 本函数只管 fd 表、stdin / stdout 与虚拟文件内容，所有内存访问都走 `env.memory`。
 *
 * 语义要点：
 * - fd 未声明或方向不对（读 stdout、写 stdin / 文件）→ `ret = -1`（派发层按位宽回绕），
 *   不触发异常、不改状态（02 §5.2）。
 * - `count` 截断到 0x1000；`count === 0` 一律通过且不触碰任何字节，不构成映射探测。
 * - buf 越权 / 未映射 → `memory_fault`，且**整段不生效**：不推进读位置、不写部分字节、
 *   不追加 stdout 的一部分。返回 `{ error }` 时状态就是传入的原状态。
 * - 虚拟文件只读；内容绝不进 `detail`（布局公开、内容私密，01 §6）。
 *
 * 装配顺序（B 在 `src/index.ts` 的落地方式）：`createSyscallIo` 需要一个 `EngineEnv`，
 * 而 `env.io` 又必须在装配时给出，所以先 `buildEnvironment` 得到 `base`，再
 * `const io = createSyscallIo(base)`，最后派生 `{ ...base, io }`——`env` 只读，不原地写。
 * 两次装配只共享不可变的题目数据与 `MemoryApi`，没有额外状态。
 */
export function createSyscallIo(env: EngineEnv): SyscallIo {
  // syscall 的 stdin / stdout / 虚拟文件语义只有一个实现：上面那套 `IoApi`。
  const io = createIo();

  /** fd 表：布局公开（03 §2 的 `fds`），内容不在其中。 */
  const fds = new Map<number, IoFdInfo>();
  for (const fd of env.pub.fds ?? []) {
    fds.set(
      fd.fd,
      fd.size === undefined
        ? { fd: fd.fd, kind: fd.kind }
        : { fd: fd.fd, kind: fd.kind, size: fd.size },
    );
  }

  /**
   * 虚拟文件内容：只来自私有包 `files`，按 fd 建立只读视图。
   *
   * 缺失内容或长度与公开 `size` 不一致属于题目包错误，`shared/validate.ts` 在加载时就会拒绝
   * （03 §2.2）。这里再兜一层并给出 `invalid_arguments`，避免引擎拿一个自相矛盾的文件长度
   * 静默跑出错误判题结果。
   */
  const files = new Map<number, FileView>();
  for (const [key, entry] of Object.entries(env.priv.files ?? {})) {
    const fd = Number.parseInt(key, 10);
    if (!Number.isSafeInteger(fd)) continue;
    const bytes = hexToBytes(entry.hex);
    const declared = fds.get(fd);
    const problem =
      declared === undefined
        ? `fd ${fd} 的虚拟文件没有对应的 fd 声明`
        : declared.size !== undefined && declared.size !== bytes.length
          ? `fd ${fd} 的虚拟文件长度 ${bytes.length} 与公开的 size ${declared.size} 不一致`
          : undefined;
    files.set(fd, problem === undefined ? { bytes } : { bytes, problem });
  }
  for (const info of fds.values()) {
    if (info.kind === 'file' && !files.has(info.fd)) {
      files.set(info.fd, { bytes: new Uint8Array(0), problem: `fd ${info.fd} 缺少虚拟文件内容` });
    }
  }

  /** `read(fd, buf, count)`：fd → stdin 或虚拟文件，读出的字节写进 buf。 */
  function readCall(state: VmState, args: readonly bigint[]): TransferResult {
    const fd = argFd(args[0]);
    const kind = fd === undefined ? undefined : fds.get(fd)?.kind;
    // 未声明的 fd 与方向不对（读 stdout）都回 -1，不触发异常（02 §5.2）。
    if (fd === undefined || kind === undefined || kind === 'stdout') return { state, ret: -1n };

    const buf = args[1] ?? 0n;
    const count = clampSyscallCount(args[2]);
    // 零长度没有信息量，不能当成“这个地址是否映射”的探测手段（02 §5.2）。
    if (count === 0) return { state, ret: 0n };

    let bytes: Uint8Array;
    let next: VmState;
    if (kind === 'stdin') {
      const outcome = io.readStdin(state.stdin, count);
      if (!outcome.ok) {
        return { error: rejectError(outcome.code, `read(fd=${fd}) 读 stdin 失败`) };
      }
      // EOF：0 字节、读位置不动，也不碰 buf。
      if (outcome.bytes.length === 0) return { state, ret: 0n };
      bytes = outcome.bytes;
      next = { ...state, stdin: outcome.stdin };
    } else {
      const view = files.get(fd);
      if (view === undefined || view.problem !== undefined) {
        return {
          error: rejectError('invalid_arguments', view?.problem ?? `fd ${fd} 不是可读的虚拟文件`),
        };
      }
      const outcome = io.readFile(view.bytes, state.fileOffsets[fd] ?? 0, count);
      if (!outcome.ok) {
        return { error: rejectError(outcome.code, `read(fd=${fd}) 读虚拟文件失败`) };
      }
      if (outcome.bytes.length === 0) return { state, ret: 0n };
      bytes = outcome.bytes;
      next = { ...state, fileOffsets: { ...state.fileOffsets, [fd]: outcome.offset } };
    }

    // 整段 buf 先校验再生效：越权时上面算出的新 stdin / 新偏移一并丢弃。
    const written = env.memory.write(state.memory, buf, bytes);
    if (!written.ok) return { error: memFaultError(written, `read(fd=${fd}) 写 buf`) };
    return { state: next, ret: BigInt(bytes.length) };
  }

  /** `write(fd, buf, count)`：只支持 stdout，`ret` = 实际写入的字节数。 */
  function writeCall(state: VmState, args: readonly bigint[]): TransferResult {
    const fd = argFd(args[0]);
    const kind = fd === undefined ? undefined : fds.get(fd)?.kind;
    // 未声明的 fd 与方向不对（写 stdin / 虚拟文件）都回 -1（02 §5.2）。
    if (fd === undefined || kind !== 'stdout') return { state, ret: -1n };

    const buf = args[1] ?? 0n;
    const count = clampSyscallCount(args[2]);
    if (count === 0) return { state, ret: 0n };

    const read = env.memory.read(state.memory, buf, count);
    if (!read.ok) return { error: memFaultError(read, `write(fd=${fd}) 读 buf`) };

    const appended = io.appendStdout(state.stdout, read.bytes);
    if (!appended.ok) {
      // 一个字节都不追加：部分输出会让“写了多少”变成探测边界的手段（02 §5.2）。
      return { error: resourceLimitError(`stdout 累计超过 ${MAX_IO_BYTES} 字节上限`) };
    }
    return { state: { ...state, stdout: appended.stdout }, ret: BigInt(read.bytes.length) };
  }

  return {
    transfer(state, syscall, args) {
      if (syscall.kind === 'read') return readCall(state, args);
      if (syscall.kind === 'write') return writeCall(state, args);
      // 派发层只把 read / write 交给 fd 宿主；其它 kind 到这里就是装配错误，
      // 显式报错而不是把 exit / custom 当成无事发生。
      return {
        error: rejectError(
          'invalid_instruction',
          `syscall ${syscall.name}（kind=${syscall.kind}）不该交给 fd 宿主`,
        ),
      };
    },
  };
}
