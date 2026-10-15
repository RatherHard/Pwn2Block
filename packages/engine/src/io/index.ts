import type { ErrorCode, InputState } from '@pwn2block/shared';

/**
 * G 的 I/O 接口（G02，D2–D3 实现）：stdin / stdout / 虚拟文件（02 §5.3）。
 *
 * D1 只冻结接口形状，不提供运行时实现；实现落点在 `createIo()`（同目录），
 * 供 syscall 的 `read` / `write` 与 `feed` 动作调用。
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
