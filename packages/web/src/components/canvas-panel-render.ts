import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type {
  CanvasBox,
  CanvasFlowPortView,
  CanvasLayoutView,
  CanvasRow,
  Rect,
} from '../canvas/view-model';
import { orthogonalPath, relationToneOf, surfaceSizeOf } from './canvas-panel-geometry';

/**
 * 画布的渲染层（需求 §6.1）。
 *
 * 只做「把视图模型翻译成 DOM」：坐标、尺寸、标题、行、端口、连线全部来自 `CanvasLayoutView`，
 * 这里一个数都不自己算（除了给 SVG 定画布大小）。这样「盒子的位置」只有 `view-model` 一份答案，
 * 渲染层改样式不会把命中测试和连线端点带偏。
 *
 * 事件全部走**委托**：盒子、端口、组合标题只写 `data-*`，真正的处理在面板外壳与交互模块里。
 * 于是渲染函数是纯的（给定状态必然给出同一份模板），也就能脱离浏览器读结构。
 */

/** 渲染一层需要的全部状态。 */
export interface StageState {
  readonly document: canvas.CanvasDocument;
  readonly view: CanvasLayoutView;
  readonly selection: readonly string[];
  readonly marquee: Rect | undefined;
}

/** SVG 里两类连线各自的箭头；数据边用地址灰、流程边用栈青，与线色一致。 */
const ARROW_IDS: Readonly<Record<'data' | 'flow', string>> = {
  data: 'p2b-canvas-arrow-data',
  flow: 'p2b-canvas-arrow-flow',
};

/** 箭头颜色与 `.edge-*` 同源：都引 token，不在这里另写一份十六进制。 */
const ARROW_FILLS: Readonly<Record<'data' | 'flow', string>> = {
  data: 'var(--p2b-addr)',
  flow: 'var(--p2b-stack)',
};

/** 整张画布：连线层 → 包络 → 盒子 → 外置流程连接点 → 框选层。 */
export function renderStage(state: StageState): TemplateResult {
  const size = surfaceSizeOf(state.view.boxes);
  return html`<div class="surface" style=${`width:${size.width}px;height:${size.height}px`}>
    ${renderEdges(state, size)}
    ${state.view.boxes.map((box) => renderBox(box, state))}
    ${state.view.flowPorts.filter(isFlowPortConnected).map(renderFlowPort)}
    ${renderMarquee(state.marquee)}
  </div>`;
}

// ---------------------------------------------------------------------------
// 连线
// ---------------------------------------------------------------------------

function renderEdges(state: StageState, size: { readonly width: number; readonly height: number }): TemplateResult {
  return html`<svg class="edges" width=${size.width} height=${size.height} viewBox=${`0 0 ${size.width} ${size.height}`}>
    <defs>
      <marker id=${ARROW_IDS.data} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" fill=${ARROW_FILLS.data}></path>
      </marker>
      <marker id=${ARROW_IDS.flow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" fill=${ARROW_FILLS.flow}></path>
      </marker>
    </defs>
    ${state.view.edges.map(
      (edge) =>
        html`<path
          class=${`edge edge-${edge.kind}`}
          d=${orthogonalPath(edge)}
          marker-end=${`url(#${ARROW_IDS[edge.kind]})`}
        ></path>`,
    )}
  </svg>`;
}

// ---------------------------------------------------------------------------
// 盒子
// ---------------------------------------------------------------------------

function renderBox(box: CanvasBox, state: StageState): TemplateResult {
  if (box.kind === 'group') return renderGroupBox(box);
  if (box.kind === 'envelope') return renderEnvelopeBox(box);
  if (box.kind === 'relation') return renderRelationBox(box, state);
  return renderNodeBox(box, state);
}

/**
 * 标题栏左侧的分类标签：颜色之外再写出类别名，满足「不能只靠颜色区分」。
 * 标签在 `.title` 之外，`.title` 的文本仍然只有节点名（单测与浏览器回归按它找）。
 */
const TONE_LABELS: Readonly<Record<CanvasBox['tone'], string>> = {
  data: '数据',
  variable: '变量',
  flow: '流程',
  convert: '转换',
  method: '方法',
};

/** 白色边框节点：标题栏带分类标签，数据行只读展示。 */
function renderNodeBox(box: CanvasBox, state: StageState): TemplateResult {
  const rows = state.view.rowsByNode.get(box.nodeId) ?? [];
  return html`<div
    class=${classesOf(['node-box', `tone-${box.tone}`, selectionClass(box, state)])}
    data-node=${box.nodeId}
    style=${rectStyle(box)}
  >
    <div class="title-bar" data-group-title=${['loop', 'if'].includes(nodeOfNodeId(state.document, box.nodeId)?.kind ?? '') ? box.nodeId : nothing}>
      <span class="tone-tag">${TONE_LABELS[box.tone]}</span>
      <div class="title" title=${box.title}>${box.title}</div>
    </div>
    ${box.subtitle === undefined ? nothing : html`<div class="subtitle">${box.subtitle}</div>`}
    ${rows.map((row, index) => renderRow(box.nodeId, row, index))}
  </div>`;
}

