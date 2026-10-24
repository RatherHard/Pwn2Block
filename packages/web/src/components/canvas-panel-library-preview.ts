import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { createMethodNode, createNode } from '../canvas/catalog';
import { layoutCanvas } from '../canvas/view-model';
import type { CanvasBox, CanvasLayoutView } from '../canvas/view-model';
import { relationToneOf } from './canvas-panel-geometry';
import type { LibraryItem } from './canvas-panel-library-model';

/**
 * 节点库的预览区：悬停或聚焦一个条目，就画出「放到画布上会是什么样」。
 *
 * 预览**不另写一份外观**：用同一个 `createNode` 造默认节点、同一个 `layoutCanvas` 算标题、行与端口，
 * 所以预览与画布上的真节点不会对不上。区别只在排版：这里是静态的小卡片，不定位、不响应拖动。
 *
 * 最下面一行说明它属于哪一类用法（流程语句 / 数据），因为这是新手最容易放错的地方：
 * 流程语句要排进步骤，数据节点要接到端口上。
 */

/** 预览用的探针 id：只在这一次布局里出现，不进任何文档。 */
const PREVIEW_ID = 'preview';

/** 预览区；没有悬停条目时给一行操作提示。 */
export function renderLibraryPreview(
  item: LibraryItem | undefined,
  blocks: readonly AuthorBlock[] | undefined,
  methods: readonly canvas.CanvasMethodDecl[],
): TemplateResult {
  if (item === undefined) {
    return html`<section class="library-preview" aria-label="节点预览">
      <p class="hint">悬停或聚焦一项查看预览；点击放到空位，拖动放到松手处。</p>
    </section>`;
  }
  const node = previewNodeOf(item, blocks);
  const view = layoutCanvas({ document: previewDocumentOf(node), methods });
  return html`<section class="library-preview" aria-label="节点预览" data-preview=${item.key}>
    <div class="preview-head">预览 · ${item.label}</div>
    <div class="preview-figure">${renderPorts(view)} ${renderFigure(node, view)}</div>
    <p class="preview-desc">${item.description}</p>
    <p class="preview-usage">${usageOf(node)}</p>
  </section>`;
}

/** 条目对应的默认节点：题目方法直接选好方法、参数齐全。 */
function previewNodeOf(item: LibraryItem, blocks: readonly AuthorBlock[] | undefined): canvas.CanvasNode {
  const block = item.blockId === undefined ? undefined : blocks?.find((entry) => entry.id === item.blockId);
  return block === undefined ? createNode(item.nodeKind, PREVIEW_ID) : createMethodNode(PREVIEW_ID, block);
}

function previewDocumentOf(node: canvas.CanvasNode): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes: [node], layout: { [PREVIEW_ID]: { x: 0, y: 0 } }, main: [] };
}

/** 左侧一列输入端口：小方框 + 端口名，与画布上「端口在盒外」同一个意思。 */
function renderPorts(view: CanvasLayoutView): TemplateResult | typeof nothing {
  const ports = view.ports.filter((port) => port.nodeId === PREVIEW_ID);
  if (ports.length === 0) return nothing;
  return html`<ul class="preview-ports" aria-label="输入端口">
    ${ports.map((port) => html`<li><span class="preview-port"></span>${port.label}</li>`)}
  </ul>`;
}

/** 白框节点画标题与行；运算类画成带标号的彩色小方框。 */
function renderFigure(node: canvas.CanvasNode, view: CanvasLayoutView): TemplateResult {
  const relation = boxOf(view, 'relation');
  if (relation !== undefined) {
    return html`<div class=${`preview-relation cat-${relationToneOf(node)}`} title=${relation.title}>
      ${symbolOf(node, relation)}
    </div>`;
  }
  const box = boxOf(view, 'node');
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

/** 用法提示：流程语句排进步骤，数据节点接到端口；声明与引用单独说。 */
function usageOf(node: canvas.CanvasNode): string {
  if (node.kind === 'start') return '流程入口：每份程序只有一个，固定在第一步';
  if (canvas.isFlowNode(node)) return '流程语句：拖到流程线上排进步骤';
  if (node.kind === 'var-decl') return '变量声明：在侧栏选类型和初值';
  return '数据：把它的输出接到需要它的端口上';
}
