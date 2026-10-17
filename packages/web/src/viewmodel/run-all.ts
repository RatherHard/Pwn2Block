/**
 * 「运行 / 终止」的分片执行（05 §3、设计 §4.3），从 `controller.ts` 拆出来。
 *
 * 这里不持有页面状态：控制器把游标读写、响应应用和「已终止」记录以 `RunAllDeps` 显式传进来，
 * 自己只保管「当前这一轮」的取消令牌（`createRunRounds`）。
 */
import { MAX_ACTIONS_PER_REQUEST, type Action, type ActionsResponse } from '@pwn2block/shared';
import type { ApiClient } from '../api';
import type { ArtifactTracker, PayloadArtifact } from '../compiler/artifact';
import { runAction } from './program';
import { terminalReasonOf } from './session';
import type { RunCommand } from './toolbar';

/** 一轮「运行」的取消令牌：每轮新建一个，终止只作用于当前这一轮，不会泄漏到下一轮。 */
export interface RunRound {
  cancelled: boolean;
}

/** 控制器交给分片循环的读写口；全部是控制器自己的函数，这里不另存状态。 */
export interface RunAllDeps {
  readonly api: ApiClient;
  readonly tracker: ArtifactTracker;
  /** 当前游标：下一次要提交的动作下标。 */
  readonly cursor: () => number;
  readonly pushCursor: (cursor: number) => void;
  /** 应用一次响应（投影、历史、结果与游标），与单步共用同一条路径。 */
  readonly applyActions: (command: RunCommand, response: ActionsResponse) => void;
  /** 记下「已终止：执行到动作 n/m」。 */
  readonly markAborted: (aborted: { readonly executed: number; readonly total: number }) => void;
  /** 走控制器的提示通道（输出区上方的 notice）报一条警告。 */
  readonly warn: (text: string) => void;
}

/** 运行途中积木被改动而停下时的提示；n/m 与「已终止」同口径（游标 / 这轮产物的动作总数）。 */
export function messageArtifactChanged(executed: number, total: number): string {
  return `积木已修改，运行在动作 ${executed}/${total} 处停止`;
}

/**
 * 批量停止条件（04 §5、09 §3.4）：服务端「遇到第一个被拒绝的动作就停」的语义要在客户端
 * **跨分片保持**——某片出现被拒绝、该片实际生效数少于提交数、或实例已经是终止态
 * （`failed` / 已退出），就不再发后续分片。`executed` 与 `results.length` 是两个口径（09 §8），
 * 两个都要看。
 *
 * 终止态用 `terminalReasonOf`（与引擎 `isTerminal()` 同源）：退出恰好落在 512 分片边界时该片
 * 全部成功、`status` 仍是 `satisfied`，只看 `status` 会多发一片，整片撞 `not_executable`
 * 并白记 `failures`（09 §8 第 10 条）。
 * 反过来不许用「`satisfied` 就停」代替：`satisfied` 本身不限制动作（04 §1.1）。
 */
export function stopped(response: ActionsResponse, submitted: number): boolean {
  if (response.results.length < submitted) return true;
  if (response.results.some((result) => !result.ok)) return true;
  if (response.executed < submitted) return true;
  return terminalReasonOf(response.projection) !== undefined;
}

/** 「运行」要发的分片：完整序列按 512 上限切开；空程序退化成一个 `[run]`。 */
function runChunks(actions: readonly Action[]): readonly (readonly Action[])[] {
  if (actions.length === 0) return [[runAction()]];
  const chunks: (readonly Action[])[] = [];
  for (let start = 0; start < actions.length; start += MAX_ACTIONS_PER_REQUEST) {
    chunks.push(actions.slice(start, start + MAX_ACTIONS_PER_REQUEST));
  }
  return chunks;
}

/** 本轮已被终止就记下执行到哪儿并返回 `true`：调用方据此不再发下一片。 */
function abortedBy(deps: RunAllDeps, round: RunRound, total: number): boolean {
  if (!round.cancelled) return false;
  deps.markAborted({ executed: deps.cursor(), total });
  return true;
}

/**
 * 发运行里的一个请求，并按服务端的口径记游标历史（04 §3）：引擎**每个请求**压一层 undo
 * （在第一个真正生效的动作之前；一条都没生效就不压），所以客户端也按请求记——
 * 请求前的游标只在响应回来且 `executed > 0` 时才压栈。请求抛错时什么都不留，
 * 撤销就不会弹出一条服务端并不存在的历史。
 */
async function sendRunRequest(
  deps: RunAllDeps,
  id: string,
  command: RunCommand,
  actions: readonly Action[],
): Promise<ActionsResponse> {
  const before = deps.cursor();
  const response = await deps.api.actions(id, actions);
  if (response.executed > 0) deps.pushCursor(before);
  deps.applyActions(command, response);
  return response;
}

/**
 * 运行途中积木被改动（产物过期，或自动重编译换了一份产物）：旧产物的后续分片已经不是
 * 画布上的程序，不能再发。这不是用户的「终止」，所以不记 `aborted`，只报一条提示说明停在哪儿。
 */
function artifactChanged(deps: RunAllDeps, artifact: PayloadArtifact): boolean {
  const state = deps.tracker.state;
  if (state.artifact === artifact && !state.stale) return false;
  deps.warn(messageArtifactChanged(deps.cursor(), artifact.actions.length));
  return true;
}

/**
 * 运行（05 §3）：先 `[reset]` 回到初态，再从头按 512 分片发**完整**序列，末尾不补 `run`。
 *
 * 终止只在每次响应应用之后检查：在途那片的响应照常应用（服务端已经执行了它），之后不再发。
 */
export async function runAll(deps: RunAllDeps, id: string, round: RunRound): Promise<void> {
  const artifact = deps.tracker.state.artifact;
  if (artifact === undefined) return;
  const total = artifact.actions.length;
  // 排在别的命令后面时就被终止了：一个请求都不发。
  if (abortedBy(deps, round, total)) return;
  const reset = await sendRunRequest(deps, id, { kind: 'reset' }, [{ type: 'reset' }]);
  if (abortedBy(deps, round, total) || stopped(reset, 1)) return;
  for (const chunk of runChunks(artifact.actions)) {
    if (artifactChanged(deps, artifact)) return;
    const response = await sendRunRequest(deps, id, { kind: 'run-all' }, chunk);
    if (abortedBy(deps, round, total) || stopped(response, chunk.length)) return;
  }
}

/** 一轮「运行」的生命周期：令牌、`running` 的置位与复位。 */
export interface RunRounds {
  /**
   * 开始新一轮：新建令牌并**同步**调用 `started`（同一 tick 的第二次「运行」在点击时就被挡下），
   * 返回要排进串行队列的任务。
   */
  begin(execute: (round: RunRound) => Promise<void>): () => Promise<void>;
  /** 终止不是请求：只置当前这一轮的取消标志。 */
  abort(): void;
}

export function createRunRounds(hooks: {
  readonly started: () => void;
  readonly finished: () => void;
}): RunRounds {
  /** 当前这一轮的取消令牌；没有在运行时为 `undefined`。 */
  let current: RunRound | undefined;
  return {
    begin(execute) {
      const round: RunRound = { cancelled: false };
      current = round;
      hooks.started();
      // 不论放行、被复查拦下、失败还是终止，`running` 都在这里复位。
      return async () => {
        try {
          await execute(round);
        } finally {
          if (current === round) current = undefined;
          hooks.finished();
        }
      };
    },
    abort() {
      if (current !== undefined) current.cancelled = true;
    },
  };
}
