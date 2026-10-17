/**
 * I/O 视图（05 §2.6，排版见 frontend-tui 设计 §3.3）。题目声明了 `syscalls` 或 `fds` 时出现
 * （`availableViews`，viewmodel/views.ts）。
 *
 * - **stdout**：按原文（ASCII）显示，可切到 hex；本次响应新写入的字节高亮（并在上方写出区间，
 *   颜色不是唯一信息载体，05 §7）；切换状态是组件本地状态，不进页面状态；
 * - **stdin**：显示已 `feed` 的全部字节，`pos` 之前的已读部分置灰；
 * - **syscall 速查**：公开包里的 `syscallAbi`、`syscalls`、`fds`，每条一行。
 *
 * 只渲染投影与公开包里的东西：隐藏 VMA 与虚拟文件的**内容**永远不在其中（01 §6 第 2 条）。
 */
import { LitElement, css, html } from 'lit';
import {
  buildIoView,
  type FdRowModel,
  type IoViewModel,
  type StdinModel,
  type StdoutModel,
  type SyscallRowModel,
} from '../viewmodel/io';
import { sharedStyles, terminalTheme } from '../theme';
import { rowStyles } from './view-rows';
import type { ViewContext } from './view-context';

export class Pwn2BlockIoView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    rowStyles,
    css`
      h3 {
        margin-top: 0.6rem;
      }
      .stream {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 10rem;
        overflow: auto;
      }
      /* stdin 的 hex 行与字符行用同一格宽，上下逐字节对齐。 */
      .hex .byte,
      .stdin .byte {
        display: inline-block;
        width: 2ch;
        margin-right: 1ch;
      }
      .byte.read {
        color: var(--p2b-dim);
      }
      .byte.new {
        color: var(--p2b-changed);
        font-weight: 700;
      }
      .syscalls {
        grid-template-columns: repeat(5, max-content);
      }
      .fds {
        grid-template-columns: repeat(4, max-content);
      }
      .nr {
        color: var(--p2b-addr);
      }
      p {
        margin: 0 0 0.2rem;
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;

  /** stdout 显示模式；组件本地状态，不进页面状态。 */
  private showHex = false;

  override render() {
    if (this.context === undefined) return html``;
    const model = this.model();
    return html`
      <div class="cmd">
        <span class="dim">速查来自公开包</span>
        ${model.stdout === undefined
          ? ''
          : html`<button
              type="button"
              aria-pressed=${this.showHex ? 'true' : 'false'}
              @click=${() => this.toggleHex()}
            >
              ${this.showHex ? 'stdout 按 ASCII 显示' : 'stdout 按 hex 显示'}
            </button>`}
      </div>
      ${this.renderStdout(model.stdout)} ${this.renderStdin(model.stdin)} ${this.renderCheatSheet(model)}
      <p class="r-hidden">隐藏 VMA 与虚拟文件的内容永远不会出现在这里（01 §6 第 2 条）。</p>
    `;
  }

  private renderStdout(stdout: StdoutModel | undefined) {
    if (stdout === undefined) {
      return html`<h3>stdout</h3>
        <p class="dim">题目未声明 stdout（未声明 fd 时投影里没有 stdout）。</p>`;
    }
    const newBytes = stdout.newRange;
    // 字节节点之间不留空白：ASCII 模式下 textContent 就是原文。
    const bytes = stdout.bytes.map(
      (byte) => html`<span
        class=${byte.isNew ? 'byte new' : 'byte'}
        title=${byte.isNew ? `新增字节 ${byte.index}：${byte.hex}` : `字节 ${byte.index}：${byte.hex}`}
      >${this.showHex ? byte.hex : byte.char}</span>`,
    );
    return html`
      <h3>stdout</h3>
      <p class="dim">
        共 ${stdout.bytes.length} 字节 · ${this.showHex ? 'hex' : 'ASCII'} 显示
        ${newBytes === undefined
          ? ''
          : html`<span class="changed"> · 本次新增 字节 ${newBytes.from}–${newBytes.to - 1}</span>`}
      </p>
      ${stdout.bytes.length === 0
        ? html`<p class="dim">还没有输出。</p>`
        : html`<div class=${this.showHex ? 'stream stdout hex' : 'stream stdout'}>${bytes}</div>`}
    `;
  }

  private renderStdin(stdin: StdinModel | undefined) {
    if (stdin === undefined) {
      return html`<h3>stdin</h3>
        <p class="dim">题目未声明 stdin（未声明 fd 时投影里没有 stdin）。</p>`;
    }
    if (stdin.bytes.length === 0) {
      return html`<h3>stdin</h3>
        <p class="dim">还没有输入：已 feed 0 字节（读位置 0）。</p>`;
    }
    const cls = (isRead: boolean) => (isRead ? 'byte read' : 'byte');
    return html`
      <h3>stdin</h3>
      <p class="dim">已 feed ${stdin.total} 字节 · 已读 ${stdin.pos} · 未读 ${stdin.unread}（已读部分置灰）</p>
      <div class="stdin">
        <div class="stream hex">${stdin.bytes.map(
          (byte) => html`<span class=${cls(byte.isRead)} title=${`字节 ${byte.index}：${byte.hex}${byte.isRead ? '（已读）' : ''}`}>${byte.hex}</span>`,
        )}</div>
        <div class="stream">${stdin.bytes.map((byte) => html`<span class=${cls(byte.isRead)}>${byte.char}</span>`)}</div>
      </div>
    `;
  }

  private renderCheatSheet(model: IoViewModel) {
    const abi = model.abi;
    return html`
      <h3>syscall 速查</h3>
      <p class="dim">
        ${abi === undefined
          ? '题目未声明 syscallAbi。'
          : `调用号 ${abi.nr} · 参数 ${abi.args.length === 0 ? '无' : abi.args.join('、')} · 返回值 ${abi.ret}`}
      </p>
      ${model.syscalls.length === 0
        ? html`<p class="dim">题目未声明 syscalls。</p>`
        : html`<div class="rows syscalls" role="list" aria-label="syscall：调用号、名字、类别、说明、效果">
            ${model.syscalls.map((row) => this.renderSyscallRow(row))}
          </div>`}
      ${model.fds.length === 0
        ? html`<p class="dim">题目未声明 fds（虚拟文件内容不下发）。</p>`
        : html`<div class="rows fds" role="list" aria-label="fd：编号、名字、类别、大小">
            ${model.fds.map((row) => this.renderFdRow(row))}
          </div>`}
    `;
  }

  private renderSyscallRow(row: SyscallRowModel) {
    return html`
      <div class="row" role="listitem">
        <span class="nr">${row.nrText}</span>
        <span>${row.name}</span>
        <span class="dim">${row.kindName}</span>
        <span class="dim">${row.doc ?? ''}</span>
        <span>${row.effectsText}</span>
      </div>
    `;
  }

  private renderFdRow(row: FdRowModel) {
    return html`
      <div class="row" role="listitem">
        <span class="nr">${row.fd}</span>
        <span>${row.name}</span>
        <span class="dim">${row.kindName}</span>
        <span>${row.sizeText ?? ''}</span>
      </div>
    `;
  }

  private model(): IoViewModel {
    return buildIoView({
      projection: this.context.projection,
      challenge: this.context.challenge,
      previous: this.context.previous,
      diff: this.context.diff,
    });
  }

  // 显示模式不是响应式属性，改完显式请求重绘。
  private toggleHex(): void {
    this.showHex = !this.showHex;
    this.requestUpdate();
  }
}

customElements.define('pwn2block-io-view', Pwn2BlockIoView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-io-view': Pwn2BlockIoView;
  }
}
