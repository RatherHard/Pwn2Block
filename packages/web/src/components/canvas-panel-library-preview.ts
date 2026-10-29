import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { createMethodNode, createNode } from '../canvas/catalog';
import { layoutCanvas } from '../canvas/view-model';
import type { CanvasBox, CanvasLayoutView } from '../canvas/view-model';
import { relationToneOf } from './canvas-panel-geometry';
import type { LibraryItem } from './canvas-panel-library-model';

/** 每个节点库条目常驻预览，标题与数据行复用画布视图模型。 */

/** 预览用的探针 id：只在这一次布局里出现，不进任何文档。 */
const PREVIEW_ID = 'preview';

/** 预览与选项一起显示。 */
export function renderLibraryPreview(
  item: LibraryItem | undefined,
  blocks: readonly AuthorBlock[] | undefined,
  methods: readonly canvas.CanvasMethodDecl[],
): TemplateResult {
  if (item === undefined) {
    return html`<span class="library-preview" aria-label="节点预览">
      <p class="hint">点击放到空位，或拖动放到画布。</p>
    </span>`;
  }
  const node = previewNodeOf(item, blocks);
  const view = layoutCanvas({ document: previewDocumentOf(node), methods });
  return html`<span class="library-preview" aria-label="节点预览" data-preview=${item.key}>
    <div class="preview-head">预览 · ${item.label}</div>
    <div class="preview-figure">${renderFigure(node, view)}</div>
    <p class="preview-desc">${item.description}</p>
    <p class="preview-usage">${usageOf(node)}</p>
  </span>`;
}

/** 条目对应的默认节点：题目方法直接选好方法、参数齐全。 */
function previewNodeOf(item: LibraryItem, blocks: readonly AuthorBlock[] | undefined): canvas.CanvasNode {
  const block = item.blockId === undefined ? undefined : blocks?.find((entry) => entry.id === item.blockId);
  return block === undefined ? createNode(item.nodeKind, PREVIEW_ID) : createMethodNode(PREVIEW_ID, block);
}

function previewDocumentOf(node: canvas.CanvasNode): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes: [node], layout: { [PREVIEW_ID]: { x: 0, y: 0 } }, main: [] };
}

/** 白框节点画标题与行；运算类画成带标号的彩色小方框。 */
function renderFigure(node: canvas.CanvasNode, view: CanvasLayoutView): TemplateResult {
  const relation = boxOf(view, 'relation');
  if (relation !== undefined) {
    return html`<div class=${`preview-relation cat-${relationToneOf(node)}`} title=${relation.title}>
      ${symbolOf(node, relation)}
    </div>`;
  }
  const box = boxOf(view, 'node') ?? boxOf(view, 'group');
  const rows = view.rowsByNode.get(PREVIEW_ID) ?? [];
  return html`<div class=${`preview-node tone-${box?.tone ?? 'data'}`}>
    <div class="preview-title">${box?.title ?? ''}</div>
    ${rows.map(
      (row) => html`<div class="preview-row">
        <span class="row-label">${row.label}</span><span class="row-value">${row.value}</span>
      </div>`,
    )}
  </div>`;
}

function boxOf(view: CanvasLayoutView, kind: CanvasBox['kind']): CanvasBox | undefined {
  return view.boxes.find((box) => box.nodeId === PREVIEW_ID && box.kind === kind);
}

/** 关系方框里的标号：与画布同一口径（二元/一元给符号，转换给转换名）。 */
function symbolOf(node: canvas.CanvasNode, box: CanvasBox): string {
  if (node.kind === 'relation') return canvas.binaryOperatorSpec(node.op).symbol;
  if (node.kind === 'unary') return canvas.unaryOperatorSpec(node.op).symbol;
  return box.title;
}

/** 用法提示：流程语句排进步骤，数据节点吸附建立关系；声明与引用单独说。 */
function usageOf(node: canvas.CanvasNode): string {
  if (node.kind === 'start') return '流程入口：每份程序只有一个，固定在第一步';
  if (canvas.isFlowNode(node)) return '流程语句：拖到流程线上排进步骤';
  if (node.kind === 'var-decl') return '变量声明：在侧栏选类型和初值';
  return '数据：拖近同类节点建立关系，选中后在侧栏配置';
}
