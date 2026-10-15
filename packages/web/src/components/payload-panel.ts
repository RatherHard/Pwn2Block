/**
 * Payload 窗口（05 §3）：积木画布 + 工具栏 + 程序区 + 输出区。
 *
 * 职责边界：
 * - **Blockly 挂载桥**是页面与 Blockly 之间唯一的接口（09 §3.2），所以画布只在这里挂载，
 *   高亮也只在这里做；组件把「编译请求」「积木被改动」派发出去，由页面壳转给控制器。
 * - **程序区 / 输出区**是纯展示：行与条目由 `viewmodel/program.ts`、`viewmodel/output.ts`
 *   算好，数据源一律是控制器的 `ArtifactTracker` 快照（09 §3.2），这里不维护第二份状态。
 * - 用户手势改动积木 → `p2b-edit`（产物过期）+ 立即重编译；**程序化装载/生成程序不会派发事件**，
 *   所以那样做之后必须自己调 `recompile()`（05 §3.1 实现备忘、本批任务第 6 条）。
 */
import { LitElement, css, html } from 'lit';
import type { PublicChallenge } from '@pwn2block/shared';
import type * as Blockly from 'blockly';
import { mountBlockly, type BlocklyBridge } from '../blocks/mount';
import type { NormalizedWorkspace } from '../compiler/types';
import type { ControllerState } from '../viewmodel/controller';
import { outputEntries } from '../viewmodel/output';
import { programRows } from '../viewmodel/program';
import type { RunButtonModel } from '../viewmodel/toolbar';
import { sharedStyles, terminalTheme } from '../theme';
import './output-view';
import './program-view';
import './run-menu';
import type { ProgramSelectDetail } from './program-view';

