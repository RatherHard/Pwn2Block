import type { MemoryApi, MemorySnapshot, VmState } from '@pwn2block/shared';

/**
 * G 的快照接口（G02，D2–D3 实现）：COW 脏页快照与恢复（02 §7）。
 *
 * 分工（08 §2 规则 2）：G 只实现状态存取；历史管理（请求层 `undo`、指令层环形缓冲
 * `step_back`、可 undo 的 `reset`）由 B 的 `src/instance.ts` 编排。快照本身不做上限裁剪，
 * 保留几份、什么时候丢，都是 B 的决定（上限见 shared 的 `MAX_SNAPSHOTS` / `STEP_BACK_WINDOW`）。
 *
 * 内存那一半已经实现：`MemoryApi.snapshot / restore`（见 `../memory/`）是 O(1) 的页表共享，
 * 本文件在 D2–D3 补的是把寄存器、标志位、reveal 集合与 I/O 状态一起抓取/恢复的包装。
 *
 * 快照覆盖的字段严格照 02 §7：内存、寄存器、标志位、已 `reveal` 的 VMA 集合、
 * stdin 缓冲与读位置、stdout、各文件 fd 的读偏移，以及程序退出时的退出码。
 * 回退到 `reveal` 之前，该区域重新隐藏。
 *
 * **退出码进快照**（`exitCode`，A 与 B 在 D1 收口时定）：它属于“那一时刻的 VM 状态”。
 * 若把它当编排字段排除，`step_back` 跨过一次程序退出后就会留下过期的退出码，
 * 让 `exited:{code}` 谓词读到不属于当前时刻的值。因此它必须随快照一起回退。
 *
 * 其余条目**故意不进快照**：
 * - `failures`：单调递增、不随回退减少，属于实例而不是 VM 状态（04 §3）。
 * - `archBits`：整道题的常量，回退不改变它。
 * - `status / steps / lastStop / error`：实例编排层的状态，回退后取什么值由 B 决定。
 */

/**
 * 快照覆盖的 VM 状态片段。
 *
 * 每个字段都用 `VmState` 的索引访问类型，避免与冻结契约漂移；
 * `memory` 换成 `MemorySnapshot`，因为快照里存的是页表引用而不是可写状态。
 */
export interface VmStateSnapshot {
  readonly kind: 'vm-snapshot';
  readonly memory: MemorySnapshot;
  readonly registers: VmState['registers'];
  readonly flags: VmState['flags'];
  readonly revealed: VmState['revealed'];
  readonly stdin: VmState['stdin'];
  readonly stdout: VmState['stdout'];
  readonly fileOffsets: VmState['fileOffsets'];
  /**
   * 类型是 `bigint | undefined`，但**槽位是必填的**：抓取时必须显式写下“有退出码”还是“没有”，
   * 这样回退就不会继承回退前那一刻的退出码（同 02 §7 的“回退到 `reveal` 之前重新隐藏”一个道理）。
   */
  readonly exitCode: VmState['exitCode'];
}

/** 断言助手：条件不成立时编译失败（`false` / `never` 不满足 `true`）。 */
type AssertTrue<T extends true> = T;

/** 集合相等（两个方向的子集都成立）。 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 编译期护栏：`VmState` 里除实例层字段（`archBits` 常量、`status / steps / lastStop / error`
 * 由 B 编排）之外的每个字段都必须恰好出现在快照里。
 *
 * `exitCode` **不**在排除名单里：它是那一时刻的 VM 状态，必须随快照回退（见文件头）。
 * 任何人不该为了“让编译过”而把它塞进下面的 `Exclude`——那等于让护栏失效。
 *
 * `shared` 给 `VmState` 加字段时，这里会立刻编译失败，逼着快照同步覆盖新状态，
 * 而不是等回退测试暴露“少存了一个字段”。
 */
