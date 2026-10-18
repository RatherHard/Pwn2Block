import { LitElement, css, html, nothing } from 'lit';
import {
  ACTION_NAMES,
  availableNodeSpecs,
  CURRENT_STAGE,
  nodeSpec,
  defaultParams,
  nodeParams,
  emptyGraphDocument,
  parseGraphDocument,
} from '@pwn2block/shared';
import type {
  ActionName,
  GraphDocument,
  ParamSpec,
  ParamValue,
  PublicChallenge,
  WorkflowIssue,
} from '@pwn2block/shared';
import { compileGraph } from '../workflow/compile';
import { checkParam } from '../workflow/params';
import { lookupGraph } from '../workflow/document';
import type { WorkflowArtifact, WorkflowContext } from '../workflow/types';
import { defaultStore, type KeyValueStore } from '../viewmodel/storage';
import {
  addNode,
  connect,
  copySelection,
  createEditor,
  disconnect,
  moveInto,
  moveNodes,
  moveOut,
  paste,
  redo,
  removeNodes,
  reorder,
  reorderAfter,
  select,
  setParam,
  undo,
  type EditResult,
  type GraphEditorState,
} from '../graph/editor';
import './graph-canvas';
import type { GraphEdit, Pwn2BlockGraphCanvas } from './graph-canvas';
import { sharedStyles, terminalTheme } from '../theme';

/**
 * 节点画布面板（06 §3–§5；07 §P2/P3）：工具箱 + 画布 + 检查器 + 编译预览。
 *
 * 位置与边界：
 * - **自带编辑器状态**：画布只收手势，命令在这里落到 `graph/editor`，文档存本地（按题目 id 分开）。
 * - **编译是本地纯计算**：数据节点求值 + 生成动作，产物只用于预览与后续运行；Python 求值经注入的
 *   `python` 求值器（服务端隔离运行器未启用时明确报 `python_unavailable`，不回落到浏览器执行）。
 * - **替换 Blockly 是 P9 的事**：这一个面板目前挂在受控入口（`?editor=graph`）后面，跑/提交仍走积木。
 */

const STORAGE_PREFIX = 'pwn2block.graph.';

/** 没有 localStorage 时的兜底：不保存，但调用方不必到处判空。 */
const MEMORY_STORE: KeyValueStore = {
  getItem: () => null,
  setItem: () => undefined,
};

