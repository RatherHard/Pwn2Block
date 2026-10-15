import type {
  Action,
  ActionResult,
  DebugInstance,
  MemorySnapshot,
  RequestOutcome,
  VmError,
  VmState,
} from '@pwn2block/shared';
import { applyBlock, applyPrimitive, screenAction } from './actions';
import type { EngineEnv } from './env';
import { createInitialState } from './env';
import type { StepHooks } from './execute';
import { forkState, withMemory } from './state';
import { rejectError } from './vm-errors';

/**
 * 调试实例：草稿纸 + 三层回退（04 §1、§3）。
 *
 * 历史管理是 B 的职责，G 只提供 `MemoryApi.snapshot / restore`（08 §2 规则 2）。
 *
 * - **请求层**：一批动作在第一个真正生效的动作前压一份快照，一次请求一次撤销。
 *   被拒绝的动作不压快照（04 §2），所以整批都被拒绝的请求不产生历史。
 * - **指令层**：`step` / `run` 每条指令前压一份轻量快照，进环形缓冲，窗口默认 64。
 * - `undo` / `step_back` 自身不压栈，否则无法连续后退；`reset` 压栈，因此可被撤销。
 * - `failures` 单调递增，不随回退减少（04 §3）。
 * - 快照覆盖全部 VM 状态：内存句柄 + `VmState` 的其余字段（寄存器、标志、revealed、
 *   stdin、stdout、文件偏移）。回退后 `revealed` 一并回滚，区域重新隐藏。
 */

interface HistoryEntry {
  /** 该时间点的完整状态（其 `memory` 字段不可复用，恢复时用快照换入新句柄）。 */
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

export function createDebugInstance(env: EngineEnv): DebugInstance {
  const undoStack: HistoryEntry[] = [];
  const stepRing: HistoryEntry[] = [];
  let current = createInitialState(env);
  let failureCount = 0;

  /**
   * 一个历史位置 = **它自己的内存 fork** + 同刻的内存快照。
   *
   * 为什么要 fork（A 的契约澄清）：`MemoryApi` 的写入是就地换页表，同一个句柄被
   * 放在多个历史位置时，旧位置会看到后来的写入。fork 是 O(1) 的共享页表操作。
   */
  const entryOf = (state: VmState): HistoryEntry => {
    const memory = env.memory.snapshot(state.memory);
    return { state: withMemory(state, env.memory.restore(memory)), memory };
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
