import { canvas } from '@pwn2block/shared';
import type { Action as CanvasAction, AuthorBlock } from '@pwn2block/shared';
import { WORKFLOW_ORIGIN_VERSION } from './artifact';
import type {
  CompiledAction,
  CompileOutcome,
  CompileTraceEntry,
  NodePreview,
  WorkflowArtifact,
  WorkflowIssue,
  WorkflowOrigin,
} from './artifact';

/**
 * 新版画布 → 旧编译产物形状的接缝（阶段三「前端切到新版画布」时，界面只认这一层）。
 *
 * 为什么要有这层：新版画布的生成器（`@pwn2block/shared` 的 `canvas/actions`）产出
 * `{ actions, steps }`，而界面、网络请求与回放共用的是 `canvas/artifact` 里的
 * `WorkflowArtifact`（新旧画布同一份契约，旧画布删除后仍留在这里）。这里只搬运，不解释：
 * - 动作原样交给服务端展开，客户端不展开出题人积木（01 §6 第 3 条）；
 * - 问题代码映射成旧代码，只为让现有界面按熟悉的分组渲染；
 * - 步骤快照 `steps` **不进产物**（产物是网络与回放共用的形状），由另一个入口单独给出。
 */

/** 轨迹上限：与旧编译一致（`workflow/compile.ts` 的 `MAX_TRACE_ENTRIES`）。 */
const MAX_TRACE_ENTRIES = 256;

/** 新版画布只有一条顶层序列，产物里的路径就固定是 `['main']`。 */
const MAIN_PATH: readonly string[] = ['main'];

export interface CanvasCompileInput {
  readonly document: canvas.CanvasDocument;
  /** 题目公开声明：方法目录与展开预检都来自这里。 */
  readonly authorBlocks?: readonly AuthorBlock[];
  /** 文档语义修订号，编译本身不读，只抄进产物（与旧编译一致）。 */
  readonly documentRevision: number;
  /** 循环/动作预算，测试用；生产走 limits 默认值。 */
  readonly maxActions?: number;
}

/** 生成成功时连同产物一起返回的步骤表，只在前端内存里用。 */
export type CanvasCompileOutcome =
  | {
      readonly ok: true;
      readonly artifact: WorkflowArtifact;
      readonly steps: readonly canvas.CanvasStep[];
      readonly warnings: readonly WorkflowIssue[];
    }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

/**
 * 编译，并把步骤快照一起交出来（「按步骤和循环轮次查看当时的值」，需求 §7）。
 *
 * 失败时**不发布部分动作**：`generateCanvasActions` 本身就是「要么整份、要么带节点的错误」。
 */
export function compileCanvasWithSteps(input: CanvasCompileInput): CanvasCompileOutcome {
  const generated = canvas.generateCanvasActions(input.document, {
    challenge: { authorBlocks: input.authorBlocks },
    ...(input.maxActions === undefined ? {} : { maxActions: input.maxActions }),
  });
  if (!generated.ok) return { ok: false, issues: generated.issues.map(toWorkflowIssue) };

  const { actions, steps } = generated.sequence;
  return {
    ok: true,
    artifact: {
      actions: compiledActionsOf(actions),
      origins: originsOf(steps),
      originsVersion: WORKFLOW_ORIGIN_VERSION,
      previews: previewsOf(input.document),
      trace: traceOf(actions, steps),
      documentRevision: input.documentRevision,
    },
    steps,
    // 目前没有「不阻止生成」的画布问题：预留字段，免得阶段三改签名。
    warnings: [],
  };
}

/** 只要产物、不要步骤表：界面与网络走这个入口。 */
export function compileCanvas(input: CanvasCompileInput): CompileOutcome {
  const outcome = compileCanvasWithSteps(input);
  if (!outcome.ok) return { ok: false, issues: outcome.issues };
  return { ok: true, artifact: outcome.artifact, warnings: outcome.warnings };
}

// ---------------------------------------------------------------------------
// 问题代码映射
// ---------------------------------------------------------------------------

/**
 * 画布问题代码 → 旧 `WorkflowIssue['code']`。
 *
 * 旧代码只是过渡期的界面分组键：阶段三把旧 `workflow/` 整体删掉后，这张表跟着消失，
 * 界面直接用 `CanvasIssueCode`。所以映射只保证「语义最近」，不追求一一对应；
 * 中文原文一律保留，映射不改文案。
 */
