/**
 * 会话控制器（04 §1/§5、05 §1/§3/§6）：把单页应用接到真实后端。纯逻辑 + 注入 `ApiClient`，
 * 不 import 任何视图组件，所以能在 node 里用假 API 完整单测。
 *
 * 四件事在这里收口：
 * 1. **请求串行**（04 §1）：所有请求走同一个串行队列，同一时刻只有一个在飞，用户连点按序排队；
 *    动作在**任务真正开始时**才根据最新状态计算，连点两次「单步」提交的是两条不同的动作。
 * 2. **完整投影进 `PageState`**（04 §4）：每次响应都复用 `viewmodel/session.ts` 的
 *    `applyProjection` / `setMode`，不在这里另造一套页面状态。
 * 3. **按钮门禁只有一份**：`run()` 直接查 `viewmodel/toolbar.ts` 的 `runMenuModel`，
 *    与组件渲染用的是同一张表——界面上禁用的动作，控制器也一定不会发出去。
 * 4. **调试实例的投影不被提交改动**（05 §6）：提交前保存调试投影，`backToDebug()` 原样恢复。
 *
 * 产物与过期状态**全部**来自 H 的 `ArtifactTracker`（09 §3.2），这里不维护第二份。
 */
import {
  MAX_ACTIONS_PER_REQUEST,
  MAX_SNAPSHOTS,
  MAX_STEP_COUNT,
  type Action,
  type ActionResultView,
  type ActionsResponse,
  type ChallengeSummary,
  type HistoryDepthView,
  type PublicChallenge,
  type SubmitResponse,
} from '@pwn2block/shared';
import { ApiClientError, isSessionExpired, type ApiClient } from '../api';
import {
  createArtifactTracker,
  type ArtifactTracker,
  type PayloadCompileState,
} from '../compiler/artifact';
import type { ActionOrigin, NormalizedWorkspace } from '../compiler/types';
import { runAction, stepAction } from './program';
import { createSerialQueue } from './queue';
import { defaultPosition } from './replay';
import {
  applyProjection,
  createPageState,
  setMode,
  terminalReasonOf,
  type PageMode,
  type PageState,
  type StatusTone,
} from './session';
import { buttonModel, runMenuModel, type RunCommand, type RunMenuInput } from './toolbar';
import {
  moveView as moveViewIn,
  scrollViews as scrollViewsIn,
  setViewShown as setViewShownIn,
  type ViewKind,
  type ViewManagerState,
} from './views';

export type ControllerPhase = 'loading' | 'choosing' | 'opening' | 'ready' | 'unavailable';

export interface Notice {
  readonly tone: StatusTone;
  readonly text: string;
  /** 提示要带一个可点的出口：会话失效给「重新开始」，网络错误给「重试」（05 §6）。 */
  readonly action?: 'restart' | 'retry';
}

export interface VerdictState {
  readonly response: SubmitResponse;
  /** 时间线位置：0 是初态，`i + 1` 对应 `frames[i]`（09 §3.4）。 */
  readonly position: number;
  /** 提交那份产物的来源表：判题动作 → 积木。 */
  readonly origins: readonly ActionOrigin[];
}

export interface ControllerState {
  readonly phase: ControllerPhase;
  readonly challenges: readonly ChallengeSummary[];
  readonly challengeId?: string;
  readonly challenge?: PublicChallenge;
  readonly sessionId?: string;
  readonly page?: PageState;
  readonly history: HistoryDepthView;
  /** 程序区数据源（H 的追踪器快照）。 */
  readonly artifact: PayloadCompileState;
  /** 程序区当前执行位置：下一次要提交的动作下标。 */
  readonly cursor: number;
  /** 最近一次请求的动作结果。 */
  readonly results: readonly ActionResultView[];
  readonly notice?: Notice;
  readonly busy: boolean;
  readonly queued: number;
  readonly sessionExpired: boolean;
  readonly verdict?: VerdictState;
}

/** 提交前保存的调试状态：`backToDebug()` 用它恢复，保证提交不改动调试实例（05 §6）。 */
interface DebugSnapshot {
  readonly page: PageState;
  readonly history: HistoryDepthView;
  readonly cursor: number;
  readonly cursorStack: readonly number[];
  readonly results: readonly ActionResultView[];
}

