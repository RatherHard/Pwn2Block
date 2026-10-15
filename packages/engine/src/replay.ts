import { isControlAction } from '@pwn2block/shared';
import type {
  Action,
  ActionResult,
  ReplayFrame,
  StepOutcome,
  SubmitOutcome,
  Verdict,
  VmError,
  VmState,
} from '@pwn2block/shared';
import { applyBlock, applyPrimitive, screenAction } from './actions';
import type { EngineEnv } from './env';
import { createInitialState } from './env';
import type { StepHooks } from './execute';
import { evaluateVerdict, predicateContext } from './predicates';
import { forkState } from './state';
import { rejectError } from './vm-errors';

/**
 * 纯提交回放（B03，04 §5.1）：从题目初态执行动作序列并判定终态。
 *
 * - **纯函数**：不读调试实例、不碰历史、不压快照，每次调用都从 `initialState()` 开始。
 * - **不读也不发 flag**：`SubmitOutcome` 里没有 flag 字段，私有包的 `flag` 字段
 *   在本文件里从未被访问；下发 flag 是服务端在判胜时的动作（04 §5.1）。
 * - 判题实例没有回退，payload 里出现回退类动作即 `rejected`。
 * - 任一动作被拒绝即终止（`rejected`）；运行期异常即判负（02 §6：异常即判负）。
 *
 * 录像帧：首帧 `init` + 每个动作一帧 `action` + 每条指令一帧 `instruction`，
 * 服务端据此压成「首份完整投影 + 逐动作 diff」（`ReplayView`）。
 */

function frameOf(
  kind: ReplayFrame['kind'],
  label: string,
  state: VmState,
  error: VmError | undefined,
): ReplayFrame {
  return error === undefined ? { kind, label, state } : { kind, label, state, error };
}

export function replaySubmit(env: EngineEnv, actions: readonly Action[]): SubmitOutcome {
  let current = createInitialState(env);
  // 每一帧都带自己的内存 fork：`MemoryApi` 的写入就地换页表，共享句柄会让
  // 早先的帧看到后来的写入（A 的契约澄清）。fork 是 O(1) 的共享页表操作。
  const frames: ReplayFrame[] = [frameOf('init', 'init', forkState(env.memory, current), undefined)];
  const results: ActionResult[] = [];
  let executed = 0;
  let rejected = false;

  const hooks: StepHooks = {
    afterInstruction: (outcome: StepOutcome, instruction) => {
      const label = instruction === undefined ? '??' : instruction.text;
      frames.push(
        frameOf('instruction', label, forkState(env.memory, outcome.state), outcome.error),
      );
    },
  };

  for (const action of actions) {
    if (isControlAction(action)) {
      const error = rejectError('action_not_allowed', '判题实例没有回退，提交 payload 不得包含回退类动作');
      results.push({ ok: false, action: action.type, error });
      frames.push(frameOf('action', action.type, forkState(env.memory, current), error));
      rejected = true;
      break;
    }

    const screenError = screenAction(env, current, action);
    if (screenError !== undefined) {
      results.push({ ok: false, action: action.type, error: screenError });
      frames.push(frameOf('action', action.type, forkState(env.memory, current), screenError));
      rejected = true;
      break;
    }

    const outcome =
      action.type === 'block'
        ? applyBlock(env, current, action, hooks)
        : applyPrimitive(env, current, action, hooks);
    current = outcome.state;

    if (!outcome.ok) {
      results.push({ ok: false, action: action.type, error: outcome.error });
      frames.push(frameOf('action', action.type, forkState(env.memory, current), outcome.error));
      rejected = true;
      break;
    }

    results.push(
      outcome.error === undefined
        ? { ok: true, action: action.type }
        : { ok: true, action: action.type, error: outcome.error },
    );
    frames.push(frameOf('action', action.type, forkState(env.memory, current), outcome.error));
    executed += 1;

    // 程序已退出：后续动作不再执行（判题实例不能交互）。
    if (current.status === 'exited') break;
    // 运行期异常即判负，不再继续。
    if (current.status === 'failed') break;
  }

  return {
    verdict: verdictOf(env, current, rejected),
    executed,
    results,
    frames,
    finalState: forkState(env.memory, current),
  };
}

function verdictOf(env: EngineEnv, state: VmState, rejected: boolean): Verdict {
  if (rejected) return 'rejected';
  // 02 §6：判题实例不回退，异常即判负；异常优先于谓词。
  if (state.error !== undefined) return 'failed';

  const judged = evaluateVerdict(env.win, env.fail, predicateContext(env, state));
  if (judged === 'fail') return 'failed';
  if (judged === 'win') return 'won';
  return state.status === 'failed' ? 'failed' : 'incomplete';
}