export class Pwn2BlockPayloadPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        overflow: auto;
        padding: 0.4rem 0.6rem;
        gap: 0.3rem;
      }
      .toolbar {
        display: flex;
        align-items: baseline;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .toolbar h2 {
        margin: 0;
      }
      #blockly-host {
        position: absolute;
        inset: 0;
        border: 1px solid var(--p2b-line);
        border-radius: 3px;
        background: var(--p2b-panel);
      }
      .canvas-wrap {
        position: relative;
        height: 18rem;
        min-height: 16rem;
      }
      .placeholder {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        border: 1px dashed var(--p2b-line);
        border-radius: 3px;
        color: var(--p2b-dim);
        text-align: center;
        padding: 1rem;
        pointer-events: none;
      }
      .placeholder[hidden] {
        display: none;
      }
      .program,
      .output {
        border: 1px solid var(--p2b-line);
        border-radius: 3px;
        background: var(--p2b-panel);
        padding: 0.3rem 0.4rem;
        min-height: 4rem;
      }
      .mode-hint {
        color: var(--p2b-dim);
      }
    `,
  ];

  static override properties = {
    challenge: { attribute: false },
    sessionId: { attribute: false },
    state: { attribute: false },
    runModel: { attribute: false },
    highlightBlockId: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare challenge?: PublicChallenge;
  declare sessionId?: string;
  declare state?: ControllerState;
  declare runModel: readonly RunButtonModel[];
  declare highlightBlockId?: string;

  private bridge?: BlocklyBridge;
  private offChange?: () => void;
  private mountedFor = '';
  private lastHighlight?: string;

  constructor() {
    super();
    this.runModel = [];
  }

  override disconnectedCallback(): void {
    this.teardown();
    super.disconnectedCallback();
  }

  override render() {
    const state = this.state;
    const artifact = state?.artifact.artifact;
    const stale = state?.artifact.stale ?? false;
    const cursor = state?.cursor ?? 0;
    const mode = state?.page?.mode ?? 'debug';
    return html`
      <div class="toolbar">
        <h2>Payload</h2>
        <pwn2block-run-menu
          .model=${this.runModel}
          .busy=${state?.busy ?? false}
          .pending=${state?.queued ?? 0}
        ></pwn2block-run-menu>
      </div>
      <div class="canvas-wrap">
        <div id="blockly-host" aria-label="积木画布"></div>
        <p class="placeholder" id="blockly-placeholder">
          积木画布正在准备：会话建立后会挂载 Blockly。未连到「开始」积木的积木不参与编译（05 §3.1）。
        </p>
      </div>
      <div class="program">
        <pwn2block-program-view
          .rows=${programRows(artifact, cursor)}
          .stale=${stale}
          .cursor=${cursor}
          .emptyMessage=${state?.challenge === undefined ? '会话还没开始。' : '点「编译」把画布上的积木编译成动作序列。'}
          @p2b-program-select=${this.onProgramSelect}
        ></pwn2block-program-view>
      </div>
      <div class="output">
        ${mode === 'verdict'
          ? html`<p class="mode-hint">下面是调试实例的历史结果；这一轮判题的结论见上方横幅。</p>`
          : ''}
        <pwn2block-output-view
          .entries=${outputEntries({
            artifact,
            errors: state?.artifact.errors ?? [],
            stale,
            results: state?.results ?? [],
            ...(state?.page === undefined ? {} : { projection: state.page.projection }),
          })}
          @p2b-block-select=${this.onBlockSelect}
        ></pwn2block-output-view>
      </div>
    `;
  }

  override updated(): void {
    this.syncMount();
    this.syncHighlight();
  }

  /**
   * 程序化装载 / 生成程序之后**必须**调它（05 §3.1）：Blockly 的变更事件只覆盖用户手势，
   * 走 `workspace.newBlock()` / `serialization.load()` 不会派发事件。
   */
  recompile(): void {
    const bridge = this.bridge;
    if (bridge === undefined) return;
    const program: NormalizedWorkspace = bridge.normalize();
    this.dispatchEvent(
      new CustomEvent<{ readonly program: NormalizedWorkspace }>('p2b-compile', {
        detail: { program },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 错误定位（05 §4）：在画布上高亮一块积木；传 `undefined` 清除高亮。 */
  highlight(blockId?: string): void {
    this.lastHighlight = blockId;
    this.bridge?.highlight(blockId);
  }

  /** 当前挂载的画布工作区（未挂载时 `undefined`）。只读出口，方便外部做错误定位与测试。 */
  get workspace(): Blockly.WorkspaceSvg | undefined {
    return this.bridge?.workspace;
  }

  private onProgramSelect(event: Event): void {
    const detail = (event as CustomEvent<ProgramSelectDetail>).detail;
    if (detail.blockId === undefined) return;
    // 点同一行两次：第二次清掉高亮，避免“看起来还亮着但其实已经切走了”。
    this.highlight(this.lastHighlight === detail.blockId ? undefined : detail.blockId);
  }

  private onBlockSelect(event: Event): void {
    const { blockId } = (event as CustomEvent<{ readonly blockId: string }>).detail;
    this.highlight(blockId);
  }

  /** 用户手势改了积木：产物过期（05 §3），并立即重新编译（本批任务第 6 条）。 */
  private onBlocklyChange(): void {
    this.dispatchEvent(new CustomEvent('p2b-edit', { bubbles: true, composed: true }));
    this.recompile();
  }

  private syncMount(): void {
    const challenge = this.challenge;
    const host = this.renderRoot.querySelector<HTMLElement>('#blockly-host');
    if (challenge === undefined || host === null) return;
    const key = `${challenge.id}#${this.sessionId ?? ''}`;
    if (this.bridge !== undefined && this.mountedFor === key) return;
    this.teardown();
    const bridge = mountBlockly(host, challenge);
    this.bridge = bridge;
    this.mountedFor = key;
    this.offChange = bridge.onChange(() => this.onBlocklyChange());
    // 占位说明用命令式显隐：它是静态节点，改它不会引起第二次渲染
    //（在 `updated()` 里改响应式属性会再排一次更新，Lit 会警告）。
    this.setPlaceholderHidden(true);
  }

  /**
   * 撤销上一次高亮。（09 §3.4 / A 收口）编译失败后 `tracker.noteEdit()` 是 no-op，
   * `errors` 会一直留到下一次编译，所以高亮必须由**最新一次**产物状态决定：
   * 新一次编译没有错误时 `autoHighlight()` 返回 `undefined`，这里就把高亮清掉，
   * 不让它停在一块可能已经被删掉的积木上。
   */
  private syncHighlight(): void {
    if (this.highlightBlockId === this.lastHighlight) return;
    this.highlight(this.highlightBlockId);
  }

  private setPlaceholderHidden(hidden: boolean): void {
    const placeholder = this.renderRoot.querySelector('#blockly-placeholder');
    if (placeholder === null) return;
    if (hidden) placeholder.setAttribute('hidden', '');
    else placeholder.removeAttribute('hidden');
  }

  /** 卸载：先解绑事件再销毁工作区（09 §3.2 的桥契约）。 */
  private teardown(): void {
    const off = this.offChange;
    this.offChange = undefined;
    if (off !== undefined) off();
    const bridge = this.bridge;
    this.bridge = undefined;
    this.mountedFor = '';
    this.lastHighlight = undefined;
    if (bridge !== undefined) bridge.dispose();
    this.setPlaceholderHidden(false);
  }
}

customElements.define('pwn2block-payload-panel', Pwn2BlockPayloadPanel);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-payload-panel': Pwn2BlockPayloadPanel;
  }
}
