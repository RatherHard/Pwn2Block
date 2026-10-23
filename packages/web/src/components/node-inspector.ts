import { LitElement, css, html, nothing } from 'lit';
import type {
  GraphDocument,
  GraphNode,
  InputPortSpec,
  NodeKindSpec,
  ParamSpec,
  ParamValue,
  PortContext,
  WorkflowIssue,
} from '@pwn2block/shared';
import { nodeInputs, nodeParams, nodeSpec } from '@pwn2block/shared';
import { portModeOf } from '../graph/editor';
import { PORT_LABELS } from '../graph/port-style';
import type { NodePreview } from '../workflow/types';
import { sharedStyles, terminalTheme } from '../theme';
import { nodeSkin } from './node-skin';
import { renderParamField } from './param-field';

/**
 * 常驻属性面板（10 §2.1、§2.2、§6）。
 *
 * 所有属性编辑统一在这里完成，修改通过命令写入文档，画布同步展示只读值。
 * 命名输入与题目动作配置均使用同一份文档。
 */

export type InspectorAction =
  | 'focus'
  | 'delete'
  | 'collapse'
  | 'expand'
  | 'move-out';

export class Pwn2BlockNodeInspector extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    nodeSkin,
    css`
      :host {
        display: block;
        height: 100%;
        overflow: auto;
        border: var(--p2b-border) solid var(--p2b-line);
        padding: 0.4rem 0.5rem;
        scrollbar-color: var(--p2b-line) transparent;
      }
      header {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        flex-wrap: wrap;
        padding-bottom: 0.3rem;
        border-bottom: 1px solid var(--p2b-line);
      }
      header .id {
        color: var(--p2b-dim);
      }
      section {
        margin-top: 0.5rem;
      }
      section > h3 {
        margin-bottom: 0.25rem;
      }
      .param-field {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        margin-bottom: 0.45rem;
      }
      .param-field > label {
        color: var(--p2b-dim);
      }
      .param-line {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        flex-wrap: wrap;
      }
      .param-line input[type='text'],
      .param-line select,
      .param-line textarea {
        width: 100%;
        min-height: 1.6rem;
        padding: 0.1rem 0.25rem;
        font: inherit;
        color: var(--p2b-fg);
        background: var(--p2b-bg);
        border: 1px solid var(--p2b-line);
        border-radius: 0;
      }
      .param-line textarea {
        min-height: 4rem;
        resize: vertical;
      }
      .param-line input[data-invalid='true'] {
        border-color: var(--p2b-error);
      }
      .param-mode {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        flex-wrap: wrap;
      }
      .param-mode .hint {
        color: var(--p2b-dim);
      }
      .param-mode button {
        min-height: 1.4rem;
        padding: 0 0.3rem;
      }
      .bad {
        color: var(--p2b-error);
      }
      .ports {
        width: 100%;
        border-collapse: collapse;
      }
      .ports td,
      .ports th {
        padding: 0.1rem 0.3rem;
        border-bottom: 1px dotted var(--p2b-line);
      }
      .ports button {
        min-height: 1.2rem;
        padding: 0 0.25rem;
        border-width: 1px;
      }
      .muted {
        color: var(--p2b-dim);
      }
      .actions {
        display: flex;
        gap: 0.3rem;
        flex-wrap: wrap;
        margin-top: 0.5rem;
      }
      .issue {
        color: var(--p2b-error);
      }
    `,
  ];

  static override properties = {
    node: { attribute: false },
    document: { attribute: false },
    context: { attribute: false },
    issues: { attribute: false },
    preview: { attribute: false },
    selectionCount: { attribute: false },
    collapsed: { attribute: false },
  };

  /** 当前选中的节点；`undefined` 时显示「选中节点」的简短提示。 */
  declare node: GraphNode | undefined;
  declare document: GraphDocument | undefined;
  declare context: PortContext | undefined;
  declare issues: readonly WorkflowIssue[] | undefined;
  declare preview: NodePreview | undefined;
  declare selectionCount: number;
  /** 容器节点当前是否折叠。 */
  declare collapsed: boolean;


  override render() {
    const node = this.node;
    const document = this.document;
    if (node === undefined || document === undefined) {
      return html`<header><h2>属性</h2></header>
        <p class="muted">选中一个节点后，在这里修改属性；画布节点只显示属性值。</p>
        ${this.selectionCount > 1
          ? html`<p class="muted">已选中 ${this.selectionCount} 个节点：属性面板一次只编辑一个。</p>`
          : nothing}`;
    }
    const spec = nodeSpec(node.kind);
    if (spec === undefined) {
      return html`<header><h2>${node.kind}</h2></header><p class="bad">未知节点类型：${node.kind}</p>`;
    }
    return html`<header>
        <h2>${spec.label}</h2>
        <span class="id">${node.id}</span>
        ${this.selectionCount > 1 ? html`<span class="muted">（已选中 ${this.selectionCount} 个）</span>` : nothing}
      </header>
      ${this.renderPreview()} ${this.renderParams(node, spec)} ${this.renderPorts(node, spec)}
      ${this.renderIssues()} ${this.renderActions(node, spec)}`;
  }

  private renderParams(node: GraphNode, spec: NodeKindSpec): unknown {
    const document = this.document;
    if (document === undefined) return nothing;
    const context = this.context ?? { archBits: 64 };
    const params = nodeParams(spec, node.params);
    // 动态输入（题目积木、命名输入）也是「可手填的参数」：没有固定 ParamSpec，就用端口类型造一个。
    const declared = new Set(params.map((param) => param.name));
    const dynamic = nodeInputs(spec, node.params, context)
      .filter((input) => !declared.has(input.name))
      .map((input) => paramLike(input));
    return html`<section>
      <h3>参数</h3>
      ${[...params, ...dynamic].map((param) => {
        const mode = param.port === undefined ? undefined : portModeOf(document, node.id, param.name);
        return renderParamField({
          nodeId: node.id,
          param,
          value: node.params[param.name],
          mode: mode?.mode ?? 'inline',
          ...(mode?.source === undefined ? {} : { source: mode.source }),
          onValue: (value: ParamValue) => this.emitParam(param.name, value),
          onMode: (next) => this.emitMode(param.name, next),
        });
      })}
    </section>`;
  }

  private renderPorts(node: GraphNode, spec: NodeKindSpec): unknown {
    const document = this.document;
    if (document === undefined) return nothing;
    const inputs = nodeParams(spec, node.params).filter((param) => param.port !== undefined);
    const outputType = spec.dynamicOutput?.(node.params) ?? spec.output;
    if (inputs.length === 0 && outputType === undefined) return nothing;
    return html`<section>
      <h3>端口与来源</h3>
      <table class="ports">
        <thead><tr><th>端口</th><th>类型</th><th>来源</th></tr></thead>
        <tbody>
          ${inputs.map((param) => {
            const mode = portModeOf(document, node.id, param.name);
            const connected = document.connections.find(
              (connection) => connection.to.node === node.id && connection.to.port === param.name,
            );
            return html`<tr>
              <td>${param.label}</td>
              <td>${PORT_LABELS[param.port ?? 'int']}</td>
              <td>
                ${connected === undefined
                  ? html`<span class="muted">${mode.mode === 'port' ? '接线中（未连上）' : '手填'}</span>`
                  : html`<button type="button" data-source=${`${connected.from.node}.${connected.from.port}`}
                      @click=${() => this.emitAction('focus')}>${connected.from.node}.${connected.from.port}</button>`}
              </td>
            </tr>`;
          })}
          ${outputType === undefined
            ? nothing
            : html`<tr><td>结果（输出）</td><td>${PORT_LABELS[outputType]}</td><td class="muted">供下游接线</td></tr>`}
        </tbody>
      </table>
    </section>`;
  }

  private renderPreview(): unknown {
    const preview = this.preview;
    if (preview === undefined) return nothing;
    return html`<section>
      <h3>当前值</h3>
      <p class="mono">${preview.summary}</p>
      ${preview.segments === undefined || preview.segments.length === 0
        ? nothing
        : html`<table class="ports">
            <thead><tr><th>分段</th><th>偏移</th><th>长度</th></tr></thead>
            <tbody>
              ${preview.segments.map(
                (segment) => html`<tr>
                  <td>${segment.port}</td>
                  <td>${segment.offset}</td>
                  <td>${segment.length}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </section>`;
  }

  private renderIssues(): unknown {
    const node = this.node;
    if (node === undefined) return nothing;
    const issues = (this.issues ?? []).filter((issue) => issue.nodeId === node.id);
    if (issues.length === 0) return nothing;
    return html`<section>
      <h3>问题</h3>
      ${issues.map(
        (issue) => html`<p class=${issue.severity === 'error' ? 'issue' : 'muted'}>${issue.message}</p>`,
      )}
    </section>`;
  }

  private renderActions(node: GraphNode, spec: NodeKindSpec): unknown {
    const isContainer = (spec.regions?.length ?? 0) > 0 || spec.dynamicRegions !== undefined;
    const inRegion = this.regionOf(node.id) !== undefined;
    return html`<div class="actions">
      <button type="button" @click=${() => this.emitAction('focus')}>定位</button>
      ${isContainer
        ? html`<button type="button" @click=${() => this.emitAction(this.collapsed ? 'expand' : 'collapse')}>
            ${this.collapsed ? '展开' : '折叠'}
          </button>`
        : nothing}
      ${inRegion ? html`<button type="button" @click=${() => this.emitAction('move-out')}>移出容器</button>` : nothing}
      <button type="button" @click=${() => this.emitAction('delete')}>删除节点</button>
    </div>`;
  }

  /** 节点是否在某块区域里：只查一层就够，嵌套时「移出」依然有效。 */
  private regionOf(nodeId: string): { container: string; region: string } | undefined {
    const document = this.document;
    if (document === undefined) return undefined;
    for (const node of document.nodes) {
      for (const [region, members] of Object.entries(node.regions ?? {})) {
        if (members.includes(nodeId)) return { container: node.id, region };
      }
    }
    return undefined;
  }

  private emitParam(name: string, value: ParamValue): void {
    this.dispatchEvent(
      new CustomEvent('p2b-inspector-param', { detail: { name, value }, bubbles: true, composed: true }),
    );
  }

  private emitMode(port: string, mode: 'inline' | 'port'): void {
    this.dispatchEvent(
      new CustomEvent('p2b-inspector-mode', { detail: { port, mode }, bubbles: true, composed: true }),
    );
  }

  private emitAction(action: InspectorAction): void {
    this.dispatchEvent(
      new CustomEvent('p2b-inspector-action', { detail: { action }, bubbles: true, composed: true }),
    );
  }
}

/**
 * 动态端口 → 可编辑参数：题目积木的 `data` 之类没有固定 ParamSpec，
 * 但用户仍然要能手填，所以按端口类型造一个同等形状的参数描述。
 */
function paramLike(input: InputPortSpec): ParamSpec {
  if (input.type === 'int') return { name: input.name, label: input.label, kind: 'int', default: 0, port: input.type };
  if (input.type === 'text') return { name: input.name, label: input.label, kind: 'text', default: '', port: input.type };
  if (input.type === 'bool') {
    return {
      name: input.name,
      label: input.label,
      kind: 'select',
      default: 'false',
      options: [
        { value: 'true', label: '真' },
        { value: 'false', label: '假' },
      ],
      port: input.type,
    };
  }
  return { name: input.name, label: input.label, kind: 'hex', default: '', port: input.type };
}

customElements.define('pwn2block-node-inspector', Pwn2BlockNodeInspector);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-node-inspector': Pwn2BlockNodeInspector;
  }
}
