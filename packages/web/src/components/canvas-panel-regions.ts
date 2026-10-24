import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import {
  newNodeId,
  nodeOf,
  refuse,
  unwrapBranch,
  unwrapLoop,
  wrapInBranch,
  wrapInLoop,
  type CanvasEdit,
} from '../canvas/editor';
import { wrapTargetCaptionOf, wrapTargetOf } from './canvas-panel-wrap-target';

/**
 * 侧栏的「流程包络」入口与包络动作（需求 §6.3、验收表 AT-15）。
 *
 * 四件事：把选中集交给 `wrapTargetOf` 判定（`canvas-panel-wrap-target.ts`）、把区间交给命令层
 * （`wrapSelectionEdit`）、把结果连同选区一起落地（`applyWrapSelection`）、把按钮画出来
 * （`renderRegionActions`）。界面**不自己拼文档**：能包不能包、深度够不够，全由
 * `canvas/editor-regions` 判断，拒绝原因照原样显示，不静默失败。
 *
 * 三条产品边界写在这里，别在界面上另开口子：
 * - 包络只能包**同一条序列里连续**的语句；跨区域、跨序列或不相邻的选择直接说明原因。
 * - 包完把选区切到新容器：刚包完的人最可能想反悔，「解除」要立刻可用。
 * - 解除只有「解除循环」与「解除分支」两个按钮，没有「合并两条路径」的入口：分支按
 *   「成立分支在前、不成立分支在后」的顺序展开（顺序见 `unwrapBranch` 的注释与文案）。
 */

/** 包进哪一类容器：两个按钮、两个快捷键共用这一份动作名。 */
export type WrapKind = 'loop' | 'branch';

/** 侧栏能发出的结构变更；`InspectorChange` 把这三条并进自己的联合类型。 */
export type RegionChange =
  | { readonly kind: 'wrap-loop' }
  | { readonly kind: 'wrap-branch' }
  | { readonly kind: 'unwrap-region' };

/** 包络动作需要的最小宿主：读文档与选区、推进一次编辑、把选区切到新容器。 */
export interface WrapHost {
  currentDocument(): canvas.CanvasDocument | undefined;
  selection(): readonly string[];
  selectNodes(ids: readonly string[]): void;
  applyEdit(edit: CanvasEdit): void;
}

/** 按钮与提示里的动作名（快捷键说明也从这里取，界面不另写一份）。 */
export const WRAP_LABELS: Readonly<Record<WrapKind, string>> = {
  loop: '包进循环',
  branch: '包进条件',
};

// ---------------------------------------------------------------------------
// 选中集 → 一次编辑
// ---------------------------------------------------------------------------

/**
 * 「包进循环 / 包进条件」：区间由选中集算，容器用面板现有的 id 工厂生成。
 *
 * 次数与条件先留 `UNCONNECTED`：新容器刚建出来时一定还没接线，这是编辑期的正常状态，
 * 校验器报 `unconnected`，用户再接数据节点。
 */
export function wrapSelectionEdit(document: canvas.CanvasDocument, ids: readonly string[], kind: WrapKind): CanvasEdit {
  const target = wrapTargetOf(document, ids);
  if ('reason' in target) return refuse(document, 'flow_error', ids[0] ?? '', target.reason);
  return kind === 'loop'
    ? wrapInLoop(document, { ...target, loopId: newNodeId(document, 'loop'), count: canvas.UNCONNECTED })
    : wrapInBranch(document, { ...target, ifId: newNodeId(document, 'if'), cond: canvas.UNCONNECTED });
}

/** 包络成功后新容器的 id：文档里刚多出来的那个节点（被拒绝时文档没变，也就没有新节点）。 */
function addedNodeIdOf(before: canvas.CanvasDocument, after: canvas.CanvasDocument): string | undefined {
  const known = new Set(before.nodes.map((node) => node.id));
  return after.nodes.find((node) => !known.has(node.id))?.id;
}

/**
 * 包络的落地入口：一次可撤销编辑，成功后把选区切到新容器。
 *
 * 被拒绝时文档与选区都不动，`applyEdit` 负责把第一句原因报到顶栏（与别处一致）。
 * 按钮与键盘都走这里，于是「包完能看到解除按钮」只有一处实现。
 */
