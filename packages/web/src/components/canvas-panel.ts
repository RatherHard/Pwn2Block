import { LitElement, html } from 'lit';
import type { PropertyValues, TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import type { WorkflowIssue } from '../canvas/artifact';
import { compileCanvasWithSteps } from '../canvas/compile';
import type { CanvasCompileOutcome } from '../canvas/compile';
import type { CanvasEdit } from '../canvas/editor';
import { loadCanvas, makeCanvasSave } from '../canvas/save';
import type { CanvasStore } from '../canvas/save';
import { layoutCanvas } from '../canvas/view-model';
import type { CanvasLayoutView } from '../canvas/view-model';
import { sharedStyles, terminalTheme } from '../theme';
import {
  addReferenceNode,
  addVariableNode,
  applyInspectorField,
  copySave,
  dissolveSelection,
  groupSelection,
  type PanelActionHost,
} from './canvas-panel-actions';
import { defaultDocument, type InspectorChange } from './canvas-panel-commands';
import { CanvasHistory } from './canvas-panel-history';
import { CanvasHighlight } from './canvas-panel-highlight';
import type { PanelInteractionHost } from './canvas-panel-host';
import { CanvasInlineEdit } from './canvas-panel-inline';
import { CanvasPanelInteraction } from './canvas-panel-interaction';
import { renderInspector } from './canvas-panel-inspector';
import { deleteSelection } from './canvas-panel-keys';
import { legacyDetailOf } from './canvas-panel-legacy';
import type { RowHandlers, StageState } from './canvas-panel-render';
import { renderStage } from './canvas-panel-render';
import { CanvasAutosave } from './canvas-panel-save';
import { canvasPanelStyles } from './canvas-panel-styles';
import { canvasPanelNodeStyles } from './canvas-panel-styles-node';
import { canvasPanelSideStyles } from './canvas-panel-styles-side';
import { canvasPanelStepsStyles } from './canvas-panel-styles-steps';
import { nodeTitlesOf, renderSteps } from './canvas-panel-steps';
import type { StepsState } from './canvas-panel-steps';
import { renderLibrary } from './canvas-panel-library';
import { addLibraryItem, dropLibraryItem, type LibraryDropHost } from './canvas-panel-library-actions';
import { INITIAL_LIBRARY_STATE, type LibraryItem, type LibraryState } from './canvas-panel-library-model';
import { toGraphPoint } from './canvas-panel-pointer';
import { canvasPanelLibraryStyles } from './canvas-panel-styles-library';
import { renderTopBar, statusCountsOf } from './canvas-panel-toolbox';
import type { StatusCounts } from './canvas-panel-toolbox';

/**
 * 新版画布面板 `<pwn2block-canvas-panel>`（阶段三核心交付）。
 *
 * 外壳只做四件事，别的都委托出去：文档与存档（`loadCanvas` + 400ms 防抖 `saveCanvas` +
 * 撤销栈 + 修订号）、事件契约、四个公开方法、装配（顶栏 + 工具箱 + 画布 + 侧栏）。
 *
 * 三条边界：
 * - 面板**不直接改文档**：写入一律经 `canvas/editor` 的命令（经由 `canvas-panel-commands`
 *   与 `canvas-panel-actions`），所以类型、成环、上限都由命令层把关；
 * - 修订号由面板自己维护：每次文档变化 +1，撤销与加载同样算一次变化，父组件不必跟踪；
 * - 编译在每次文档变化后重跑：成功发产物、失败发错误列表，父组件据此决定「能不能运行」。
 *
 * 步骤快照（`canvas.CanvasStep`）是面板自己的状态：它**不进产物、也不进事件 payload**，
 * 只喂给面板底部的「步骤与轮次」区（需求 §7）。于是父组件的产物契约一点没变。
 */

/** `p2b-canvas-changed` 的 detail：父组件用它存档。 */
export interface CanvasChangedDetail {
  readonly document: canvas.CanvasDocument;
  readonly revision: number;
}

/** `p2b-canvas-legacy` 的 detail 在 `canvas-panel-legacy` 里定义（判定与上报在同处），这里再导出给调用方。 */
export type { CanvasLegacyDetail } from './canvas-panel-legacy';

export class CanvasPanelElement extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    canvasPanelStyles,
    canvasPanelNodeStyles,
    canvasPanelSideStyles,
    canvasPanelStepsStyles,
    canvasPanelLibraryStyles,
  ];

  static override properties = {
    challenge: { attribute: false },
    document: { attribute: false },
    revision: { attribute: false },
    store: { attribute: false },
  };

  /** 题目公开包：方法目录与出题人积木都来自它。 */
  declare challenge: PublicChallenge | undefined;
  /** 文档：父组件可注入；不注入就自己读本地存档，读不到新建「只有开始节点」的文档。 */
  declare document: canvas.CanvasDocument | undefined;
  /** 文档语义修订号：每次变化由面板 +1。 */
  declare revision: number;
  /** 存档后端；不注入就用 `loadCanvas`/`saveCanvas` 的默认行为。 */
  declare store: CanvasStore | undefined;

  private readonly history = new CanvasHistory();
  private readonly highlight = new CanvasHighlight(() => this.requestUpdate());
  private readonly autosave = new CanvasAutosave({
    store: () => this.store,
    challengeId: () => this.challenge?.id,
    document: () => this.document,
  });
  private readonly host: PanelInteractionHost & PanelActionHost & LibraryDropHost;
  private readonly inline: CanvasInlineEdit;
  private readonly interaction: CanvasPanelInteraction;
  private readonly rowHandlers: RowHandlers;
  private selection: string[] = [];
  private message: string | undefined;
  private compileIssues: readonly WorkflowIssue[] = [];
  /** 上一次编译成功给出的步骤快照；编译失败时清空（失败不发布部分动作，也不留上一轮的步骤）。 */
  private steps: readonly canvas.CanvasStep[] = [];
  /** 「步骤与轮次」区是否折叠：折叠状态归面板，重渲染不会把它忘掉。 */
  private stepsCollapsed = false;
  /** 节点库的标签页、页码、搜索词与预览：归面板持有，重渲染不丢。 */
  private library: LibraryState = INITIAL_LIBRARY_STATE;
  /** 正在从节点库拖出的条目；松手或拖到别处后清掉。 */
  private dragging: LibraryItem | undefined;
  private loadedFor: string | undefined;
  /** 上一次「已经处理过」的文档引用：用来识别父组件直接换文档，避免重复广播。 */
  private handledDocument: canvas.CanvasDocument | undefined;

  constructor() {
    super();
    this.revision = 0;
    this.host = {
      currentDocument: () => this.document,
      currentLayout: () => this.layout(),
      selection: () => this.selection,
      selectNodes: (ids) => this.selectNodes(ids),
      applyEdit: (edit) => this.applyEdit(edit),
      report: (message) => this.report(message),
      requestRender: () => this.requestUpdate(),
      stageElement: () => this.stageElement(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      methods: () => this.methods(),
      authorBlocks: () => this.challenge?.authorBlocks,
      exportSave: () => this.exportSave(),
      layoutOf: (document) => layoutCanvas({ document, methods: this.methods() }),
    };
    this.inline = new CanvasInlineEdit(this.host);
    this.interaction = new CanvasPanelInteraction(this.host, this.inline);
    this.rowHandlers = { rowKeyDown: this.inline.rowKeyDown, rowBlur: this.inline.rowBlur };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('keydown', this.interaction.keyDown);
    this.loadForChallenge();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.interaction.keyDown);
    this.interaction.destroy();
    this.autosave.flush();
    this.highlight.clear();
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has('challenge')) this.loadForChallenge();
    else if (changed.has('document')) this.adoptExternal();
  }

  /** 父组件直接换了文档（没走 `setDocument`）：旧历史作废，其余按一次变化处理。 */
  private adoptExternal(): void {
    const document = this.document;
    if (document === undefined || document === this.handledDocument) return;
    this.history.reset();
    this.selection = [];
    this.afterChange();
  }

  // -------------------------------------------------------------------------
  // 公开方法（下一步 app-shell 会调）
  // -------------------------------------------------------------------------

  /** 滚到某个节点并高亮 1.2 秒；节点不在文档里就静默返回。 */
  locate(nodeId: string): void {
    const box = this.layout().boxes.find((item) => item.nodeId === nodeId);
    if (box === undefined) return;
    const stage = this.stageElement();
    if (stage !== null) {
      stage.scrollLeft = Math.max(0, box.x - stage.clientWidth / 2);
      stage.scrollTop = Math.max(0, box.y - stage.clientHeight / 2);
    }
    this.highlight.show(nodeId);
  }

  /** 跳到第一条匹配的问题；`code` 省略时取第一条有节点的问题。返回是否找到。 */
  focusIssue(code?: WorkflowIssue['code']): boolean {
    const issue = this.compileIssues.find((item) => (code === undefined ? item.nodeId !== '' : item.code === code));
    if (issue === undefined) return false;
    if (issue.nodeId !== '') this.locate(issue.nodeId);
    return true;
  }

  /** 导出存档 JSON 文本；能被 `parseCanvasSave` 原样读回。 */
  exportSave(): string {
    const document = this.document ?? defaultDocument();
    return JSON.stringify(makeCanvasSave(this.challenge?.id ?? '', document));
  }

  /** 外部替换文档（导入存档、放弃旧档）：重置历史并立即落盘。 */
  setDocument(next: canvas.CanvasDocument): void {
    this.history.reset();
    this.selection = [];
    this.document = next;
    this.afterChange();
    this.autosave.flush();
  }

  // -------------------------------------------------------------------------
  // 文档与历史
  // -------------------------------------------------------------------------

  private loadForChallenge(): void {
    const challenge = this.challenge;
    if (challenge === undefined || this.loadedFor === challenge.id) return;
    this.loadedFor = challenge.id;
    if (this.document !== undefined) {
      this.afterChange();
      return;
    }
    const loaded = loadCanvas(this.store, challenge.id);
    if (loaded.ok) {
      this.document = loaded.document;
      this.afterChange();
      return;
    }
    if (loaded.reason === 'corrupt' && loaded.raw !== undefined) this.emitLegacyOf(loaded.raw);
    this.document = defaultDocument();
    this.afterChange();
  }

  /** 旧存档只汇报、不迁移：把 `parseCanvasSave` 的结论和原文一起带出去。 */
  private emitLegacyOf(raw: string): void {
    const detail = legacyDetailOf(raw, this.challenge?.id);
    if (detail === undefined) return;
    this.dispatch('p2b-canvas-legacy', detail);
  }

  private applyEdit(edit: CanvasEdit): void {
    if (edit.issues.length > 0) this.report(edit.issues[0].message);
    if (edit.document === this.document) {
      this.requestUpdate();
      return;
    }
    if (this.document !== undefined) this.history.push(this.document);
    this.document = edit.document;
    this.afterChange();
  }

  private undo(): void {
    const previous = this.history.undo(this.document);
    if (previous === undefined) {
      this.report('没有可撤销的操作');
      return;
    }
    this.document = previous;
    this.afterChange();
  }

  private redo(): void {
    const next = this.history.redos(this.document);
    if (next === undefined) {
      this.report('没有可重做的操作');
      return;
    }
    this.document = next;
    this.afterChange();
  }

  /** 一次文档变化：修订号 +1、广播、重编译、排一次存档。 */
  private afterChange(): void {
    const document = this.document;
    if (document === undefined) return;
    this.handledDocument = document;
    this.revision += 1;
    const detail: CanvasChangedDetail = { document, revision: this.revision };
    this.dispatch('p2b-canvas-changed', detail);
    this.recompile();
    this.autosave.schedule();
    this.requestUpdate();
  }

  // -------------------------------------------------------------------------
  // 编译与运行
  // -------------------------------------------------------------------------

  private recompile(): void {
    const document = this.document;
    if (document === undefined) return;
    const outcome = this.compile(document);
    if (outcome.ok) {
      this.compileIssues = outcome.warnings;
      this.steps = outcome.steps;
      this.dispatch('p2b-canvas-compiled', { artifact: outcome.artifact });
      return;
    }
    this.compileIssues = outcome.issues;
    this.steps = [];
    this.dispatch('p2b-canvas-compile-failed', { errors: outcome.issues });
  }

  private run(): void {
    const document = this.document;
    if (document === undefined) return;
    const outcome = this.compile(document);
    if (!outcome.ok) {
      this.compileIssues = outcome.issues;
      this.steps = [];
      this.dispatch('p2b-canvas-compile-failed', { errors: outcome.issues });
      this.report(`还有 ${outcome.issues.length} 条问题，修好再运行`);
      return;
    }
    this.steps = outcome.steps;
    this.dispatch('p2b-canvas-run', { artifact: outcome.artifact });
    this.report(undefined);
  }

  private compile(document: canvas.CanvasDocument): CanvasCompileOutcome {
    const authorBlocks = this.challenge?.authorBlocks;
    return compileCanvasWithSteps({
      document,
      ...(authorBlocks === undefined ? {} : { authorBlocks }),
      documentRevision: this.revision,
    });
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private selectNodes(ids: readonly string[]): void {
    this.selection = [...ids];
    this.requestUpdate();
  }

  private report(message: string | undefined): void {
    this.message = message;
    this.requestUpdate();
  }

  private methods(): readonly canvas.CanvasMethodDecl[] {
    const authorBlocks = this.challenge?.authorBlocks;
    return canvas.canvasMethodsOf({ ...(authorBlocks === undefined ? {} : { authorBlocks }) });
  }

  private layout(): CanvasLayoutView {
    const document = this.interaction.displayDocument() ?? defaultDocument();
    return layoutCanvas({ document, methods: this.methods() });
  }

  private stageElement(): HTMLElement | null {
    const found = this.renderRoot.querySelector('.stage');
    return found instanceof HTMLElement ? found : null;
  }

  private dispatch<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private stageState(document: canvas.CanvasDocument, view: CanvasLayoutView): StageState {
    const interaction = this.interaction;
    return {
      document,
      view,
      selection: this.selection,
      editing: interaction.inlineEdit(),
      snap: interaction.snapPreview(),
      marquee: interaction.marqueeRect(),
      wire: interaction.wirePreview(),
      highlight: this.highlight.current(),
    };
  }

  private setLibrary(next: LibraryState): void {
    this.library = next;
    this.requestUpdate();
  }

  /** 节点库拖到画布上：`dragover` 必须取消默认行为，浏览器才会把 `drop` 交给画布。 */
  private stageDragOver = (event: DragEvent): void => {
    if (this.dragging === undefined) return;
    event.preventDefault();
    const transfer = event.dataTransfer ?? undefined;
    if (transfer !== undefined) transfer.dropEffect = 'copy';
  };

  private stageDrop = (event: DragEvent): void => {
    const item = this.dragging;
    this.dragging = undefined;
    if (item === undefined) return;
    event.preventDefault();
    dropLibraryItem(this.host, item, toGraphPoint(this.stageElement(), event));
  };

  private renderLibraryPane(): TemplateResult {
    return renderLibrary({
      state: this.library,
      blocks: this.challenge?.authorBlocks,
      methods: this.methods(),
      onChange: (next) => this.setLibrary(next),
      onAdd: (item) => addLibraryItem(this.host, item),
      onDragStart: (item) => {
        this.dragging = item;
      },
      onAddVariable: () => addVariableNode(this.host),
      onAddReference: () => addReferenceNode(this.host),
    });
  }

  private toggleSteps(): void {
    this.stepsCollapsed = !this.stepsCollapsed;
    this.requestUpdate();
  }

  /** 顶栏的三个计数；文档还没到位时全是 0（不是「没问题」的假象，只是还没算）。 */
  private countsOf(document: canvas.CanvasDocument | undefined): StatusCounts {
    return document === undefined
      ? { errors: 0, warnings: 0, unconnected: 0 }
      : statusCountsOf(document, this.methods());
  }

  /** 「步骤与轮次」区的状态：步骤表自己拿着，标题从视图模型抄，点行回到 `locate`。 */
  private stepsState(view: CanvasLayoutView | undefined): StepsState {
    return {
      steps: this.steps,
      selection: this.selection,
      titles: view === undefined ? new Map<string, string>() : nodeTitlesOf(view),
      collapsed: this.stepsCollapsed,
      onLocate: (nodeId) => this.locate(nodeId),
      onToggle: () => this.toggleSteps(),
    };
  }

  override render(): TemplateResult {
    const document = this.interaction.displayDocument();
    const view = document === undefined ? undefined : this.layout();
    const counts = this.countsOf(document);
    return html`<section class="panel" tabindex="0">
      ${renderTopBar({
        counts,
        revision: this.revision,
        message: this.message,
        canUndo: this.history.canUndo(),
        canRedo: this.history.canRedo(),
        onUndo: () => this.undo(),
        onRedo: () => this.redo(),
        onDelete: () => deleteSelection(this.host),
        onGroup: () => groupSelection(this.host),
        onDissolve: () => dissolveSelection(this.host),
        onExport: () => copySave(this.host),
        onRun: () => this.run(),
      })}
      <div class="body">
        ${this.renderLibraryPane()}
        <div
          class="stage"
          @pointerdown=${this.interaction.pointerDown}
          @click=${this.interaction.click}
          @dblclick=${this.interaction.doubleClick}
          @dragover=${this.stageDragOver}
          @drop=${this.stageDrop}
        >
          ${document === undefined || view === undefined
            ? html`<p class="hint">等待题目加载…</p>`
            : renderStage(this.stageState(document, view), this.rowHandlers)}
        </div>
        ${document === undefined || view === undefined
          ? html`<aside class="inspector"><p class="hint">等待题目加载…</p></aside>`
          : renderInspector({
              document,
              authorBlocks: this.challenge?.authorBlocks,
              selection: this.selection,
              issuesByNode: view.issuesByNode,
              onChange: (change: InspectorChange) => applyInspectorField(this.host, change),
            })}
      </div>
      ${renderSteps(this.stepsState(view))}
    </section>`;
  }
}

/** 注册自定义元素：模块顶层完成，父组件 import 后即可用标签名实例化。 */
customElements.define('pwn2block-canvas-panel', CanvasPanelElement);