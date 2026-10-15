/**
 * 测试夹具：假 `ApiClient`、假 `ArtifactTracker`、录像与提交响应构造器。
 *
 * 文件名不是 `*.test.ts`，所以不会被 vitest 收成测试文件。所有响应都过 shared 的 Schema，
 * 保证测试里的“假后端”与真实后端受同一套契约约束。
 */
import {
  CreateSessionResponseSchema,
  ReplaySchema,
  SubmitResponseSchema,
  ret2winPublic,
  type Action,
  type ActionResultView,
  type ActionsResponse,
  type ChallengeSummary,
  type HistoryDepth,
  type Projection,
  type PublicChallenge,
  type ReplayFrameView,
  type ReplayView,
  type SubmitResponse,
  type Verdict,
} from '@pwn2block/shared';
import type { ApiClient } from '../src/api';
import type { ArtifactTracker, PayloadArtifact, PayloadCompileState } from '../src/compiler/artifact';
import type { CompiledAction, NormalizedWorkspace } from '../src/compiler/types';
import type { ControllerState } from '../src/viewmodel/controller';
import { createPageState } from '../src/viewmodel/session';
import { makeProjection, makeVma } from './helpers';

export const FAKE_SESSION_ID = 's'.repeat(32);

export interface FakeCall {
  readonly method: keyof ApiClient;
  readonly challengeId?: string;
  readonly sessionId?: string;
  readonly actions?: readonly Action[];
}

export interface FakeApiOptions {
  readonly challenges?: readonly ChallengeSummary[];
  readonly challenge?: PublicChallenge;
  readonly projection?: Projection;
  readonly history?: HistoryDepth;
  readonly submit?: SubmitResponse;
}

export interface FakeApi {
  readonly client: ApiClient;
  readonly calls: FakeCall[];
  /** 让之后的所有请求都先等这个 Promise：用来稳定观察「同一时刻只有一个请求在飞」。 */
  gate(promise: Promise<void> | undefined): void;
  /** 让下一个会话作用域请求失败一次（会话过期 / 网络错误）。 */
  failNext(error: unknown): void;
  /** 之后的 `actions` 响应里报告的可用回退深度（默认 0：没有历史可退）。 */
  setHistory(history: HistoryDepth): void;
  /** 自定义 `POST /actions` 的响应（默认：全部成功、投影不变）。 */
  setActionsResponse(respond: (actions: readonly Action[]) => ActionsResponse): void;
  reset(): void;
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const calls: FakeCall[] = [];
  const projection = options.projection ?? makeProjection();
  let history = options.history ?? { undo: 0, stepBack: 0 };
  let gate: Promise<void> | undefined;
  let failure: unknown;
  let customActions: ((actions: readonly Action[]) => ActionsResponse) | undefined;

  // 响应总是异步给出（哪怕没有 gate），与真实 fetch 的时序一致。
  function settle<T>(value: () => T): Promise<T> {
    const wait = gate;
    const fail = failure;
    failure = undefined;
    const respond = (): T => {
      if (fail !== undefined) throw fail;
      return value();
    };
    return wait === undefined ? Promise.resolve().then(respond) : wait.then(respond);
  }

  function actionsResponse(actions: readonly Action[]): ActionsResponse {
    if (customActions !== undefined) return customActions(actions);
    const results: ActionResultView[] = actions.map((action) => ({ ok: true, action: action.type }));
    return { results, executed: actions.length, projection, history };
  }

  const client: ApiClient = {
    listChallenges: () => {
      calls.push({ method: 'listChallenges' });
      return settle(() => options.challenges ?? [{ id: 'ret2win', title: '回到胜利' }]);
    },

    getChallenge: (challengeId) => {
      calls.push({ method: 'getChallenge', challengeId });
      return settle(() => options.challenge ?? ret2winPublic);
    },

    createSession: (challengeId) => {
      calls.push({ method: 'createSession', challengeId });
      return settle(() =>
        CreateSessionResponseSchema.parse({ sessionId: FAKE_SESSION_ID, projection, history }),
      );
    },

    sessionState: (sessionId) => {
      calls.push({ method: 'sessionState', sessionId });
      return settle(() => ({ sessionId: FAKE_SESSION_ID, projection, history }));
    },

    actions: async (sessionId, actions) => {
      calls.push({ method: 'actions', sessionId, actions: [...actions] });
      return settle(() => actionsResponse(actions));
    },

    submit: async (sessionId, actions) => {
      calls.push({ method: 'submit', sessionId, actions: [...actions] });
      return settle(() => options.submit ?? makeSubmitResponse('won'));
    },

    endSession: (sessionId) => {
      calls.push({ method: 'endSession', sessionId });
      return settle(() => undefined);
    },
  };

  return {
    client,
    calls,
    gate(promise: Promise<void> | undefined): void {
      gate = promise;
    },
    failNext(error: unknown): void {
      failure = error;
    },
    setHistory(next: HistoryDepth): void {
      history = next;
    },
    setActionsResponse(respond: (actions: readonly Action[]) => ActionsResponse): void {
      customActions = respond;
    },
    reset(): void {
      calls.length = 0;
      failure = undefined;
      gate = undefined;
    },
  };
}

export interface FakeTracker {
  readonly tracker: ArtifactTracker;
  readonly compileCalls: NormalizedWorkspace[];
  /** 设定下一次 `compile()` 的产物，并立刻反映到 `state`（测试里就不用真的拼积木了）。 */
  setArtifact(artifact: PayloadArtifact | undefined): void;
  setErrors(errors: PayloadCompileState['errors']): void;
}

