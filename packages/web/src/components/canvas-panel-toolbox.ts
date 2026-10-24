import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';

/**
 * 顶栏与状态计数（需求 §6.2）。左侧节点库在 `canvas-panel-library.ts`。
 *
 * 计数口径有一条容易搞错的地方：`unconnected`（未接线）是编辑期的正常状态，
 * **不算错误**，单独显示成「未接线 N 处」。否则刚拖出一个节点满屏飘红，用户会以为画布坏了。
 */

/** 顶栏右侧的三个计数。 */
export interface StatusCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly unconnected: number;
}

/**
 * 从校验结果算计数。
 *
 * 校验是纯函数，每次渲染算一遍即可（一份文档的节点数是有限的，编辑期不需要缓存失效策略）。
 * `unconnected` 不计入 `errors`，理由见文件头。
 */
export function statusCountsOf(
  document: canvas.CanvasDocument,
  methods: readonly canvas.CanvasMethodDecl[],
): StatusCounts {
  const issues = canvas.validateCanvasDocument(document, { methods }).issues;
  let errors = 0;
  let warnings = 0;
  let unconnected = 0;
  for (const issue of issues) {
    if (issue.code === 'unconnected') {
      unconnected += 1;
      continue;
    }
    if (issue.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings, unconnected };
}

/** 顶栏按钮与计数。按钮顺序：撤销、重做、删除、成组、解除组合、导出、运行，最后是计数。 */
export interface TopBarInput {
  readonly counts: StatusCounts;
  readonly revision: number;
  readonly message: string | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onDelete: () => void;
  readonly onGroup: () => void;
  readonly onDissolve: () => void;
  readonly onExport: () => void;
  readonly onRun: () => void;
}

export function renderTopBar(input: TopBarInput): TemplateResult {
  return html`<header class="top">
    <button class="btn-undo" ?disabled=${!input.canUndo} @click=${input.onUndo}>撤销</button>
    <button class="btn-redo" ?disabled=${!input.canRedo} @click=${input.onRedo}>重做</button>
    <button class="btn-delete" @click=${input.onDelete}>删除选中</button>
    <button class="btn-group" @click=${input.onGroup}>成组</button>
    <button class="btn-dissolve" @click=${input.onDissolve}>解除组合</button>
    <button class="btn-export" @click=${input.onExport}>导出存档</button>
    <button class="btn-run" @click=${input.onRun}>运行</button>
    <span class="spacer"></span>
    ${renderStatus(input.counts, input.revision)}
    ${input.message === undefined ? nothing : html`<div class="message">${input.message}</div>`}
  </header>`;
}

function renderStatus(counts: StatusCounts, revision: number): TemplateResult {
  return html`<div class="status">
    <span class="status-error">错误 ${counts.errors}</span>
    <span class="status-warn">警告 ${counts.warnings}</span>
    <span class="status-unconnected">未接线 ${counts.unconnected} 处</span>
    <span class="status-revision">修订 ${revision}</span>
  </div>`;
}
