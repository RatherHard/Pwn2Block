import type {
  CreateRuntime,
  EngineRuntime,
  PrivateChallenge,
  PublicChallenge,
} from '@pwn2block/shared';

/**
 * 引擎入口（`@pwn2block/engine`）。
 *
 * D1 只冻结签名：调用即抛错，避免半截实现被当成可用引擎。
 * 实现分工（08 §2 规则 2）：
 * - B01–B03：解码、指令执行、动作分发、回退编排、纯提交回放，以及 `index.ts` 这个包入口。
 * - G01–G02：`src/memory/**`（VMA、权限、COW、快照）、`src/io/**`、`src/snapshots/**`。
 *
 * 依赖方向：engine 只依赖 shared，**不许 import server**（07 §2）。
 */
export const createRuntime: CreateRuntime = (
  _pub: PublicChallenge,
  _priv: PrivateChallenge,
): EngineRuntime => {
  throw new Error('引擎尚未实现：B01（D1–D3），见 docs/08-Agent并行开发日程.md §4');
};

export type {
  ActionResult,
  Action,
  DebugInstance,
  EngineRuntime,
  HistoryDepth,
  MemoryApi,
  RequestOutcome,
  ReplayFrame,
  StepOutcome,
  SubmitOutcome,
  VmState,
} from '@pwn2block/shared';