export class Pwn2BlockGraphPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: 12rem minmax(0, 1fr) 18rem;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 0.5rem;
        height: 100%;
        min-height: 0;
        padding: 0.6rem 0 0;
      }
      header {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .toolbox {
        grid-row: 2;
        overflow: auto;
        border: var(--p2b-border) solid var(--p2b-line);
        padding: 0.4rem;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .toolbox h3 {
        margin: 0.35rem 0 0.25rem;
      }
      .toolbox button {
        display: block;
        width: 100%;
        text-align: left;
        margin-bottom: 0.2rem;
      }
      .canvas-host {
        grid-row: 2;
        min-height: 0;
        min-width: 0;
      }
      .inspector {
        grid-row: 2;
        overflow: auto;
        border: var(--p2b-border) solid var(--p2b-line);
        padding: 0.4rem;
        scrollbar-color: var(--p2b-line) transparent;
      }
      footer {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
        padding-top: 0.35rem;
        max-height: 12rem;
        overflow: auto;
      }
      .issues {
        margin: 0;
        padding-left: 1.2rem;
      }
      .issues li.error {
        color: var(--p2b-error);
      }
      .issues li.warning {
        color: var(--p2b-changed);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .param {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        margin-bottom: 0.45rem;
      }
      .bad {
        color: var(--p2b-error);
      }
      .ok {
        color: var(--p2b-ip);
      }
      code {
        color: var(--p2b-data);
      }
      label {
        color: var(--p2b-dim);
      }
      input,
      select,
      textarea {
        font: inherit;
        color: var(--p2b-fg);
        background: var(--p2b-bg);
        border: 1px solid var(--p2b-line);
        padding: 0.1rem 0.25rem;
        width: 100%;
      }
      textarea {
        min-height: 7rem;
        resize: vertical;
      }
      button {
        font: inherit;
        color: var(--p2b-fg);
        background: var(--p2b-bg);
        border: var(--p2b-border) solid var(--p2b-line);
        padding: 0.1rem 0.5rem;
        cursor: pointer;
      }
      button:disabled {
        color: var(--p2b-dim);
        border-color: var(--p2b-dim);
        cursor: not-allowed;
      }
    `,
  ];

  static override properties = {
    challenge: { attribute: false },
    store: { attribute: false },
  };

  declare challenge?: PublicChallenge;
  declare store?: KeyValueStore;

  private editor: GraphEditorState = createEditor(emptyGraphDocument());
  private artifact?: WorkflowArtifact;
  private issues: WorkflowIssue[] = [];
  private status = '还没有编译。搭好图后点「编译」。';
  private compiledRevision = -1;
  private message = '';
  private loadedFor = '';

  override render() {
    const challenge = this.challenge;
    if (challenge === undefined) return html`<p>正在等待题面…</p>`;
    this.ensureLoaded(challenge);
    const state = this.editor;
    const selected = state.selection
      .map((id) => state.document.nodes.find((node) => node.id === id))
      .filter((node) => node !== undefined);
    const stale = this.compiledRevision !== state.semanticRevision;
    return html`
      <header>
        <strong>节点画布</strong>
        <button
          part="compile"
          ?disabled=${state.document.main.length === 0}
          @click=${() => this.compile()}
        >编译</button>
        <button ?disabled=${state.past.length === 0} @click=${() => this.setEditor(undo(state))}>撤销</button>
        <button ?disabled=${state.future.length === 0} @click=${() => this.setEditor(redo(state))}>重做</button>
        <button @click=${() => this.canvas()?.fit()}>适应窗口</button>
        <span class=${stale ? 'bad' : 'ok'}>${this.status}</span>
      </header>
      ${this.renderToolbox()}
      <div class="canvas-host">
        <pwn2block-graph-canvas
          .state=${state}
          .context=${this.portContext(challenge)}
          .previews=${this.artifact?.previews ?? []}
          .issues=${this.issues}
          @p2b-graph-edit=${(event: CustomEvent<GraphEdit>) => this.onEdit(event.detail)}
          @p2b-graph-undo=${() => this.setEditor(undo(this.editor))}
          @p2b-graph-redo=${() => this.setEditor(redo(this.editor))}
          @p2b-graph-copy=${() => this.setEditor(copySelection(this.editor))}
          @p2b-graph-paste=${() => this.run((editor) => paste(editor, this.portContextOf()))}
          @p2b-graph-message=${(event: CustomEvent<{ message: string }>) => this.say(event.detail.message)}
        ></pwn2block-graph-canvas>
      </div>
      ${this.renderInspector(selected, challenge)}
      <footer>
        ${this.message === '' ? nothing : html`<p class="bad">${this.message}</p>`}
        ${this.renderIssues()}
      </footer>
    `;
  }

  private renderToolbox() {
    const stage = CURRENT_STAGE;
    const groups = new Map<string, { label: string; kinds: { kind: string; label: string; summary: string }[] }>();
    for (const spec of availableNodeSpecs(stage)) {
      const group = groups.get(spec.category) ?? { label: spec.category, kinds: [] };
      group.kinds.push({ kind: spec.kind, label: spec.label, summary: spec.summary });
      groups.set(spec.category, group);
    }
    return html`<aside class="toolbox" aria-label="工具箱">
      ${[...groups.values()].map(
        (group) => html`<section>
          <h3>${group.label}</h3>
          ${group.kinds.map(
            (item) => html`<button
              title=${item.summary}
              data-kind=${item.kind}
              @click=${() => this.run((state) => addNode(state, { kind: item.kind }))}
            >${item.label}</button>`,
          )}
        </section>`,
      )}
    </aside>`;
  }

  private renderInspector(
    selected: readonly { id: string; kind: string; params: Record<string, ParamValue> }[],
    challenge: PublicChallenge,
  ) {
    if (selected.length === 0) {
      return html`<aside class="inspector" aria-label="检查器">
        <p>选中节点后可在这里改参数。</p>
        <p>快捷键：<code>Delete</code> 删除、<code>Ctrl+Z/Y</code> 撤销/重做、<code>Ctrl+C/V</code> 复制/粘贴、
          <code>方向键</code> 微调、<code>f</code> 适应窗口、<code>c</code> 键盘接线。</p>
      </aside>`;
    }
    if (selected.length > 1) {
      return html`<aside class="inspector" aria-label="检查器">
        <p>已选中 ${selected.length} 个节点。</p>
        <button @click=${() => this.run((state) => removeNodes(state, this.editor.selection))}>删除选中</button>
      </aside>`;
    }
    const node = selected[0];
    if (node === undefined) return nothing;
    const spec = nodeSpec(node.kind);
    const specs = spec === undefined ? [] : nodeParams(spec, defaultParams(spec));
    const lookup = lookupGraph(this.editor.document);
    const placement = lookup.placements.get(node.id);
    const container = placement?.container;
    return html`<aside class="inspector" aria-label="检查器">
      <h3>${spec?.label ?? node.kind}</h3>
      <p><code>${node.id}</code></p>
      ${placement === undefined
        ? nothing
        : html`<div class="row">
            <button ?disabled=${placement.index === 0} @click=${() => this.run((state) => reorder(state, node.id, -1))}>前移</button>
            <button @click=${() => this.run((state) => reorder(state, node.id, 1))}>后移</button>
            ${container === undefined
              ? nothing
              : html`<button @click=${() => this.setEditor(moveOut(this.editor, [node.id]))}>移出容器</button>`}
          </div>`}
      ${specs.map((param) => this.renderParam(node.id, param, challenge))}
      <div class="row">
        <button @click=${() => this.canvas()?.focusNode(node.id)}>定位</button>
        <button @click=${() => this.run((state) => removeNodes(state, [node.id]))}>删除</button>
      </div>
    </aside>`;
  }

  private renderParam(nodeId: string, param: ParamSpec, challenge: PublicChallenge) {
    const node = this.editor.document.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return nothing;
    const value = node.params[param.name] ?? param.default;
    const reason = checkParam(param, value);
    const error = reason === undefined ? nothing : html`<span class="bad">${reason}</span>`;
    const update = (next: ParamValue) =>
      this.setEditor(setParam(this.editor, nodeId, param.name, next, this.portContext(challenge)));

    if (param.kind === 'select' || param.kind === 'type') {
      const options =
        param.kind === 'select' ? (param.options ?? []) : (param.options ?? []);
      return html`<div class="param">
        <label for=${`${nodeId}-${param.name}`}>${param.label}</label>
        <select
          id=${`${nodeId}-${param.name}`}
          @change=${(event: Event) => update((event.target as HTMLSelectElement).value)}
        >
          ${options.map(
            (option) => html`<option value=${option.value} ?selected=${String(value) === option.value}>
              ${option.label}
            </option>`,
          )}
        </select>
        ${error}
      </div>`;
    }
    if (param.kind === 'code' || param.kind === 'portList') {
      const text = Array.isArray(value) ? value.join(',') : String(value);
      return html`<div class="param">
        <label for=${`${nodeId}-${param.name}`}>${param.label}</label>
        <textarea
          id=${`${nodeId}-${param.name}`}
          .value=${text}
          @change=${(event: Event) => {
            const raw = (event.target as HTMLTextAreaElement).value;
            update(param.kind === 'portList' ? splitPorts(raw) : raw);
          }}
        ></textarea>
        ${error}
      </div>`;
    }
    return html`<div class="param">
      <label for=${`${nodeId}-${param.name}`}>${param.label}</label>
      <input
        id=${`${nodeId}-${param.name}`}
        .value=${String(value)}
        @change=${(event: Event) => update(coerce(param, (event.target as HTMLInputElement).value))}
      />
      ${error}
    </div>`;
  }

  private renderIssues() {
    if (this.issues.length === 0) return nothing;
    return html`<p>问题 ${this.issues.length} 条</p>
      <ul class="issues">
        ${this.issues.slice(0, 12).map(
          (issue) => html`<li class=${issue.severity}>
            ${issue.nodeId === '' ? '' : html`<code>${issue.nodeId}</code> `}${issue.message}
          </li>`,
        )}
      </ul>`;
  }

  // ------------------------------------------------------------------ 状态

  private ensureLoaded(challenge: PublicChallenge): void {
    if (this.loadedFor === challenge.id) return;
    this.loadedFor = challenge.id;
    const stored = this.storage().getItem(`${STORAGE_PREFIX}${challenge.id}`) ?? undefined;
    const document = stored === undefined ? emptyGraphDocument() : restore(stored) ?? emptyGraphDocument();
    this.editor = createEditor(document);
    this.artifact = undefined;
    this.issues = [];
    this.status = stored === undefined ? '还没有编译。搭好图后点「编译」。' : '已恢复上次的图，还没有编译。';
    this.compiledRevision = -1;
  }

  private storage(): KeyValueStore {
    return this.store ?? defaultStore() ?? MEMORY_STORE;
  }

  private persist(): void {
    const challenge = this.challenge;
    if (challenge === undefined) return;
    this.storage().setItem(`${STORAGE_PREFIX}${challenge.id}`, JSON.stringify(this.editor.document));
  }

  private setEditor(next: GraphEditorState): void {
    this.editor = next;
    this.persist();
    this.requestUpdate();
  }

  private say(message: string): void {
    this.message = message;
    this.requestUpdate();
  }

  private run(edit: (state: GraphEditorState) => GraphEditorState | EditResult): void {
    const result = edit(this.editor);
    if ('ok' in result) {
      if (!result.ok) {
        this.say(result.message);
        return;
      }
      this.message = '';
      this.setEditor(result.state);
      return;
    }
    this.message = '';
    this.setEditor(result);
  }

  private onEdit(edit: GraphEdit): void {
    switch (edit.type) {
      case 'select':
        this.setEditor(select(this.editor, edit.ids));
        return;
      case 'move':
        this.setEditor(moveNodes(this.editor, edit.moves));
        return;
      case 'connect': {
        const result = connect(this.editor, this.portContextOf(), edit.from, edit.to);
        if (!result.ok) this.say(result.message);
        else this.setEditor(result.state);
        return;
      }
      case 'delete':
        this.setEditor(removeNodes(this.editor, edit.ids));
        return;
      case 'moveInto': {
        const result = moveInto(this.editor, edit.nodeIds, edit.container, edit.region);
        if (result.ok) this.setEditor(result.state);
        else this.say(result.message);
        return;
      }
      case 'reorder':
        this.setEditor(reorderAfter(this.editor, edit.nodeId, edit.after));
        return;
      case 'disconnect':
        this.setEditor(disconnect(this.editor, edit.edge));
        return;
    }
  }

  private canvas(): Pwn2BlockGraphCanvas | undefined {
    return this.shadowRoot?.querySelector('pwn2block-graph-canvas') ?? undefined;
  }

  private portContextOf() {
    const challenge = this.challenge;
    return this.portContext(challenge as PublicChallenge);
  }

  private portContext(challenge: PublicChallenge) {
    return {
      archBits: challenge.archBits,
      authorBlocks: challenge.authorBlocks,
    };
  }

  /** 编译：本地求值 + 生成动作，只更新预览与问题，不发送任何请求。 */
  private async compile(): Promise<void> {
    const challenge = this.challenge;
    if (challenge === undefined) return;
    const context: WorkflowContext = {
      archBits: challenge.archBits,
      allowedActions: challenge.allowedActions.filter((name): name is ActionName =>
        (ACTION_NAMES as readonly string[]).includes(name),
      ),
      ...(challenge.authorBlocks === undefined ? {} : { authorBlocks: challenge.authorBlocks }),
    };
    this.status = '正在编译…';
    this.requestUpdate();
    const revision = this.editor.semanticRevision;
    const outcome = await compileGraph({
      document: this.editor.document,
      context,
      documentRevision: revision,
    });
    if (!outcome.ok) {
      this.artifact = undefined;
      this.issues = [...outcome.issues];
      this.status = `编译失败：${outcome.issues.length} 个问题`;
      this.compiledRevision = revision;
      this.requestUpdate();
      return;
    }
    this.artifact = outcome.artifact;
    this.issues = [...(outcome.warnings ?? [])];
    this.compiledRevision = revision;
    this.status = `编译成功：${outcome.artifact.actions.length} 个动作`;
    this.requestUpdate();
  }
}

function splitPorts(raw: string): readonly string[] {
  return raw
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** 输入框里的字符串按参数类型转换；转换不了就原样交给校验器报错。 */
function coerce(param: ParamSpec, raw: string): ParamValue {
  if (param.kind === 'int' || param.kind === 'hex') {
    const trimmed = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    return raw;
  }
  return raw;
}

function restore(raw: string): GraphDocument | undefined {
  const parsed = safeJson(raw);
  if (parsed === 'invalid') return undefined;
  const result = parseGraphDocument(parsed);
  if (!result.ok) return undefined;
  return result.document;
}

function safeJson(raw: string): unknown | 'invalid' {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return 'invalid';
  }
}

customElements.define('pwn2block-graph-panel', Pwn2BlockGraphPanel);
declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-graph-panel': Pwn2BlockGraphPanel;
  }
}