/** 只读数据行：左标签右值，配置统一在侧栏完成。 */
function renderRow(
  nodeId: string,
  row: CanvasRow,
  index: number,
): TemplateResult {
  return html`<div class=${row.severity === 'error' ? 'row row-error' : 'row'} data-row=${index} data-node=${nodeId} title=${`${row.label}：${row.value}`}>
    <span class="row-label">${row.label}</span><span class="row-value">${row.value}</span>
  </div>`;
}

/** 关系方框：彩色小方框 + 标号，悬停给完整文案，点击切换运算（需求 §6.1）。 */
function renderRelationBox(box: CanvasBox, state: StageState): TemplateResult {
  const node = nodeOfNodeId(state.document, box.nodeId);
  const tone = node?.kind === 'group' ? 'compare' : node === undefined ? 'arith' : relationToneOf(node);
  const text = node === undefined ? box.title : relationTextOf(node, box);
  return html`<div
    class=${classesOf(['relation-box', `cat-${tone}`, selectionClass(box, state)])}
    role="button" tabindex="0" aria-label=${relationTitleOf(node, box)}
    @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (event.currentTarget as HTMLElement).click(); } }}
    data-relation=${box.nodeId}
    data-group-title=${node?.kind === 'convert' ? box.nodeId : nothing}
    style=${rectStyle(box)}
    title=${`${relationTitleOf(node, box)}（点击切换运算）`}
  >
    ${text}
  </div>`;
}

/** 组合包络：实线框 + 可拖动的标题（拖标题 = 整组移动，需求 §6.2）。 */
function renderGroupBox(box: CanvasBox): TemplateResult {
  const subtitle = box.subtitle === undefined ? '' : ` · ${box.subtitle}`;
  return html`<div class="group-box" data-group=${box.nodeId} style=${rectStyle(box)}>
    <div class="group-title" data-group-title=${box.nodeId} title="拖动包络可整体移动，点击在侧栏编辑">
      ${`${box.title}${subtitle}`}
    </div>
  </div>`;
}

/** 转换包络：只画虚线框与标题，内部结构照常画在上面。 */
function renderEnvelopeBox(box: CanvasBox): TemplateResult {
  return html`<div class="envelope-box" data-envelope=${box.nodeId} style=${rectStyle(box)}>
    <div class="envelope-title" data-group-title=${box.nodeId}>包络</div>
  </div>`;
}

/**
 * 端口小方框：已接线实心、未接线空心（需求 §6.1「连接点在节点外部」）。
 * 平时是低调的灰框，所在节点被选中时提亮（`active`）——要拉线的时候才需要看清它。
 */
/** 流程连接点只画已接线的那一端：序列首步没有入口、末步没有出口，画出来就是悬空的小方框。 */
function isFlowPortConnected(port: CanvasFlowPortView): boolean {
  return port.connected;
}

/**
 * 流程连接点小方框（需求 §6.1「外置流程连接点」）。
 *
 * 它是**只读装饰**：不写 `data-port`，`canvas-panel-interaction` 的 `startWire` 就不会命中它，
 * 用户改流程顺序只能靠拖动节点而不是拉线。坐标是方框中心，样式用 `translate(-50%, -50%)` 对齐，
 * 所以流程连线正好落在方框中心。
 */
function renderFlowPort(port: CanvasFlowPortView): TemplateResult {
  const label = port.direction === 'in' ? '流程入口' : '流程出口';
  return html`<div
    class="port flow-port"
    data-node=${port.nodeId}
    data-flow=${port.direction}
    style=${`left:${port.x}px;top:${port.y}px`}
    title=${`${label}：上/下一条流程语句的连线接在这里`}
  ></div>`;
}

// ---------------------------------------------------------------------------
// 预览层
// ---------------------------------------------------------------------------

function renderMarquee(marquee: Rect | undefined): TemplateResult | typeof nothing {
  if (marquee === undefined) return nothing;
  return html`<div class="marquee" style=${rectStyle(marquee)}></div>`;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 关系方框的正文：二元/一元给**标号**（`+`、`且`、`#`），转换给转换名。
 * 需求 §6.1 要求「不能只靠颜色区分」，所以方框里一定有文字。
 */
function relationTextOf(node: canvas.CanvasNode, box: CanvasBox): string {
  if (node.kind === 'group') return node.mode === 'list' ? '组成列表' : '连接串';
  if (node.kind === 'relation') return canvas.binaryOperatorSpec(node.op).symbol;
  if (node.kind === 'unary') return canvas.unaryOperatorSpec(node.op).symbol;
  return box.title;
}

/** 悬停的完整文案：`title` 属性满足「悬停显示完整文案」（需求 §6.1）。 */
function relationTitleOf(node: canvas.CanvasNode | undefined, box: CanvasBox): string {
  if (node === undefined) return box.title;
  if (node.kind === 'relation') return canvas.binaryOperatorSpec(node.op).label;
  if (node.kind === 'unary') return canvas.unaryOperatorSpec(node.op).label;
  return box.title;
}

function nodeOfNodeId(document: canvas.CanvasDocument, nodeId: string): canvas.CanvasNode | undefined {
  return document.nodes.find((node) => node.id === nodeId);
}

function selectionClass(box: CanvasBox, state: StageState): string {
  return state.selection.includes(box.nodeId) ? 'selected' : '';
}

function classesOf(items: readonly string[]): string {
  return items.filter((item) => item !== '').join(' ');
}

function rectStyle(rect: Rect): string {
  return `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
}
