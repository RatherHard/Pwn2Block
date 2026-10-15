/**
 * I/O 视图（05 §2.6）。题目声明了 `syscalls` 或 `fds` 时出现（`availableViews`，viewmodel/views.ts）。
 *
 * - **stdout**：按 ASCII 显示，可切到 hex；本次响应新写入的字节高亮（并在下方写出区间，
 *   颜色不是唯一信息载体，05 §7）；切换状态是组件本地状态，不进页面状态；
 * - **stdin**：显示已 `feed` 的全部字节，`pos` 之前的已读部分置灰；
 * - **syscall 速查**：公开包里的 `syscallAbi`、`syscalls`、`fds`，学习者不用翻题面。
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
import type { ViewContext } from './view-context';

export class Pwn2BlockIoView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        padding: 0.3rem 0.5rem;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
        margin-bottom: 0.3rem;
      }
      h3 {
        margin-top: 0.6rem;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 10rem;
        overflow: auto;
      }
      .byte {
        display: inline-block;
        width: 1.7ch;
        text-align: center;
      }
      .byte.read {
        color: var(--p2b-dim);
      }
      .byte.new {
        color: var(--p2b-changed);
        font-weight: 700;
      }
      .stream-meta {
        color: var(--p2b-dim);
        margin: 0 0 0.2rem;
      }
      .new-note {
        color: var(--p2b-changed);
      }
      .empty {
        color: var(--p2b-dim);
      }
      th.fd,
      th.nr {
        color: var(--p2b-accent);
        font-weight: 400;
      }
      td.doc,
      td.kind {
        color: var(--p2b-dim);
      }
      .boundary {
        color: var(--p2b-hidden);
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
      <header>
        <h2>I/O 视图</h2>
        <span class="note">速查来自公开包</span>
        ${model.stdout === undefined
          ? ''
          : html`<button
              type="button"
              aria-pressed=${this.showHex ? 'true' : 'false'}
              @click=${() => this.toggleHex()}
            >
              ${this.showHex ? 'stdout 按 ASCII 显示' : 'stdout 按 hex 显示'}
            </button>`}
      </header>
      ${this.renderStdout(model.stdout)} ${this.renderStdin(model.stdin)} ${this.renderCheatSheet(model)}
      <p class="boundary">隐藏 VMA 与虚拟文件的内容永远不会出现在这里（01 §6 第 2 条）。</p>
    `;
  }

  private renderStdout(stdout: StdoutModel | undefined) {
    if (stdout === undefined) {
      return html`<h3>stdout</h3>
        <p class="empty">题目未声明 stdout（未声明 fd 时投影里没有 stdout）。</p>`;
    }
    const newBytes = stdout.newRange;
    return html`
      <h3>stdout</h3>
      <p class="stream-meta">
        共 ${stdout.bytes.length} 字节 · ${this.showHex ? 'hex' : 'ASCII'} 显示
        ${newBytes === undefined
          ? ''
          : html`<span class="new-note"> · 本次新增 字节 ${newBytes.from}–${newBytes.to - 1}</span>`}
      </p>
      ${stdout.bytes.length === 0
        ? html`<p class="empty">还没有输出。</p>`
        : html`<pre>${stdout.bytes.map(
            (byte) =>
              html`<span
                class="byte ${byte.isNew ? 'new' : ''}"
                title=${byte.isNew ? `新增字节 ${byte.index}：${byte.hex}` : `字节 ${byte.index}：${byte.hex}`}
                >${this.showHex ? byte.hex : byte.char}</span
              >`,
          )}</pre>`}
    `;
  }

  private renderStdin(stdin: StdinModel | undefined) {
    if (stdin === undefined) {
      return html`<h3>stdin</h3>
        <p class="empty">题目未声明 stdin（未声明 fd 时投影里没有 stdin）。</p>`;
    }
    if (stdin.bytes.length === 0) {
      return html`<h3>stdin</h3>
        <p class="empty">还没有输入：已 feed 0 字节（读位置 0）。</p>`;
    }
    return html`
      <h3>stdin</h3>
      <p class="stream-meta">
        已 feed ${stdin.total} 字节 · 已读 ${stdin.pos} · 未读 ${stdin.unread}（已读部分置灰）
      </p>
      <pre
        >${stdin.bytes.map(
          (byte) =>
            html`<span class="byte ${byte.isRead ? 'read' : ''}" title=${`字节 ${byte.index}：${byte.hex}${byte.isRead ? '（已读）' : ''}`}
              >${byte.hex}</span
            >`,
        )}
</pre>
      <pre
        >${stdin.bytes.map(
          (byte) =>
            html`<span class="byte ${byte.isRead ? 'read' : ''}">${byte.char}</span>`,
        )}
</pre>
    `;
  }

  private renderCheatSheet(model: IoViewModel) {
    const abi = model.abi;
    return html`
      <h3>syscall 速查</h3>
      <p class="stream-meta">
        ${abi === undefined
          ? '题目未声明 syscallAbi。'
          : `调用号 ${abi.nr} · 参数 ${abi.args.length === 0 ? '无' : abi.args.join('、')} · 返回值 ${abi.ret}`}
      </p>
      ${model.syscalls.length === 0
        ? html`<p class="empty">题目未声明 syscalls。</p>`
        : html`<table>
            <thead>
              <tr>
                <th class="nr">调用号</th>
                <th>名字</th>
                <th>类别</th>
                <th>说明</th>
                <th>效果</th>
              </tr>
            </thead>
            <tbody>
              ${model.syscalls.map((row) => this.renderSyscallRow(row))}
            </tbody>
          </table>`}
      ${model.fds.length === 0
        ? html`<p class="empty">题目未声明 fds（虚拟文件内容不下发）。</p>`
        : html`<table>
            <thead>
              <tr>
                <th class="fd">fd</th>
                <th>名字</th>
                <th>类别</th>
                <th>大小</th>
              </tr>
            </thead>
            <tbody>
              ${model.fds.map((row) => this.renderFdRow(row))}
            </tbody>
          </table>`}
    `;
  }

  private renderSyscallRow(row: SyscallRowModel) {
    return html`
      <tr>
        <th class="nr" scope="row">${row.nrText}</th>
        <td>${row.name}</td>
        <td class="kind">${row.kindName}</td>
        <td class="doc">${row.doc ?? ''}</td>
        <td>${row.effectsText}</td>
      </tr>
    `;
  }

  private renderFdRow(row: FdRowModel) {
    return html`
      <tr>
        <th class="fd" scope="row">${row.fd}</th>
        <td>${row.name}</td>
        <td class="kind">${row.kindName}</td>
        <td>${row.sizeText ?? ''}</td>
      </tr>
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
