import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { canvas, type PublicChallenge } from '@pwn2block/shared';
import { compileCanvasWithSteps, type CanvasCompileOutcome } from '../canvas/compile';
import type { WorkflowIssue } from '../canvas/artifact';
import { loadCanvas, makeCanvasSave, parseCanvasSave, type CanvasStore } from '../canvas/save';
import { CanvasHistory } from './canvas-panel-history';
import { CanvasAutosave } from './canvas-panel-save';
import { normalizeLogicLayerOrder } from '../canvas/logic-layers';
import { legacyDetailOf } from './canvas-panel-legacy';
import { terminalTheme, sharedStyles } from '../theme';
import './logic-canvas';
import type { LogicCanvasElement } from './logic-canvas';
export type { CanvasLegacyDetail } from './canvas-panel-legacy';
export interface CanvasChangedDetail {
  readonly document: canvas.CanvasDocument;
  readonly revision: number;
}

/** Application boundary: document/history/persistence and the established compile/run events. */
export class CanvasPanelElement extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        border: 1px solid var(--p2b-line);
      }
      pwn2block-logic-canvas {
        height: 100%;
      }
      .archive {
        padding: 16px;
        border-bottom: 1px solid var(--p2b-line);
      }
      .archive button {
        margin: 6px;
      }
      .notice {
        padding: 5px 10px;
        color: var(--p2b-error);
      }
    `,
  ];
  static override properties = {
    challenge: { attribute: false },
    document: { attribute: false },
    revision: { attribute: false },
    store: { attribute: false },
  };
  declare challenge: PublicChallenge | undefined;
  declare document: canvas.CanvasDocument | undefined;
  declare revision: number;
  declare store: CanvasStore | undefined;
  private readonly history = new CanvasHistory();
  private readonly autosave = new CanvasAutosave({
    store: () => this.store,
    challengeId: () => this.loadedFor,
    document: () => (this.archiveRaw === undefined ? this.document : undefined),
  });
  private handled: canvas.CanvasDocument | undefined;
  private loadedFor: string | undefined;
  private archiveRaw: string | undefined;
  private issues: readonly WorkflowIssue[] = [];
  private steps: readonly canvas.CanvasStep[] = [];
  private message = '';
  private importGeneration = 0;
  constructor() {
    super();
    this.revision = 0;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.load();
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.importGeneration++;
    this.autosave.flush();
  }
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('challenge')) this.load();
    else if (changed.has('document') && this.document !== this.handled) {
      this.history.reset();
      this.changed();
    }
  }
  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  private load(): void {
    if (!this.challenge || this.loadedFor === this.challenge.id) return;
    const first = this.loadedFor === undefined;
    this.autosave.flush();
    this.loadedFor = this.challenge.id;
    this.history.reset();
    this.archiveRaw = undefined;
    if (first && this.document) {
      this.setDocument(this.document);
      return;
    }
    const loaded = loadCanvas(this.store, this.challenge.id);
    if (loaded.ok && loaded.document.logic) this.document = loaded.document;
    else {
      if (loaded.ok) this.archiveRaw = JSON.stringify(makeCanvasSave(this.challenge.id, loaded.document));
      else if (loaded.reason === 'corrupt' && loaded.raw !== undefined) {
        this.archiveRaw = loaded.raw;
        const legacy = legacyDetailOf(loaded.raw, this.challenge.id);
        if (legacy) this.emit('p2b-canvas-legacy', legacy);
      }
      this.document = canvas.newLogicDocument();
    }
    this.changed();
  }
  private compile(): CanvasCompileOutcome {
    if (this.archiveRaw !== undefined)
      return {
        ok: false,
        issues: [
          {
            code: 'invalid_param',
            severity: 'error',
            nodeId: '',
            message: '请先导出原存档并新建画布，再执行程序',
          },
        ],
      };
    return compileCanvasWithSteps({
      document: this.document ?? canvas.newLogicDocument(),
      authorBlocks: this.challenge?.authorBlocks,
      documentRevision: this.revision,
    });
  }
  private changed(): void {
    if (!this.document) return;
    this.handled = this.document;
    this.revision++;
    this.emit('p2b-canvas-changed', {
      document: this.document,
      revision: this.revision,
    } satisfies CanvasChangedDetail);
    const result = this.compile();
    if (result.ok) {
      this.issues = result.warnings;
      this.steps = result.steps;
      this.emit('p2b-canvas-compiled', { artifact: result.artifact });
    } else {
      this.issues = result.issues;
      this.steps = [];
      this.emit('p2b-canvas-compile-failed', { errors: result.issues });
    }
    this.autosave.schedule();
    this.requestUpdate();
  }
  private edit(graph: canvas.LogicGraph, layerOrder?: readonly string[]): void {
    if (!this.document) return;
    const order = normalizeLogicLayerOrder(graph, layerOrder ?? this.document.logicView?.layerOrder);
    const previous = this.document.logicView?.layerOrder ?? [];
    const orderChanged = order.length !== previous.length || order.some((id, index) => id !== previous[index]);
    if (this.document.logic === graph && !orderChanged) return;
    this.history.push(this.document);
    this.document = { ...this.document, logic: graph, logicView: { layerOrder: order } };
    this.changed();
  }
  private undo(): void {
    const previous = this.history.undo(this.document);
    if (previous) {
      this.document = previous;
      this.changed();
    }
  }
  private redo(): void {
    const next = this.history.redos(this.document);
    if (next) {
      this.document = next;
      this.changed();
    }
  }
  private run(): void {
    const result = this.compile();
    if (result.ok) this.emit('p2b-canvas-run', { artifact: result.artifact });
    else {
      this.issues = result.issues;
      this.emit('p2b-canvas-compile-failed', { errors: result.issues });
      this.requestUpdate();
    }
  }
  locate(id: string): void {
    this.renderRoot.querySelector<LogicCanvasElement>('pwn2block-logic-canvas')?.locate(id);
  }
  focusIssue(code?: WorkflowIssue['code']): boolean {
    const issue = this.issues.find((i) => (code === undefined ? i.nodeId !== '' : i.code === code));
    if (!issue) return false;
    this.locate(issue.nodeId);
    return true;
  }
  exportSave(): string {
    return (
      this.archiveRaw ??
      JSON.stringify(makeCanvasSave(this.challenge?.id ?? '', this.document ?? canvas.newLogicDocument()))
    );
  }
  setDocument(document: canvas.CanvasDocument): void {
    const parsed = canvas.parseCanvasDocument(document);
    if (!parsed.ok) {
      this.message = '文档格式不合法';
      this.requestUpdate();
      return;
    }
    this.history.reset();
    this.archiveRaw = undefined;
    if (!document.logic) {
      this.archiveRaw = JSON.stringify(makeCanvasSave(this.challenge?.id ?? '', document));
      this.document = canvas.newLogicDocument();
    } else this.document = parsed.document;
    this.changed();
    this.autosave.flush();
  }
  private download(): void {
    const blob = new Blob([this.exportSave()], { type: 'application/json' });
    const url = URL.createObjectURL(blob),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.challenge?.id ?? 'canvas'}${this.archiveRaw ? '-legacy' : ''}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    const generation = ++this.importGeneration;
    const challengeId = this.challenge?.id,
      revision = this.revision,
      document = this.document;
    // 文件读取期间可能切题、编辑、卸载或发起新导入；旧结果不能覆盖新上下文。
    const current = (): boolean =>
      this.isConnected &&
      generation === this.importGeneration &&
      challengeId === this.challenge?.id &&
      revision === this.revision &&
      document === this.document;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('存档不能超过 4 MiB');
      const text = await file.text();
      if (!current()) return;
      const raw: unknown = JSON.parse(text);
      const parsed = parseCanvasSave(raw, challengeId);
      if (!parsed.ok) throw new Error(parsed.message);
      this.setDocument(parsed.save.document);
      this.message = '';
    } catch (error) {
      if (current()) this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.importGeneration) {
        input.value = '';
        this.requestUpdate();
      }
    }
  }
  override render(): TemplateResult {
    return html`${this.message ? html`<div class="notice" role="alert">${this.message}</div>` : nothing}
      ${
        this.archiveRaw !== undefined
          ? html`<div class="archive">
              <p>
                检测到旧模型或不可读取的存档。原文已保留；旧版的列表、组合和流程序列不能直接解释为新的节点连接。
              </p>
              <button @click=${() => this.download()}>导出原存档</button
              ><button
                @click=${() => {
                  this.download();
                  this.archiveRaw = undefined;
                  this.setDocument(canvas.newLogicDocument());
                }}
              >
                导出原存档并新建画布
              </button>
            </div>`
          : this.document?.logic
            ? html` <pwn2block-logic-canvas
                tabindex="0"
                .graph=${this.document.logic}
                .layerOrder=${this.document.logicView?.layerOrder ?? []}
                .methods=${canvas.canvasMethodsOf({ authorBlocks: this.challenge?.authorBlocks })}
                .issues=${this.issues}
                .steps=${this.steps}
                .canUndo=${this.history.canUndo()}
                .canRedo=${this.history.canRedo()}
                @logic-edit=${(e: CustomEvent<canvas.LogicGraph>) => this.edit(e.detail, (e.currentTarget as LogicCanvasElement).layerOrder)}
                @logic-undo=${() => this.undo()}
                @logic-redo=${() => this.redo()}
                @logic-run=${() => this.run()}
                @logic-export=${() => this.download()}
                @logic-import=${() => this.renderRoot.querySelector<HTMLInputElement>('input[type=file]')?.click()}
              ></pwn2block-logic-canvas>`
            : nothing
      }
      <input
        type="file"
        accept="application/json,.json"
        hidden
        @change=${(e: Event) => {
          void this.importFile(e);
        }}
      />`;
  }
}
customElements.define('pwn2block-canvas-panel', CanvasPanelElement);
