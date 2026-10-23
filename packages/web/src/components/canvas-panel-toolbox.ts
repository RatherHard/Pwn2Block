import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import { CANVAS_CATALOG, CANVAS_CATEGORY_LABELS } from '../canvas/catalog';
import type { CanvasNodeCategory, CanvasNodeSpec } from '../canvas/catalog';

/**
 * 工具箱、顶栏与状态计数（需求 §6.2、§10 任务第 10 条）。
 *
 * 工具箱的顺序**就是目录顺序**：同一个分类连续排（`CANVAS_CATALOG` 的注释锁住了这一点），
 * 这里只按「分类第一次出现」分组，不重排、不筛选，所以界面顺序与 `catalog.ts` 不会漂移。
 *
 * 计数口径有一条容易搞错的地方：`unconnected`（未接线）是编辑期的正常状态，
 * **不算错误**，单独显示成「未接线 N 处」。否则刚拖出一个节点满屏飘红，用户会以为画布坏了。
 */

/** 工具箱里的一组：分类 + 该分类的节点描述。 */
export interface ToolboxGroup {
  readonly category: CanvasNodeCategory;
  readonly label: string;
  readonly specs: readonly CanvasNodeSpec[];
}

/** 按目录顺序分组；分类只在第一次出现的位置建组，所以组顺序同样等于目录顺序。 */
export function toolboxGroups(catalog: readonly CanvasNodeSpec[] = CANVAS_CATALOG): readonly ToolboxGroup[] {
  const groups: { category: CanvasNodeCategory; label: string; specs: CanvasNodeSpec[] }[] = [];
  for (const spec of catalog) {
    const group = groups.find((item) => item.category === spec.category);
    if (group === undefined) {
      groups.push({ category: spec.category, label: CANVAS_CATEGORY_LABELS[spec.category], specs: [spec] });
      continue;
    }
    group.specs.push(spec);
  }
  return groups;
}

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

/** 工具箱的三种动作：加目录节点、加变量、引用变量（需求 §10 任务第 10 条）。 */
export interface ToolboxHandlers {
  readonly onAdd: (kind: canvas.CanvasNodeKind) => void;
  readonly onAddVariable: () => void;
  readonly onAddReference: () => void;
}

/** 分组工具箱；点一项 = 在空位加一个该种类的默认节点。 */
export function renderToolbox(handlers: ToolboxHandlers): TemplateResult {
  return html`<aside class="toolbox" aria-label="工具箱">
    <div class="toolbox-actions">
      <button class="btn-add-variable" @click=${handlers.onAddVariable}>加变量</button>
      <button class="btn-add-reference" @click=${handlers.onAddReference}>引用变量</button>
    </div>
    ${toolboxGroups().map(
      (group) => html`<div class="toolbox-group" data-category=${group.category}>
        <h3>${group.label}</h3>
        ${group.specs.map(
          (spec) => html`<button
            class="tool"
            data-kind=${spec.kind}
            title=${spec.description}
            @click=${() => handlers.onAdd(spec.kind)}
          >
            ${spec.label}
          </button>`,
        )}
      </div>`,
    )}
  </aside>`;
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
