/**
 * 会话控制器（04 §1/§5、05 §1/§3/§6）：把单页应用接到真实后端。纯逻辑 + 注入 `ApiClient`，
 * 不 import 任何视图组件，所以能在 node 里用假 API 完整单测。
 *
 * 四件事在这里收口：
 * 1. **请求串行**（04 §1）：所有请求走同一个串行队列，同一时刻只有一个在飞，用户连点按序排队；
 *    动作在**任务真正开始时**才根据最新状态计算，连点两次「单步」提交的是两条不同的动作。
 * 2. **完整投影进 `PageState`**（04 §4）：每次响应都复用 `viewmodel/session.ts` 的
 *    `applyProjection` / `setMode`，不在这里另造一套页面状态。
 * 3. **按钮门禁只有一份**：`run()`（点击时）与 `execute()`（任务真正开始时）查的是同一张
 *    按钮表（`runMenuModel` + `payloadControls`）——界面上禁用的动作，控制器在**发出请求之前**
 *    一定不会发出去。D5 ① 修的正是「只有点击时求值」：排队期间实例可能已经进入终止态，那时必须复查。
 * 4. **调试实例的投影不被提交改动**（05 §6）：提交前保存调试投影，`backToDebug()` 原样恢复。
 *
 * 产物与过期状态**全部**来自 H 的 `ArtifactTracker`（09 §3.2），这里不维护第二份。
 */
import {
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
import { createArtifactTracker, type ArtifactTracker, type PayloadCompileState } from '../compiler/artifact';
import type { ActionOrigin, CompiledAction, CompileError, NormalizedWorkspace } from '../compiler/types';
import { stepAction } from './program';
import { createSerialQueue } from './queue';
import { defaultPosition, displayedView } from './replay';
import { createRunRounds, runAll, type RunAllDeps, type RunRound } from './run-all';
import { clearSession, readSession, readViewTab, writeSession, writeViewTab, type KeyValueStore } from './storage';
import {
  applyProjection,
  createPageState,
  setMode,
  terminalReasonOf,
  type PageMode,
  type PageState,
  type StatusTone,
} from './session';
import {
  buttonModel,
  payloadControls,
  runMenuModel,
  type RunButtonModel,
  type RunCommand,
  type RunMenuInput,
} from './toolbar';
import {
  availableViews,
  createViewManagerState,
  cycleView as cycleViewIn,
  selectView as selectViewIn,
  type ViewKind,
  type ViewManagerState,
} from './views';

/**
 * 启动进度；unavailable 表示启动失败，是否保留工作台由已取得的 challenge 决定。
 * missing 表示地址里的题目不在服务器的题目列表里（history 路由的深链接）。
 */
export type ControllerPhase = 'loading' | 'choosing' | 'missing' | 'opening' | 'ready' | 'unavailable';

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
  /**
   * 来源表版本（09 §3.4）：判题结果的「高亮哪块积木」也走 `compiler/locate.ts` 的
   * `blockIdForAction()`，版本对不上就按「来源未知」处理，不做猜测式定位。
   */
  readonly originsVersion: number;
}

