import { LitElement, css, html, nothing } from 'lit';
import {
  ACTION_NAMES,
  NODE,
  availableNodeSpecs,
  CURRENT_STAGE,
  nodeSpec,
  nodeRegions,
  defaultParams,
  nodeParams,
  collectModuleBundle,
  emptyGraphDocument,
  makeGraphSave,
  parseGraphDocument,
  parseGraphSave,
} from '@pwn2block/shared';
import type { GraphDocument } from '@pwn2block/shared';
import type {
  ActionName,
  ParamSpec,
  ParamValue,
  PublicChallenge,
  PythonCapability,
  WorkflowIssue,
} from '@pwn2block/shared';
import { compileGraph } from '../workflow/compile';
import { checkParam } from '../workflow/params';
import { lookupGraph } from '../workflow/document';
import { extractModule } from '../graph/extract';
import { groupSelection, setPortMode, ungroup, withDocument } from '../graph/editor';
import { locateTarget, type LocateRequest } from '../graph/locate';
import { moduleViewState, withModuleBody } from '../graph/module-view';
import { upgradeModule, upgradeTargetOf } from '../graph/module-upgrade';
import { importDocument } from '../graph/transfer';
import { loadGraph, saveGraph } from '../graph/storage';
import { createHttpPython, fetchPythonCapability } from '../workflow/python-evaluator';
import type { NodePreview, PreviewSegment, WorkflowArtifact, WorkflowContext } from '../workflow/types';
import type { GraphNode as WorkspaceNodeLike } from '@pwn2block/shared';
import { defaultStore, type KeyValueStore } from '../viewmodel/storage';
import type { PayloadControlsModel } from '../viewmodel/toolbar';
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
  setCollapsed,
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
      button.link {
        border: none;
        background: none;
        padding: 0;
        color: var(--p2b-data);
        text-decoration: underline;
      }
      tr.selected td {
        background: var(--p2b-changed);
        color: var(--p2b-bg);
      }
      .load-failure {
        border: var(--p2b-border) solid var(--p2b-error);
        padding: 0.25rem 0.4rem;
      }
      .trace ol {
        margin: 0;
        padding-left: 1.2rem;
      }
    `,
  ];

  static override properties = {
    challenge: { attribute: false },
    store: { attribute: false },
    controls: { attribute: false },
    highlightNodeId: { attribute: false },
  };

  declare challenge?: PublicChallenge;
  declare store?: KeyValueStore;
  /** 运行/终止按钮的可用性与原因由控制器算好（`payloadControls`），这里只渲染、只派发。 */
  declare controls?: PayloadControlsModel;
  /** 执行结果的定位目标：真实动作结果对应的节点 id（可能为空 = 清除高亮）。 */
  declare highlightNodeId?: string;

  private editor: GraphEditorState = createEditor(emptyGraphDocument());
  private artifact?: WorkflowArtifact;
  private issues: WorkflowIssue[] = [];
  private status = '还没有编译。搭好图后点「编译」。';
  private compiledRevision = -1;
  private message = '';
  private loadedFor = '';
  private pythonCapability: PythonCapability | undefined;
  private capabilityLoaded = false;
  /** 编辑模块体时保存主图；`editingModuleId` 为空表示当前就在主图。 */
  private mainEditor?: GraphEditorState;
  private editingModuleId?: string;
  /** 当前编译的取消句柄：语义编辑或重新编译都会取消上一次。 */
  private abort: AbortController | undefined;
  /** 存档读取失败时保留原因与原文：不覆盖、不猜，给用户一个导出出口。 */
  private loadFailure?: { readonly reason: string; readonly raw?: string; readonly issues?: readonly string[] };
  /** 存档迁移/恢复的说明（旧积木、旧画布），显示一次就够。 */
  private loadNote = '';
  /** 当前选中的组装分段：高亮输入端口并显示对应结果字节。 */
  private segmentFocus?: { readonly nodeId: string; readonly port: string };
  /** 最近一次写入是否失败：只提示一次，避免每次拖动都刷同一句。 */
  private persistFailed = false;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadCapability();
  }

  /** 读一次 Python 能力；失败就保持「未知」，不把节点当成可用。 */
  private async loadCapability(): Promise<void> {
    if (this.capabilityLoaded) return;
    this.capabilityLoaded = true;
    this.pythonCapability = await fetchPythonCapability();
    this.requestUpdate();
  }

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
        <span class="breadcrumb">
          ${this.editingModuleId === undefined
            ? '主图'
            : html`<button class="crumb" @click=${() => this.exitModule()}>主图</button> / ${this.moduleLabel()}`}
        </span>
        <button
          part="compile"
          ?disabled=${this.editingModuleId !== undefined || state.document.main.length === 0}
          @click=${() => this.compile()}
        >编译</button>
        ${this.controls === undefined ? nothing : this.renderRunControls()}
        <button ?disabled=${!this.canUndo()} @click=${() => this.undoEdit()}>撤销</button>
        <button ?disabled=${!this.canRedo()} @click=${() => this.redoEdit()}>重做</button>
        ${this.editingModuleId !== undefined || state.selection.length < 2
          ? nothing
          : html`<button @click=${() => this.run((editor) => groupSelection(editor))}>分组</button>`}
        ${this.editingModuleId !== undefined || state.selection.length === 0
          ? nothing
          : html`<button @click=${() => this.extractSelection()}>提取为模块</button>`}
        <button @click=${() => this.canvas()?.fit()}>适应窗口</button>
        ${this.editingModuleId === undefined
          ? html`<button @click=${() => this.exportGraph()}>导出</button>
              <label class="import">导入<input type="file" accept="application/json,.json" @change=${(event: Event) => this.importGraph(event)} /></label>`
          : nothing}
        ${this.renderPythonStatus()}
        <span class=${stale ? 'bad' : 'ok'}>${this.status}</span>
      </header>
      ${this.renderToolbox()}
      <div class="canvas-host">
        <pwn2block-graph-canvas
          .state=${state}
          .context=${this.portContext(challenge)}
          .previews=${this.artifact?.previews ?? []}
          .issues=${this.issues}
          .highlightNodeId=${this.highlightNodeId}
          .focusPort=${this.segmentFocus === undefined ? undefined : { nodeId: this.segmentFocus.nodeId, port: this.segmentFocus.port }}
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
        ${this.loadNote === '' ? nothing : html`<p class="hint">${this.loadNote}</p>`}
        ${this.loadFailure === undefined ? nothing : this.renderLoadFailure()}
        ${this.message === '' ? nothing : html`<p class="bad">${this.message}</p>`}
        ${this.renderIssues()} ${this.renderTrace()}
      </footer>
    `;
  }

  /** 运行/终止：可用性与禁用原因全部来自控制器给的模型（07 §P9 默认画布后仍只有一份门禁）。 */
  private renderRunControls() {
    const controls = this.controls;
    if (controls === undefined) return nothing;
    const dispatch = (command: 'run-all' | 'abort'): void => {
      this.dispatchEvent(
        new CustomEvent('p2b-graph-run', {
          detail: command,
          bubbles: true,
          composed: true,
        }),
      );
    };
    return html`<span class="run-controls">
      <button
        data-run="run-all"
        ?disabled=${!controls.run.enabled}
        title=${controls.run.hint}
        aria-describedby="run-reason"
        @click=${() => dispatch('run-all')}
      >${controls.run.label}</button>
      <button
        data-run="abort"
        ?disabled=${!controls.abort.enabled}
        title=${controls.abort.disabledReason ?? controls.abort.hint}
        @click=${() => dispatch('abort')}
      >${controls.abort.label}</button>
      <span id="run-reason" class="hint">${controls.run.enabled ? '' : controls.run.hint}</span>
    </span>`;
  }

  /** Python 能力：不可用时写清原因，避免学习者以为节点坏了（06 §6）。 */
  private renderPythonStatus() {
    const capability = this.pythonCapability;
    if (capability === undefined) return html`<span class="bad">Python：未知</span>`;
    if (!capability.available) {
      return html`<span class="bad">Python：不可用${capability.reason === undefined ? '' : `（${capability.reason}）`}</span>`;
    }
    const isolation = capability.isolated ? '已隔离' : '未隔离，仅开发';
    return html`<span class="ok">Python：${capability.backend} · ${isolation}</span>`;
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
      ${this.renderModules()} ${this.renderGroups()}
    </aside>`;
  }

  /** 已定义的模块：显示种类/版本/被调用次数，并可插入调用节点（模块体在提取时生成）。 */
  private renderModules() {
    const modules = this.editor.document.modules ?? [];
    if (modules.length === 0) {
      return nothing;
    }
    const usage = new Map<string, number>();
    for (const node of this.editor.document.nodes) {
      const id = typeof node.params.moduleId === 'string' ? node.params.moduleId : '';
      if (id !== '') usage.set(id, (usage.get(id) ?? 0) + 1);
    }
    return html`<section class="modules">
      <h3>模块</h3>
      ${modules.map(
        (module) => html`<span class="module-row">
        <button
          title="${module.kind === 'flow' ? '流程模块' : '数据模块'} · ${usage.get(module.id) ?? 0} 处调用"
          data-module=${module.id}
          @click=${() =>
            this.run((state) =>
              addNode(state, {
                kind: module.kind === 'flow' ? NODE.moduleCall : NODE.moduleData,
                params: {
                  moduleId: module.id,
                  moduleVersion: module.version,
                  ...(module.output === undefined ? { hasOutput: 'no' } : { hasOutput: 'yes', outputType: module.output.type }),
                  ...(module.output === undefined ? {} : { outputType: module.output.type }),
                  inputs: module.inputs.map((input) => `${input.name}:${input.type}`),
                },
              }),
            )}
        >${module.name} v${module.version}</button>
        <button data-edit-module=${module.id} @click=${() => this.enterModule(module.id)}>编辑</button>
        <button data-export-module=${module.id} @click=${() => this.exportModule(module.id)}>导出</button>
        </span>`,
      )}
    </section>`;
  }

  /** 已建的分组：只列名字与解组入口；分组是布局，改它不需要重新编译。 */
  private renderGroups() {
    const groups = this.editor.document.groups ?? [];
    if (groups.length === 0) return nothing;
    return html`<section class="modules">
      <h3>分组</h3>
      ${groups.map(
        (group) => html`<button data-group=${group.id} @click=${() => this.setEditor(ungroup(this.editor, group.id))}
          >${group.name} · ${group.members.length} 个节点（解组）</button
        >`,
      )}
    </section>`;
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
    const declared = spec === undefined ? [] : nodeParams(spec, defaultParams(spec));
    // 动态输入（题目积木参数、变参）同样是「可手填可接线」的参数，检查器必须给输入框，
    // 否则用户只能看到端口、没有任何地方填值（06 §3）。
    const dynamic = spec?.dynamicInputs?.(node.params, this.portContext(challenge)) ?? [];
    const specs = [
      ...declared,
      ...dynamic
        .filter((input) => !declared.some((param) => param.name === input.name))
        .map((input) => ({
          name: input.name,
          label: input.label,
          kind: (input.type === 'bytes' ? 'hex' : input.type === 'int' ? 'int' : 'text') as ParamSpec['kind'],
          default: input.type === 'bytes' ? '' : 0,
          port: input.type,
        })),
    ];
    const lookup = lookupGraph(this.editor.document);
    const placement = lookup.placements.get(node.id);
    const container = placement?.container;
    const isContainer = spec !== undefined && nodeRegions(spec, node.params).length > 0;
    const collapsed = this.editor.document.layout[node.id]?.collapsed === true;
    const upgrade = upgradeTargetOf(this.editor.document, node);
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
      ${specs.map((param) => this.renderParam(node.id, param, challenge))} ${this.renderSegments(node)}
      ${upgrade === undefined
        ? nothing
        : html`<div class="row">
            <button @click=${() => this.upgrade(node.id)}>升级到 v${upgrade.version}</button>
            <span class="hint">输入与结果类型不变才能升级</span>
          </div>`}
      <div class="row">
        <button @click=${() => this.canvas()?.focusNode(node.id)}>定位</button>
        ${isContainer
          ? html`<button @click=${() => this.setEditor(setCollapsed(this.editor, node.id, !collapsed))}>
              ${collapsed ? '展开容器' : '折叠容器'}
            </button>`
          : nothing}
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
    const update = (next: ParamValue) => {
      const edited = setParam(this.editor, nodeId, param.name, next, this.portContext(challenge));
      // 手动填值就是选择「手填」：否则必填的端口参数会一直报「缺少输入」，即使输入框里已有值。
      this.setEditor(
        param.port === undefined ? edited : setPortMode(edited, nodeId, param.name, 'inline'),
      );
    };

    const modeSwitch = param.port === undefined ? nothing : this.renderPortMode(nodeId, param.name);

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
      ${error} ${modeSwitch}
    </div>`;
  }

  /** 组装预览：逐段显示偏移、长度与来源，编译前就能看出各段落在哪。 */
  private renderSegments(node: WorkspaceNodeLike) {
    if (node.kind !== NODE.assemble) return nothing;
    const preview = this.artifact?.previews.find((item) => item.nodeId === node.id);
    const segments = preview?.segments;
    if (segments === undefined || segments.length === 0) return nothing;
    const lookup = lookupGraph(this.editor.document);
    const selected = this.segmentFocus?.nodeId === node.id ? this.segmentFocus.port : undefined;
    const focus = segments.find((segment) => segment.port === selected);
    return html`<table class="segments">
      <thead><tr><th>段</th><th>偏移</th><th>长度</th><th>来源</th></tr></thead>
      <tbody>
        ${segments.map((segment) => {
          const incoming = lookup.incoming.get(`${node.id}\u0000${segment.port}`);
          return html`<tr class=${segment.port === selected ? 'selected' : ''}>
            <td><button class="link" @click=${() => this.focusSegment(node.id, segment)}>
              <code>${segment.port}</code>
            </button></td>
            <td>+${String(segment.offset)}</td>
            <td>${String(segment.length)}</td>
            <td>${incoming === undefined ? '手填' : incoming.source}</td>
          </tr>`;
        })}
      </tbody>
    </table>
    ${focus === undefined ? nothing : this.renderSegmentBytes(preview, focus)}`;
  }

  /** 选中分段后显示它的字节：预览只保留前 64 字节，超出时明确说明而不是假装全有。 */
  private renderSegmentBytes(preview: NodePreview | undefined, segment: PreviewSegment) {
    const hex = preview?.hex;
    if (hex === undefined) return html`<p class="hint">这一段没有字节预览。</p>`;
    const start = segment.offset * 2;
    const end = start + segment.length * 2;
    if (start >= hex.length) {
      return html`<p class="hint">这一段从第 ${String(segment.offset)} 字节开始，超出预览的 64 字节上限。</p>`;
    }
    const slice = hex.slice(start, Math.min(end, hex.length));
    const truncated = end > hex.length ? '（预览截断）' : '';
    return html`<p class="hint">第 ${String(segment.offset)} 字节起：<code>${slice}</code>${truncated}</p>`;
  }

  private focusSegment(nodeId: string, segment: PreviewSegment): void {
    const same = this.segmentFocus?.nodeId === nodeId && this.segmentFocus.port === segment.port;
    this.segmentFocus = same ? undefined : { nodeId, port: segment.port };
    this.requestUpdate();
    if (!same) void this.updateComplete.then(() => this.canvas()?.centerOnPort(nodeId, segment.port));
  }

  /** 一个端口的来源切换：手填会断线，接线要求必须有线（缺线由编译报 missing_input）。 */
  private renderPortMode(nodeId: string, port: string) {
    const node = this.editor.document.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return nothing;
    const lookup = lookupGraph(this.editor.document);
    const incoming = lookup.incoming.get(`${nodeId}\u0000${port}`);
    const mode = node.params[`${port}Mode`];
    const current = mode === 'inline' || mode === 'port' ? mode : incoming === undefined ? 'inline' : 'port';
    return html`<div class="row">
      <span class="hint">${incoming === undefined ? '手填值' : `接线自 ${incoming.source}`}</span>
      <button
        ?disabled=${current === 'inline'}
        @click=${() => this.setEditor(setPortMode(this.editor, nodeId, port, 'inline'))}
      >手填</button>
      <button
        ?disabled=${current === 'port'}
        @click=${() => this.setEditor(setPortMode(this.editor, nodeId, port, 'port'))}
      >接线</button>
    </div>`;
  }

  private renderIssues() {
    if (this.issues.length === 0) return nothing;
    return html`<p>问题 ${this.issues.length} 条</p>
      <ul class="issues">
        ${this.issues.slice(0, 12).map(
          (issue) => html`<li class=${issue.severity}>
            ${issue.nodeId === ''
              ? nothing
              : html`<button class="link" @click=${() => this.locate({ nodeId: issue.nodeId })}>
                  定位
                </button>
                <code>${issue.nodeId}</code> `}
            ${issue.message}
          </li>`,
        )}
      </ul>`;
  }

  /** 存档读取失败：说明原因、列出旧积木的具体问题，并提供原文导出（不覆盖、不猜）。 */
  private renderLoadFailure() {
    const failure = this.loadFailure;
    if (failure === undefined) return nothing;
    return html`<div class="load-failure">
      <p class="bad">${failure.reason}</p>
      ${failure.issues === undefined || failure.issues.length === 0
        ? nothing
        : html`<ul class="issues">
            ${failure.issues.map((issue) => html`<li class="warning">${issue}</li>`)}
          </ul>`}
      ${failure.raw === undefined
        ? nothing
        : html`<button @click=${() => this.downloadRaw(failure.raw as string)}>导出原文</button>`}
    </div>`;
  }

  /** 编译轨迹：分支选择、循环轮次、模块路径；点一条回到对应节点（06 §8）。 */
  private renderTrace() {
    const trace = this.artifact?.trace ?? [];
    if (trace.length === 0) return nothing;
    return html`<details class="trace">
      <summary>编译轨迹 ${trace.length} 条</summary>
      <ol>
        ${trace.slice(0, 40).map(
          (entry) => html`<li>
            <button class="link" @click=${() => this.locate({ nodeId: entry.nodeId, path: entry.path, ...(entry.rounds === undefined ? {} : { rounds: entry.rounds }) })}>
              ${entry.nodeId}
            </button>
            ${entry.rounds === undefined
              ? ''
              : html`<span class="hint">${Object.entries(entry.rounds).map(([id, round]) => `${id} 第 ${round + 1} 轮`).join('、')} </span>`}
            ${entry.message}
          </li>`,
        )}
      </ol>
    </details>`;
  }

  // ------------------------------------------------------------------ 状态

  private ensureLoaded(challenge: PublicChallenge): void {
    if (this.loadedFor === challenge.id) return;
    this.loadedFor = challenge.id;
    const loaded = loadGraph(this.storage(), challenge.id);
    this.artifact = undefined;
    this.issues = [];
    this.compiledRevision = -1;
    this.segmentFocus = undefined;
    this.persistFailed = false;
    this.loadFailure = undefined;
    this.loadNote = '';
    if (!loaded.ok) {
      this.editor = createEditor(emptyGraphDocument());
      this.status = '还没有编译。搭好图后点「编译」。';
      if (loaded.raw !== undefined) {
        this.loadFailure = { reason: loaded.reason, raw: loaded.raw, ...(loaded.issues === undefined ? {} : { issues: loaded.issues }) };
      }
      return;
    }
    this.editor = createEditor(loaded.document);
    this.status = '已恢复上次的图，还没有编译。';
    if (loaded.source === 'interim') this.loadNote = '已把上一阶段的画布存档升到新格式；旧存档保留，可回滚。';
    if (loaded.source === 'blockly') {
      this.loadNote = '已从旧积木存档迁移；旧存档原样保留，可回滚。';
      if (loaded.notes.length > 0) this.loadNote += ` ${loaded.notes.join('；')}`;
    }
  }

  private storage(): KeyValueStore {
    return this.store ?? defaultStore() ?? MEMORY_STORE;
  }

  private persist(): void {
    const challenge = this.challenge;
    if (challenge === undefined) return;
    const document = this.mainEditor?.document ?? this.editor.document;
    const ok = saveGraph(this.storage(), challenge.id, document);
    if (!ok && !this.persistFailed) {
      this.persistFailed = true;
      this.say('无法写入存档（浏览器存储不可用或已满）：当前修改只在这页有效，建议先导出。');
    }
    if (ok) this.persistFailed = false;
  }

  private setEditor(next: GraphEditorState): void {
    if (this.mainEditor !== undefined && this.editingModuleId !== undefined) {
      // 只改选中：画布与检查器要立刻反映，但不写回主图、不涨语义版本。
      if (next.document === this.editor.document) {
        this.editor = next;
        this.requestUpdate();
        return;
      }
      const semanticChanged = next.semanticRevision !== this.editor.semanticRevision;
      if (semanticChanged) this.abort?.abort();
      const merged = withModuleBody(
        this.mainEditor,
        this.editingModuleId,
        next.document,
        semanticChanged ? 'semantic' : 'layout',
      );
      if (!merged.ok) {
        this.say(merged.message);
        return;
      }
      this.mainEditor = merged.state;
      const view = moduleViewState(merged.state, this.editingModuleId, next.selection);
      if (view === undefined) {
        this.exitModule();
        return;
      }
      this.editor = view;
      this.persist();
      if (semanticChanged) {
        this.dispatchEvent(new CustomEvent('p2b-graph-edited', { bubbles: true, composed: true }));
      }
      this.requestUpdate();
      return;
    }
    const semanticChanged = next.semanticRevision !== this.editor.semanticRevision;
    // 语义变了，正在跑的 Python 求值已经没有意义：取消，别让迟到结果覆盖新产物（07 §P7）。
    if (semanticChanged) this.abort?.abort();
    this.editor = next;
    this.persist();
    if (semanticChanged) {
      this.dispatchEvent(new CustomEvent('p2b-graph-edited', { bubbles: true, composed: true }));
    }
    this.requestUpdate();
  }

  /** 进入模块体：画布切到模块自己的节点，面包屑显示模块名。 */
  private enterModule(moduleId: string): void {
    const view = moduleViewState(this.editor, moduleId);
    if (view === undefined) {
      this.say(`找不到模块 ${moduleId}`);
      return;
    }
    this.mainEditor = this.editor;
    this.editingModuleId = moduleId;
    this.editor = view;
    this.artifact = undefined;
    this.issues = [];
    this.status = '编辑模块体：返回主图后整体编译';
    this.requestUpdate();
  }

  /** 返回主图：模块体已经逐次写回，直接把主图放回画布。 */
  private exitModule(): void {
    if (this.mainEditor === undefined) return;
    this.editor = this.mainEditor;
    this.mainEditor = undefined;
    this.editingModuleId = undefined;
    this.artifact = undefined;
    this.issues = [];
    this.status = '已返回主图，记得重新编译';
    this.requestUpdate();
  }

  private moduleLabel(): string {
    const id = this.editingModuleId;
    if (id === undefined) return '主图';
    const module = (this.mainEditor?.document.modules ?? []).find((candidate) => candidate.id === id);
    return module === undefined ? id : `${module.name} v${module.version}`;
  }

  private canUndo(): boolean {
    return (this.mainEditor ?? this.editor).past.length > 0;
  }

  private canRedo(): boolean {
    return (this.mainEditor ?? this.editor).future.length > 0;
  }

  /** 模块体里的撤销/重做作用在主图上，然后把模块视图重新算出来。 */
  private undoEdit(): void {
    const base = this.mainEditor;
    if (base !== undefined && this.editingModuleId !== undefined) {
      this.mainEditor = undo(base);
      this.refreshModuleView();
      return;
    }
    this.setEditor(undo(this.editor));
  }

  private redoEdit(): void {
    const base = this.mainEditor;
    if (base !== undefined && this.editingModuleId !== undefined) {
      this.mainEditor = redo(base);
      this.refreshModuleView();
      return;
    }
    this.setEditor(redo(this.editor));
  }

  private refreshModuleView(): void {
    if (this.mainEditor === undefined || this.editingModuleId === undefined) return;
    const view = moduleViewState(this.mainEditor, this.editingModuleId, this.editor.selection);
    if (view !== undefined) this.editor = view;
    this.persist();
    this.requestUpdate();
  }

  /** 提取为模块：纯编辑命令，拒绝时把原因显示在状态区。 */
  private extractSelection(): void {
    const result = extractModule(this.editor, this.editor.selection);
    if (!result.ok) {
      this.say(result.message);
      return;
    }
    this.setEditor(result.state);
    this.say(`已提取为模块 ${result.moduleId}`);
  }

  /** 显式升级模块调用：不做自动升级，失败时保留原版本。 */
  private upgrade(nodeId: string): void {
    const result = upgradeModule(this.editor, nodeId);
    if (!result.ok) {
      this.say(result.message);
      return;
    }
    this.setEditor(result.state);
    this.say('已升级到新版本');
  }

  /** 把产物交给页面壳写进运行追踪器；来源用节点 id 表示（runner 的 blockId 口径）。 */
  private publish(artifact: WorkflowArtifact): void {
    this.dispatchEvent(
      new CustomEvent('p2b-graph-compiled', {
        detail: {
          actions: artifact.actions,
          origins: artifact.origins.map((origin) => ({ index: origin.index, blockId: origin.nodeId })),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 导出当前图：包装里带依赖表，换机器/换版本打开时能自证模块齐全。 */
  private exportGraph(): void {
    const challenge = this.challenge;
    if (challenge === undefined) return;
    const document = this.mainEditor?.document ?? this.editor.document;
    this.download('pwn2block-graph.json', JSON.stringify(makeGraphSave(challenge.id, document), null, 2));
  }

  /** 导入先校验再替换；失败时原图不动，只报原因。兼容裸图与带依赖的包装。 */
  private async importGraph(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    const raw = await file.text();
    const parsed = safeJson(raw);
    if (parsed === 'invalid') {
      this.say('导入失败：不是合法 JSON，原图未改动');
      return;
    }
    const challenge = this.challenge;
    const wrapped = challenge === undefined ? undefined : parseGraphSave(parsed, challenge.id);
    const graphText = wrapped !== undefined && wrapped.ok ? JSON.stringify(wrapped.value.document) : raw;
    const result = importDocument(this.editor, graphText);
    if (!result.ok) {
      this.say(result.message);
      return;
    }
    this.setEditor(result.state);
    this.say('已导入图，原图可撤销恢复');
  }

  /** 模块导出必须带上它调用到的模块：缺依赖的文件在导入时会被拒绝。 */
  private exportModule(moduleId: string): void {
    const document = this.mainEditor?.document ?? this.editor.document;
    const bundle = collectModuleBundle(document, moduleId);
    if (bundle === undefined) {
      this.say(`找不到模块 ${moduleId}`);
      return;
    }
    this.download(`${moduleId}-module.json`, JSON.stringify(bundle, null, 2));
  }

  private download(name: string, content: string): void {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private downloadRaw(raw: string): void {
    this.download('pwn2block-old-save.json', raw);
  }

  /**
   * 定位一个节点（供输出面板、问题列表与轨迹共用）。
   *
   * 只改布局：展开折叠容器、必要时切进模块视图，不碰语义，因此不会把已编译产物判成过期。
   */
  locate(request: LocateRequest): void {
    const base = this.mainEditor ?? this.editor;
    const target = locateTarget(base.document, request);
    if (target === undefined) {
      this.say('来源未知：这条记录对应的节点已不在图里（可能被删除或存档来自另一版本）');
      return;
    }
    const expanded = withDocument(base, target.document, 'layout');
    const next = { ...expanded, selection: [target.nodeId] };
    if (target.moduleId !== undefined) {
      // 进模块视图：主图留在这份展开后的状态，之后的编辑经 withModuleBody 写回。
      this.mainEditor = next;
      this.editingModuleId = target.moduleId;
      const view = moduleViewState(next, target.moduleId, [target.nodeId]);
      if (view !== undefined) this.editor = view;
    } else {
      // 定位主图节点时不能留下 `mainEditor`：否则后续编辑会被当成「模块体编辑」写不回去。
      this.mainEditor = undefined;
      this.editingModuleId = undefined;
      this.editor = next;
    }
    this.persist();
    this.say(target.detail);
    this.requestUpdate();
    void this.updateComplete.then(() => this.canvas()?.focusNode(target.nodeId));
  }

  /** 用一份图替换当前画布（导入、测试与将来的模板入口共用；失败时不改原图）。 */
  loadDocument(document: GraphDocument): boolean {
    const parsed = parseGraphDocument(document);
    if (!parsed.ok) {
      this.say(`图不可用：${parsed.message}`);
      return false;
    }
    this.abort?.abort();
    this.editor = createEditor(parsed.document);
    this.artifact = undefined;
    this.issues = [];
    this.compiledRevision = -1;
    this.segmentFocus = undefined;
    this.persist();
    this.requestUpdate();
    return true;
  }

  /** 当前图（主图，不含正在编辑的模块视图差异）。 */
  currentDocument(): GraphDocument {
    return (this.mainEditor ?? this.editor).document;
  }

  /** 程序化触发一次编译（与点「编译」等价）。 */
  recompile(): Promise<void> {
    return this.compile();
  }

  /** 旧 Blockly 面板的同名接口：画布没有「装载一次」的动作，返回 `undefined` 表示无需提示。 */
  restoreArchive(): string | undefined {
    return undefined;
  }

  /** 旧 Blockly 面板的同名接口：画布在每次编辑时已写入，提交前无需再存。 */
  saveArchive(): string | undefined {
    this.persist();
    return undefined;
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
      case 'collapse':
        this.setEditor(setCollapsed(this.editor, edit.nodeId, edit.collapsed));
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
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const context: WorkflowContext = {
      archBits: challenge.archBits,
      allowedActions: challenge.allowedActions.filter((name): name is ActionName =>
        (ACTION_NAMES as readonly string[]).includes(name),
      ),
      ...(challenge.authorBlocks === undefined ? {} : { authorBlocks: challenge.authorBlocks }),
      ...(this.pythonCapability?.available === true
        ? { python: createHttpPython({ signal: controller.signal }) }
        : {}),
    };
    this.status = '正在编译…';
    this.requestUpdate();
    const revision = this.editor.semanticRevision;
    const outcome = await compileGraph({
      document: this.editor.document,
      context,
      documentRevision: revision,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (!outcome.ok) {
      this.artifact = undefined;
      this.issues = [...outcome.issues];
      this.status = `编译失败：${outcome.issues.length} 个问题`;
      this.compiledRevision = revision;
      this.dispatchEvent(
        new CustomEvent('p2b-graph-compile-failed', {
          detail: {
            errors: outcome.issues
              .filter((issue) => issue.severity === 'error')
              .map((issue) => ({ code: issue.code, message: issue.message, blockId: issue.nodeId })),
          },
          bubbles: true,
          composed: true,
        }),
      );
      this.requestUpdate();
      return;
    }
    this.artifact = outcome.artifact;
    this.issues = [...(outcome.warnings ?? [])];
    this.compiledRevision = revision;
    this.publish(outcome.artifact);
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
  if (param.kind === 'int') {
    const trimmed = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    return raw;
  }
  // `hex` 是字节串（`4141`），不是数字：全数字的字节串不能按十进制吞掉。
  if (param.kind === 'hex') return raw.trim();
  return raw;
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
