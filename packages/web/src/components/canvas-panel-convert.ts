import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import {
  newNodeId,
  unwrapConversion,
  wrapInConversion,
  type CanvasEdit,
  type WrapConversionResult,
} from '../canvas/editor';
import { singleNodeOf } from './canvas-panel-regions';
import { convertWrapCaptionOf, convertWrapTargetOf } from './canvas-panel-wrap-target';

/**
 * 侧栏的「转换包络」入口（需求 §4.1、§6.3，验收表 AT-14）。
 *
 * 三件事：把选中集交给 `convertWrapTargetOf` 判定（`canvas-panel-wrap-target.ts`）、
 * 把结果落到命令层（`wrapInConversion` / `unwrapConversion`）、把按钮画出来（`renderConvertActions`）。
 * 界面**不自己拼文档**：能不能包、包完连接接到哪，全由 `canvas/editor-convert` 判断，
 * 拒绝原因照原样报到顶栏，不静默失败。
 *
 * 三条产品边界写在这里，别在界面上另开口子：
 * - 「包络为转换」作用在**整段数据选区**上：多成员时命令层先合成组合，组合就是整体结果。
 * - 包完把选区切到新转换节点：刚包完的人最可能想反悔，「解除转换」要立刻可用。
 * - 「解除转换」只删转换与它的包络，内部结构（组合与成员）原样留下。
 */

/** 侧栏能发出的转换结构变更；`InspectorChange` 把这两条并进自己的联合类型。 */
export type ConvertChange =
  | { readonly kind: 'wrap-convert' }
  | { readonly kind: 'unwrap-convert' };

/** 转换动作需要的最小宿主：读文档与选区、推进一次编辑、把选区切到新转换节点。 */
export interface ConvertHost {
  currentDocument(): canvas.CanvasDocument | undefined;
  selection(): readonly string[];
  selectNodes(ids: readonly string[]): void;
  applyEdit(edit: CanvasEdit): void;
  report(message: string | undefined): void;
}

/** 按钮与提示里的动作名（只在渲染与提示里用，界面不另写一份）。 */
export const CONVERT_LABELS = {
  wrap: '包络为转换',
  unwrap: '解除转换',
} as const;

// ---------------------------------------------------------------------------
// 一次编辑
// ---------------------------------------------------------------------------

/**
 * 「包络为转换」：id 缺省由面板现有的 id 工厂生成，于是包完能直接把选区切到它。
 *
 * 被拒绝时文档不变，只把命令层那句话交回来（`message` 与 `edit.issues` 说的是同一件事）。
 */
export function wrapConvertEdit(
  document: canvas.CanvasDocument,
  ids: readonly string[],
  convertId: string = newNodeId(document, 'convert'),
): WrapConversionResult {
  return wrapInConversion(document, ids, convertId);
}

/** 一次可撤销编辑：成功就把选区切到新转换节点，被拒绝就把原因报到顶栏。 */
export function applyConvertChange(host: ConvertHost, change: ConvertChange): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  if (change.kind === 'unwrap-convert') {
    unwrapSelected(host, document);
    return;
  }
  const convertId = newNodeId(document, 'convert');
  const result = wrapConvertEdit(document, host.selection(), convertId);
  if (result.message !== undefined) {
    host.report(result.message);
    return;
  }
  host.applyEdit(result.edit);
  host.selectNodes([convertId]);
}

/** 「解除转换」：只对选中的第一个节点生效；它不是转换时由命令层给出原因。 */
function unwrapSelected(host: ConvertHost, document: canvas.CanvasDocument): void {
  const convertId = host.selection()[0];
  if (convertId === undefined) {
    host.report('先选中一个转换包络再解除');
    return;
  }
  host.applyEdit(unwrapConversion(document, convertId));
}

// ---------------------------------------------------------------------------
// 侧栏渲染
// ---------------------------------------------------------------------------

/** 侧栏「转换包络」块的输入：文档与当前选中集，渲染层不自己判断能不能包。 */
export interface ConvertActionsInput {
  readonly document: canvas.CanvasDocument;
  readonly selection: readonly string[];
  readonly onChange: (change: ConvertChange) => void;
}

/**
 * 侧栏里的转换包络块。
 *
 * 三档：选中的是转换节点时给「解除转换」；选中的是数据节点（含多选）时给「包络为转换」，
 * 能不能点由 `convertWrapTargetOf` 判定，禁用时把同一句原因同时放进 `title` 与块底提示；
 * 单选的其它节点（流程语句、声明）不给这个块——它们没有转换入口。
 */
export function renderConvertActions(input: ConvertActionsInput): TemplateResult | typeof nothing {
  if (input.selection.length === 0) return nothing;
  const only = singleNodeOf(input.document, input.selection);
  if (only !== undefined) {
    if (only.kind === 'convert') return renderConvertUnwrap(input.onChange);
    if (!canvas.isValueNode(only)) return nothing;
  }
  return renderConvertWrap(input);
}

/** 转换节点上的「解除」：说明里写清内部结构会留下，避免被读成「连组合一起删」。 */
function renderConvertUnwrap(onChange: (change: ConvertChange) => void): TemplateResult {
  return html`<div class="block">
    <h4>转换包络</h4>
    <button class="mini btn-unwrap-convert" @click=${() => onChange({ kind: 'unwrap-convert' })}>解除转换</button>
    <p class="hint">只删掉转换与它的包络，内部结构（组合与成员）原样留下；原来接转换结果的连接会改接回内部结果，没有内部结果时断开。</p>
  </div>`;
}

/** 包络按钮：禁用与可用只差 `disabled` 和同一条 `detail`（选区说明或原因）。 */
function renderConvertWrap(input: ConvertActionsInput): TemplateResult {
  const target = convertWrapTargetOf(input.document, input.selection);
  const blocked = 'reason' in target;
  const detail = blocked ? target.reason : convertWrapCaptionOf(target);
  const hint = blocked
    ? `不能包成转换：${detail}`
    : `${detail}；原来接整体结果的连接会改接到转换结果，类型不匹配由校验标出。`;
  return html`<div class="block">
    <h4>转换包络</h4>
    <button
      class="mini btn-wrap-convert"
      ?disabled=${blocked}
      title=${`${CONVERT_LABELS.wrap}：${detail}`}
      @click=${() => input.onChange({ kind: 'wrap-convert' })}
    >包络为转换</button>
    <p class="hint">${hint}</p>
  </div>`;
}