export function applyWrapSelection(host: WrapHost, kind: WrapKind): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  const edit = wrapSelectionEdit(document, host.selection(), kind);
  if (edit.document === document) {
    host.applyEdit(edit);
    return;
  }
  const created = addedNodeIdOf(document, edit.document);
  host.applyEdit(edit);
  if (created !== undefined) host.selectNodes([created]);
}

/** 「解除」：只对循环与条件分支生效，别的节点没有可展开的区域，返回 `undefined`。 */
export function unwrapEditOf(document: canvas.CanvasDocument, nodeId: string): CanvasEdit | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'loop') return unwrapLoop(document, nodeId);
  if (node.kind === 'if') return unwrapBranch(document, nodeId);
  return undefined;
}

// ---------------------------------------------------------------------------
// 侧栏渲染
// ---------------------------------------------------------------------------

/** 侧栏「流程包络」块的输入：文档与当前选中集，渲染层不自己判断能不能包。 */
export interface RegionActionsInput {
  readonly document: canvas.CanvasDocument;
  readonly selection: readonly string[];
  readonly onChange: (change: RegionChange) => void;
}

/**
 * 侧栏里的流程包络块。
 *
 * 三档：选中的是循环 / 条件分支时给「解除」；其余流程语句给「包进循环 / 包进条件」，
 * 能不能点由 `wrapTargetOf` 判定，禁用时把同一句原因同时放进 `title` 与块底提示。
 * 单个数据节点不给这个块（它没有流程入口）；多选里含数据节点则禁用并说明原因。
 */
export function renderRegionActions(input: RegionActionsInput): TemplateResult | typeof nothing {
  if (input.selection.length === 0) return nothing;
  const only = singleNodeOf(input.document, input.selection);
  if (only !== undefined) {
    if (only.kind === 'loop') return renderLoopUnwrap(input.onChange);
    if (only.kind === 'if') return renderBranchUnwrap(input.onChange);
    if (!canvas.isFlowNode(only)) return nothing;
  }
  return renderWrapActions(input);
}

/** 单选时那一个节点；多选没有「当前节点」这个概念（转换包络块也用这同一份判定）。 */
export function singleNodeOf(
  document: canvas.CanvasDocument,
  selection: readonly string[],
): canvas.CanvasNode | undefined {
  return selection.length === 1 ? nodeOf(document, selection[0]) : undefined;
}

/** 循环上的「解除」：展开后循环体接回原位置，循环节点消失。 */
function renderLoopUnwrap(onChange: (change: RegionChange) => void): TemplateResult {
  return html`<div class="block">
    <h4>流程包络</h4>
    <button class="mini btn-unwrap-loop" @click=${() => onChange({ kind: 'unwrap-region' })}>解除循环</button>
    <p class="hint">循环体按原顺序接回循环所在的位置，循环节点消失。</p>
  </div>`;
}

/** 分支上的「解除」：说明里必须写清展开顺序，避免被读成「合并两条路径」。 */
function renderBranchUnwrap(onChange: (change: RegionChange) => void): TemplateResult {
  return html`<div class="block">
    <h4>流程包络</h4>
    <button class="mini btn-unwrap-branch" @click=${() => onChange({ kind: 'unwrap-region' })}>解除分支</button>
    <p class="hint">成立分支在前、不成立分支在后，依次接回原位置；这是顺序展开，不是把两条路径合并。</p>
  </div>`;
}

/** 包络按钮：禁用与可用只差 `disabled` 和同一条 `detail`（位置说明或原因）。 */
function renderWrapActions(input: RegionActionsInput): TemplateResult {
  const target = wrapTargetOf(input.document, input.selection);
  const blocked = 'reason' in target;
  const detail = blocked ? target.reason : wrapTargetCaptionOf(input.document, target);
  const hint = blocked ? `不能包进区域：${detail}` : `${detail}；包进后原位置留下新容器，语句按原顺序进新区域。`;
  return html`<div class="block">
    <h4>流程包络</h4>
    <button
      class="mini btn-wrap-loop"
      ?disabled=${blocked}
      title=${`${WRAP_LABELS.loop}：${detail}`}
      @click=${() => input.onChange({ kind: 'wrap-loop' })}
    >包进循环</button>
    <button
      class="mini btn-wrap-branch"
      ?disabled=${blocked}
      title=${`${WRAP_LABELS.branch}：${detail}`}
      @click=${() => input.onChange({ kind: 'wrap-branch' })}
    >包进条件</button>
    <p class="hint">${hint}</p>
  </div>`;
}
