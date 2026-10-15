import type { Action, ActionName } from './actions';
import type { PrivateChallenge, PublicChallenge } from './challenge';
import type { InstanceStatus, LastStop, StopReason, Verdict, VmError } from './errors';
import type { ArchBits, Perm, PermChar, VmaId, VmaKind, VmaLayout } from './primitives';
import type { DisasmEntry } from './projection';

/**
 * 引擎与外部（服务端 / 出题 CLI / 验收测试）之间的契约。
 *
 * 分工（08 §2 规则 2）：
 * - **G** 实现 `MemoryApi`（COW 分页、权限、位宽、快照），只负责状态存取。
 * - **B** 实现解码 / 执行 / 回退编排 / 纯提交回放，并拥有执行循环。
 * - **C/E/F** 只依赖本文件里的接口，不直接碰内存内部表示。
 */

export interface Flags {
  readonly ZF: boolean;
  readonly CF: boolean;
  readonly SF: boolean;
}

export const NO_FLAGS: Flags = Object.freeze({ ZF: false, CF: false, SF: false });

/** 内存状态句柄：G 在 `packages/engine/src/memory` 实现，对 B/C 不透明。 */
export interface MemoryState {
  readonly kind: 'cow-memory';
}

/** 内存快照句柄：同样由 G 实现（脏页 + 页表，见 02 §7）。 */
export interface MemorySnapshot {
  readonly kind: 'cow-memory-snapshot';
}

export type MemAccessReason = 'unmapped' | 'permission';

export interface MemFault {
  readonly ok: false;
  readonly reason: MemAccessReason;
  readonly addr: bigint;
  readonly len: number;
}

export type MemCheck = { readonly ok: true } | MemFault;
export type MemResult = { readonly ok: true; readonly bytes: Uint8Array } | MemFault;

/** 初始内容补丁，已解析成引擎形态（`at` 为整数，`bytes` 为字节）。 */
export interface VmaInitPatch {
  readonly at: bigint;
  readonly bytes: Uint8Array;
}

export interface VmaInit {
  readonly id: VmaId;
  readonly kind: VmaKind;
  readonly label?: string;
  readonly start: bigint;
  readonly size: number;
  readonly perm: Perm;
  readonly hidden: boolean;
  readonly init: readonly VmaInitPatch[];
}

/**
 * 内存访问接口（G 实现）。
 *
 * 关键语义：**这里不做隐藏检查**。隐藏只是“不进入投影”，程序指令照常读写隐藏 VMA（02 §3）；
 * 隐藏区的拒绝属于动作层（B 的 `applyAction`）与投影层（C）。
 */
export interface MemoryApi {
  readonly pageSize: number;
  create(vmas: readonly VmaInit[], archBits: ArchBits): MemoryState;
  /** 只校验权限与映射，不产生字节。取指用 `'x'`。 */
  check(mem: MemoryState, addr: bigint, len: number, need: PermChar): MemCheck;
  read(mem: MemoryState, addr: bigint, len: number): MemResult;
  /** 整段先校验再写：任何一字节越权就整体失败且无副作用（02 §5.2）。 */
  write(mem: MemoryState, addr: bigint, bytes: Uint8Array): MemResult;
  /** 原子拷贝：越权整体失败。`src` 与 `dst` 可跨 VMA。 */
  copy(mem: MemoryState, src: bigint, dst: bigint, len: number): MemResult;
  /** 整块读取某个 VMA 的内容（含隐藏区；调用方负责可见性）。 */
  readVma(mem: MemoryState, vmaId: VmaId): Uint8Array | undefined;
  snapshot(mem: MemoryState): MemorySnapshot;
  restore(snapshot: MemorySnapshot): MemoryState;
}

/** stdin 缓冲与读位置（02 §5.3）。 */
export interface InputState {
  readonly bytes: Uint8Array;
  readonly pos: number;
}

/**
 * 完整 VM 状态。快照覆盖这里列出的全部字段（02 §7）：
 * 内存、寄存器、标志位、已 reveal 的 VMA、stdin、stdout、各 fd 读偏移。
 *
 * `failures` 不在其中：它单调递增、不随回退减少（04 §3），属于实例而不是 VM 状态。
 */
