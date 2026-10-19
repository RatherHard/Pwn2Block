import { LitElement, css, html, nothing } from 'lit';
import {
  ACTION_NAMES,
  NODE,
  availableNodeSpecs,
  CURRENT_STAGE,
  collectModuleBundle,
  emptyGraphDocument,
  makeGraphSave,
  nodeSpec,
  parseGraphDocument,
  parseGraphSave,
} from '@pwn2block/shared';
import type {
  ActionName,
  GraphDocument,
  ParamValue,
  PublicChallenge,
  PythonCapability,
  WorkflowIssue,
} from '@pwn2block/shared';
import { compileGraph } from '../workflow/compile';
import { extractModule } from '../graph/extract';
import {
  addNode,
  connect,
  copySelection,
  createEditor,
  disconnect,
  groupSelection,
  moveInto,
  moveNodes,
  moveOut,
  paste,
  redo,
  removeNodes,
  reorderAfter,
  rewire,
  select,
  setCollapsed,
  setInlineParam,
  setPortMode,
  undo,
  ungroup,
  type EditResult,
  type GraphEditorState,
} from '../graph/editor';
import { locateTarget, type LocateRequest } from '../graph/locate';
import { moduleViewState, withModuleBody } from '../graph/module-view';
import { importDocument } from '../graph/transfer';
import { clearGraph, loadGraph, saveGraph } from '../graph/storage';
import { createHttpPython, fetchPythonCapability } from '../workflow/python-evaluator';
import type { WorkflowArtifact, WorkflowContext } from '../workflow/types';
import { defaultStore, type KeyValueStore } from '../viewmodel/storage';
import type { PayloadControlsModel } from '../viewmodel/toolbar';
import { sharedStyles, terminalTheme } from '../theme';
import './graph-canvas';
import './node-library';
import './node-inspector';
import {
  moduleCallParams,
  renderGroups,
  renderIssues,
  renderLoadFailure,
  renderModules,
  renderPythonStatus,
  renderRunControls,
  renderTemplates,
  renderTrace,
  type ChromeHandlers,
} from './graph-panel-chrome';
import type { GraphEdit, Pwn2BlockGraphCanvas } from './graph-canvas';
import type { Pwn2BlockNodeInspector } from './node-inspector';
import type { LibraryDragEndDetail } from './node-library';