export interface ControllerState {
  readonly phase: ControllerPhase;
  readonly challenges: readonly ChallengeSummary[];
  readonly challengeId?: string;
  readonly challenge?: PublicChallenge;
  readonly sessionId?: string;
  readonly page?: PageState;
  readonly history: HistoryDepthView;
  /** 编译产物与过期状态（H 的追踪器快照）。 */
  readonly artifact: PayloadCompileState;
  /** 当前执行位置（游标）：下一次单步要提交的动作下标。 */
  readonly cursor: number;
  /** 最近一次请求的动作结果。 */
  readonly results: readonly ActionResultView[];
  readonly notice?: Notice;
  readonly busy: boolean;
  readonly queued: number;
  readonly sessionExpired: boolean;
  readonly verdict?: VerdictState;
  /** 一轮「运行」从点击到结束（最后一片响应 / 失败 / 终止）期间为 `true`；不是串行队列的门禁。 */
  readonly running: boolean;
  /** 上一轮「运行」被终止时执行到的位置；任何其他命令开始执行、或新一轮运行开始时清掉。 */
  readonly aborted?: { readonly executed: number; readonly total: number };
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
  | { readonly kind: 'list'; readonly target?: string }
  | { readonly kind: 'open'; readonly id: string }
  | { readonly kind: 'run'; readonly command: RunCommand };

/** 本地会话记录里要套回游标与结果的那部分（见 `pendingResume` 的注释）。 */
interface StoredResume {
  readonly cursor: number;
  readonly results: readonly ActionResultView[];
  readonly actionsLength: number;
}

export interface SessionControllerDeps {
  readonly api: ApiClient;
  /** 编译产物追踪器；默认新建一个（09 §3.2 冻结的接口，测试可注入假实现）。 */
  readonly tracker?: ArtifactTracker;
  /**
   * 本地保存用的存储（05 §3.1）。**缺省不保存**：页面壳显式传 `defaultStore()`，
   * 测试不传就不会碰到 jsdom 里那份真实 `localStorage`（否则用例之间会互相串会话）。
   */
  readonly store?: KeyValueStore;
  /** 画布存档的还原出口（05 §3.1 的「先画布、再会话」顺序靠它保证）。 */
  readonly canvas?: CanvasPort;
}

/**
 * 画布端口（05 §3.1）：控制器不能碰 Blockly（`blocks/**` 是唯一接触点，09 §6），
 * 所以「把本地存档装回画布」这件事由页面壳实现、控制器只按顺序调用。
 */
export interface CanvasPort {
  /**
   * 保证画布已挂载并装回存档，返回 `undefined` 表示成功（没有存档也算成功），
   * 否则返回**给用户看**的失败原因。实现方负责等画布挂载完成，别在这里抛错。
   */
  restore(): Promise<string | undefined>;
}

export interface SessionController {
  readonly state: ControllerState;
  subscribe(listener: (state: ControllerState) => void): () => void;
  /**
   * 首屏：`GET /api/challenges`。不带 `target` 停在题目列表；带 `target`（地址里的题目 id）
   * 时列表里有就直接打开，没有就进入 `missing`。
   */
  start(target?: string): void;
  /** 打开列表里的一道题；id 不在列表里时进入 `missing`，不拿它去请求后端。 */
  choose(challengeId: string): void;
  /** 返回列表保留按题保存的会话，后续选回时接回进度；请求在飞或排队时不切换，返回 false。 */
  browseChallenges(): boolean;
  /** 「重新开始」：丢弃失效会话，用同一道题创建新会话。 */
  restart(): void;
  /** 重试上一次失败的操作（列表加载 / 打开题目 / 上一条命令）。 */
  retry(): void;
  setMode(mode: PageMode): void;
  /** 当前标签存在 `PageState.views` 里，改动经控制器并写进本地存储（设计 §3.1）。 */
  selectView(kind: ViewKind): void;
  cycleView(delta: -1 | 1): void;
  compile(program: NormalizedWorkspace): void;
  /**
   * 采用画布编译出的动作与来源：写入同一个追踪器，运行/单步/提交照旧走既有链路。
   * 来源的 `blockId` 是画布节点 id。
   */
  publish(actions: readonly CompiledAction[], origins: readonly ActionOrigin[]): void;
  /** 画布编译失败：把错误写进同一个追踪器，输出区与运行门禁照常读到（05 §3）。 */
  publishErrors(errors: readonly CompileError[]): void;
  /** 积木被改动：产物过期，运行、单步与提交被禁用（05 §3）。 */
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
  /**
   * 会话恢复时待应用的游标（05 §3.1、04 §1.1）。
   *
   * 服务端只回投影，不回「执行到第几条动作」——那是纯前端的指针，所以它跟会话 id 一起
   * 存在本地。**只有产物的动作条数跟存的时候一致才认**：画布存档丢了或被改过，产物就对不上，
   * 硬套一个旧指针会让下一次单步把已经执行过的动作再提交一遍。
   */
  let pendingResume: StoredResume | undefined;

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
    running: false,
  };