export interface VmState {
  readonly archBits: ArchBits;
  readonly registers: Readonly<Record<string, bigint>>;
  readonly flags: Flags;
  readonly memory: MemoryState;
  readonly revealed: readonly VmaId[];
  readonly stdin: InputState;
  readonly stdout: Uint8Array;
  readonly fileOffsets: Readonly<Record<number, number>>;
  readonly status: InstanceStatus;
  readonly steps: number;
  readonly lastStop?: LastStop;
  readonly error?: VmError;
}

export interface StepOutcome {
  readonly state: VmState;
  readonly executed: number;
  readonly stop: StopReason;
  readonly error?: VmError;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly action: ActionName;
  readonly error?: VmError;
}

/** 一次 `actions` 请求的结果：整批只压一份请求层快照（04 §3）。 */
export interface RequestOutcome {
  readonly results: readonly ActionResult[];
  readonly executed: number;
  readonly state: VmState;
  readonly failures: number;
}

export type ReplayFrameKind = 'init' | 'action' | 'instruction';

/** 回放录像的一帧：判题那一次运行的每一步，服务端据此投影成逐动作 diff（04 §5.1）。 */
export interface ReplayFrame {
  readonly kind: ReplayFrameKind;
  readonly label: string;
  readonly state: VmState;
  readonly error?: VmError;
}

export type PredicateVerdict = 'win' | 'fail' | 'none';

/** 纯提交回放的产物：不含 flag。flag 只由服务端在判胜时下发（04 §5.1）。 */
export interface SubmitOutcome {
  readonly verdict: Verdict;
  readonly executed: number;
  readonly results: readonly ActionResult[];
  readonly frames: readonly ReplayFrame[];
  readonly finalState: VmState;
}

/** 可回退的历史深度，供前端禁用按钮并给出原因（05 §6）。 */
export interface HistoryDepth {
  readonly undo: number;
  readonly stepBack: number;
}

/**
 * 调试实例：草稿纸。`applyRequest` 串行处理一批动作，
 * 遇到第一个被拒绝的动作或进入 `failed` / `exited` 就停止（04 §5）。
 */
export interface DebugInstance {
  state(): VmState;
  failures(): number;
  applyRequest(actions: readonly Action[]): RequestOutcome;
  historyDepth(): HistoryDepth;
}

/** 可见性读取的结果：隐藏区永远不返回字节（01 §6 第 2 条）。 */
export type VisibleRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'hidden' | 'unmapped' | 'permission' };

/**
 * 一道题在服务端的运行期句柄（B 实现 `createRuntime`）。
 * 引擎不读环境变量、不读文件、不发 flag：flag 由服务端从私有包取。
 */
export interface EngineRuntime {
  readonly challengeId: string;
  readonly archBits: ArchBits;
  /** 字长 W = archBits / 8。 */
  readonly wordBytes: number;
  /** 全部 VMA 的公开布局（含 `hidden` 标志），顺序即题目包声明顺序。 */
  readonly layout: readonly VmaLayout[];
  readonly publicPkg: PublicChallenge;
  readonly privatePkg: PrivateChallenge;
  readonly memory: MemoryApi;

  initialState(): VmState;
  step(state: VmState, count: number): StepOutcome;
  run(state: VmState, maxSteps: number): StepOutcome;
  /** 判胜 / 判负谓词求值，`fail` 优先于 `win`（03 §2.1）。 */
  evaluate(state: VmState): PredicateVerdict;
  /** 纯提交回放：从初态执行并判定终态，不读也不发 flag，供 C/E 复用（B03）。 */
  replaySubmit(actions: readonly Action[]): SubmitOutcome;
  createDebugInstance(): DebugInstance;
  /** 服务端反汇编：只覆盖非隐藏的可执行区域（02 §4）。 */
  disassemble(state: VmState): readonly DisasmEntry[];
  /** 只读可见字节：隐藏且未 reveal 的区域拒绝。 */
  readVisible(state: VmState, addr: bigint, len: number): VisibleRead;
  /** 按 VMA 读可见内容：隐藏且未 reveal 时返回 undefined（布局仍公开）。 */
  readVmaVisible(state: VmState, vmaId: VmaId): Uint8Array | undefined;
}

/** 引擎对外的唯一入口（B 实现）。 */
export type CreateRuntime = (pub: PublicChallenge, priv: PrivateChallenge) => EngineRuntime;
