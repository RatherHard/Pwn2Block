/**
 * Payload 窗口（05 §3）：积木画布 + 标题栏上的「运行 / 终止」。
 *
 * 职责边界：
 * - **Blockly 挂载桥**是页面与 Blockly 之间唯一的接口（09 §3.2），所以画布只在这里挂载，
 *   高亮也只在这里做；组件把「编译请求」「积木被改动」派发出去，由页面壳转给控制器。
 * - **输出区已移到页面壳**（本批任务第 6 条）：这里不再维护任何输出相关的状态。
 *   画布高亮是唯一的定位线索（05 §4）：出错 / 被拒绝的动作通过 `highlightBlockId` 高亮
 *   对应积木，出口是页面壳输出区条目上的「定位积木」按钮，点击后由页面壳调用这里的
 *   `highlight()`。
 * - 「运行 / 终止」的可用性与禁用原因只有一处事实来源：`PayloadControlsModel`（控制器算好，
 *   见 `viewmodel/toolbar.ts` 的 `payloadControls`），这里只渲染、只派发，不自己判定。
 * - 用户手势改动积木 → `p2b-edit`（产物过期）+ 立即重编译；**程序化装载/生成程序不会派发事件**，
 *   所以那样做之后必须自己调 `recompile()`（05 §3.1 实现备忘）。
 */
import { LitElement, css, html, nothing } from 'lit';
import type { PublicChallenge } from '@pwn2block/shared';
import type * as Blockly from 'blockly';
import { mountBlockly, type BlocklyBridge } from '../blocks/mount';
import type { NormalizedWorkspace } from '../compiler/types';
import type { ControllerState } from '../viewmodel/controller';
import { defaultStore, readCanvas, writeCanvas, type KeyValueStore } from '../viewmodel/storage';
import {
  MESSAGE_NOT_RUNNING,
  type PayloadControlsModel,
  type RunButtonModel,
  type RunCommand,
} from '../viewmodel/toolbar';
import { sharedStyles, terminalTheme } from '../theme';

