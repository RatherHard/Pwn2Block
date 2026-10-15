import type {
  Action,
  ActionResult,
  ArchBits,
  DebugInstance,
  InstanceStatus,
  LastStop,
  MemorySnapshot,
  MemoryState,
  RequestOutcome,
  VmError,
  VmState,
} from '@pwn2block/shared';
import { applyBlock, applyPrimitive, screenAction } from './actions';
import type { EngineEnv } from './env';
import { createInitialState } from './env';
import type { StepHooks } from './execute';
import type { SnapshotApi, VmStateSnapshot } from './snapshots/index';
import { createSnapshotApi } from './snapshots/index';
import { forkState, withMemory } from './state';
import { rejectError } from './vm-errors';

/**
 * 调试实例：草稿纸 + 三层回退（04 §1、§3）。
 *
 * 历史管理是 B 的职责，G 只提供状态存取（08 §2 规则 2）：请求层快照、64 条指令环形缓冲、
 * 可 undo 的 reset 都由本文件编排，快照的“抓取 / 恢复”经 `SnapshotApi`（G02）完成。
 *
 * - **请求层**：一批动作在第一个真正生效的动作前压一份快照，一次请求一次撤销。
 *   被拒绝的动作不压快照（04 §2），所以整批都被拒绝的请求不产生历史。
 * - **指令层**：`step` / `run` 每条指令前压一份轻量快照，进环形缓冲，窗口默认 64。
 * - `undo` / `step_back` 自身不压栈，否则无法连续后退；`reset` 压栈，因此可被撤销。
 * - `failures` 单调递增，不随回退减少（04 §3）。
 * - 快照覆盖全部 VM 状态：内存 + `VmState` 的其余字段（寄存器、标志、revealed、
 *   stdin、stdout、文件偏移、退出码）。回退后 `revealed` 一并回滚，区域重新隐藏。
 *   “覆盖哪些字段”由 G 的 `VmStateSnapshot` 单点定义；`status / steps / lastStop / error`
 *   是编排层字段，由本文件随历史条目显式存取（见 `OrchestrationSlice`）。
 */

/**
 * 历史位置：某一时刻的完整状态。
 *
 * - `state.memory` 是该位置**自己的内存句柄**，恢复时用快照换入新句柄，历史之间不共享。
 * - `memory` 是同刻的内存页表快照，`restore` 每次据此派生新句柄（O(1) 共享页表）。
 */
interface HistoryEntry {
  readonly state: VmState;
  readonly memory: MemorySnapshot;
}

interface OneResult {
  readonly ok: boolean;
  readonly error?: VmError;
}

/** 一次请求里“是否已经压过请求层快照”的开关。 */
interface RequestMark {
  pushed: boolean;
}

/**
 * 编排层字段：**不在** `VmStateSnapshot` 里（02 §7 的快照名单没有它们，G 故意不收）。
 *
 * 回退后取什么值由 B 决定，因此随历史条目显式存取，`undo` / `step_back` 仍能恢复
 * `status / steps / lastStop / error`，语义与切到 G 的快照前一致。
 */
interface OrchestrationSlice {
  readonly status: InstanceStatus;
  readonly steps: number;
  readonly lastStop?: LastStop;
  readonly error?: VmError;
}

/** 断言助手：条件不成立时编译失败（`false` / `never` 不满足 `true`）。 */
type AssertTrue<T extends true> = T;

/** 集合相等（两个方向的子集都成立）。 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 编译期护栏：编排层字段必须**恰好**是 `VmState` 减掉快照覆盖的字段（G 的
 * `VmStateSnapshot`）与题常量 `archBits`。
 *
 * 这样“回退要恢复什么”仍然只有一处定义：`shared` 给 `VmState` 加字段时，要么 G 把它加进
 * `VmStateSnapshot`（随快照自动回退），要么这里立刻编译失败，逼着它进编排层字段被显式存取，
 * 不会出现“加了字段但回退后悄悄留旧值”。
 */
export type VmHistoryCoversOrchestration = AssertTrue<
  SameKeys<keyof OrchestrationSlice, Exclude<keyof VmState, keyof VmStateSnapshot | 'archBits'>>
>;

/** 取编排层字段；保留字段是否存在，不把 `undefined` 显式写进去（与投影形状一致）。 */
function orchestrationOf(state: VmState): OrchestrationSlice {
  return {
    status: state.status,
    steps: state.steps,
    ...('lastStop' in state ? { lastStop: state.lastStop } : {}),
    ...('error' in state ? { error: state.error } : {}),
  };
}

/**
 * 把 G 的快照恢复结果拼回完整 `VmState`。
 *
 * 8 个 VM 字段逐个拼（不要整个 spread：`kind` 不属于 `VmState`），`status / steps /
 * `lastStop` / `error` 由编排层字段补上。
 *
 * `restore` 返回片段里的 `memory` 已经是 G 从页表快照派生的**活句柄**，但接口把该字段的
 * 类型沿用 `VmStateSnapshot.memory: MemorySnapshot`，所以这里窄化一次；契约缺口已报 A
 * （`SnapshotApi.restore` 的返回类型应把 `memory` 标成 `MemoryState`）。
 */
function materializeSnapshot(
  restored: VmStateSnapshot,
  orchestration: OrchestrationSlice,
  archBits: ArchBits,
): VmState {
  return {
    archBits,
    registers: restored.registers,
    flags: restored.flags,
    revealed: restored.revealed,
    stdin: restored.stdin,
    stdout: restored.stdout,
    fileOffsets: restored.fileOffsets,
    // 退出码的槽位在快照里必填；写回状态时保持字段的存在性，形状与 `withoutError` 一致。
    ...(restored.exitCode === undefined ? {} : { exitCode: restored.exitCode }),
    memory: restored.memory as unknown as MemoryState,
    status: orchestration.status,
    steps: orchestration.steps,
    ...(orchestration.lastStop === undefined ? {} : { lastStop: orchestration.lastStop }),
    ...(orchestration.error === undefined ? {} : { error: orchestration.error }),
  };
}

