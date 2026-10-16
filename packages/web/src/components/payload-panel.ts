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
import { debugOffset, rejectedRowFor } from '../viewmodel/highlight';
import { outputEntries } from '../viewmodel/output';
import { programRows } from '../viewmodel/program';
import { defaultStore, readCanvas, writeCanvas, type KeyValueStore } from '../viewmodel/storage';
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
        gap: 0.75rem;
        overflow: auto;
        padding: 0.85rem;
        scroll-padding-block: 0.85rem;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .window-bar {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        flex: none;
        min-height: 2rem;
        padding: 0.35rem 0.65rem;
        border: 1px solid var(--p2b-line-soft);
        color: var(--p2b-dim);
        background: rgb(7 18 21 / 96%);
        font-size: 0.72rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .window-lights {
        display: inline-flex;
        gap: 0.25rem;
      }
      .window-lights i {
        display: block;
        width: 0.45rem;
        height: 0.45rem;
        border: 1px solid rgb(255 255 255 / 18%);
        border-radius: 50%;
        background: var(--p2b-line);
      }
      .window-lights i:first-child { background: var(--p2b-error); }
      .window-lights i:nth-child(2) { background: var(--p2b-warn); }
      .window-lights i:nth-child(3) { background: var(--p2b-accent); }
      .window-title,
      .prompt {
        color: var(--p2b-accent);
      }
      .window-state {
        margin-left: auto;
        color: var(--p2b-accent);
        font-size: 0.65rem;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 0.8rem;
        flex-wrap: wrap;
        padding: 0.1rem 0.1rem 0.2rem;
      }
      .toolbar h2 {
        margin-right: auto;
      }
      .command-line {
        margin-right: auto;
        color: var(--p2b-fg);
      }
      .command-line .prompt {
        margin-right: 0.45rem;
      }
      #blockly-host {
        position: absolute;
        inset: 0;
        overflow: hidden;
        border: 1px solid var(--p2b-line);
        border-radius: 2px;
        background: #061014;
      }
      #blockly-host .blocklySvg {
        background: #061014;
      }
      #blockly-host .blocklyToolboxDiv,
      #blockly-host .blocklyFlyout {
        border-right: 1px solid var(--p2b-line);
        background: #08171a;
      }
      #blockly-host .blocklyTreeRow {
        margin: 0.2rem 0.35rem;
        border-left: 2px solid transparent;
        border-radius: 2px;
      }
      #blockly-host .blocklyTreeRow:hover,
      #blockly-host .blocklyTreeSelected {
        border-left-color: var(--p2b-accent);
        background: rgb(94 225 194 / 12%);
      }
      #blockly-host .blocklyScrollbarHandle {
        fill: #2a5c5a;
      }
      .canvas-wrap {
        position: relative;
        height: clamp(18rem, 38vh, 29rem);
        min-height: 16rem;
        overflow: hidden;
        border-radius: 2px;
        box-shadow: 0 12px 32px rgb(0 0 0 / 28%);
      }
      .placeholder {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 1.5rem;
        border: 1px dashed var(--p2b-line);
        border-radius: 0.7rem;
        color: var(--p2b-dim);
        background: linear-gradient(135deg, rgb(17 31 51 / 94%), rgb(10 23 39 / 94%));
        text-align: center;
        pointer-events: none;
      }
      .placeholder[hidden] {
        display: none;
      }
      .program,
      .output {
        flex-shrink: 0;
        min-height: 4rem;
        padding: 0.75rem;
        border: 1px solid var(--p2b-line);
        border-radius: 0.7rem;
        background: rgb(17 31 51 / 88%);
      }
      .mode-hint {
        margin: 0 0 0.65rem;
        padding: 0.5rem 0.65rem;
        border-left: 3px solid var(--p2b-warn);
        border-radius: 0.3rem;
        color: var(--p2b-warn);
        background: rgb(74 53 25 / 24%);
      }
    `,
  ];

  static override properties = {
    challenge: { attribute: false },
    sessionId: { attribute: false },
    state: { attribute: false },
    runModel: { attribute: false },
    highlightBlockId: { attribute: false },
    store: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare challenge?: PublicChallenge;
  declare sessionId?: string;
  declare state?: ControllerState;
  declare runModel: readonly RunButtonModel[];
  declare highlightBlockId?: string;
  /** 本地保存用的存储（05 §3.1）；缺省取 `localStorage`，没有就退化成「不保存」。 */
  declare store?: KeyValueStore;

  private bridge?: BlocklyBridge;
  private offChange?: () => void;
  private mountedFor = '';
  private lastHighlight?: string;
  /** 这一轮挂载的存档还原结果：`failed` 有值表示画布保持原样、原因需要提示出来。 */
  private restored?: { readonly failed?: string };

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
    const errors = state?.artifact.errors ?? [];
    const stale = state?.artifact.stale ?? false;
    const cursor = state?.cursor ?? 0;
    const mode = state?.page?.mode ?? 'debug';
    // 编译失败时程序区没有行可显示，只留一个「定位出错积木」出口：目标就是画布上正亮着的那块
    // （`highlightBlockId` 由页面壳用 `compiler/locate.ts` 算好，两处不会指到不同积木）。
    const errorBlockId = artifact === undefined && errors.length > 0 ? this.highlightBlockId : undefined;
    const rejectedRow = this.rejectedRowOf(state);
    return html`
      <div class="window-bar" aria-label="Payload \u7ec8\u7aef\u7a97\u53e3">
        <span class="window-lights" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="window-title">/proc/pwn2block/payload</span>
        <span class="window-state">${state?.busy ? 'RUNNING' : 'READY'}</span>
      </div>
      <div class="toolbar">
        <div class="command-line"><span class="prompt">root@pwn2block:~$</span> payload</div>
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
          .rows=${programRows(artifact, cursor, rejectedRow)}
          .stale=${stale}
          .cursor=${cursor}
          .errorBlockId=${errorBlockId}
          .emptyMessage=${this.emptyProgramMessage(state, errors.length)}
          @p2b-program-select=${this.onProgramSelect}
          @p2b-block-select=${this.onBlockSelect}
        ></pwn2block-program-view>
      </div>
      <div class="output">
        ${mode === 'verdict'
          ? html`<p class="mode-hint">下面是调试实例的历史结果；这一轮判题的结论见上方横幅。</p>`
          : ''}
        <pwn2block-output-view
          .entries=${outputEntries({
            artifact,
            errors,
            stale,
            results: state?.results ?? [],
            cursor,
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

  /**
   * 被拒绝的那个动作在程序区的行号（05 §6 的 `rejected` 结论：高亮对应积木）。
   *
   * 判题结果模式优先用**提交那份结果**（横幅讲的就是它）：判题动作序列与程序区行一一对应，
   * 偏移是 0；提交没被拒时退回调试结果。映射对不上产物时 `undefined`（不猜，09 §3.4）。
   */
  private rejectedRowOf(state: ControllerState | undefined): number | undefined {
    if (state === undefined) return undefined;
    const artifact = state.artifact.artifact;
    const verdict = state.verdict;
    if ((state.page?.mode ?? 'debug') === 'verdict' && verdict !== undefined) {
      const fromSubmission = rejectedRowFor(artifact, verdict.response.results, 0);
      if (fromSubmission !== undefined) return fromSubmission;
    }
    // 服务端 `results` 的下标基准是**分片起点**（`debugOffset` 里有推导）。
    const batchStart = debugOffset(state.results, state.cursor);
    return rejectedRowFor(artifact, state.results, batchStart);
  }

  /** 程序区空态的说明：编译失败时要说清「没有可用产物」，而不是让用户以为忘了点编译。 */
  private emptyProgramMessage(state: ControllerState | undefined, errorCount: number): string {
    if (state?.challenge === undefined) return '会话还没开始。';
    if (errorCount > 0) {
      return `编译失败：共 ${errorCount} 条错误，程序区没有可用动作序列（错误逐条列在输出区）。`;
    }
    return '点「编译」把画布上的积木编译成动作序列。';
  }

  private onBlockSelect(event: Event): void {
    const { blockId } = (event as CustomEvent<{ readonly blockId: string }>).detail;
    this.highlight(blockId);
  }

  /** 用户手势改了积木：先落盘再重编译（本地保存是便利，顺序无所谓，但要保证改完就存）。 */
  private onBlocklyChange(): void {
    this.saveArchive();
    this.dispatchEvent(new CustomEvent('p2b-edit', { bubbles: true, composed: true }));
    this.recompile();
  }

  /**
   * 把本地存档装回画布（05 §3.1，D5 批次 2）。**幂等**：同一轮挂载只装一次，
   * 第二次调用直接返回第一次的结果，所以页面壳可以在「画布挂载完成」后放心再问一遍。
   *
   * 契约要点（09 §3.2）：`loadProgram` 失败即**无副作用**——画布逐块保持原样、不通知、
   * 原错误抛给这里；所以坏存档的后果只是「程序没被恢复」，用户的当前程序绝不会被抹掉。
   * 返回失败原因（成功或没有存档时为 `undefined`），由调用方决定怎么提示。
   */
  restoreArchive(): string | undefined {
    const done = this.restored;
    if (done !== undefined) return done.failed;
    const bridge = this.bridge;
    const challenge = this.challenge;
    if (bridge === undefined || challenge === undefined) {
      // 画布还没挂载：不记结果，等挂载完成后再问一次（调用方按契约会重试）。
      return undefined;
    }
    const archive = readCanvas(this.store ?? defaultStore(), challenge.id);
    if (archive === undefined) {
      this.restored = {};
      return undefined;
    }
    try {
      bridge.loadProgram(archive);
      this.restored = {};
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.restored = { failed: `本地保存的程序恢复失败（画布保持原样）：${reason}` };
      return this.restored.failed;
    }
  }

  /**
   * 当前画布落盘（05 §3.1）。`bridge.save()` 是纯函数（不改画布、不通知），`dispose()` 之后会抛错，
   * 所以只能在持有 `bridge` 时调用。存不进去只说明本地保存不可用，绝不打断做题。
   */
  saveArchive(): boolean {
    const bridge = this.bridge;
    const challenge = this.challenge;
    if (bridge === undefined || challenge === undefined) return false;
    try {
      return writeCanvas(this.store ?? defaultStore(), challenge.id, bridge.save());
    } catch {
      // `save()` 只在已卸载的画布上抛错；卸载是同步的，所以这里只是兜底，不能让它冒出去。
      return false;
    }
  }

  private syncMount(): void {
    const challenge = this.challenge;
    const host = this.renderRoot.querySelector<HTMLElement>('#blockly-host');
    if (challenge === undefined || host === null) return;
    // 挂载键**只认题目**（D5 批次 2 起）：画布是用户的程序，不是会话的一部分。
    // 原来键里带 `sessionId`，会话一换就重挂一次、把画布清空——那与本地存档自相矛盾
    // （存档按题目保存，清空的画布下一次刷新又会被装回来），「重新开始」也会白丢用户的程序。
    const key = challenge.id;
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
    // 换了画布（换题 / 会话变了）就要让下一轮挂载重新尝试恢复存档。
    this.restored = undefined;
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
