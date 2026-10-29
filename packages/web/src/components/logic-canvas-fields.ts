import { attachLogic, unwrapLogic } from '../canvas/logic-editor';
import { html, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { canvas } from '@pwn2block/shared';
import { logicTitle } from './logic-canvas-view';

/** Node property forms share a small edit boundary with the canvas interaction controller. */
export class LogicNodeFields {
  constructor(
    private readonly graph: canvas.LogicGraph,
    private readonly methods: readonly canvas.CanvasMethodDecl[],
    private readonly commit: (graph: canvas.LogicGraph) => void,
    private readonly report: (message: string) => void,
  ) {}
  private updateNode(node: canvas.LogicNode): void {
    this.commit({ ...this.graph, nodes: this.graph.nodes.map((n) => (n.id === node.id ? node : n)) });
  }
  private attach(nodeId: string, envelopeId?: string): void {
    const result = attachLogic(this.graph, nodeId, envelopeId);
    if (result.ok) this.commit(result.graph);
    else this.report(result.message);
  }
  private literalFields(
    value: canvas.LogicLiteral,
    update: (value: canvas.LogicLiteral) => void,
  ): TemplateResult {
    return html`<label
        >数据类型<select
          aria-label="数据类型"
          @change=${(e: Event) => {
            const type = (e.target as HTMLSelectElement).value as canvas.LogicType;
            update({
              type,
              text: type === 'bool' ? 'false' : type === 'int' || type === 'double' ? '0' : '',
            });
          }}
        >
          ${canvas.LOGIC_TYPES.map((t) => html`<option value=${t} .selected=${live(t === value.type)}>${t}</option>`)}
        </select></label
      >
      <label
        >${value.type === 'bytes' ? '值（十六进制 bytes）' : '值'}${
          value.type === 'bool'
            ? html`<select
                aria-label="值"
                .value=${value.text}
                @change=${(e: Event) => update({ ...value, text: (e.target as HTMLSelectElement).value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>`
            : html`<textarea
                aria-label="值"
                .value=${value.text}
                @change=${(e: Event) => update({ ...value, text: (e.target as HTMLTextAreaElement).value })}
              ></textarea>`
        }</label
      >`;
  }
  render(node: canvas.LogicNode): TemplateResult | typeof nothing {
    if (node.kind === 'constant')
      return this.literalFields(node.value, (value) => this.updateNode({ ...node, value }));
    if (node.kind === 'variable')
      return html`<label
          >名称<input
            aria-label="名称"
            .value=${node.name}
            @change=${(e: Event) => this.updateNode({ ...node, name: (e.target as HTMLInputElement).value })}
        /></label>
        <p class="hint">
          类型在第一次赋值时确定。同名节点读取同一个变量。全局定义引用其他变量时自动成为只读派生变量。
        </p>`;
    if (node.kind === 'convert')
      return html`${
          node.input
            ? html`<p>输入：包络 ${node.input}</p>
                <button @click=${() => this.attach(node.id)}>解除附着</button>`
            : this.literalFields(node.value, (value) => this.updateNode({ ...node, value }))
        }
        <label
          >转换为<select
            aria-label="转换为"
            @change=${(e: Event) =>
              this.updateNode({ ...node, target: (e.target as HTMLSelectElement).value as canvas.LogicType })}
          >
            ${canvas.LOGIC_TYPES.map((t) => html`<option value=${t} .selected=${live(t === node.target)}>${t}</option>`)}
          </select></label
        >
        <label
          >字节宽度<select
            aria-label="字节宽度"
            @change=${(e: Event) =>
              this.updateNode({
                ...node,
                width: (e.target as HTMLSelectElement).value as '1' | '2' | '4' | '8',
              })}
          >
            ${['1', '2', '4', '8'].map((w) => html`<option value=${w} .selected=${live(w === node.width)}>${w}</option>`)}
          </select></label
        >
        <label
          >字节序<select
            .value=${node.endian}
            @change=${(e: Event) =>
              this.updateNode({ ...node, endian: (e.target as HTMLSelectElement).value as 'little' | 'big' })}
          >
            <option value="little">little</option>
            <option value="big">big</option>
          </select></label
        >
        <label
          >有符号整数<input
            type="checkbox"
            .checked=${node.signed}
            @change=${(e: Event) =>
              this.updateNode({ ...node, signed: (e.target as HTMLInputElement).checked })} /></label
        >${this.attachmentField(node)}`;
    if (node.kind === 'loop')
      return html`<label
          >次数（int）<input
            aria-label="次数"
            .value=${node.count}
            @change=${(e: Event) => this.updateNode({ ...node, count: (e.target as HTMLInputElement).value })}
        /></label>
        <p class="hint">连接 count 引用后，使用引用的整数次数。</p>
        ${this.attachmentField(node)}`;
    if (node.kind === 'branch')
      return html`<p class="hint">引用 bool 数据决定分支。右侧两个方框分别连接 true 和 false 流程。</p>`;
    if (node.kind === 'envelope')
      return html`<label
          >包络名称<input
            .value=${node.title}
            @change=${(e: Event) => this.updateNode({ ...node, title: (e.target as HTMLInputElement).value })}
        /></label>
        <p class="hint">${node.members.length} 个直接成员；包络整体可参与连接。</p>
        <button @click=${() => this.commit(unwrapLogic(this.graph, node.id))}>解除包络</button>`;
    return nothing;
  }
  private attachmentField(node: Extract<canvas.LogicNode, { kind: 'loop' | 'convert' }>): TemplateResult {
    const candidates = this.graph.nodes.filter(
      (n) =>
        n.kind === 'envelope' &&
        (node.kind === 'loop' ? canvas.logicIsFlow(this.graph, n) : n.category === 'data'),
    );
    const current = node.kind === 'loop' ? node.body : node.input;
    return html`<label
      >附着包络<select
        aria-label="附着包络"
        @change=${(e: Event) => this.attach(node.id, (e.target as HTMLSelectElement).value || undefined)}
      >
        <option value="" .selected=${live(current === undefined)}>未附着</option>
        ${candidates.map((n) => html`<option value=${n.id} .selected=${live(current === n.id)}>${logicTitle(n, this.methods)} (${n.id})</option>`)}
      </select></label
    >`;
  }
}