type Intent =
  | { readonly kind: 'list' }
  | { readonly kind: 'open'; readonly id: string }
  | { readonly kind: 'run'; readonly command: RunCommand };

export interface SessionControllerDeps {
  readonly api: ApiClient;
  /** 编译产物追踪器；默认新建一个（09 §3.2 冻结的接口，测试可注入假实现）。 */
  readonly tracker?: ArtifactTracker;
}

export interface SessionController {
  readonly state: ControllerState;
  subscribe(listener: (state: ControllerState) => void): () => void;
  /** 首屏：`GET /api/challenges` → 选题 → 创建会话。 */
  start(): void;
  choose(challengeId: string): void;
  /** 「重新开始」：丢弃失效会话，用同一道题创建新会话。 */
  restart(): void;
  /** 重试上一次失败的操作（列表加载 / 打开题目 / 上一条命令）。 */
  retry(): void;
  setMode(mode: PageMode): void;
  /** 视图管理器状态存在 `PageState.views` 里（05 §2.1），所以改它也要经过控制器。 */
  setViewShown(kind: ViewKind, shown: boolean): void;
  moveView(kind: ViewKind, delta: number): void;
  scrollViews(delta: number): void;
  compile(program: NormalizedWorkspace): void;
  /** 积木被改动：产物过期，试运行与提交被禁用（05 §3）。 */
  noteEdit(): void;
  run(command: RunCommand): void;
  backToDebug(): void;
  selectPosition(position: number): void;
}

const EMPTY_HISTORY: HistoryDepthView = { undo: 0, stepBack: 0 };

