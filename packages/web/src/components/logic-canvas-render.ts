import { html, svg, nothing, type TemplateResult } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { canvas } from '@pwn2block/shared';
import { logicBox, logicEnvelopeDepth, logicEnvelopeHeaderHeight, logicAttachmentHost, LOGIC_RELATION_WIDTH, type LogicSnap } from '../canvas/logic-editor';
import { logicFlowHitClip, logicEdgeGeometry, logicSummary, logicLiteralSummary, logicTitle } from './logic-canvas-view';
import type { LogicLayer } from '../canvas/logic-layers';

interface ViewContext {
  graph: canvas.LogicGraph;
  methods: readonly canvas.CanvasMethodDecl[];
  selected: readonly string[];
  snap: LogicSnap | undefined;
  dragIds: readonly string[] | undefined;
  wiring: { input: string } | undefined;
  edgeId: string | undefined;
  bend: { edgeId: string; index: number } | undefined;
  startNode(event: PointerEvent, id: string): void;
  startPan(event: PointerEvent): boolean;
  flowPort(event: PointerEvent, node: canvas.LogicNode, outlet?: 'next' | 'then' | 'else'): void;
  chooseEdge(event: Event, id: string): void;
  addBend(event: MouseEvent, edge: canvas.LogicEdge): void;
  startBend(event: PointerEvent, id: string, index: number): void;
  selectNode(id: string): void;
  selectBend(id: string, index: number): void;
  removeSelection(): void;
  update(): void;
}
export class LogicCanvasView {
  constructor(private readonly ui: ViewContext) {}
  dragHints(original: canvas.LogicGraph): TemplateResult {
    const { graph, dragIds } = this.ui;
    const moving = new Set((dragIds ?? []).flatMap((id) => [...canvas.logicMembers(original, id)]));
    const cut = original.edges.filter((edge) => edge.kind === 'data' && moving.has(edge.from) !== moving.has(edge.to) &&
      !graph.edges.some((item) => item.id === edge.id && item.from === edge.from && item.to === edge.to));
    const removed = original.nodes.filter((node) => !graph.nodes.some((item) => item.id === node.id));
    const anchor = dragIds?.find((id) => graph.nodes.some((node) => node.id === id));
    const box = anchor ? logicBox(graph, anchor) : { x: 0, y: 0 };
    return html`${cut.map((edge) => {
      const point = logicEdgeGeometry(original, edge);
      return html`<span class="cut-marker" style=${styleMap({ left: `${point.x}px`, top: `${point.y}px` })}>断开</span>`;
    })}${removed.length ? html`<span class="drag-cleanup" style=${styleMap({ left: `${box.x}px`, top: `${box.y - 30}px` })}>松开将清理：${removed.map((node) => logicTitle(node, this.ui.methods)).join('、')}；Esc 取消</span>` : nothing}`;
  }
  ports(node: canvas.LogicNode): TemplateResult | typeof nothing {
    if (!canvas.logicIsFlow(this.ui.graph, node) || (node.kind === 'loop' && node.body)) return nothing;
    return html`${node.kind !== 'start'
      ? html`<button class="port port-in" aria-label="流程入口"
          aria-pressed=${this.ui.wiring?.input === node.id}
          @pointerdown=${(e: PointerEvent) => this.ui.flowPort(e, node)}></button>` : nothing}
    ${node.kind === 'branch'
      ? html`<span class="port-label then-label">true</span><button
          class="port port-then" aria-label="true 分支"
          @pointerdown=${(e: PointerEvent) => this.ui.flowPort(e, node, 'then')}></button>
        <span class="port-label else-label">false</span><button
          class="port port-else" aria-label="false 分支"
          @pointerdown=${(e: PointerEvent) => this.ui.flowPort(e, node, 'else')}></button>`
      : html`<button class="port port-out" aria-label="流程出口"
          @pointerdown=${(e: PointerEvent) => this.ui.flowPort(e, node, 'next')}></button>`}`;
  }
  edgeSvg(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult {
    const geometry = logicEdgeGeometry(graph, edge);
    return svg`${edge.kind === 'flow' && !ghost ? svg`<defs><clipPath id=${`flow-hit-${edge.id}`}>
      <path clip-rule="evenodd" d=${logicFlowHitClip(graph, edge)}></path>
    </clipPath></defs>` : nothing}<g data-edge=${edge.id} data-edge-kind=${edge.kind} class=${ghost ? 'ghost' : ''}>
      ${geometry.paths.map((d) => svg`<path class="${edge.kind === 'flow' ? 'flow-line' : 'reference-line'} ${this.ui.edgeId === edge.id ? 'edge-selected' : ''}" d=${d} marker-end=${edge.kind === 'flow' ? 'url(#logic-arrow)' : nothing}></path>`)}
      ${!ghost && geometry.paths[0] ? svg`<path class="edge-hit" clip-path=${edge.kind === 'flow' ? `url(#flow-hit-${edge.id})` : nothing} d=${geometry.paths[edge.kind === 'reference' ? 1 : 0]} @pointerdown=${(e: Event) => this.ui.chooseEdge(e, edge.id)} @dblclick=${(e: MouseEvent) => this.ui.addBend(e, edge)}></path>` : nothing}
      ${!ghost && edge.kind === 'flow' && this.ui.edgeId === edge.id ? (edge.points ?? []).map((point, index) => svg`
        <circle class="bend-handle ${this.ui.bend?.edgeId === edge.id && this.ui.bend.index === index ? 'active' : ''}"
          cx=${point.x} cy=${point.y} r="6" tabindex="0" role="button" aria-label=${`转折点 ${index + 1}`}
          @pointerdown=${(event: PointerEvent) => this.ui.startBend(event, edge.id, index)}
          @keydown=${(event: KeyboardEvent) => {
            if (['Delete', 'Backspace', 'Enter', ' '].includes(event.key)) {
              event.preventDefault(); event.stopPropagation(); this.ui.selectBend(edge.id, index);
              if (event.key === 'Delete' || event.key === 'Backspace') this.ui.removeSelection();
              this.ui.update();
            }
          }}></circle>`) : nothing}
    </g>`;
  }
  relation(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult | typeof nothing {
    if (edge.kind !== 'data') return nothing;
    const p = logicEdgeGeometry(graph, edge);
    return html`<button
      data-edge=${edge.id}
      data-edge-kind="data"
      class="relation ${edge.op === 'assign' ? 'assignment' : ''} ${ghost
        ? 'ghost'
        : ''} ${this.ui.edgeId === edge.id ? 'selected' : ''}"
      style=${styleMap({ left: `${p.x}px`, top: `${p.y}px`, width: `${LOGIC_RELATION_WIDTH}px` })}
      aria-label=${`数据连接 ${edge.op === 'concat' ? '+' : edge.op}`}
      @pointerdown=${(e: Event) => this.ui.chooseEdge(e, edge.id)}
    >
      ${edge.op === 'assign' ? (logicBox(graph, edge.to).x <= logicBox(graph, edge.from).x ? '← 赋值' : '赋值 →') : edge.op === 'concat' ? '+' : edge.op}
    </button>`;
  }
  renderNode(
    graph: canvas.LogicGraph,
    node: canvas.LogicNode,
    preview: ReadonlyMap<string, canvas.Value | string>,
  ): TemplateResult {
    const box = logicBox(graph, node.id),
      selected = this.ui.selected.includes(node.id),
      snap = this.ui.snap?.target === node.id,
      moving = this.ui.dragIds?.some((id) => canvas.logicMembers(graph, id).has(node.id));
    const attached = graph.nodes.filter(
      (n) => (n.kind === 'loop' && n.body === node.id) || (n.kind === 'convert' && n.input === node.id),
    );
    if (node.kind === 'envelope') {
      const envelopeDepth = logicEnvelopeDepth(graph, node.id);
      return html`<div
        data-node=${node.id}
        data-kind="envelope"
        class="envelope ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''} ${moving ? 'drag-member' : ''}"
        style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: `${3 + envelopeDepth}` })}
      >
        <div class="envelope-header" style=${styleMap({ zIndex: `${10 + envelopeDepth}` })}><button class="envelope-title" @pointerdown=${(e: PointerEvent) => this.ui.startNode(e, node.id)}>
          ${logicTitle(node, this.ui.methods)}
          [${node.category === 'data' ? (canvas.logicHasAssignment(graph, node.id) ? '数据 / 流程' : '数据') : '流程'}]
          </button>
          ${node.category === 'data' ? html`<span class="envelope-summary" title=${logicSummary(preview.get(node.id))}>
            ${node.members.length ? `= ${logicSummary(preview.get(node.id))}` : '空包络'}</span>` : nothing}
          ${attached.map((n) => html`<button class="attachment ${this.ui.selected.includes(n.id) ? 'selected' : ''} ${this.ui.snap?.attachment === n.id ? 'ghost' : ''}"
            data-attachment=${n.id} aria-label=${`编辑 ${logicTitle(n, this.ui.methods)}`}
            @pointerdown=${(e: PointerEvent) => this.ui.startNode(e, n.id)}
            @click=${() => { this.ui.selectNode(n.id); }}>
            ${logicTitle(n, this.ui.methods)}${n.kind === 'loop' ? ` · ${n.count} 次` : ''}
          </button>`)}
        </div>
        ${!node.members.length ? html`<span class="empty-envelope-hint" style=${styleMap({ top: `${logicEnvelopeHeaderHeight(graph, node.id) + 24}px` })}>拖入一个完整结构</span>` : nothing}
        ${this.ports(node)}
      </div>`;
    }
    const summary =
      node.kind === 'start'
        ? '全局定义完成后执行'
        : node.kind === 'loop'
          ? `${node.body ? '已附着' : '拖近流程包络附着'} · ${node.count} 次`
          : node.kind === 'branch'
            ? 'bool 条件'
            : node.kind === 'method'
              ? '引用数据作为参数'
              : node.kind === 'constant' ? logicLiteralSummary(node.value) : logicSummary(preview.get(node.id));
    return html`<div
      role="button"
      tabindex="0"
      data-node=${node.id}
      data-kind=${node.kind}
      aria-label=${logicTitle(node, this.ui.methods)}
      aria-pressed=${selected}
      class="node ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''} ${moving ? 'drag-member' : ''} ${moving && this.ui.snap?.kind ? 'ghost' : ''}"
      style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, zIndex: `${2 + logicEnvelopeDepth(graph, node.id)}` })}
      @pointerdown=${(e: PointerEvent) => this.ui.startNode(e, node.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.ui.selectNode(node.id);
        }
      }}
    >
      <span class="node-title">${logicTitle(node, this.ui.methods)}</span
      ><span class="node-summary" title=${summary}>${summary}</span>${this.ports(node)}
    </div>`;
  }
  renderLayer(
    graph: canvas.LogicGraph,
    layer: LogicLayer,
    preview: ReadonlyMap<string, canvas.Value | string>,
  ): TemplateResult {
    const members = new Set(layer.members);
    return html`<div class="logic-layer" style=${styleMap({ zIndex: `${10 + layer.index}` })}>
      ${graph.nodes
        .filter((node) => members.has(node.id) && node.kind === 'envelope')
        .map((node) => this.renderNode(graph, node, preview))}
      ${graph.nodes
        .filter((node) => members.has(node.id) && node.kind !== 'envelope' && !logicAttachmentHost(node))
        .map((node) => this.renderNode(graph, node, preview))}
      ${graph.edges
        .filter((edge) => edge.kind === 'data' && members.has(edge.from) && members.has(edge.to))
        .map((edge) => this.relation(graph, edge, this.ui.snap?.edges?.some((item) => item.id === edge.id) ?? false))}
    </div>`;
  }
}