const ISSUE_CODE_MAP: Readonly<Record<canvas.CanvasIssueCode, WorkflowIssue['code']>> = {
  unknown_node: 'unknown_node',
  unknown_kind: 'unknown_kind',
  duplicate_id: 'duplicate_id',
  invalid_id: 'invalid_id',
  self_reference: 'data_cycle',
  input_cycle: 'data_cycle',
  type_mismatch: 'type_mismatch',
  group_empty: 'invalid_param',
  group_mode_conflict: 'invalid_param',
  dict_duplicate_key: 'invalid_param',
  conversion_unsupported: 'invalid_param',
  invalid_value: 'invalid_param',
  eval_failed: 'eval_failed',
  limit_exceeded: 'limit_exceeded',
  ownership_conflict: 'duplicate_placement',
  unconnected: 'missing_input',
  variable_error: 'eval_failed',
  flow_error: 'eval_failed',
  method_mismatch: 'eval_failed',
  pending: 'eval_failed',
};

function toWorkflowIssue(issue: canvas.CanvasIssue): WorkflowIssue {
  return {
    code: ISSUE_CODE_MAP[issue.code],
    severity: 'error',
    message: issue.message,
    nodeId: issue.nodeId,
  };
}

// ---------------------------------------------------------------------------
// 产物各段
// ---------------------------------------------------------------------------

/**
 * 画布生成器只产出 `block` 动作（展开由服务端做），但动作联合类型里含回退类动作
 * （`undo` / `step_back` / `reset`）。`WorkflowArtifact.actions` 不收回退类动作，所以显式滤掉：
 * 产物是**要发给服务端的动作序列**，多带一条回退动作等于替用户按了撤销。
 */
function compiledActionsOf(actions: readonly CanvasAction[]): readonly CompiledAction[] {
  return actions.filter((action): action is CompiledAction => !isControlAction(action));
}

function isControlAction(action: CanvasAction): boolean {
  return action.type === 'undo' || action.type === 'step_back' || action.type === 'reset';
}

function originsOf(steps: readonly canvas.CanvasStep[]): readonly WorkflowOrigin[] {
  const origins: WorkflowOrigin[] = [];
  for (const step of steps) {
    if (step.kind !== 'action' || step.actionIndex === null) continue;
    origins.push({
      index: step.actionIndex,
      nodeId: step.nodeId,
      path: MAIN_PATH,
      ...roundsFieldOf(step.rounds),
    });
  }
  return origins;
}

function traceOf(
  actions: readonly CanvasAction[],
  steps: readonly canvas.CanvasStep[],
): readonly CompileTraceEntry[] {
  const trace: CompileTraceEntry[] = [];
  for (const step of steps) {
    if (step.kind !== 'action') continue;
    if (trace.length >= MAX_TRACE_ENTRIES) break;
    trace.push({
      nodeId: step.nodeId,
      path: MAIN_PATH,
      message: `动作 ${actionTypeOf(actions, step.actionIndex)}`,
      ...roundsFieldOf(step.rounds),
    });
  }
  return trace;
}

/** 画布只生成 `block`；取不到动作时（理论上不会）仍按 `block` 写，不猜别的类型。 */
function actionTypeOf(actions: readonly CanvasAction[], index: number | null): string {
  const action = index === null ? undefined : actions[index];
  return action === undefined ? 'block' : action.type;
}

/** 不在任何循环里就没有这个字段：`rounds: {}` 是噪声，不是信息。 */
function roundsFieldOf(
  rounds: Readonly<Record<string, number>>,
): { readonly rounds?: Readonly<Record<string, number>> } {
  return Object.keys(rounds).length === 0 ? {} : { rounds };
}

/**
 * 编辑期预览：只收算得出来的值（`value`）和算错的原因（`error`）。
 *
 * `pending` 不产出预览——界面按「待执行」渲染，写一条空摘要反而会把「还没运行」画成「结果是空」。
 * 摘要口径复用 `previewSummary`，与画布上的就地预览保持同一句话。
 */
function previewsOf(document: canvas.CanvasDocument): readonly NodePreview[] {
  const previews: NodePreview[] = [];
  for (const [nodeId, preview] of canvas.previewCanvasDocument(document).nodes) {
    if (preview.status === 'pending') continue;
    previews.push({ nodeId, type: 'canvas', summary: canvas.previewSummary(preview) });
  }
  return previews;
}