/** 假追踪器：只实现 `ArtifactTracker` 的状态机语义，省掉“先拼积木再编译”的构造开销。 */
export function createFakeTracker(): FakeTracker {
  const compileCalls: NormalizedWorkspace[] = [];
  let produced: PayloadArtifact | undefined;
  let errors: PayloadCompileState['errors'] = [];
  let state: PayloadCompileState = { artifact: undefined, errors: [], stale: false, revision: 0 };

  const tracker: ArtifactTracker = {
    get state(): PayloadCompileState {
      return state;
    },
    compile(program: NormalizedWorkspace): PayloadArtifact | undefined {
      compileCalls.push(program);
      state = {
        artifact: produced,
        errors: produced === undefined ? errors : [],
        stale: false,
        revision: produced === undefined ? state.revision : state.revision + 1,
      };
      return state.artifact;
    },
    noteEdit(): void {
      if (state.artifact === undefined || state.stale) return;
      state = { ...state, stale: true };
    },
    clear(): void {
      produced = undefined;
      errors = [];
      state = { artifact: undefined, errors: [], stale: false, revision: state.revision };
    },
  };

  return {
    tracker,
    compileCalls,
    setArtifact(next: PayloadArtifact | undefined): void {
      produced = next;
      state = {
        artifact: next,
        errors: [],
        stale: false,
        revision: next === undefined ? state.revision : state.revision + 1,
      };
    },
    setErrors(next: PayloadCompileState['errors']): void {
      produced = undefined;
      errors = next;
      state = { artifact: undefined, errors: next, stale: false, revision: state.revision };
    },
  };
}

/** 产物：动作 + 与之一一对应的来源表（`blockIds[i]` 为该动作的积木 id）。 */
export function makeArtifact(actions: readonly CompiledAction[], blockIds?: readonly string[]): PayloadArtifact {
  return {
    actions,
    origins: actions.map((_, index) => ({ index, blockId: blockIds?.[index] ?? `blk-${index}` })),
    originsVersion: 1,
    revision: 1,
  };
}

/** 程序区常用的重复动作：`count` 个 `ret`。 */
export function repeatedActions(count: number): readonly CompiledAction[] {
  return Array.from({ length: count }, () => ({ type: 'ret' }) as const);
}

export function makeControllerState(overrides: Partial<ControllerState> = {}): ControllerState {
  return {
    phase: 'ready',
    challenges: [{ id: 'ret2win', title: '回到胜利' }],
    challengeId: 'ret2win',
    challenge: ret2winPublic,
    sessionId: FAKE_SESSION_ID,
    page: createPageState(makeProjection()),
    history: { undo: 0, stepBack: 0 },
    artifact: { artifact: undefined, errors: [], stale: false, revision: 0 },
    cursor: 0,
    results: [],
    busy: false,
    queued: 0,
    sessionExpired: false,
    ...overrides,
  };
}

export interface FrameSpec {
  readonly kind?: ReplayFrameView['kind'];
  readonly label?: string;
  readonly status?: ReplayFrameView['status'];
  readonly steps?: number;
  readonly failures?: number;
  readonly changedVmas?: readonly Record<string, unknown>[];
  readonly registers?: readonly { readonly name: string; readonly value: string }[];
  readonly flags?: { readonly ZF: boolean; readonly CF: boolean; readonly SF: boolean };
  readonly lastStop?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
  readonly stdin?: { readonly hex: string; readonly pos: number };
  readonly stdout?: { readonly hex: string };
}

/** 录像：`initial` + 逐帧 diff。位置约定见 `viewmodel/replay.ts`（0 是初态，`i + 1` 是 `frames[i]`）。 */
export function makeReplay(specs: readonly FrameSpec[] = [], initial?: Projection): ReplayView {
  const frames = specs.map((spec, index) => ({
    index,
    label: spec.label ?? `动作 ${index + 1}`,
    kind: spec.kind ?? 'action',
    status: spec.status ?? 'ready',
    steps: spec.steps ?? index + 1,
    failures: spec.failures ?? 0,
    registers: spec.registers ?? [{ name: 'RIP', value: '0x400000' }],
    flags: spec.flags ?? { ZF: false, CF: false, SF: false },
    changedVmas: spec.changedVmas ?? [],
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    ...(spec.stdout === undefined ? {} : { stdout: spec.stdout }),
    ...(spec.lastStop === undefined ? {} : { lastStop: spec.lastStop }),
    ...(spec.error === undefined ? {} : { error: spec.error }),
  }));
  return ReplaySchema.parse({ initial: initial ?? makeProjection(), frames });
}

/** 代码段在回放中被改写（`perm` 含 `x`）：指令视图必须报不可用（09 §3.4）。 */
export const CHANGED_CODE_VMA: Record<string, unknown> = makeVma({
  id: 'text',
  kind: 'code',
  start: '0x400000',
  perm: 'rx',
  hex: 'c3',
});

/** 只改数据段（`rw`）：指令视图仍然可用。 */
export const CHANGED_DATA_VMA: Record<string, unknown> = makeVma({
  id: 'stack',
  kind: 'stack',
  start: '0x7fffe000',
  size: '0x2000',
  perm: 'rw',
  hex: '41'.repeat(8),
});

export interface SubmitSpec {
  readonly executed?: number;
  readonly results?: readonly ActionResultView[];
  readonly replay?: ReplayView;
  readonly flag?: string;
}

export function makeSubmitResponse(verdict: Verdict, spec: SubmitSpec = {}): SubmitResponse {
  const replay = spec.replay ?? makeReplay([]);
  return SubmitResponseSchema.parse({
    verdict,
    executed: spec.executed ?? replay.frames.filter((frame) => frame.kind === 'action').length,
    results: spec.results ?? [],
    replay,
    ...(spec.flag === undefined ? {} : { flag: spec.flag }),
  });
}