export function createSessionController(deps: SessionControllerDeps): SessionController {
  const api = deps.api;
  const tracker = deps.tracker ?? createArtifactTracker();
  const listeners = new Set<(state: ControllerState) => void>();

  let sessionId: string | undefined;
  /** 换题 / 重新开始时被替换掉的会话：先 DELETE 掉它，见 `releaseRetiredSession()`。 */
  let retiredSessionId: string | undefined;
  let cursorStack: readonly number[] = [];
  let debugSnapshot: DebugSnapshot | undefined;
  let lastIntent: Intent | undefined;

  let state: ControllerState = {
    phase: 'loading',
    challenges: [],
    history: EMPTY_HISTORY,
    artifact: tracker.state,
    cursor: 0,
    results: [],
    busy: false,
    queued: 0,
    sessionExpired: false,
  };

  const queue = createSerialQueue({ onChange: sync });

  function publish(next: ControllerState): void {
    state = next;
    for (const listener of [...listeners]) listener(next);
  }

  function patch(changes: Partial<ControllerState>): void {
    publish({ ...state, ...changes });
  }

  function notify(tone: StatusTone, text: string, action?: Notice['action']): void {
    patch({ notice: action === undefined ? { tone, text } : { tone, text, action } });
  }

  function sync(): void {
    if (state.busy === queue.inFlight && state.queued === queue.queued) return;
    patch({ busy: queue.inFlight, queued: queue.queued });
  }

  function hasSession(): boolean {
    return sessionId !== undefined && state.challenge !== undefined;
  }

  function patchViews(update: (views: ViewManagerState) => ViewManagerState): void {
    const page = state.page;
    if (page === undefined) return;
    const views = update(page.views);
    if (views === page.views) return;
    patch({ page: { ...page, views } });
  }

  function clampedCursor(): number {
    const total = tracker.state.artifact?.actions.length ?? 0;
    return Math.min(Math.max(0, state.cursor), total);
  }

  /** 门禁的唯一来源：与组件渲染的是同一张按钮表（05 §1 两处菜单等价）。 */
  function menuInput(): RunMenuInput {
    const page = state.page;
    return {
      mode: page?.mode ?? 'debug',
      hasSession: hasSession(),
      sessionExpired: state.sessionExpired,
      artifact: tracker.state.artifact,
      stale: tracker.state.stale,
      compileErrorCount: tracker.state.errors.length,
      history: state.history,
      cursor: state.cursor,
      allowedActions: state.challenge?.allowedActions ?? [],
      // 终止态（failed / 已退出）来自调试实例的投影（04 §1.1）：`satisfied` 与「已退出」可以同时成立。
      terminal: page === undefined ? undefined : terminalReasonOf(page.projection),
    };
  }

  function enqueue(task: () => Promise<void>): void {
    void queue.push(task).catch((error: unknown) => {
      // 正常情况下 `execute` 自己吞掉异常；走到这里说明是控制器的 bug，必须显式报出来。
      notify('error', `界面内部错误：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function handleFailure(error: unknown, command: RunCommand | undefined): void {
    if (isSessionExpired(error)) {
      patch({
        sessionExpired: true,
        notice: {
          tone: 'error',
          text: '会话已失效（服务端已回收或重启）。调试实例的进度已丢失，点「重新开始」创建新会话。',
          action: 'restart',
        },
      });
      return;
    }
    if (command !== undefined) lastIntent = { kind: 'run', command };
    // 429 是唯一「等一下再来」的错误码（04 §6）：带上服务端给的等待秒数，而不是让用户盲试。
    if (error instanceof ApiClientError && error.code === 'rate_limited') {
      const seconds = error.retryAfterSeconds;
      patch({
        notice: {
          tone: 'error',
          text:
            seconds === undefined
              ? `请求过于频繁：${error.message}。这是服务端的限流，稍后点「重试」重新发送。`
              : `请求过于频繁：服务端要求 ${seconds} 秒后再试。到时间点「重试」重新发送。`,
          action: 'retry',
        },
      });
      return;
    }
    const network = error instanceof ApiClientError && error.network;
    const message = error instanceof ApiClientError ? error.message : '未知错误';
    patch({
      notice: {
        tone: 'error',
        text: network ? `网络错误：${message}。检查连接后点「重试」。` : `请求失败：${message}`,
        action: 'retry',
      },
    });
  }

  function pushCursor(): void {
    const next = [...cursorStack, state.cursor];
    cursorStack = next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
  }

  function nextAction(): Action | undefined {
    return tracker.state.artifact?.actions[clampedCursor()];
  }

  function clampCount(count: number): number | undefined {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STEP_COUNT) return undefined;
    return count;
  }

  /** 一次请求的动作（05 §3）：单步在序列用完时退化成 `step`。 */
  function singleActions(command: RunCommand): readonly Action[] | undefined {
    switch (command.kind) {
      case 'step': {
        const action = nextAction();
        return action === undefined ? [stepAction()] : [action];
      }
      case 'run-n': {
        const count = clampCount(command.count);
        if (count === undefined) {
          notify('error', `运行步数需要是 1–${MAX_STEP_COUNT} 的整数`);
          return undefined;
        }
        return [stepAction(count)];
      }
      case 'step-back':
        return [{ type: 'step_back' }];
      case 'undo':
        return [{ type: 'undo' }];
      case 'reset':
        return [{ type: 'reset' }];
      default:
        return undefined;
    }
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
  function stopped(response: ActionsResponse, submitted: number): boolean {
    if (response.results.length < submitted) return true;
    if (response.results.some((result) => !result.ok)) return true;
    if (response.executed < submitted) return true;
    return terminalReasonOf(response.projection) !== undefined;
  }

  function nextCursor(command: RunCommand, response: ActionsResponse): number {
    switch (command.kind) {
      case 'trial-run':
      case 'step': {
        const total = tracker.state.artifact?.actions.length ?? 0;
        return Math.min(total, clampedCursor() + response.results.length);
      }
      case 'reset':
        return 0;
      case 'undo': {
        const restored = cursorStack[cursorStack.length - 1];
        cursorStack = cursorStack.slice(0, -1);
        return restored ?? 0;
      }
      default:
        return state.cursor;
    }
  }

  function applyActions(command: RunCommand, response: ActionsResponse): void {
    const page = state.page;
    patch({
      page: page === undefined ? page : applyProjection(page, response.projection),
      history: response.history,
      results: response.results,
      cursor: nextCursor(command, response),
      notice: undefined,
      sessionExpired: false,
    });
  }

  async function stepOnce(id: string, command: RunCommand): Promise<void> {
    const actions = singleActions(command);
    if (actions === undefined) return;
    if (command.kind === 'step' || command.kind === 'run-n' || command.kind === 'reset') pushCursor();
    applyActions(command, await api.actions(id, actions));
  }

  /** 试运行（05 §3）：提交程序区剩余动作，按 512 上限分块；序列用完退化成 `run`。 */
  async function trialRun(id: string): Promise<void> {
    const artifact = tracker.state.artifact;
    if (artifact === undefined) return;
    const remaining = artifact.actions.slice(clampedCursor());
    pushCursor();
    if (remaining.length === 0) {
      applyActions({ kind: 'trial-run' }, await api.actions(id, [runAction()]));
      return;
    }
    for (let start = 0; start < remaining.length; start += MAX_ACTIONS_PER_REQUEST) {
      const chunk = remaining.slice(start, start + MAX_ACTIONS_PER_REQUEST);
      const response = await api.actions(id, chunk);
      applyActions({ kind: 'trial-run' }, response);
      if (stopped(response, chunk.length)) return;
    }
  }

  async function debugNow(id: string, command: RunCommand): Promise<void> {
    if (command.kind === 'trial-run') {
      await trialRun(id);
      return;
    }
    await stepOnce(id, command);
  }

  async function submitNow(): Promise<void> {
    const id = sessionId;
    const artifact = tracker.state.artifact;
    if (id === undefined || artifact === undefined) return;
    const response = await api.submit(id, artifact.actions);
    const page = state.page;
    // 提交不改动调试实例（04 §5.1）：这里存的纯粹是「切到判题结果之前，界面上是什么」。
    if (page !== undefined) {
      debugSnapshot = {
        page,
        history: state.history,
        cursor: state.cursor,
        cursorStack,
        results: state.results,
      };
    }
    patch({
      verdict: { response, position: defaultPosition(response.replay), origins: artifact.origins },
      // `results` 保持调试实例的最近一次结果：判题结果有自己的 `results`（在 verdict 里），
      // 而调试实例并没有被这次提交改动（04 §5.1）。
      page: page === undefined ? page : setMode(page, 'verdict'),
      notice: undefined,
      sessionExpired: false,
    });
  }

  async function execute(command: RunCommand): Promise<void> {
    if (sessionId === undefined) {
      notify('error', '会话还没准备好：先选一道题');
      return;
    }
    try {
      if (command.kind === 'submit') await submitNow();
      else await debugNow(sessionId, command);
    } catch (error) {
      handleFailure(error, command);
    }
  }

  /** 换题 / 重新开始前的交接：旧会话摘下来，等真正要建新会话时再释放。 */
  function retireSession(): void {
    if (sessionId !== undefined) retiredSessionId = sessionId;
    sessionId = undefined;
  }

  /**
   * 主动结束被替换掉的会话（04 §5 的 DELETE）。
   *
   * 存活会话有每 IP / 全局上限（04 §6），换题与重新开始必须把旧的还回去，否则一次试用
   * 会攒下一串空闲会话，把配额耗到 30 分钟回收为止。**先释放再建新的**：正好在上限上时，
   * 这样新会话才建得起来。清理失败不算错——会话可能已被空闲回收（404）、或网络抖动——
   * 所以只记不抛，绝不挡住新会话。
   */
  async function releaseRetiredSession(): Promise<void> {
    const id = retiredSessionId;
    retiredSessionId = undefined;
    if (id === undefined) return;
    try {
      await api.endSession(id);
    } catch {
      // 有意忽略：这是尽力而为的清理，不是用户请求；失败原因已在上面注释里说明。
    }
  }

  async function openSession(id: string): Promise<void> {
    await releaseRetiredSession();
    const challenge: PublicChallenge = await api.getChallenge(id);
    const session = await api.createSession(id);
    sessionId = session.sessionId;
    tracker.clear();
    cursorStack = [];
    debugSnapshot = undefined;
    publish({
      ...state,
      phase: 'ready',
      challengeId: id,
      challenge,
      sessionId: session.sessionId,
      page: createPageState(session.projection),
      history: session.history,
      artifact: tracker.state,
      cursor: 0,
      results: [],
      notice: undefined,
      sessionExpired: false,
      verdict: undefined,
    });
  }

  function open(id: string): void {
    // 换题：旧会话不再被引用，等这一轮排队任务开始时先 DELETE 掉（04 §5/§6）。
    retireSession();
    lastIntent = { kind: 'open', id };
    patch({ phase: 'opening', challengeId: id, notice: undefined, sessionId: undefined });
    enqueue(() => openSession(id));
  }

  function start(): void {
    lastIntent = { kind: 'list' };
    patch({ phase: 'loading', notice: undefined });
    enqueue(async () => {
      const challenges = await api.listChallenges();
      if (challenges.length === 0) {
        publish({
          ...state,
          challenges: [],
          phase: 'unavailable',
          notice: {
            tone: 'warn',
            text: '服务器上没有可用题目。请确认题目包已放进 challenges/ 并注入了 flag 环境变量，然后点「重试」。',
            action: 'retry',
          },
        });
        return;
      }
      publish({ ...state, challenges });
      const first = challenges[0];
      // 只有一道题时直接开局，省掉一次没有意义的点击；多题走选题界面。
      if (challenges.length === 1 && first !== undefined) {
        open(first.id);
        return;
      }
      patch({ phase: 'choosing' });
    });
  }

  function run(command: RunCommand): void {
    const button = buttonModel(runMenuModel(menuInput()), command.kind);
    if (button === undefined || !button.enabled) {
      notify('warn', button?.disabledReason ?? '这个动作现在不可用');
      return;
    }
    lastIntent = { kind: 'run', command };
    enqueue(() => execute(command));
  }

  return {
    get state(): ControllerState {
      return state;
    },

    subscribe(listener: (next: ControllerState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start,

    choose(challengeId: string): void {
      open(challengeId);
    },

    restart(): void {
      const id = state.challengeId;
      // 重新开始也要把旧会话还回去：它可能还活着（只是被判题结果 / 编辑折腾过），
      // 而存活会话有配额（04 §6）。已经被回收的会话 DELETE 会回 404，忽略即可。
      retireSession();
      debugSnapshot = undefined;
      cursorStack = [];
      tracker.clear();
      publish({
        ...state,
        phase: id === undefined ? 'loading' : 'opening',
        sessionId: undefined,
        page: undefined,
        history: EMPTY_HISTORY,
        artifact: tracker.state,
        cursor: 0,
        results: [],
        notice: undefined,
        sessionExpired: false,
        verdict: undefined,
      });
      if (id === undefined) {
        start();
        return;
      }
      open(id);
    },

    retry(): void {
      const intent = lastIntent;
      if (intent === undefined) return;
      switch (intent.kind) {
        case 'list':
          start();
          return;
        case 'open':
          open(intent.id);
          return;
        case 'run':
          run(intent.command);
          return;
      }
    },

    setMode(mode: PageMode): void {
      const page = state.page;
      if (page === undefined) return;
      patch({ page: setMode(page, mode) });
    },

    setViewShown(kind: ViewKind, shown: boolean): void {
      patchViews((views) => setViewShownIn(views, kind, shown));
    },

    moveView(kind: ViewKind, delta: number): void {
      patchViews((views) => moveViewIn(views, kind, delta));
    },

    scrollViews(delta: number): void {
      patchViews((views) => scrollViewsIn(views, delta));
    },

    compile(program: NormalizedWorkspace): void {
      const challenge = state.challenge;
      if (challenge === undefined) {
        notify('warn', '会话还没准备好：先选一道题再编译');
        return;
      }
      tracker.compile(program, challenge);
      cursorStack = [];
      patch({ artifact: tracker.state, cursor: 0, results: [] });
    },

    noteEdit(): void {
      const before = state.artifact;
      tracker.noteEdit();
      if (tracker.state !== before) patch({ artifact: tracker.state });
    },

    run,

    backToDebug(): void {
      const snapshot = debugSnapshot;
      const page = state.page;
      if (snapshot === undefined) {
        if (page !== undefined) patch({ page: setMode(page, 'debug') });
        return;
      }
      cursorStack = snapshot.cursorStack;
      patch({
        // 视图的显隐 / 排序是用户在判题模式里也可能改的，恢复时保留当前的视图状态。
        page: { ...snapshot.page, mode: 'debug', views: page?.views ?? snapshot.page.views },
        history: snapshot.history,
        cursor: snapshot.cursor,
        results: snapshot.results,
      });
    },

    selectPosition(position: number): void {
      const verdict = state.verdict;
      if (verdict === undefined) return;
      const last = verdict.response.replay.frames.length;
      const clamped = Math.min(Math.max(0, Math.floor(position)), last);
      if (clamped === verdict.position) return;
      patch({ verdict: { ...verdict, position: clamped } });
    },
  };
}