export type VmSnapshotCoversVmState = AssertTrue<
  SameKeys<
    Exclude<keyof VmStateSnapshot, 'kind'>,
    Exclude<keyof VmState, 'archBits' | 'status' | 'steps' | 'lastStop' | 'error'>
  >
>;

/**
 * 快照存取接口（G02 实现）。
 *
 * 两个方法都必须与回退前的状态无别名耦合：
 * - `capture` 是 O(1)：内存只抓页表引用，其余字段共享不可变值；
 * - `restore` 派生新值：内存从快照派生新句柄，数组与对象要么复制要么只读共享，
 *   因此“回退”不会改动被回退掉的那段历史。
 */
export interface SnapshotApi {
  capture(state: VmState): VmStateSnapshot;
  /** 返回可拼回 `VmState` 的状态片段；`status / steps` 等由 B 自行决定。 */
  restore(snapshot: VmStateSnapshot): VmStateSnapshot;
}

/**
 * `SnapshotApi` 的实现（G02，D2）。
 *
 * 分工（08 §2 规则 2）：本函数只做**状态存取**，历史管理（请求层 `undo`、指令层环形缓冲
 * `step_back`、可 undo 的 `reset`、`MAX_SNAPSHOTS` 裁剪）由 B 的 `src/instance.ts` 编排；
 * 内存那一半由 `MemoryApi.snapshot / restore`（`../memory/`）提供 O(1) 页表共享。
 *
 * 别名纪律（`vm.ts` 的 `MemoryState` 注释）：`MemoryState` 是可变句柄。
 * - `capture` 是 O(1)：内存只抓页表引用，其余字段共享不可变值，**不复制**；
 * - `restore` 派生新值：内存用 `memory.restore` 换一个与快照共享不可变页表的**新句柄**，
 *   数组与对象复制一份，于是“回退”不会改动被回退掉的那段历史。
 *
 * 返回的对象形状是 `VmStateSnapshot`（带 `kind`），调用方要把 8 个 VM 字段逐个拼回
 * `VmState`，**不要整个 spread 进 `VmState`**（`kind` 不属于 `VmState`）。
 * `status / steps / lastStop / error` 不在快照里，回退后取什么值由 B 决定（见文件头）。
 */
export function createSnapshotApi(memory: MemoryApi): SnapshotApi {
  return {
    capture(state: VmState): VmStateSnapshot {
      return {
        kind: 'vm-snapshot',
        memory: memory.snapshot(state.memory),
        registers: state.registers,
        flags: state.flags,
        revealed: state.revealed,
        stdin: state.stdin,
        stdout: state.stdout,
        fileOffsets: state.fileOffsets,
        // 槽位必填：显式写下“有退出码”还是“没有”，回退才不会继承回退前那一刻的值。
        exitCode: state.exitCode,
      };
    },

    restore(snapshot: VmStateSnapshot): VmStateSnapshot {
      /**
       * `memory.restore` 派生出来的是**活句柄**（`MemoryState`），而冻结的字段类型是
       * `VmStateSnapshot.memory: MemorySnapshot`（`MemoryState` 是可变句柄，两者在 shared 里
       * 用不同品牌区分）。这里显式窄化一次，B 在 `instance.ts` 的 `materializeSnapshot`
       * 同样窄化——契约缺口已由 B 报 A：`SnapshotApi.restore` 的返回类型应把 `memory`
       * 标成 `MemoryState`。不要为此改 `VmStateSnapshot` 的形状（那会动冻结契约）。
       */
      const restoredMemory = memory.restore(snapshot.memory) as unknown as MemorySnapshot;
      return {
        kind: 'vm-snapshot',
        memory: restoredMemory,
        registers: { ...snapshot.registers },
        flags: { ...snapshot.flags },
        revealed: [...snapshot.revealed],
        stdin: { bytes: snapshot.stdin.bytes.slice(), pos: snapshot.stdin.pos },
        stdout: snapshot.stdout.slice(),
        fileOffsets: { ...snapshot.fileOffsets },
        exitCode: snapshot.exitCode,
      };
    },
  };
}
