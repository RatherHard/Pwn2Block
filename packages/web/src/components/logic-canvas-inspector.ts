import { html, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { canvas } from '@pwn2block/shared';
import { createLogicEdge, layoutLogicDataComponents, logicAttachmentHost, normalizeLogicEnvelopes } from '../canvas/logic-editor';
import { LogicNodeFields } from './logic-canvas-fields';
import { logicTitle } from './logic-canvas-view';

interface InspectorContext {
  graph: canvas.LogicGraph;
  methods: readonly canvas.CanvasMethodDecl[];
  selected: readonly string[];
  edgeId: string | undefined;
  bend: { edgeId: string; index: number } | undefined;
  commit(graph: canvas.LogicGraph): void;
  attempt(work: () => canvas.LogicGraph): void;
  removeSelection(): void;
  addEdge(edge: canvas.LogicEdge): void;
  extractSelected(): void;
  selectEdge(id: string): void;
  feedback(message: string): void;
  update(): void;
}
export class LogicCanvasInspector {
  private targetId = '';
  private connectionOperator: canvas.LogicOperator | '' = '';
  render(ui: InspectorContext): TemplateResult {
    const edge = ui.graph.edges.find((e) => e.id === ui.edgeId);
    if (edge)
      return html`<h3>连接属性</h3>
        <p>${edge.from} → ${edge.to}</p>
        ${edge.kind === 'flow' ? html`<p class="hint">双击连线添加转折点，拖动调整曲线；选中转折点后按 Delete 删除。</p>
          ${ui.bend?.edgeId === edge.id ? html`<button @click=${() => ui.removeSelection()}>删除转折点</button>` : nothing}` : nothing}
        ${edge.kind === 'data'
          ? html`<label
              >关系<select
                aria-label="关系"
                @change=${(e: Event) => {
                  const op = (e.target as HTMLSelectElement).value as canvas.LogicOperator;
                  const reverse = op === 'assign' && ui.graph.nodes.some((n) => n.id === edge.from && n.kind === 'variable');
                  ui.attempt(() => {
                    const updated = { ...edge, op, from: reverse ? edge.to : edge.from, to: reverse ? edge.from : edge.to };
                    return layoutLogicDataComponents({ ...ui.graph, edges: ui.graph.edges.map((item) => item.id === edge.id ? updated : item) }, updated.to);
                  });
                }}
              >
                ${canvas.LOGIC_OPERATORS.map(
                  (op) =>
                    html`<option value=${op} .selected=${live(op === (edge.op === 'concat' ? '+' : edge.op))}>
                      ${op === 'assign' ? '赋值（值 → 变量）' : op === '+' ? '加法 / 拼接 +' : op === '*' ? '乘法 / 重复 *' : op}
                    </option>`,
                )}
              </select></label
            >`
          : edge.kind === 'reference'
            ? html`<label
                >引用端口<select
                  aria-label="引用端口"
                  @change=${(e: Event) =>
                    ui.commit({
                      ...ui.graph,
                      edges: ui.graph.edges.map((item) =>
                        item.id === edge.id ? { ...edge, port: (e.target as HTMLSelectElement).value } : item,
                      ),
                    })}
                >
                  ${this.referencePorts(ui, edge.to).map(
                    (port) => html`<option value=${port} .selected=${live(port === edge.port)}>${port}</option>`,
                  )}
                </select></label
              >`
            : html`<p>运行方向：${edge.outlet === 'next' ? '下一步' : edge.outlet === 'then' ? 'true' : 'false'}</p>`}
        <button @click=${() => ui.removeSelection()}>删除连接</button>`;
    const node = ui.selected.length === 1 ? ui.graph.nodes.find((n) => n.id === ui.selected[0]) : undefined;
    if (!node)
      return html`<h3>属性</h3>
        <p class="hint">
          ${ui.selected.length
            ? `已选择 ${ui.selected.length} 个节点，可创建包络。`
            : '点击节点或连接编辑属性。Shift 点击多选，空白处拖动框选，Space 拖动平移。'}
        </p>`;
    const host = logicAttachmentHost(node);
    const connectionNode = ui.graph.nodes.find((n) => n.id === host) ?? node;
    const targets = ui.graph.nodes.filter((n) => n.id !== connectionNode.id && !logicAttachmentHost(n));
    const targetId = targets.some((n) => n.id === this.targetId) ? this.targetId : '';
    return html`<h3>${logicTitle(node, ui.methods)}</h3>
      ${new LogicNodeFields(
        ui.graph,
        ui.methods,
        (graph) => ui.commit(graph),
        (message) => {
          ui.feedback(message);
        },
      ).render(node)}
      ${host ? html`<p class="hint">连接将使用所属包络。</p>` : nothing}
      <label
        >连接到<select
          aria-label="连接到"
          @change=${(e: Event) => {
            this.targetId = (e.target as HTMLSelectElement).value;
            ui.update();
          }}
        >
          <option value="" .selected=${live(targetId === '')}>选择节点</option>
          ${targets.map((n) => html`<option value=${n.id} .selected=${live(n.id === targetId)}>${logicTitle(n, ui.methods)} (${n.id})</option>`)}
        </select></label
      >${canvas.logicCategory(connectionNode) === 'data' ? html`<label>新增关系<select aria-label="新增关系"
        @change=${(event: Event) => { this.connectionOperator = (event.target as HTMLSelectElement).value as canvas.LogicOperator | ''; }}>
        <option value="" .selected=${live(this.connectionOperator === '')}>自动（加法 / 赋值）</option>
        ${canvas.LOGIC_OPERATORS.map((op) => html`<option value=${op} .selected=${live(this.connectionOperator === op)}>${op === 'assign' ? '赋值' : op}</option>`)}
      </select></label>` : nothing}<button
        ?disabled=${!targetId}
        @click=${() => {
          const target = targets.find((n) => n.id === targetId);
          let edge = target && createLogicEdge(ui.graph, connectionNode, target, ui.methods);
          if (edge?.kind === 'data' && this.connectionOperator) {
            const op = this.connectionOperator;
            edge = { ...edge, op, from: op === 'assign' && connectionNode.kind === 'variable' ? target!.id : connectionNode.id,
              to: op === 'assign' && connectionNode.kind === 'variable' ? connectionNode.id : target!.id };
          }
          if (edge) ui.addEdge(edge);
          else {
            ui.feedback('这两个节点之间没有可用连接');
          }
        }}
      >
        建立连接
      </button>
      <p class="hint">拖节点拔起自身及右侧尾段；Alt 拖动只取出此节点。关系框不可拖动，可接收插入。Esc 取消拖动。</p>
      ${canvas.logicCategory(node) === 'data' ? html`<button @click=${() => ui.extractSelected()}>取出此节点</button>` : nothing}
      ${node.kind === 'envelope' && canvas.logicComponents(ui.graph, node.members, node.category).length > 1
        ? html`<button @click=${() => ui.attempt(() => normalizeLogicEnvelopes(ui.graph, ui.graph, [], node.id))}>整理包络：保留左段，其余移出</button>` : nothing}
      ${ui.graph.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map(
          (e) =>
            html`<button
              @click=${() => {
                ui.selectEdge(e.id);
              }}
            >
              ${e.kind === 'reference' ? `引用 ${e.port}` : e.kind === 'data' ? e.op : e.outlet} ·
              ${e.from === node.id ? e.to : e.from}
            </button>`,
        )}`;
  }
  private referencePorts(ui: InspectorContext, id: string): string[] {
    const node = ui.graph.nodes.find((n) => n.id === id);
    return node?.kind === 'branch'
      ? ['condition']
      : node?.kind === 'loop'
        ? ['count']
        : node?.kind === 'method'
          ? (ui.methods.find((m) => m.id === node.method)?.params.map((p) => p.name) ?? [])
          : [];
  }
}