/** 还没拿到控制器算好的模型时的兜底：两个按钮都禁用（没有会话 / 没有在运行）。 */
const DEFAULT_CONTROLS: PayloadControlsModel = {
  run: { id: 'run-all', label: '运行', hint: '', enabled: false },
  abort: { id: 'abort', label: '终止', hint: '', enabled: false, disabledReason: MESSAGE_NOT_RUNNING },
};

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
        /* 与视图管理器一致：框贴齐所在一栏，上方只留出压在边框上的标题和按钮。 */
        padding: 0.85rem 0 0;
        scroll-padding-block: 0.85rem;
        scrollbar-color: var(--p2b-line) transparent;
      }
      .box {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        /* 上内边距要盖住按钮压在边框下方的那一半，否则画布会挡住按钮底边。 */
        padding: 1.4rem 0.75rem 0.75rem;
      }
      /* 按钮组垂直居中压在上边框上，和左侧标题嵌在边框里的写法一致。 */
      .controls {
        position: absolute;
        top: calc(var(--p2b-border) / -2);
        right: 0.6rem;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0 0.3rem;
        background: var(--p2b-bg);
        transform: translateY(-50%);
      }
      .controls button {
        min-height: 1.7rem;
        padding-block: 0;
      }
      /*
       * 禁用原因：平时视觉隐藏（仍在无障碍树里，供 aria-describedby 引用）；对应按钮获得键盘焦点时
       * 排到两个按钮左侧显示一行。按钮在 DOM 里在前，这里用 order 把原因挪到左边，
       * 右对齐的按钮位置因此不动。
       */
      .controls .reason {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      .controls button:focus-visible + .reason {
        position: static;
        order: -1;
        width: auto;
        height: auto;
        overflow: visible;
        clip-path: none;
        color: var(--p2b-dim);
      }
      #blockly-host {
        position: absolute;
        inset: 0;
        overflow: hidden;
        /* 不画边框：外面的 .canvas-wrap 已经有一圈，再画就是双线。 */
        background: var(--p2b-bg);
      }
      #blockly-host .blocklySvg {
        background: var(--p2b-bg);
      }
      #blockly-host .blocklyToolboxDiv,
      #blockly-host .blocklyFlyout {
        border-right: var(--p2b-border) solid var(--p2b-line);
        background: var(--p2b-bg);
      }
      #blockly-host .blocklyTreeRow {
        margin: 0.2rem 0.35rem;
        border-left: 2px solid transparent;
        border-radius: 0;
      }
      #blockly-host .blocklyTreeRow:hover,
      #blockly-host .blocklyTreeSelected {
        border-left-color: var(--p2b-ip);
        background: var(--p2b-bg);
      }
      #blockly-host .blocklyScrollbarHandle {
        fill: var(--p2b-line);
      }
      .blocklyPath,
      .blocklySelected > .blocklyPath {
        filter: none;
      }
      .canvas-wrap {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        border: var(--p2b-border) solid var(--p2b-line);
        border-radius: 0;
      }
      .placeholder {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 1.5rem;
        border: var(--p2b-border) dashed var(--p2b-line);
        border-radius: 0;
        color: var(--p2b-dim);
        background: var(--p2b-bg);
        text-align: center;
        pointer-events: none;
      }
      .placeholder[hidden] {
        display: none;
      }
    `,
  ];

  static override properties = {
    challenge: { attribute: false },
    sessionId: { attribute: false },
    state: { attribute: false },
    controls: { attribute: false },
    highlightBlockId: { attribute: false },
    store: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare challenge?: PublicChallenge;
  declare sessionId?: string;
  declare state?: ControllerState;
  declare controls: PayloadControlsModel | undefined;
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
    this.controls = undefined;
  }

  override disconnectedCallback(): void {
    this.teardown();
    super.disconnectedCallback();
  }

  override render() {
    const controls = this.controls ?? DEFAULT_CONTROLS;
    return html`
      <div class="box">
        <h2 class="box-title">payload</h2>
        <div class="controls">
          ${this.renderButton(controls.run, { kind: 'run-all' })}
          ${this.renderButton(controls.abort, { kind: 'abort' })}
        </div>
        <div class="canvas-wrap">
          <div id="blockly-host" aria-label="积木画布"></div>
          <p class="placeholder" id="blockly-placeholder">
            积木画布正在准备：会话建立后会挂载 Blockly。未连到「开始」积木的积木不参与编译（05 §3.1）。
          </p>
        </div>
      </div>
    `;
  }

  /**
   * 手工渲染「运行 / 终止」按钮。不可用时用 `aria-disabled` 而不是 `disabled`：按钮保持可聚焦，
   * 禁用原因经 `aria-describedby` 交给读屏，键盘聚焦时在标题栏里显示一行（鼠标悬停仍看 `title`）。
   * 也正因为保持可聚焦，运行结束、点了「终止」之后焦点不会掉回 `body`。
   */
  private renderButton(button: RunButtonModel, command: RunCommand) {
    const reasonId = `reason-${button.id}`;
    const reason = button.enabled ? undefined : button.disabledReason ?? '';
    return html`<button
        type="button"
        title=${reason ?? button.hint}
        aria-disabled=${button.enabled ? 'false' : 'true'}
        aria-describedby=${reason === undefined ? nothing : reasonId}
        @click=${() => this.onRunClick(button, command)}
      >
        ${button.label}
      </button>${reason === undefined ? nothing : html`<span class="reason" id=${reasonId}>${reason}</span>`}`;
  }

  /** 不可用时点击（含键盘回车 / 空格）什么也不做：`aria-disabled` 不会替我们拦截事件。 */
  private onRunClick(button: RunButtonModel, command: RunCommand): void {
    if (!button.enabled) return;
    this.emitRun(command);
  }

  private emitRun(command: RunCommand): void {
    this.dispatchEvent(
      new CustomEvent<RunCommand>('p2b-run', { detail: command, bubbles: true, composed: true }),
    );
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
