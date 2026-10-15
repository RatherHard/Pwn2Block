import type {
  CreateRuntime,
  EngineRuntime,
  PrivateChallenge,
  PublicChallenge,
  RuntimeOptions,
} from '@pwn2block/shared';
import { disassembleState } from './disasm';
import { buildEnvironment, createInitialState } from './env';
import { runState, stepState } from './execute';
import { createDebugInstance } from './instance';
import { createMemory } from './memory/index';
import { evaluateVerdict, predicateContext } from './predicates';
import { replaySubmit } from './replay';
import { readVisible, readVmaVisible } from './visibility';

/**
 * 引擎入口（`@pwn2block/engine`）：`createRuntime` 是唯一的装配点（09 §3.3）。
 *
 * 分工（08 §2 规则 2）：
 * - B01–B03：解码、指令执行、动作分发、回退编排、纯提交回放，以及本文件。
 * - G01–G02：`src/memory/**`（VMA、权限、COW、快照）、`src/io/**`、`src/snapshots/**`。
 *
 * 依赖方向：engine 只依赖 shared，**不许 import server**（07 §2）。
 *
 * 编码表：`pub.encoding` 是 `{preset, add, remove}` 时，调用方必须把展开后的表经
 * `options.encoding`（或已建好的 `options.lookup`）传进来——引擎不做文件 IO，读不到
 * `presets/<name>.json`；缺失时 `buildEnvironment` 显式抛错（03 §1）。
 * 引擎不读环境变量、不读文件、不发 flag。
 */
export const createRuntime: CreateRuntime = (
  pub: PublicChallenge,
  priv: PrivateChallenge,
  options?: RuntimeOptions,
): EngineRuntime => {
  const env = buildEnvironment(pub, priv, createMemory, {
    encoding: options?.encoding,
    lookup: options?.lookup,
  });

  return {
    challengeId: env.challengeId,
    archBits: env.archBits,
    wordBytes: env.wordBytes,
    layout: env.layout,
    publicPkg: pub,
    privatePkg: priv,
    memory: createMemory,

    initialState: () => createInitialState(env),
    step: (state, count) => stepState(env, state, count),
    run: (state, maxSteps) => runState(env, state, maxSteps),
    evaluate: (state) => evaluateVerdict(env.win, env.fail, predicateContext(env, state)),
    replaySubmit: (actions) => replaySubmit(env, actions),
    createDebugInstance: () => createDebugInstance(env),
    disassemble: (state) => disassembleState(env, state),
    readVisible: (state, addr, len) => readVisible(env, state, addr, len),
    readVmaVisible: (state, vmaId) => readVmaVisible(env, state, vmaId),
  };
};

export type {
  ActionResult,
  Action,
  DebugInstance,
  DisasmEntry,
  EngineRuntime,
  HistoryDepth,
  MemoryApi,
  RequestOutcome,
  ReplayFrame,
  RuntimeOptions,
  StepOutcome,
  SubmitOutcome,
  VisibleRead,
  VmError,
  VmState,
} from '@pwn2block/shared';
