import type { GraphDocument, WorkflowIssue } from '@pwn2block/shared';
import { compileGraph } from './compile';
import type { WorkflowArtifact, WorkflowContext } from './types';

/**
 * 异步编译产物的状态机（07 §P1「改造 artifact.ts」）。
 *
 * 三条规则是三面：**记住产物**、**改了图就标过期**、**过期/失败/取消都不许运行或提交**。
 * 放在一处，界面只读 `state`，不必自己维护 revision / stale / 请求编号的耦合。
 *
 * 为什么必须异步：Python 求值要走服务端（06 §6）。异步带来一个必须显式处理的问题——
 * **迟到结果**：用户在编译途中改了图、切了题，旧请求晚到的结果绝不能覆盖当前状态。
 * 所以每次编译领一个自增 `requestId`，回调时对不上就直接丢弃（07 §P1 最后两条）。
 *
 * 语义修订与布局修订**分开记**：拖动节点只改 `layoutRevision`，不会让产物过期（07 §P1）。
 */

export type WorkflowStatus = 'idle' | 'compiling' | 'ready' | 'failed' | 'stale' | 'cancelled';

export interface WorkflowArtifactState {
  readonly status: WorkflowStatus;
  /** 最近一次**成功**编译的产物；失败、取消或从未编译时为 `undefined`。 */
  readonly artifact: WorkflowArtifact | undefined;
  /** 最近一次编译的错误（或取消原因）。 */
  readonly issues: readonly WorkflowIssue[];
  /** 与错误分开保存的警告（例如「未使用的节点」），成功时也保留。 */
  readonly warnings: readonly WorkflowIssue[];
  /** 图的语义修订号：任何改变动作的编辑都会 +1。 */
  readonly documentRevision: number;
  /** 布局修订号：拖动、缩放、折叠只改它。 */
  readonly layoutRevision: number;
  /** 当前（或最近一次）编译请求的编号，用来丢弃迟到结果。 */
  readonly requestId: number;
}

export interface RunGate {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface WorkflowTracker {
  readonly state: WorkflowArtifactState;
  /** 图语义变了：作废旧产物；正在编译的请求立即失效。 */
  noteSemanticEdit(): void;
  /** 只改了布局：不旧化产物。 */
  noteLayoutEdit(): void;
  /** 发起一次编译。返回值是本次请求的产物（被丢弃或失败时为 `undefined`）。 */
  compile(): Promise<WorkflowArtifact | undefined>;
  /** 取消正在进行的编译。 */
  cancel(): void;
  /** 切题 / 销毁：清空产物与错误，并让在途请求失效。 */
  clear(): void;
  /** 运行与提交的门禁：只有「当前修订的完整产物」才放行。 */
  gate(): RunGate;
}

export interface TrackerSource {
  readonly document: GraphDocument;
  readonly context: WorkflowContext;
}

export type TrackerProvider = () => TrackerSource;

const MESSAGE_COMPILING = '正在编译：等这次编译完成后再运行或提交（06 §2）';
const MESSAGE_IDLE = '还没有可运行的产物：先编译一次（06 §2）';
const MESSAGE_FAILED = '编译失败：先修好错误再运行或提交（06 §2）';
const MESSAGE_CANCELLED = '编译已取消：重新编译后再运行或提交';
const MESSAGE_STALE = '图在上次编译后改过：重新编译后才能运行或提交（06 §2）';
const MESSAGE_REVISION = '产物与当前图不一致：重新编译（07 §P1）';

export function createWorkflowTracker(provider: TrackerProvider): WorkflowTracker {
  let state: WorkflowArtifactState = {
    status: 'idle',
    artifact: undefined,
    issues: [],
    warnings: [],
    documentRevision: 0,
    layoutRevision: 0,
    requestId: 0,
  };
  let controller: AbortController | undefined;

  const invalidate = (): void => {
    controller?.abort();
    controller = undefined;
    state = {
      ...state,
      requestId: state.requestId + 1,
      status: state.artifact === undefined ? 'idle' : 'stale',
    };
  };

  return {
    get state(): WorkflowArtifactState {
      return state;
    },

    noteSemanticEdit(): void {
      state = { ...state, documentRevision: state.documentRevision + 1 };
      invalidate();
    },

    noteLayoutEdit(): void {
      state = { ...state, layoutRevision: state.layoutRevision + 1 };
    },

    async compile(): Promise<WorkflowArtifact | undefined> {
      controller?.abort();
      const abort = new AbortController();
      controller = abort;
      const requestId = state.requestId + 1;
      const documentRevision = state.documentRevision;
      state = { ...state, requestId, status: 'compiling', issues: [] };

      const source = provider();
      const outcome = await compileGraph({
        document: source.document,
        context: source.context,
        documentRevision,
        signal: abort.signal,
      });

      // 迟到结果：这次请求已经不是当前请求（编辑、切题或被新编译顶掉），直接丢弃。
      if (state.requestId !== requestId) return undefined;

      if (abort.signal.aborted) {
        state = { ...state, status: 'cancelled', artifact: undefined, issues: [{ code: 'cancelled', severity: 'error', nodeId: '', message: MESSAGE_CANCELLED }] };
        return undefined;
      }

      if (!outcome.ok) {
        state = { ...state, status: 'failed', artifact: undefined, issues: outcome.issues, warnings: [] };
        return undefined;
      }

      // 编译期间图又改过：产物属于旧修订，标过期而不是当成就绪（07 §P1）。
      const stale = outcome.artifact.documentRevision !== state.documentRevision;
      state = {
        ...state,
        status: stale ? 'stale' : 'ready',
        artifact: outcome.artifact,
        issues: [],
        warnings: outcome.warnings,
      };
      return outcome.artifact;
    },

    cancel(): void {
      if (state.status !== 'compiling') return;
      controller?.abort();
      controller = undefined;
      state = { ...state, requestId: state.requestId + 1, status: 'cancelled' };
    },

    clear(): void {
      controller?.abort();
      controller = undefined;
      state = {
        status: 'idle',
        artifact: undefined,
        issues: [],
        warnings: [],
        documentRevision: state.documentRevision + 1,
        layoutRevision: state.layoutRevision,
        requestId: state.requestId + 1,
      };
    },

    gate(): RunGate {
      switch (state.status) {
        case 'compiling':
          return { ok: false, reason: MESSAGE_COMPILING };
        case 'failed':
          return { ok: false, reason: MESSAGE_FAILED };
        case 'cancelled':
          return { ok: false, reason: MESSAGE_CANCELLED };
        case 'stale':
          return { ok: false, reason: MESSAGE_STALE };
        case 'idle':
          return { ok: false, reason: MESSAGE_IDLE };
        case 'ready':
          if (state.artifact === undefined) return { ok: false, reason: MESSAGE_IDLE };
          if (state.artifact.documentRevision !== state.documentRevision) {
            return { ok: false, reason: MESSAGE_REVISION };
          }
          return { ok: true };
      }
    },
  };
}