  const queue = createSerialQueue({ onChange: sync });
  const rounds = createRunRounds({
    // 同步置位：同一 tick 的第二次「运行」在点击时就被 MESSAGE_RUNNING 挡下。
    started: () => patch({ running: true, aborted: undefined }),
    finished: () => patch({ running: false }),
  });

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

  /** 只在本题可用的标签里切换；没变化就不重绘、不写存储。 */
  function patchViews(
    update: (views: ViewManagerState, available: readonly ViewKind[]) => ViewManagerState,
  ): void {
    const page = state.page;
    if (page === undefined) return;
    const views = update(page.views, availableViews(displayedView(page, state.verdict).projection, state.challenge));
    if (views === page.views) return;
    writeViewTab(deps.store, views.active);
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

  /**
   * 命令当前被挡住的**原因**；放行时返回 `undefined`。
   *
   * 这是 `run()`（点击时）与 `execute()`（任务真正开始时）共用的唯一判定，
   * 所以两处不可能给出不同的结论（D5 ① 的缺陷就是「只有点击时求值」）。
   *
   * 被禁的是**执行类动作在终止态下**这一类（以及产物过期、无产物、无可退历史、判题模式…），
   * `busy` / `queued` **不是**门禁：串行队列本来就允许合法排队（04 §1），
   * 把排队也算成禁用会砍掉「连点两次单步按序执行」这个正常用法。
   *
   * 「运行 / 终止」读 `payloadControls`，其余读 `runMenuModel`。`running` 只挡点击：
   * 一轮运行在 `run()` 里同步置位，`execute()` 复查时它必然为真，所以复查传 `ignoreRunning`。
   */
  function blockedReason(
    command: RunCommand,
    options: { readonly ignoreRunning?: boolean } = {},
  ): string | undefined {
    const button =
      command.kind === 'run-all' || command.kind === 'abort'
        ? payloadButton(command.kind, options.ignoreRunning === true)
        : buttonModel(runMenuModel(menuInput()), command.kind);
    if (button === undefined) return '这个动作现在不可用';
    return button.enabled ? undefined : button.disabledReason ?? '这个动作现在不可用';
  }

  function payloadButton(kind: 'run-all' | 'abort', ignoreRunning: boolean): RunButtonModel {
    const controls = payloadControls({ ...menuInput(), running: ignoreRunning ? false : state.running });
    return kind === 'run-all' ? controls.run : controls.abort;
  }

  function enqueue(task: () => Promise<void>): void {
    void queue.push(task).catch((error: unknown) => {
      // 正常情况下 `execute` 自己吞掉异常；走到这里说明是控制器的 bug，必须显式报出来。
      notify('error', `界面内部错误：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function handleFailure(error: unknown, command: RunCommand | undefined): void {
    if (isSessionExpired(error)) {
      // 会话已经死了：本地那条会话记录也不能留，否则下一次刷新会拿一个必然 404 的 id 去接。
      if (state.challengeId !== undefined) clearSession(deps.store, state.challengeId);
      pendingResume = undefined;
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

  /**
   * **启动路径**（题目列表 / 新建会话 / 接回会话）的失败收尾：`handleFailure` 给出提示与
   * 「重试」出口，这里再补一件它不做的事——把相位从 `loading` / `opening` 挪开。
   *
   * `unavailable` 记录启动失败，不直接决定画面：app-shell 按是否已有 challenge 分派。
   * 未取得题面时，renderBoot 用该相位显示失败页；已有题面时仍保留工作台和画布，
   * 由 notice 解释失败、无 session 的门禁禁用运行按钮。两条路径的重试出口都来自 notice。
   */
  function handleStartupFailure(error: unknown): void {
    handleFailure(error, undefined);
    if (state.notice?.action === 'retry' || state.notice?.tone === 'error') {
      patch({ phase: 'unavailable' });
    }
  }

  function pushCursor(cursor: number = state.cursor): void {
    const next = [...cursorStack, cursor];
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

  function nextCursor(command: RunCommand, response: ActionsResponse): number {
    switch (command.kind) {
      case 'run-all':
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
    // 游标变了就落盘：刷新后要接着这里，而不是把已经执行过的动作再发一遍。
    persistResume();
  }

  async function stepOnce(id: string, command: RunCommand): Promise<void> {
    const actions = singleActions(command);
    if (actions === undefined) return;
    if (command.kind === 'step' || command.kind === 'run-n' || command.kind === 'reset') pushCursor();
    applyActions(command, await api.actions(id, actions));
  }

  /** 分片循环的读写口：游标、响应应用与「已终止」都仍由控制器持有。 */
  const runAllDeps: RunAllDeps = {
    api,
    tracker,
    cursor: () => state.cursor,
    pushCursor,
    applyActions,
    markAborted: (aborted) => patch({ aborted }),
    warn: (text) => notify('warn', text),
  };

  async function debugNow(id: string, command: RunCommand, round: RunRound | undefined): Promise<void> {
    if (command.kind === 'run-all') {
      await runAll(runAllDeps, id, round ?? { cancelled: false });
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
      verdict: {
        response,
        position: defaultPosition(response.replay),
        origins: artifact.origins,
        originsVersion: artifact.originsVersion,
      },
      // `results` 保持调试实例的最近一次结果：判题结果有自己的 `results`（在 verdict 里），
      // 而调试实例并没有被这次提交改动（04 §5.1）。
      page: page === undefined ? page : setMode(page, 'verdict'),
      notice: undefined,
      sessionExpired: false,
    });
  }

  async function execute(command: RunCommand, round?: RunRound): Promise<void> {
    if (sessionId === undefined) {
      notify('error', '会话还没准备好：先选一道题');
      return;
    }
    // **门禁复查（D5 ①）**：点击时放行不等于任务真正开始时还放行。串行队列里的任务可能排了
    // 好一会儿，排在前面的响应足以把实例推进终止态（或让产物过期、把历史退空）。
    // G2 Phase 2 的 jsdom 探针实测：同一 tick 连点两次「单步」，第一次响应已把实例推到
    // `failed`，第二次仍然发出请求（`sentActionsRequests: 2`），多出来的那次被
    // `not_executable` 拒绝、白记一次 `failures`。这里用与点击时**同一张**按钮表复查，
    // 被挡住就不发请求，并给出与点击时一致的 `disabledReason` 通知。
    const blocked = blockedReason(command, { ignoreRunning: true });
    if (blocked !== undefined) {
      notify('warn', blocked);
      return;
    }
    // 「已终止」只描述上一轮运行：别的命令一旦真正开始，它就过时了。
    if (state.aborted !== undefined) patch({ aborted: undefined });
    try {
      if (command.kind === 'submit') await submitNow();
      else await debugNow(sessionId, command, round);
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

  /**
   * 画布存档的还原（05 §3.1）：失败只是「本地程序没恢复」，画布在桥那一侧**逐块保持原样**
   * （09 §3.2 的事务式语义），所以这里把原因转成提示，不抛。
   */
  async function restoreCanvas(): Promise<string | undefined> {
    const port = deps.canvas;
    if (port === undefined) return undefined;
    try {
      return await port.restore();
    } catch (error) {
      return `本地保存的程序恢复失败（画布保持原样）：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * 接回上次的调试会话，接不上就新建一个（04 §1.1 的 `GET /api/sessions/:id`、05 §3.1）。
   *
   * 两种「接不上」要分开对待：
   * - **404 / 会话已回收**：正常现象（空闲回收、服务端重启），清掉记录后安静地新建，
   *   只提示一句，不把「会话已失效」那种红色错误甩给刚刚刷新的用户；
   * - **网络 / 限流**：交给 `handleFailure` 统一给出「重试」出口，并返回 `undefined` 让调用方
   *   停在第一相位——第一相位（题面 + 画布）已经发布了，用户的程序还在屏幕上，可以重试。
   */
  async function resumeOrCreate(id: string): Promise<
    | {
        readonly sessionId: string;
        readonly projection: PageState['projection'];
        readonly history: HistoryDepthView;
        readonly resume?: StoredResume;
        readonly notice?: Notice;
      }
    | undefined
  > {
    const stored = readSession(deps.store, id);
    if (stored !== undefined) {
      try {
        const resumed = await api.sessionState(stored.sessionId);
        return {
          sessionId: resumed.sessionId,
          projection: resumed.projection,
          history: resumed.history,
          resume: { cursor: stored.cursor, results: stored.results, actionsLength: stored.actionsLength },
        };
      } catch (error) {
        if (!isSessionExpired(error)) {
          handleStartupFailure(error);
          return undefined;
        }
        clearSession(deps.store, id);
        const created = await createFresh(id);
        if (created === undefined) return undefined;
        return {
          ...created,
          notice: {
            tone: 'warn',
            text: '上次的调试会话已经不可用了（服务端已回收或重启），已新建一个。本地保存的程序还在。',
          },
        };
      }
    }
    return createFresh(id);
  }

  /**
   * 新建调试会话。失败**必须**交给 `handleStartupFailure`：让异常穿透到 `enqueue` 的 catch
   * 会显示「界面内部错误」并把界面留在启动页（429 配额、网络抖动都是真实会发生的）。
   */
  async function createFresh(id: string): Promise<
    | {
        readonly sessionId: string;
        readonly projection: PageState['projection'];
        readonly history: HistoryDepthView;
      }
    | undefined
  > {
    try {
      const session = await api.createSession(id);
      return { sessionId: session.sessionId, projection: session.projection, history: session.history };
    } catch (error) {
      handleStartupFailure(error);
      return undefined;
    }
  }

  /**
   * 打开一道题（05 §3.1）。**两个相位，顺序是硬要求**：
   * 1. 题面 + 画布：先把 `challenge` 发下去让页面壳挂上画布并装回本地存档；
   * 2. 会话：`GET /api/sessions/:id` 接回旧实例或新建。
   *
   * 反过来的话，会话状态先到、画布还是空的，用户会看到「服务端调试状态回来了、画布空着」的
   * 半恢复；而画布装载本身会触发一次重编译，重编译的产物必须落在**已经恢复好的**画布上。
   */
  async function openSession(id: string): Promise<void> {
    await releaseRetiredSession();
    const challenge: PublicChallenge = await api.getChallenge(id);
    // **换题**才清产物：`state.challenge` 记得的是画布当前挂的那道题（`open()` 只改
    // `challengeId`，不动它）。同一道题重新打开（「重新开始」/ 重试）时画布没换，
    // 产物与它仍然对得上，清掉只会让画布上还有积木、却没有可运行的产物——又一种半恢复。
    if (state.challenge?.id !== id) tracker.clear();
    cursorStack = [];
    debugSnapshot = undefined;
    pendingResume = undefined;
    // 第一相位：题面先到（`page` 还没有，页面壳为此渲染「正在恢复」的骨架 + payload 窗口）。
    publish({
      ...state,
      phase: 'opening',
      challengeId: id,
      challenge,
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
    const canvasFailure = await restoreCanvas();
    // 第二相位：会话。画布已经就位，这一相位里发生的任何重编译都作用在恢复后的程序上。
    const resumed = await resumeOrCreate(id);
    // 网络 / 限流：`resumeOrCreate` 已经给出提示与「重试」出口，就停在这里（第一相位不回滚）。
    if (resumed === undefined) return;
    sessionId = resumed.sessionId;
    publish({
      ...state,
      phase: 'ready',
      challengeId: id,
      challenge,
      sessionId: resumed.sessionId,
      page: createPageState(resumed.projection, createViewManagerState(readViewTab(deps.store))),
      history: resumed.history,
      artifact: tracker.state,
      cursor: 0,
      results: [],
      notice: canvasFailure === undefined ? resumed.notice : { tone: 'warn', text: canvasFailure },
      sessionExpired: false,
      verdict: undefined,
    });
    // 指针要等产物编译出来才能认（`compile()` 里还会再试一次）。
    pendingResume = resumed.resume;
    applyPendingResume();
    persistResume();
  }

  /**
   * 把游标（执行到哪儿）写进本地会话记录（05 §3.1）：刷新后要接着上次的位置，而不是从头发一遍。
   *
   * 还没套上旧指针时（`pendingResume` 有值，产物还没编译出来）**不写**：这时候 `state.cursor`
   * 还是刚重置的 0，落盘会把刚读出来的旧指针覆盖掉。
   */
  function persistResume(): void {
    const id = state.challengeId;
    if (id === undefined || sessionId === undefined || pendingResume !== undefined) return;
    writeSession(deps.store, id, {
      sessionId,
      cursor: state.cursor,
      results: state.results,
      actionsLength: tracker.state.artifact?.actions.length ?? 0,
    });
  }

  /**
   * 把会话恢复时读到的游标套上去，**只认条数对得上的产物**；对不上就丢掉并说明，
   * 绝不把一个指向别的动作序列的指针硬套上去。
   */
  function applyPendingResume(): void {
    const pending = pendingResume;
    if (pending === undefined) return;
    const actions = tracker.state.artifact?.actions;
    if (actions === undefined) return; // 画布还没编出产物：等 `compile()`。
    pendingResume = undefined;
    if (actions.length !== pending.actionsLength) {
      notify(
        'warn',
        '本地保存的程序与上次的调试进度对不上（积木被改过，或画布存档没恢复成功），将从第一条动作重新开始。',
      );
      return;
    }
    patch({
      cursor: Math.min(pending.cursor, actions.length),
      results: pending.results,
    });
  }

  function open(id: string): void {
    // 换题：旧会话不再被引用，等这一轮排队任务开始时先 DELETE 掉（04 §5/§6）。
    retireSession();
    lastIntent = { kind: 'open', id };
    patch({ phase: 'opening', challengeId: id, notice: undefined, sessionId: undefined });
    enqueue(() => openSession(id));
  }

  function start(target?: string): void {
    lastIntent = target === undefined ? { kind: 'list' } : { kind: 'list', target };
    patch({ phase: 'loading', notice: undefined });
    enqueue(async () => {
      // 列表加载失败（网络不通 / 被限流）同样要有出口：`handleStartupFailure` 会给出带
      // 「重试」的提示并把相位挪出 `loading`，`retry()` 再按 `lastIntent` 重跑 `start()`。
      let challenges: readonly ChallengeSummary[];
      try {
        challenges = await api.listChallenges();
      } catch (error) {
        handleStartupFailure(error);
        return;
      }
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
      // 列表路由始终停在列表，即使只有一道题；题目路由才直接开局。
      if (target === undefined) {
        patch({ phase: 'choosing' });
        return;
      }
      // 这里还在队列任务里，`showList` 会因「请求在飞」拒绝切换，所以直接发布。
      if (!challenges.some((item) => item.id === target)) {
        patch({ phase: 'missing' });
        return;
      }
      open(target);
    });
  }

  function choose(id: string): void {
    if (state.challenges.some((item) => item.id === id)) {
      open(id);
      return;
    }
    showList('missing');
  }

  /**
   * 回到列表页（`choosing`）或「题目不存在」页（`missing`）。
   *
   * 离开一道题是暂存而非结束会话：每道题复用其保存的会话，失效后仍走既有的新建路径。
   * 请求在飞或排队时不切换，否则迟到响应会覆盖列表页或下一题；返回值表示是否切换成功。
   */
  function showList(phase: 'choosing' | 'missing'): boolean {
    if (queue.inFlight || queue.queued > 0) return false;
    // 列表还没拿到（加载中 / 加载失败）时没有列表可回，交给 `start()` / `retry()`。
    const listed = state.phase === 'choosing' || state.phase === 'missing';
    if (state.challenge === undefined && !listed) return false;
    if (state.challenge !== undefined) {
      persistResume();
      sessionId = undefined;
      cursorStack = [];
      debugSnapshot = undefined;
      pendingResume = undefined;
      tracker.clear();
    }
    lastIntent = { kind: 'list' };
    publish({
      phase, challenges: state.challenges, history: EMPTY_HISTORY,
      artifact: tracker.state, cursor: 0, results: [], busy: false, queued: 0, sessionExpired: false,
      running: false,
    });
    return true;
  }

  function run(command: RunCommand): void {
    const blocked = blockedReason(command);
    if (blocked !== undefined) {
      notify('warn', blocked);
      return;
    }
    // 终止不是请求：不进串行队列，只置本轮的取消标志。
    if (command.kind === 'abort') {
      rounds.abort();
      return;
    }
    lastIntent = { kind: 'run', command };
    if (command.kind === 'run-all') {
      enqueue(rounds.begin((round) => execute({ kind: 'run-all' }, round)));
      return;
    }
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

    choose,

    browseChallenges(): boolean {
      return showList('choosing');
    },

    restart(): void {
      const id = state.challengeId;
      // 重新开始也要把旧会话还回去：它可能还活着（只是被判题结果 / 编辑折腾过），
      // 而存活会话有配额（04 §6）。已经被回收的会话 DELETE 会回 404，忽略即可。
      retireSession();
      // 新会话就等于新实例：本地那条会话记录（含游标）必须一起丢掉，
      // 否则刷新后会拿旧指针去对新实例。**画布与产物不动**——积木是用户的程序，
      // 不是会话的一部分（D5 批次 2；`openSession` 也按同一条口径决定要不要清产物）。
      if (id !== undefined) clearSession(deps.store, id);
      debugSnapshot = undefined;
      cursorStack = [];
      pendingResume = undefined;
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
          start(intent.target);
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

    selectView(kind: ViewKind): void {
      patchViews((views, available) => selectViewIn(views, kind, available));
    },

    cycleView(delta: -1 | 1): void {
      patchViews((views, available) => cycleViewIn(views, delta, available));
    },

    publish(actions: readonly CompiledAction[], origins: readonly ActionOrigin[]): void {
      tracker.adopt(actions, origins);
      patch({ artifact: tracker.state, cursor: 0, results: [] });
      applyPendingResume();
      persistResume();
    },

    publishErrors(errors: readonly CompileError[]): void {
      tracker.fail(errors);
      patch({ artifact: tracker.state, cursor: 0, results: [] });
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
      // 画布恢复会走到这里：产物刚编出来，正是判断「上次的游标还算不算数」的时候。
      applyPendingResume();
      // 产物条数是新的，会话记录里的 `actionsLength` 也要跟着走。
      persistResume();
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
        // 当前标签是用户在判题模式里也可能改的，恢复时保留当前的视图状态。
        page: { ...snapshot.page, mode: 'debug', views: page?.views ?? snapshot.page.views },
        history: snapshot.history,
        cursor: snapshot.cursor,
        results: snapshot.results,
      });
      persistResume();
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
