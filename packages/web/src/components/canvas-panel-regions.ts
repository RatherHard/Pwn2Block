import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import {
  newNodeId,
  refuse,
  regionOfId,
  regionSequenceOf,
  unwrapBranch,
  unwrapLoop,
  wrapInBranch,
  wrapInLoop,
  type CanvasEdit,
} from '../canvas/editor';

/**
 * 侧栏的「流程包络」入口（需求 §6.3、验收表 AT-15）。
 *
 * 三件事：把选中集算成一段连续区间（`regionSpanOf`）、把区间交给命令层
 * （`wrapSelectionEdit` / `unwrapEditOf`）、把三个按钮画出来（`renderRegionActions`）。
 * 界面**不自己拼文档**：能包不能包、深度够不够，全由 `canvas/editor-regions` 判断，
 * 拒绝原因照原样显示，不静默失败。
 *
 * 两条产品边界写在这里，别在界面上另开口子：
 * - 包络只能包**同一条序列里连续**的语句；跨区域或不相邻的选择直接说明原因。
 * - 解除只有「解除循环」与「解除分支」两个按钮，没有「合并两条路径」的入口：分支按
 *   「成立分支在前、不成立分支在后」的顺序展开（顺序见 `unwrapBranch` 的注释与文案）。
 */

/** 侧栏能发出的结构变更；`InspectorChange` 把这三条并进自己的联合类型。 */
export type RegionChange =
  | { readonly kind: 'wrap-loop' }
  | { readonly kind: 'wrap-branch' }
  | { readonly kind: 'unwrap-region' };

/** 选中集算出来的一段连续区间；不满足条件时只有一句中文原因。 */
export type RegionSpan =
  | { readonly ok: true; readonly region: canvas.FlowRegionRef; readonly from: number; readonly to: number }
  | { readonly ok: false; readonly message: string };

/** 选中集 → 一段连续区间：必须都是流程语句、都在同一条序列里、并且相邻。 */
export function regionSpanOf(document: canvas.CanvasDocument, ids: readonly string[]): RegionSpan {
  if (ids.length === 0) return { ok: false, message: '先选中一条要包起来的流程语句' };
  const regions: canvas.FlowRegionRef[] = [];
  const positions: number[] = [];
  for (const id of ids) {
    const node = document.nodes.find((item) => item.id === id);
    if (node === undefined) return { ok: false, message: `选中的「${id}」不在文档里` };
    if (!canvas.isFlowNode(node)) {
      return { ok: false, message: `「${id}」是数据节点，只有流程语句能包进循环或条件分支` };
    }
    const region = regionOfId(document, id);
    const sequence = region === undefined ? undefined : regionSequenceOf(document, region);
    const index = sequence === undefined ? -1 : sequence.indexOf(id);
    if (region === undefined || index < 0) {
      return { ok: false, message: `「${id}」还没排进任何流程序列，先把它放进流程再包` };
    }
    regions.push(region);
    positions.push(index);
  }
  const head = regions[0];
  if (!regions.every((item) => item.ownerId === head.ownerId && item.kind === head.kind)) {
    return { ok: false, message: '选中的语句不在同一条序列里：一次只包同一区域的连续语句' };
  }
  const from = Math.min(...positions);
  const to = Math.max(...positions);
  if (to - from + 1 !== positions.length) {
    return { ok: false, message: '选中的语句在序列里不相邻：一次只包连续的一段' };
  }
  return { ok: true, region: head, from, to };
}

/**
 * 「包进循环 / 包进条件」：区间由选中集算，容器用一个新的空 id。
 *
 * 次数与条件先留 `UNCONNECTED`：新容器刚建出来时一定还没接线，这是编辑期的正常状态，
 * 校验器报 `unconnected`，用户再接数据节点。
 */
export function wrapSelectionEdit(
  document: canvas.CanvasDocument,
  ids: readonly string[],
  kind: 'loop' | 'branch',
): CanvasEdit {
  const span = regionSpanOf(document, ids);
  if (!span.ok) return refuse(document, 'flow_error', ids[0] ?? '', span.message);
  const at = { ownerId: span.region.ownerId, kind: span.region.kind, from: span.from, to: span.to };
  return kind === 'loop'
    ? wrapInLoop(document, { ...at, loopId: newNodeId(document, 'loop'), count: canvas.UNCONNECTED })
    : wrapInBranch(document, { ...at, ifId: newNodeId(document, 'if'), cond: canvas.UNCONNECTED });
}

/** 「解除」：只对循环与条件分支生效，别的节点没有可展开的区域，返回 `undefined`。 */
export function unwrapEditOf(document: canvas.CanvasDocument, nodeId: string): CanvasEdit | undefined {
  const node = document.nodes.find((item) => item.id === nodeId);
  if (node === undefined) return undefined;
  if (node.kind === 'loop') return unwrapLoop(document, nodeId);
  if (node.kind === 'if') return unwrapBranch(document, nodeId);
  return undefined;
}

/**
 * 侧栏里的流程包络块：语句上给两个「包进…」，循环与分支上给「解除」。
 *
 * 开始节点不给包入口：它必须是流程第一步，包进任何区域都会立刻违反这条结构规则。
 */
export function renderRegionActions(
  node: canvas.CanvasNode,
  onChange: (change: RegionChange) => void,
): TemplateResult | typeof nothing {
  if (node.kind === 'loop') {
    return html`<div class="block">
      <h4>流程包络</h4>
      <button class="mini btn-unwrap-loop" @click=${() => onChange({ kind: 'unwrap-region' })}>解除循环</button>
      <p class="hint">循环体按原顺序接回循环所在的位置，循环节点消失。</p>
    </div>`;
  }
  if (node.kind === 'if') {
    return html`<div class="block">
      <h4>流程包络</h4>
      <button class="mini btn-unwrap-branch" @click=${() => onChange({ kind: 'unwrap-region' })}>解除分支</button>
      <p class="hint">成立分支在前、不成立分支在后，依次接回原位置；这是顺序展开，不是把两条路径合并。</p>
    </div>`;
  }
  if (!canvas.isFlowNode(node) || node.kind === 'start') return nothing;
  return html`<div class="block">
    <h4>流程包络</h4>
    <button class="mini btn-wrap-loop" @click=${() => onChange({ kind: 'wrap-loop' })}>包进循环</button>
    <button class="mini btn-wrap-branch" @click=${() => onChange({ kind: 'wrap-branch' })}>包进条件</button>
    <p class="hint">选中的语句从原序列移进新区域，原位置留下容器。</p>
  </div>`;
}