/**
 * 节点画布面板（10 §2、§4、§5、§6）。
 *
 * 布局：工具栏 + 「节点库 / 画布 / 属性面板」三栏 + 问题区。属性面板常驻并默认展开，
 * 节点内与属性面板编辑的是**同一份文档**（命令都落到 `graph/editor`），复杂配置只在面板里。
 *
 * 边界：
 * - **只做装配**：手势来自画布、库与面板的事件，编辑结果落 `graph/editor` 的纯函数，文档存本地。
 * - **编译是本地纯计算**：数据节点求值 + 生成动作，产物只用于预览与后续运行；Python 求值经注入的
 *   `python` 求值器（服务端隔离运行器未启用时明确报 `python_unavailable`，不回落到浏览器执行）。
 * - **空画布是合法状态**：没有存档与「存档是空画布」分开处理；损坏存档不会被静默覆盖。
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
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        height: 100%;
        min-height: 0;
        padding: 0.5rem 0 0.4rem;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      header button {
        min-height: 1.6rem;
        padding: 0.05rem 0.35rem;
      }
      .breadcrumb {
        color: var(--p2b-dim);
      }
      .divider {
        color: var(--p2b-line);
      }
      .workspace {
        flex: 1 1 auto;
        min-height: 30rem;
        display: grid;
        grid-template-columns: 13rem minmax(0, 1fr) 19rem;
        gap: 0.5rem;
        align-items: stretch;
      }
      .toolbox {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        min-height: 0;
        border: var(--p2b-border) solid var(--p2b-line);
        padding: 0.3rem;
        overflow: auto;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .extras h3 {
        margin: 0.4rem 0 0.2rem;
      }
      .extras button {
        display: block;
        width: 100%;
        text-align: left;
        margin-bottom: 0.2rem;
      }
      .canvas-host {
        min-height: 0;
        min-width: 0;
        display: flex;
      }
      .canvas-host pwn2block-graph-canvas {
        flex: 1 1 auto;
      }
      aside.inspector {
        min-height: 0;
        display: flex;
      }
      aside.inspector pwn2block-node-inspector {
        flex: 1 1 auto;
      }
      footer {
        flex: none;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
        padding-top: 0.3rem;
        max-height: 11rem;
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
      .bad {
        color: var(--p2b-error);
      }
      .ok {
        color: var(--p2b-ip);
      }
      .hint {
        color: var(--p2b-dim);
      }
      .load-failure {
        border: var(--p2b-border) solid var(--p2b-error);
        padding: 0.25rem 0.4rem;
      }
      .trace ol {
        margin: 0;
        padding-left: 1.2rem;
      }
      .run-controls {
        display: flex;
        align-items: center;
        gap: 0.3rem;
      }
      button.link {
        border: 0;
        background: none;
        padding: 0;
        color: var(--p2b-data);
        text-decoration: underline;
      }
      label.import {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        color: var(--p2b-dim);
        cursor: pointer;
      }
      label.import input {
        width: 8rem;
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
  private loadFailure?: { readonly reason: string; readonly raw: string; readonly issues?: readonly string[] };
  /**
   * 损坏存档的锁：锁住期间**不写存档**，直到用户明确选择「从空白开始」。
   * 这样「读不出来」不会被当成「首次进入」而把用户原来的内容覆盖掉（10 §5）。
   */
  private archiveLocked = false;
  /** 存档迁移/恢复的说明（旧积木、旧画布），显示一次就够。 */
  private loadNote = '';
  /** 当前选中的组装分段：高亮输入端口并显示对应结果字节。 */
  private segmentFocus?: { readonly nodeId: string; readonly port: string };
  /** 最近一次写入是否失败：只提示一次，避免每次拖动都刷同一句。 */
  private persistFailed = false;
  /** 属性面板正在编辑的节点：节点标题与面板同时高亮，提示两处是同一份数据。 */
  private editingNodeId?: string;
  /** 从节点库拖入时的节点种类：用于画布上的落点预览。 */
  private dragKind?: string;

  private readonly chrome: ChromeHandlers = {
    onCommand: (command) => {
      this.dispatchEvent(new CustomEvent('p2b-graph-run', { detail: command, bubbles: true, composed: true }));
    },
    onLocate: (nodeId, extra) => this.locate({ nodeId, ...(extra ?? {}) }),
    onTemplate: (template) => this.addPythonTemplate(template),
    onAddModule: (moduleId) => this.addModuleCall(moduleId),
    onEditModule: (moduleId) => this.enterModule(moduleId),
    onExportModule: (moduleId) => this.exportModule(moduleId),
    onUngroup: (groupId) => this.setEditor(ungroup(this.editor, groupId)),
    onDownloadRaw: (raw) => this.download('pwn2block-old-save.json', raw),
    onDiscardArchive: () => this.discardCorruptArchive(),
  };

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
      .find((node) => node !== undefined);
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
          ?disabled=${this.editingModuleId !== undefined}
          title=${this.editingModuleId === undefined
            ? '在本地求值并生成动作；不发送任何请求'
            : '先回到主图再编译'}
          @click=${() => this.compile()}
        >编译</button>
        ${renderRunControls(this.controls, this.chrome)}
        <span class="divider">|</span>
        <button ?disabled=${!this.canUndo()} title="撤销（Ctrl+Z）" @click=${() => this.undoEdit()}>撤销</button>
        <button ?disabled=${!this.canRedo()} title="重做（Ctrl+Y）" @click=${() => this.redoEdit()}>重做</button>
        <button title="缩小（Ctrl+滚轮也可以）" @click=${() => this.canvas()?.zoomBy(1 / 1.15)}>缩放 -</button>
        <button title="放大" @click=${() => this.canvas()?.zoomBy(1.15)}>缩放 +</button>
        <button title="把全部节点放进可视区（f）" @click=${() => this.canvas()?.fit()}>适应画布</button>
        ${this.editingModuleId !== undefined || state.selection.length < 2
          ? nothing
          : html`<button @click=${() => this.run((editor) => groupSelection(editor))}>分组</button>`}
        ${this.editingModuleId !== undefined || state.selection.length === 0
          ? nothing
          : html`<button @click=${() => this.extractSelection()}>提取为模块</button>`}
        ${this.editingModuleId === undefined
          ? html`<button @click=${() => this.exportGraph()}>导出图</button>
              <label class="import"
                >导入图<input
                  type="file"
                  accept="application/json,.json"
                  @change=${(event: Event) => this.importGraph(event)}
              /></label>`
          : nothing}
        ${renderPythonStatus(this.pythonCapability)}
        <span class=${stale ? 'bad' : 'ok'}>${this.status}</span>
      </header>
      <section class="workspace">
        <aside class="toolbox" aria-label="节点库">
          <pwn2block-node-library
            .specs=${availableNodeSpecs(CURRENT_STAGE)}
            .context=${this.portContext(challenge)}
            .store=${this.storage()}
            @p2b-library-add=${(event: CustomEvent<{ kind: string }>) => this.addFromLibrary(event.detail.kind)}
            @p2b-library-dragstart=${(event: CustomEvent<{ kind: string; clientX: number; clientY: number }>) =>
              this.startLibraryDrag(event.detail)}
            @p2b-library-dragmove=${(event: CustomEvent<{ kind: string; clientX: number; clientY: number }>) =>
              this.moveLibraryDrag(event.detail)}
            @p2b-library-dragend=${(event: CustomEvent<LibraryDragEndDetail>) => this.endLibraryDrag(event.detail)}
          ></pwn2block-node-library>
          ${renderTemplates(this.chrome)} ${renderModules(state.document, this.chrome)}
          ${renderGroups(state.document, this.chrome)}
        </aside>
        <div class="canvas-host">
          <pwn2block-graph-canvas
            .state=${state}
            .context=${this.portContext(challenge)}
            .previews=${this.artifact?.previews ?? []}
            .issues=${this.issues}
            .highlightNodeId=${this.highlightNodeId}
            .editingNodeId=${this.editingNodeId}
            .focusPort=${this.segmentFocus === undefined
              ? undefined
              : { nodeId: this.segmentFocus.nodeId, port: this.segmentFocus.port }}
            @p2b-graph-edit=${(event: CustomEvent<GraphEdit>) => this.onEdit(event.detail)}
            @p2b-graph-undo=${() => this.undoEdit()}
            @p2b-graph-redo=${() => this.redoEdit()}
            @p2b-graph-copy=${() => this.setEditor(copySelection(this.editor))}
            @p2b-graph-paste=${() => this.run((editor) => paste(editor, this.portContextOf()))}
            @p2b-graph-open=${(event: CustomEvent<{ nodeId: string }>) => this.openInspector(event.detail.nodeId)}
            @p2b-graph-message=${(event: CustomEvent<{ message: string }>) => this.say(event.detail.message)}
          ></pwn2block-graph-canvas>
        </div>
        <aside class="inspector" aria-label="属性">
          <pwn2block-node-inspector
            .node=${selected}
            .document=${state.document}
            .context=${this.portContext(challenge)}
            .issues=${this.issues}
            .preview=${selected === undefined
              ? undefined
              : this.artifact?.previews.find((item) => item.nodeId === selected.id)}
            .selectionCount=${state.selection.length}
            .collapsed=${selected !== undefined && state.document.layout[selected.id]?.collapsed === true}
            @p2b-inspector-param=${(event: CustomEvent<{ name: string; value: ParamValue }>) =>
              this.onInspectorParam(event.detail.name, event.detail.value)}
            @p2b-inspector-mode=${(event: CustomEvent<{ port: string; mode: 'inline' | 'port' }>) =>
              this.onInspectorMode(event.detail.port, event.detail.mode)}
            @p2b-inspector-action=${(event: CustomEvent<{ action: string }>) =>
              this.onInspectorAction(event.detail.action)}
          ></pwn2block-node-inspector>
        </aside>
      </section>
      <footer>
        ${this.loadNote === '' ? nothing : html`<p class="hint">${this.loadNote}</p>`}
        ${this.loadFailure === undefined ? nothing : renderLoadFailure(this.loadFailure, this.chrome)}
        ${this.message === '' ? nothing : html`<p class="bad">${this.message}</p>`}
        ${renderIssues(this.issues, this.chrome)} ${renderTrace(this.artifact?.trace ?? [], this.chrome)}
      </footer>
    `;
  }

  // ------------------------------------------------------------ 节点库与模板

  private addFromLibrary(kind: string): void {
    this.run((state) => addNode(state, { kind, at: this.visiblePlacement() }));
  }

  /** 点击添加落在当前可见画布范围内（10 §4.2）：取视口左上角向内一点，避开已有节点。 */
  private visiblePlacement(): { x: number; y: number } {
    const canvas = this.canvas();
    const base = canvas === undefined
      ? { x: 40, y: 40 }
      : (() => {
          const rect = canvas.getBoundingClientRect();
          const point = canvas.worldFromClient(rect.left + 60, rect.top + 60);
          return { x: Math.round(point.x), y: Math.round(point.y) };
        })();
    return this.freeSpotNear(base);
  }

  /**
   * 连续点击添加时按网格错开：不会把新节点盖在上一个节点上（10 §4.2）。
   *
   * 节点宽高约 232×120，按 250×140 的格子向右铺，铺满可见宽度后另起一行。
   */
  private freeSpotNear(start: { x: number; y: number }): { x: number; y: number } {
    const taken = Object.values(this.editor.document.layout);
    const rect = this.canvas()?.getBoundingClientRect();
    const columns = rect === undefined ? 2 : Math.max(1, Math.min(4, Math.floor(rect.width / 260)));
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const spot = { x: start.x + column * 250, y: start.y + row * 140 };
        const clash = taken.some(
          (placement) => Math.abs(placement.x - spot.x) < 120 && Math.abs(placement.y - spot.y) < 60,
        );
        if (!clash) return spot;
      }
    }
    return start;
  }

  private startLibraryDrag(detail: { kind: string; clientX: number; clientY: number }): void {
    this.dragKind = detail.kind;
    this.moveLibraryDrag(detail);
  }

  /** 拖入预览：落在画布内才显示虚线框，拖回节点库或画布外就取消。 */
  private moveLibraryDrag(detail: { kind: string; clientX: number; clientY: number }): void {
    const canvas = this.canvas();
    if (canvas === undefined || this.dragKind === undefined) return;
    if (!this.insideCanvas(detail.clientX, detail.clientY)) {
      canvas.showDropHint(undefined);
      return;
    }
    const point = canvas.worldFromClient(detail.clientX, detail.clientY);
    const label = nodeSpec(detail.kind)?.label ?? detail.kind;
    canvas.showDropHint({ x: Math.round(point.x - 8), y: Math.round(point.y - 12), label });
  }

  private endLibraryDrag(detail: LibraryDragEndDetail): void {
    const kind = this.dragKind;
    this.dragKind = undefined;
    this.canvas()?.showDropHint(undefined);
    if (kind === undefined || detail.canceled === true) return;
    if (!this.insideCanvas(detail.clientX, detail.clientY)) return;
    const point = this.canvas()?.worldFromClient(detail.clientX, detail.clientY) ?? { x: 40, y: 40 };
    this.run((state) =>
      addNode(state, { kind, at: { x: Math.round(point.x - 8), y: Math.round(point.y - 12) } }),
    );
  }

  private insideCanvas(clientX: number, clientY: number): boolean {
    const canvas = this.canvas();
    if (canvas === undefined) return false;
    const rect = canvas.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  /** 带模板新建 Python 节点：代码与输入/输出类型一起写进参数，编辑器里可继续改。 */
  private addPythonTemplate(template: {
    readonly code: string;
    readonly inputs: readonly string[];
    readonly outputType: string;
  }): void {
    this.run((state) =>
      addNode(state, {
        kind: NODE.python,
        params: { code: template.code, inputs: [...template.inputs], outputType: template.outputType },
      }),
    );
  }

  /** 插入模块调用节点（流程模块 → `module.call`，数据模块 → `module.data`）。 */
  private addModuleCall(moduleId: string): void {
    const module = (this.editor.document.modules ?? []).find((candidate) => candidate.id === moduleId);
    if (module === undefined) {
      this.say(`找不到模块 ${moduleId}`);
      return;
    }
    this.run((state) =>
      addNode(state, {
        kind: module.kind === 'flow' ? NODE.moduleCall : NODE.moduleData,
        params: moduleCallParams(module),
      }),
    );
  }

  // ------------------------------------------------------------ 存档

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
    this.archiveLocked = false;
    this.editingNodeId = undefined;
    if (!loaded.ok) {
      this.editor = createEditor(emptyGraphDocument());
      this.status = '画布是空的：从左侧节点库添加节点。';
      if (loaded.kind === 'corrupt') {
        this.archiveLocked = true;
        this.loadFailure = {
          reason: loaded.reason,
          raw: loaded.raw,
          ...(loaded.issues === undefined ? {} : { issues: loaded.issues }),
        };
        this.status = '存档读不出来：已保留原文，暂时不写入新存档。';
      }
      return;
    }
    this.editor = createEditor(loaded.document);
    this.status =
      loaded.document.nodes.length === 0
        ? '画布是空的：从左侧节点库添加节点。'
        : '已恢复上次的图，还没有编译。';
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
    if (this.archiveLocked) return;
    const document = this.mainEditor?.document ?? this.editor.document;
    const ok = saveGraph(this.storage(), challenge.id, document);
    if (!ok && !this.persistFailed) {
      this.persistFailed = true;
      this.say('无法写入存档（浏览器存储不可用或已满）：当前修改只在这页有效，建议先导出。');
    }
    if (ok) this.persistFailed = false;
  }

  /** 用户明确放弃损坏存档：清掉坏存档、解锁写入，之后才开始保存新内容。 */
  private discardCorruptArchive(): void {
    const challenge = this.challenge;
    if (challenge === undefined) return;
    clearGraph(this.storage(), challenge.id);
    this.archiveLocked = false;
    this.loadFailure = undefined;
    this.status = '已放弃损坏存档，从现在开始保存新画布。';
    this.persist();
    this.requestUpdate();
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
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
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

  // ------------------------------------------------------------ 编辑器状态

  private setEditor(next: GraphEditorState): void {
    if (this.mainEditor !== undefined && this.editingModuleId !== undefined) {
      // 只改选中：画布与属性面板要立刻反映，但不写回主图、不涨语义版本。
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
      if (semanticChanged) this.dispatchEvent(new CustomEvent('p2b-graph-edited', { bubbles: true, composed: true }));
      this.requestUpdate();
      return;
    }
    const semanticChanged = next.semanticRevision !== this.editor.semanticRevision;
    // 语义变了，正在跑的 Python 求值已经没有意义：取消，别让迟到结果覆盖新产物（07 §P7）。
    if (semanticChanged) this.abort?.abort();
    this.editor = next;
    this.persist();
    if (semanticChanged) this.dispatchEvent(new CustomEvent('p2b-graph-edited', { bubbles: true, composed: true }));
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

  // ------------------------------------------------------------ 对外接口

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
    const expanded = withDocumentOf(base, target.document, 'layout');
    const next = { ...expanded, selection: [target.nodeId] };
    if (target.moduleId !== undefined) {
      this.mainEditor = next;
      this.editingModuleId = target.moduleId;
      const view = moduleViewState(next, target.moduleId, [target.nodeId]);
      if (view !== undefined) this.editor = view;
    } else {
      this.mainEditor = undefined;
      this.editingModuleId = undefined;
      this.editor = next;
    }
    this.editingNodeId = target.nodeId;
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

  /** 画布没有「装载一次」的动作，返回 `undefined` 表示无需提示。 */
  restoreArchive(): string | undefined {
    return undefined;
  }

  /** 画布在每次编辑时已写入，提交前无需再存。 */
  saveArchive(): string | undefined {
    this.persist();
    return undefined;
  }

  /** 属性面板正在编辑的节点；`undefined` 表示没有选中。 */
  currentEditingNode(): string | undefined {
    return this.editingNodeId;
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
        if (edit.ids.length === 1) this.editingNodeId = edit.ids[0];
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
      case 'rewire': {
        const result = rewire(this.editor, this.portContextOf(), edit.edge, edit.end, edit.to);
        if (!result.ok) this.say(result.message);
        else this.setEditor(result.state);
        return;
      }
      case 'param':
        this.setEditor(setInlineParam(this.editor, edit.nodeId, edit.name, edit.value, this.portContextOf()));
        return;
      case 'portMode':
        this.setEditor(setPortMode(this.editor, edit.nodeId, edit.port, edit.mode));
        return;
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

  /** 属性面板的修改：走与节点内完全相同的编辑命令，所以撤销一次就是一次修改。 */
  private onInspectorParam(name: string, value: ParamValue): void {
    const nodeId = this.editor.selection[0];
    if (nodeId === undefined) return;
    this.setEditor(setInlineParam(this.editor, nodeId, name, value, this.portContextOf()));
  }

  private onInspectorMode(port: string, mode: 'inline' | 'port'): void {
    const nodeId = this.editor.selection[0];
    if (nodeId === undefined) return;
    this.setEditor(setPortMode(this.editor, nodeId, port, mode));
  }

  private onInspectorAction(action: string): void {
    const nodeId = this.editor.selection[0];
    if (nodeId === undefined) return;
    switch (action) {
      case 'focus':
        this.canvas()?.focusNode(nodeId);
        return;
      case 'delete':
        this.setEditor(removeNodes(this.editor, [nodeId]));
        return;
      case 'collapse':
        this.setEditor(setCollapsed(this.editor, nodeId, true));
        return;
      case 'expand':
        this.setEditor(setCollapsed(this.editor, nodeId, false));
        return;
      case 'move-out':
        this.setEditor(moveOut(this.editor, [nodeId]));
        return;
      default:
        this.say(`未知操作：${action}`);
    }
  }

  /** 点节点上的「配置」或双击：选中它并把注意力交回属性面板。 */
  private openInspector(nodeId: string): void {
    this.editingNodeId = nodeId;
    this.setEditor(select(this.editor, [nodeId]));
    void this.updateComplete.then(() => {
      const inspector = this.shadowRoot?.querySelector<Pwn2BlockNodeInspector>('pwn2block-node-inspector');
      inspector?.scrollIntoView({ block: 'nearest' });
    });
  }

  private canvas(): Pwn2BlockGraphCanvas | undefined {
    return this.shadowRoot?.querySelector('pwn2block-graph-canvas') ?? undefined;
  }

  private portContextOf() {
    const challenge = this.challenge;
    return challenge === undefined
      ? { archBits: 64 as const }
      : { archBits: challenge.archBits, authorBlocks: challenge.authorBlocks };
  }

  private portContext(challenge: PublicChallenge) {
    return { archBits: challenge.archBits, authorBlocks: challenge.authorBlocks };
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

function withDocumentOf(
  state: GraphEditorState,
  document: GraphDocument,
  kind: 'layout' | 'semantic',
): GraphEditorState {
  return {
    ...state,
    document,
    ...(kind === 'semantic'
      ? { semanticRevision: state.semanticRevision + 1 }
      : { layoutRevision: state.layoutRevision + 1 }),
    past: [...state.past, state.document].slice(-50),
    future: [],
  };
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
