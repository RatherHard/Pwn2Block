/**
 * 指令视图（05 §2.3）。
 *
 * 三列：地址、机器码、伪汇编。数据直接来自投影 `disasm`，**前端不解码**。
 * `target` 可点击跳转（不在本次反汇编窗口时给出提示）；`ip` 所在行高亮并自动滚入视野；
 * 函数列表由公开标注里 `kind = func` 的条目生成。
 */
import { LitElement, css, html } from 'lit';
import { parseHex } from '@pwn2block/shared';
import { buildDisasmRows, findDisasmRow, type DisasmRowModel } from '../viewmodel/disasm';
import { formatAddrShort } from '../viewmodel/format';
import { funcLabels } from '../viewmodel/labels';
import { sharedStyles, terminalTheme } from '../theme';
import type { ViewContext } from './view-context';

export class Pwn2BlockDisasmView extends LitElement {
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
      .funcs {
        display: flex;
        gap: 0.3rem;
        flex-wrap: wrap;
      }
      tr.ip th,
      tr.ip td {
        background: #1d2a22;
      }
      tr.ip th.addr::before {
        content: '▶ ';
        color: var(--p2b-accent);
      }
      tr.focused td,
      tr.focused th {
        outline: 1px dashed var(--p2b-focus);
      }
      tr.changed td {
        background: #2a2713;
      }
      th.addr {
        color: var(--p2b-accent);
        font-weight: 400;
      }
      td.bytes {
        color: var(--p2b-dim);
      }
      td.text {
        white-space: pre;
      }
      button.target {
        padding: 0 0.3rem;
        margin-left: 0.4rem;
      }
      .error {
        color: var(--p2b-error);
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;

  private focusedAddr?: bigint;
  private focusMiss = '';

  override render() {
    const rows = this.disasmRows();
    const funcs = funcLabels(this.context?.labels);
    return html`
      <header>
        <h2>指令视图</h2>
        <span class="note">${rows.length} 条 · 伪汇编来自服务端投影</span>
        ${funcs.length === 0
          ? ''
          : html`<span class="funcs">函数：
              ${funcs.map(
                (label) =>
                  html`<button type="button" @click=${() => this.jumpTo(parseHex(label.addr))}>
                    ${label.name}
                  </button>`,
              )}
            </span>`}
        ${this.focusMiss.length === 0 ? '' : html`<span class="error" role="alert">${this.focusMiss}</span>`}
      </header>
      <table>
        <thead>
          <tr>
            <th>地址</th>
            <th>机器码</th>
            <th>伪汇编</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => this.renderRow(row))}
        </tbody>
      </table>
      <p class="note">
        没有断点：想停在某条指令前，用「运行 N 步」冲过去再 step_back 倒回来，或者点上面的跳转目标。
      </p>
    `;
  }

  private renderRow(row: DisasmRowModel) {
    const target = row.target;
    const classes = [
      row.isIp ? 'ip' : '',
      this.focusedAddr === row.addr ? 'focused' : '',
      row.changed ? 'changed' : '',
    ]
      .filter((item) => item.length > 0)
      .join(' ');
    return html`
      <tr class=${classes}>
        <th class="addr" scope="row">${row.address}</th>
        <td class="bytes">${row.bytesText}</td>
        <td class="text">
          ${row.text}
          ${target === undefined
            ? ''
            : html`<button
                type="button"
                class="target"
                title="跳到 ${formatAddrShort(target)}"
                @click=${() => this.jumpTo(target)}
              >
                → ${row.targetText}
              </button>`}
        </td>
      </tr>
    `;
  }

  private disasmRows(): readonly DisasmRowModel[] {
    if (this.context === undefined) return [];
    return buildDisasmRows({
      projection: this.context.projection,
      archBits: this.context.archBits,
      ip: this.ipValue(),
      diff: this.context.diff,
      labels: this.context.labels,
    });
  }

  private ipValue(): bigint | undefined {
    if (this.context === undefined) return undefined;
    const found = this.context.projection.registers.find((item) => item.name === this.context.roles.ip);
    return found === undefined ? undefined : parseHex(found.value);
  }

  // 点击目标行后要高亮并滚入视野：内部状态不是响应式属性，改完显式请求重绘。
  private jumpTo(addr: bigint): void {
    const row = findDisasmRow(this.disasmRows(), addr);
    if (row === undefined) {
      this.focusedAddr = undefined;
      this.focusMiss = `目标 ${formatAddrShort(addr)} 不在本次投影的反汇编里`;
    } else {
      this.focusMiss = '';
      this.focusedAddr = addr;
    }
    this.requestUpdate();
  }

  /** `ip` 行与刚点过的目标行自动滚入视野（05 §2.3）。 */
  override updated(): void {
    const selector = this.focusedAddr === undefined ? 'tr.ip' : 'tr.focused';
    const element = this.renderRoot.querySelector(selector);
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' });
  }
}

customElements.define('pwn2block-disasm-view', Pwn2BlockDisasmView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-disasm-view': Pwn2BlockDisasmView;
  }
}