export function createDebugInstance(env: EngineEnv): DebugInstance {
  const undoStack: HistoryEntry[] = [];
  const stepRing: HistoryEntry[] = [];
  let current = createInitialState(env);
  let failureCount = 0;

  /**
   * G02 的快照存取：`createSnapshotApi(env.memory)`（08 §2 规则 2）。
   *
   * 历史的“抓取 / 恢复”只经它，“快照覆盖哪些字段”由 `src/snapshots/index.ts` 的类型与
   * 编译期护栏单点定义——本文件不再自己决定快照里放什么。
   */
  const snapshots: SnapshotApi = createSnapshotApi(env.memory);

  /**
   * 一个历史位置 = **它自己的内存 fork** + 同刻的内存快照。
   *
   * 为什么要 fork（A 的契约澄清）：`MemoryApi` 的写入是就地换页表，同一个句柄被
   * 放在多个历史位置时，旧位置会看到后来的写入。fork 是 O(1) 的共享页表操作。
   *
   * G 的 `restore` 在这里立刻调用一次，等价于把这一格页表派生成本历史位置自己的句柄；
   * 条目另留 `vm.memory` 这份页表快照，每次回退都从它派生新句柄，历史之间不共享。
   */
  const entryOf = (state: VmState): HistoryEntry => {
    const vm = snapshots.capture(state);
    return {
      state: materializeSnapshot(snapshots.restore(vm), orchestrationOf(state), env.archBits),
      memory: vm.memory,
    };
  };

  const restoreEntry = (entry: HistoryEntry): VmState =>
    withMemory(entry.state, env.memory.restore(entry.memory));

  const pushUndo = (entry: HistoryEntry): void => {
    undoStack.push(entry);
    if (undoStack.length > env.limits.maxSnapshots) undoStack.shift();
  };

  const hooks: StepHooks = {
    beforeInstruction: (state, _ip) => {
      stepRing.push(entryOf(state));
      if (stepRing.length > env.limits.stepBackWindow) stepRing.shift();
    },
  };

  /** 请求层快照：在第一个真正生效的动作前压入，且整批只压一次。 */
  const markRequest = (mark: RequestMark): void => {
    if (mark.pushed) return;
    pushUndo(entryOf(current));
    mark.pushed = true;
  };

  function doUndo(): OneResult {
    const entry = undoStack.pop();
    if (entry === undefined) return { ok: false, error: rejectError('empty_history') };
    current = restoreEntry(entry);
    // 指令层缓冲属于被撤销的那条时间线，不能再用它往下回退。
    stepRing.length = 0;
    return { ok: true };
  }

  function doStepBack(): OneResult {
    const entry = stepRing.pop();
    if (entry === undefined) return { ok: false, error: rejectError('empty_history') };
    current = restoreEntry(entry);
    return { ok: true };
  }

  function doReset(mark: RequestMark): OneResult {
    markRequest(mark);
    stepRing.length = 0;
    current = createInitialState(env);
    return { ok: true };
  }

  function applyOne(action: Action, mark: RequestMark): OneResult {
    if (action.type === 'undo') return doUndo();
    if (action.type === 'step_back') return doStepBack();
    if (action.type === 'reset') return doReset(mark);

    const screenError = screenAction(env, current, action);
    if (screenError !== undefined) return { ok: false, error: screenError };

    // 快照必须在**真正生效前**压，但拒绝的动作不压（04 §2）。
    // 写原语的隐藏 / 权限校验发生在动作内部，所以这里先压、被拒时再撤回。
    const pushedNow = !mark.pushed;
    markRequest(mark);

    const outcome =
      action.type === 'block'
        ? applyBlock(env, current, action, hooks)
        : applyPrimitive(env, current, action, hooks);

    if (!outcome.ok) {
      // 被拒绝的动作状态不变（写原语先校验后落笔，积木内部自带整块回滚），
      // 因此这份刚压的快照等于原地不动的状态，撤掉它才不会污染 undo 历史。
      if (pushedNow) {
        undoStack.pop();
        mark.pushed = false;
      }
      return { ok: false, error: outcome.error };
    }

    current = outcome.state;
    return outcome.error === undefined ? { ok: true } : { ok: true, error: outcome.error };
  }

  function applyRequest(actions: readonly Action[]): RequestOutcome {
    const results: ActionResult[] = [];
    const mark: RequestMark = { pushed: false };
    let executed = 0;

    for (const action of actions) {
      const outcome = applyOne(action, mark);
      results.push(
        outcome.error === undefined
          ? { ok: outcome.ok, action: action.type }
          : { ok: outcome.ok, action: action.type, error: outcome.error },
      );

      if (!outcome.ok) {
        failureCount += 1;
        break;
      }
      executed += 1;
      if (current.status === 'failed') {
        failureCount += 1;
        break;
      }
      if (current.status === 'exited') break;
    }

    // 交给调用方的状态必须能安全长期持有：fork 内存句柄，后续请求不会改到它。
    return { results, executed, state: forkState(env.memory, current), failures: failureCount };
  }

  return {
    state: () => forkState(env.memory, current),
    failures: () => failureCount,
    applyRequest,
    historyDepth: () => ({ undo: undoStack.length, stepBack: stepRing.length }),
  };
}
