import { LitElement, html, svg, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { styleMap } from 'lit/directives/style-map.js';
import { canvas } from '@pwn2block/shared';
import type { WorkflowIssue } from '../canvas/artifact';
import {
  connectLogic,
  createLogicEdge,
  logicBox,
  logicId,
  moveLogicNodes,
  nextLogicPosition,
  nearestLogicSnap,
  removeLogic,
  wrapLogic,
  type LogicSnap,
} from '../canvas/logic-editor';
import { terminalTheme, sharedStyles } from '../theme';
import { LogicNodeFields } from './logic-canvas-fields';
import { logicCanvasStyles } from './logic-canvas-styles';
import { logicEdgeGeometry, logicSummary, logicTitle } from './logic-canvas-view';

type Drag = { id: string; startX: number; startY: number; original: canvas.LogicGraph; ids: string[]; moved: boolean };
export class LogicCanvasElement extends LitElement {
  static override styles = [terminalTheme, sharedStyles, logicCanvasStyles];
  static override properties = {
    graph: { attribute: false },
    methods: { attribute: false },
    issues: { attribute: false },
    steps: { attribute: false },
    canUndo: { type: Boolean },
    canRedo: { type: Boolean },
  };
  declare graph: canvas.LogicGraph;
  declare methods: readonly canvas.CanvasMethodDecl[];
  declare issues: readonly WorkflowIssue[];
  declare steps: readonly canvas.CanvasStep[];
  declare canUndo: boolean;
  declare canRedo: boolean;
  private selected: string[] = [];
  private edgeId: string | undefined;
  private draft: canvas.LogicGraph | undefined;
  private snap: LogicSnap | undefined;
  private drag: Drag | undefined;
  private marquee: { x: number; y: number; endX: number; endY: number } | undefined;
  private wiring: { id: string; outlet: 'next' | 'then' | 'else' } | undefined;
  private message = '';
  private targetId = '';
  constructor() {
    super();
    this.methods = [];
    this.issues = [];
    this.steps = [];
    this.canUndo = false;
    this.canRedo = false;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('keydown', this.keyDown);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.keyDown);
    this.stopPointer();
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('graph') && this.graph) {
      this.selected = this.selected.filter((id) => this.graph.nodes.some((n) => n.id === id));
      if (this.edgeId && !this.graph.edges.some((e) => e.id === this.edgeId)) this.edgeId = undefined;
      if (this.wiring && !this.graph.nodes.some((n) => n.id === this.wiring?.id)) this.wiring = undefined;
    }
  }
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('graph') && this.graph && this.drag && this.drag.original !== this.graph) this.cancelPointer();
  }
  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  private commit(graph: canvas.LogicGraph): void {
    if (graph === this.graph) return;
    if (!canvas.LogicGraphSchema.safeParse(graph).success) {
      this.message = '超出文档限制：最多 512 节点、2048 连接，请检查字段长度与坐标范围';
      this.requestUpdate();
      return;
    }
    this.message = '';
    this.emit('logic-edit', graph);
    this.requestUpdate();
  }
  private attempt(work: () => canvas.LogicGraph): void {
    try {
      this.commit(work());
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    }
  }
  private point(event: PointerEvent): { x: number; y: number } {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage')!;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left + stage.scrollLeft, y: event.clientY - rect.top + stage.scrollTop };
  }
  locate(id: string): void {
    const edge = this.graph.edges.find((e) => e.id === id);
    this.edgeId = edge?.id;
    this.selected = edge ? [] : [id];
    const box = logicBox(this.graph, edge?.from ?? id);
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    if (stage) {
      stage.scrollLeft = Math.max(0, box.x - 100);
      stage.scrollTop = Math.max(0, box.y - 100);
    }
    this.requestUpdate();
  }
  private startNode(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.focus({ preventScroll: true });
    if (this.wiring) {
      const edge: canvas.LogicEdge = {
        id: logicId(this.graph, 'edge'),
        kind: 'flow',
        from: this.wiring.id,
        to: id,
        outlet: this.wiring.outlet,
      };
      this.wiring = undefined;
      this.addEdge(edge);
      return;
    }
    if (event.shiftKey)
      this.selected = this.selected.includes(id) ? this.selected.filter((i) => i !== id) : [...this.selected, id];
    else if (!this.selected.includes(id)) this.selected = [id];
    this.edgeId = undefined;
    const point = this.point(event);
    this.drag = { id, startX: point.x, startY: point.y, original: this.graph, ids: [...this.selected], moved: false };
    this.listenPointer();
    this.requestUpdate();
  }
  private startStage(event: PointerEvent): void {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.node, .envelope-title, .relation, .edge-hit, .port')) return;
    event.preventDefault();
    this.focus({ preventScroll: true });
    const p = this.point(event);
    this.selected = [];
    this.edgeId = undefined;
    this.wiring = undefined;
    this.marquee = { ...p, endX: p.x, endY: p.y };
    this.listenPointer();
    this.requestUpdate();
  }
  private listenPointer(): void {
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointercancel', this.cancelPointer);
  }
  private stopPointer(): void {
    window.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('pointercancel', this.cancelPointer);
  }
  private pointerMove = (event: PointerEvent): void => {
    const p = this.point(event);
    if (this.drag) {
      const dx = p.x - this.drag.startX,
        dy = p.y - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      this.draft = moveLogicNodes(this.drag.original, this.drag.ids, dx, dy);
      this.snap = this.drag.ids.length === 1 ? nearestLogicSnap(this.draft, this.drag.id, this.methods) : undefined;
    } else if (this.marquee) this.marquee = { ...this.marquee, endX: p.x, endY: p.y };
    this.requestUpdate();
  };
  private pointerUp = (): void => {
    this.stopPointer();
    if (this.drag?.moved && this.draft) {
      let graph = this.snap?.graph ?? this.draft;
      // A data snap places the relation between two nearby boxes, with a visible gap on either side.
      if (this.snap?.edge?.kind === 'data') {
        const moving = this.drag.id,
          target = moving === this.snap.edge.from ? this.snap.edge.to : this.snap.edge.from;
        const a = logicBox(graph, moving),
          b = logicBox(graph, target);
        const x = moving === this.snap.edge.from ? b.x - a.width - 68 : b.x + b.width + 68;
        graph = moveLogicNodes(graph, [moving], Math.max(0, x) - a.x, b.y - a.y);
      }
      this.commit(graph);
    }
    if (this.marquee) {
      const r = this.marquee,
        left = Math.min(r.x, r.endX),
        top = Math.min(r.y, r.endY),
        right = Math.max(r.x, r.endX),
        bottom = Math.max(r.y, r.endY);
      this.selected = this.graph.nodes
        .filter((n) => {
          const b = logicBox(this.graph, n.id);
          return b.x >= left && b.y >= top && b.x + b.width <= right && b.y + b.height <= bottom;
        })
        .map((n) => n.id);
    }
    this.drag = undefined;
    this.draft = undefined;
    this.snap = undefined;
    this.marquee = undefined;
    this.requestUpdate();
  };
  private cancelPointer = (): void => {
    this.stopPointer();
    this.drag = undefined;
    this.draft = undefined;
    this.snap = undefined;
    this.marquee = undefined;
    this.wiring = undefined;
    this.requestUpdate();
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (
      event
        .composedPath()
        .some(
          (t) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement,
        )
    )
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      this.cancelPointer();
      this.selected = [];
      this.edgeId = undefined;
    } else if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.cancelPointer();
      this.emit(event.shiftKey ? 'logic-redo' : 'logic-undo');
    } else if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.emit('logic-redo');
    } else if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selected = this.graph.nodes.map((n) => n.id);
    } else if (modifier && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      this.attempt(() => wrapLogic(this.graph, this.selected));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.removeSelection();
    } else if (this.selected.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 20 : 4;
      this.commit(
        moveLogicNodes(
          this.graph,
          this.selected,
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        ),
      );
    }
    this.requestUpdate();
  };
  private removeSelection(): void {
    this.commit(removeLogic(this.graph, this.edgeId ? [this.edgeId] : this.selected));
    this.selected = [];
    this.edgeId = undefined;
  }
  private add(kind: 'constant' | 'variable' | 'convert' | 'branch' | 'loop' | 'method', method = ''): void {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    const base = {
      id: logicId(this.graph, kind),
      ...nextLogicPosition(this.graph, stage?.scrollLeft ?? 0, stage?.scrollTop ?? 0, stage?.clientWidth ?? 800),
    };
    let node: canvas.LogicNode;
    if (kind === 'constant') node = { ...base, kind, value: { type: 'int', text: '0' } };
    else if (kind === 'variable')
      node = { ...base, kind, name: `变量${this.graph.nodes.filter((n) => n.kind === 'variable').length + 1}` };
    else if (kind === 'convert')
      node = {
        ...base,
        kind,
        value: { type: 'int', text: '0' },
        target: 'bytes',
        width: '8',
        endian: 'little',
        signed: false,
      };
    else if (kind === 'loop') node = { ...base, kind, count: '1' };
    else if (kind === 'method') node = { ...base, kind, method };
    else node = { ...base, kind };
    this.selected = [node.id];
    this.edgeId = undefined;
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, node] });
  }
  private addEdge(edge: canvas.LogicEdge): void {
    this.attempt(() => {
      const next = connectLogic(this.graph, edge);
      const old = new Set(canvas.validateLogicGraph(this.graph).map((i) => `${i.nodeId}:${i.message}`));
      const issue = canvas.validateLogicGraph(next).find((i) => !old.has(`${i.nodeId}:${i.message}`));
      if (issue) throw new Error(issue.message);
      return next;
    });
  }
  private chooseEdge(event: Event, id: string): void {
    event.stopPropagation();
    this.edgeId = id;
    this.selected = [];
    this.requestUpdate();
  }
  private ports(node: canvas.LogicNode): TemplateResult | typeof nothing {
    if (!canvas.logicIsFlow(this.graph, node) || (node.kind === 'loop' && node.body)) return nothing;
    const startWire = (event: Event, outlet: 'next' | 'then' | 'else'): void => {
      event.stopPropagation();
      this.wiring = { id: node.id, outlet };
      this.message = '点击目标流程节点完成连接，Esc 取消';
      this.requestUpdate();
    };
    return html`${node.kind !== 'start'
      ? html`<button
          class="port port-in"
          aria-label="流程入口"
          @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}
        ></button>`
      : nothing}
    ${node.kind === 'branch'
      ? html`<span class="port-label then-label">true</span
          ><button
            class="port port-then"
            aria-label="true 分支"
            @pointerdown=${(e: Event) => startWire(e, 'then')}
          ></button
          ><span class="port-label else-label">false</span
          ><button
            class="port port-else"
            aria-label="false 分支"
            @pointerdown=${(e: Event) => startWire(e, 'else')}
          ></button>`
      : html`<button
          class="port port-out"
          aria-label="流程出口"
          @pointerdown=${(e: Event) => startWire(e, 'next')}
        ></button>`}`;
  }
  private edgeSvg(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult {
    const geometry = logicEdgeGeometry(graph, edge);
    return svg`<g data-edge=${edge.id} data-edge-kind=${edge.kind} class=${ghost ? 'ghost' : ''}>
      ${geometry.paths.map((d) => svg`<path class="${edge.kind === 'flow' ? 'flow-line' : 'reference-line'} ${this.edgeId === edge.id ? 'edge-selected' : ''}" d=${d} marker-end=${edge.kind === 'flow' ? 'url(#logic-arrow)' : nothing}></path>`)}
      ${!ghost && geometry.paths[0] ? svg`<path class="edge-hit" d=${geometry.paths[0]} @pointerdown=${(e: Event) => this.chooseEdge(e, edge.id)}></path>` : nothing}
    </g>`;
  }
  private relation(graph: canvas.LogicGraph, edge: canvas.LogicEdge, ghost = false): TemplateResult | typeof nothing {
    if (edge.kind !== 'data') return nothing;
    const p = logicEdgeGeometry(graph, edge);
    return html`<button
      data-edge=${edge.id}
      data-edge-kind="data"
      class="relation ${edge.op === 'assign' ? 'assignment' : edge.op === 'concat' ? 'concat' : ''} ${ghost
        ? 'ghost'
        : ''} ${this.edgeId === edge.id ? 'selected' : ''}"
      style=${styleMap({ left: `${p.x}px`, top: `${p.y}px` })}
      aria-label=${`数据连接 ${edge.op}`}
      @pointerdown=${(e: Event) => this.chooseEdge(e, edge.id)}
    >
      ${edge.op === 'assign' ? '赋值 →' : edge.op === 'concat' ? '拼接 +' : edge.op}
    </button>`;
  }
  private renderNode(
    graph: canvas.LogicGraph,
    node: canvas.LogicNode,
    preview: ReadonlyMap<string, canvas.Value | string>,
  ): TemplateResult {
    const box = logicBox(graph, node.id),
      selected = this.selected.includes(node.id),
      snap = this.snap?.target === node.id;
    const attached = graph.nodes.filter(
      (n) => (n.kind === 'loop' && n.body === node.id) || (n.kind === 'convert' && n.input === node.id),
    );
    if (node.kind === 'envelope')
      return html`<div
        data-node=${node.id}
        data-kind="envelope"
        class="envelope ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''}"
        style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })}
      >
        <button class="envelope-title" @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}>
          ${node.title}
          [${node.category === 'data' ? (canvas.logicHasAssignment(graph, node.id) ? '数据 / 流程' : '数据') : '流程'}]
          ${attached.map((n) => html`<span class="attachment">· ${logicTitle(n, this.methods)}</span>`)}</button
        >${this.ports(node)}
      </div>`;
    const summary =
      node.kind === 'start'
        ? '全局定义完成后执行'
        : node.kind === 'loop'
          ? `${node.body ? '已附着' : '拖近流程包络附着'} · ${node.count} 次`
          : node.kind === 'branch'
            ? 'bool 引用 → true / false'
            : node.kind === 'method'
              ? '引用数据作为参数'
              : logicSummary(preview.get(node.id));
    return html`<div
      role="button"
      tabindex="0"
      data-node=${node.id}
      data-kind=${node.kind}
      aria-label=${logicTitle(node, this.methods)}
      aria-pressed=${selected}
      class="node ${selected ? 'selected' : ''} ${snap ? 'snap-target' : ''}"
      style=${styleMap({ left: `${box.x}px`, top: `${box.y}px` })}
      @pointerdown=${(e: PointerEvent) => this.startNode(e, node.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selected = [node.id];
          this.edgeId = undefined;
          this.requestUpdate();
        }
      }}
    >
      <span class="node-title">${logicTitle(node, this.methods)}</span
      ><span class="node-summary" title=${summary}>${summary}</span>${this.ports(node)}
    </div>`;
  }
  private inspector(): TemplateResult {
    const edge = this.graph.edges.find((e) => e.id === this.edgeId);
    if (edge)
      return html`<h3>连接属性</h3>
        <p>${edge.from} → ${edge.to}</p>
        ${edge.kind === 'data'
          ? html`<label
              >关系<select
                aria-label="关系"
                @change=${(e: Event) =>
                  this.commit({
                    ...this.graph,
                    edges: this.graph.edges.map((item) =>
                      item.id === edge.id
                        ? { ...edge, op: (e.target as HTMLSelectElement).value as canvas.LogicOperator }
                        : item,
                    ),
                  })}
              >
                ${canvas.LOGIC_OPERATORS.map(
                  (op) =>
                    html`<option value=${op} .selected=${live(op === edge.op)}>
                      ${op === 'assign' ? '赋值 →' : op === 'concat' ? '拼接 +' : op}
                    </option>`,
                )}
              </select></label
            >`
          : edge.kind === 'reference'
            ? html`<label
                >引用端口<select
                  aria-label="引用端口"
                  @change=${(e: Event) =>
                    this.commit({
                      ...this.graph,
                      edges: this.graph.edges.map((item) =>
                        item.id === edge.id ? { ...edge, port: (e.target as HTMLSelectElement).value } : item,
                      ),
                    })}
                >
                  ${this.referencePorts(edge.to).map(
                    (port) => html`<option value=${port} .selected=${live(port === edge.port)}>${port}</option>`,
                  )}
                </select></label
              >`
            : html`<p>运行方向：${edge.outlet === 'next' ? '下一步' : edge.outlet === 'then' ? 'true' : 'false'}</p>`}
        <button @click=${() => this.removeSelection()}>删除连接</button>`;
    const node = this.selected.length === 1 ? this.graph.nodes.find((n) => n.id === this.selected[0]) : undefined;
    if (!node)
      return html`<h3>属性</h3>
        <p class="hint">
          ${this.selected.length
            ? `已选择 ${this.selected.length} 个节点，可创建包络。`
            : '点击节点或连接编辑属性。Shift 点击多选，空白处拖动框选。'}
        </p>`;
    const targets = this.graph.nodes.filter((n) => n.id !== node.id);
    const targetId = targets.some((n) => n.id === this.targetId) ? this.targetId : '';
    return html`<h3>${logicTitle(node, this.methods)}</h3>
      ${new LogicNodeFields(
        this.graph,
        this.methods,
        (graph) => this.commit(graph),
        (message) => {
          this.message = message;
          this.requestUpdate();
        },
      ).render(node)}
      <label
        >连接到<select
          aria-label="连接到"
          @change=${(e: Event) => {
            this.targetId = (e.target as HTMLSelectElement).value;
            this.requestUpdate();
          }}
        >
          <option value="" .selected=${live(targetId === '')}>选择节点</option>
          ${targets.map((n) => html`<option value=${n.id} .selected=${live(n.id === targetId)}>${logicTitle(n, this.methods)} (${n.id})</option>`)}
        </select></label
      ><button
        ?disabled=${!targetId}
        @click=${() => {
          const target = targets.find((n) => n.id === targetId);
          const edge = target && createLogicEdge(this.graph, node, target, this.methods);
          if (edge) this.addEdge(edge);
          else {
            this.message = '这两个节点之间没有可用连接';
            this.requestUpdate();
          }
        }}
      >
        建立连接
      </button>
      <p class="hint">也可拖近节点吸附。数据连接方向从左向右；引用始终由数据指向流程。</p>
      ${this.graph.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map(
          (e) =>
            html`<button
              @click=${() => {
                this.edgeId = e.id;
                this.selected = [];
                this.requestUpdate();
              }}
            >
              ${e.kind === 'reference' ? `引用 ${e.port}` : e.kind === 'data' ? e.op : e.outlet} ·
              ${e.from === node.id ? e.to : e.from}
            </button>`,
        )}`;
  }
  private referencePorts(id: string): string[] {
    const node = this.graph.nodes.find((n) => n.id === id);
    return node?.kind === 'branch'
      ? ['condition']
      : node?.kind === 'loop'
        ? ['count']
        : node?.kind === 'method'
          ? (this.methods.find((m) => m.id === node.method)?.params.map((p) => p.name) ?? [])
          : [];
  }
  override render(): TemplateResult {
    if (!this.graph) return html``;
    const graph = this.draft ?? this.graph,
      preview = canvas.previewLogicGraph(graph);
    const boxes = graph.nodes.map((n) => logicBox(graph, n.id));
    const width = Math.max(1600, ...boxes.map((b) => b.x + b.width + 200)),
      height = Math.max(900, ...boxes.map((b) => b.y + b.height + 200));
    return html`<section class="workspace">
      <div class="toolbar">
        <button
          @click=${() => this.attempt(() => wrapLogic(this.graph, this.selected))}
          ?disabled=${!this.selected.length}
        >
          包络</button
        ><button @click=${() => this.removeSelection()} ?disabled=${!this.selected.length && !this.edgeId}>删除</button
        ><button @click=${() => this.emit('logic-undo')} ?disabled=${!this.canUndo}>撤销</button
        ><button @click=${() => this.emit('logic-redo')} ?disabled=${!this.canRedo}>重做</button
        ><button @click=${() => this.emit('logic-import')}>导入</button
        ><button @click=${() => this.emit('logic-export')}>导出</button
        ><button class="btn-run" @click=${() => this.emit('logic-run')} ?disabled=${this.issues.length > 0}>运行</button
        ><span class="status"
          >${graph.nodes.length} 节点 · ${graph.edges.length} 连接 · ${this.issues.length} 问题</span
        >
      </div>
      <div class="body">
        <aside class="library" aria-label="节点库">
          <h3>数据节点</h3>
          <button @click=${() => this.add('constant')}>+ 常量</button
          ><button @click=${() => this.add('variable')}>+ 变量</button
          ><button @click=${() => this.add('convert')}>+ 类型转换</button>
          <h3>流程节点</h3>
          <button @click=${() => this.add('loop')}>+ 次数循环</button
          ><button @click=${() => this.add('branch')}>+ 条件分支</button>
          <h3>题目方法</h3>
          ${this.methods.map((m) => html`<button @click=${() => this.add('method', m.id)}>${m.label}</button>`)}
          <p>拖近节点：吸附连接<br />Shift 点击：多选<br />Ctrl+G：包络<br />Esc：取消拖动</p>
        </aside>
        <div class="stage" tabindex="0" aria-label="节点画布" @pointerdown=${this.startStage}>
          <div class="surface" style=${styleMap({ width: `${width}px`, height: `${height}px` })}>
            <svg class="wires" width=${width} height=${height} aria-label="画布连接">
              <defs>
                <pattern id="logic-dots" width="20" height="20" patternUnits="userSpaceOnUse">
                  <rect x="0" y="0" width="1" height="1" fill="var(--p2b-line)"></rect>
                </pattern>
                <marker id="logic-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M 0 0 L 6 3.5 L 0 7" fill="none" stroke="var(--p2b-fg)"></path>
                </marker>
              </defs>
              <rect width="100%" height="100%" fill="url(#logic-dots)"></rect>
              ${graph.edges.map((e) => this.edgeSvg(graph, e))}${this.snap?.edge
                ? this.edgeSvg(this.snap.graph, this.snap.edge, true)
                : nothing}
            </svg>
            ${graph.nodes
              .filter((n) => n.kind === 'envelope')
              .map((n) => this.renderNode(graph, n, preview))}${graph.nodes
              .filter((n) => n.kind !== 'envelope')
              .map((n) => this.renderNode(graph, n, preview))}${graph.edges.map((e) => this.relation(graph, e))}${this
              .snap?.edge
              ? this.relation(this.snap.graph, this.snap.edge, true)
              : nothing}
            ${this.snap?.attachment
              ? html`<div
                  class="attachment ghost"
                  style=${styleMap({
                    position: 'absolute',
                    left: `${logicBox(graph, this.snap.target).x}px`,
                    top: `${logicBox(graph, this.snap.target).y - 20}px`,
                  })}
                >
                  松开附着
                </div>`
              : nothing}
            ${this.marquee
              ? html`<div
                  class="marquee"
                  style=${styleMap({
                    left: `${Math.min(this.marquee.x, this.marquee.endX)}px`,
                    top: `${Math.min(this.marquee.y, this.marquee.endY)}px`,
                    width: `${Math.abs(this.marquee.x - this.marquee.endX)}px`,
                    height: `${Math.abs(this.marquee.y - this.marquee.endY)}px`,
                  })}
                ></div>`
              : nothing}
          </div>
        </div>
        <aside class="inspector" aria-label="属性">${this.inspector()}</aside>
      </div>
      <div class="feedback" role="status">
        ${this.message ? html`<div>${this.message}</div>` : nothing}${this.issues.map(
          (i) => html`<div class="error"><button @click=${() => this.locate(i.nodeId)}>${i.message}</button></div>`,
        )}${!this.issues.length && !this.message
          ? '先定义全局变量，再连接开始流程。数据包络含赋值时，也可接入流程。'
          : nothing}
        ${this.steps.length
          ? html`<details class="steps">
              <summary>执行步骤与变量 (${this.steps.length})</summary>
              <table>
                <tbody>
                  ${this.steps.map(
                    (s) =>
                      html`<tr>
                        <td><button @click=${() => this.locate(s.nodeId)}>${s.step + 1} · ${s.nodeId}</button></td>
                        <td>
                          ${Object.entries(s.rounds)
                            .map(([id, round]) => `${id} 第 ${round + 1} 轮`)
                            .join(' / ')}
                        </td>
                        <td>${s.variables.map((v) => `${v.name} = ${logicSummary(v.value)}`).join('；')}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </details>`
          : nothing}
      </div>
    </section>`;
  }
}
customElements.define('pwn2block-logic-canvas', LogicCanvasElement);
