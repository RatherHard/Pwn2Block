/**
 * 寄存器视图（05 §2.4）。
 *
 * 显示投影里的寄存器与 `ZF / CF / SF`；本次投影变化的值高亮并带符号标记
 * （颜色不是唯一信息载体，05 §7）；点击值复制到剪贴板。
 */
import { LitElement, css, html } from 'lit';
import { buildRegisterRows } from '../viewmodel/registers';
import { sharedStyles, terminalTheme } from '../theme';
import type { ViewContext } from './view-context';

export class Pwn2BlockRegistersView extends LitElement {
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
        margin-bottom: 0.3rem;
      }
      table {
        table-layout: fixed;
      }
      th {
        color: var(--p2b-dim);
        font-weight: 400;
      }
      td.name {
        color: var(--p2b-fg);
      }
      td.name .role {
        color: var(--p2b-changed);
      }
      td.value button {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        cursor: copy;
      }
      tr.changed td.value,
      tr.changed td.name {
        color: var(--p2b-changed);
      }
      td.target,
      .decimal {
        color: var(--p2b-dim);
      }
      .flag-on {
        color: var(--p2b-ip);
      }
      .flag-off {
        color: var(--p2b-dim);
      }
      .copied {
        color: var(--p2b-ip);
      }
      .copy-error {
        color: var(--p2b-error);
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;

  private copied = '';
  private copyError = '';

  override render() {
    const rows = this.context === undefined ? { registers: [], flags: [] } : this.buildRows();
    return html`
      <header>
        <h2>寄存器视图</h2>
        <span class="note">点击值复制</span>
        ${this.copied.length === 0 ? '' : html`<span class="copied" role="status">已复制 ${this.copied}</span>`}
        ${this.copyError.length === 0 ? '' : html`<span class="copy-error" role="alert">${this.copyError}</span>`}
      </header>
      <table>
        <thead>
          <tr>
            <th>寄存器</th>
            <th>值</th>
            <th>十进制</th>
            <th>指向</th>
          </tr>
        </thead>
        <tbody>
          ${rows.registers.map(
            (row) => html`
              <tr class=${row.changed ? 'changed' : ''}>
                <td class="name">
                  ${row.name}${row.role === undefined ? '' : html` <span class="role">(${row.role})</span>`}
                  ${row.changed ? html`<span class="changed"> ✱变化</span>` : ''}
                </td>
                <td class="value">
                  <button
                    type="button"
                    title="复制 ${row.name} = ${row.hex}"
                    @click=${() => this.copy(row.name, row.hex)}
                  >
                    ${row.hex}
                  </button>
                </td>
                <td class="decimal">${row.decimal}</td>
                <td class="target">
                  ${row.targetKind === 'vma' || row.targetKind === 'hidden'
                    ? row.targetText
                    : html`<span class="empty">未映射</span>`}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      <h3>标志位</h3>
      <table>
        <thead>
          <tr>
            <th>标志</th>
            <th>说明</th>
            <th>值</th>
          </tr>
        </thead>
        <tbody>
          ${rows.flags.map(
            (flag) => html`
              <tr class=${flag.changed ? 'changed' : ''}>
                <td class="name">${flag.name}</td>
                <td class="target">${flag.description}</td>
                <td class=${flag.value ? 'flag-on' : 'flag-off'}>
                  ${flag.value ? '真 (1)' : '假 (0)'}${flag.changed ? html`<span class="changed"> ✱变化</span>` : ''}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  private buildRows() {
    return buildRegisterRows({
      projection: this.context.projection,
      archBits: this.context.archBits,
      roles: this.context.roles,
      labels: this.context.labels,
      diff: this.context.diff,
    });
  }

  // 复制结果不是响应式属性，改完要显式请求重绘。
  private async copy(name: string, hex: string): Promise<void> {
    this.copied = '';
    this.copyError = '';
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      this.copyError = `无法访问剪贴板，请手动复制 ${name} = ${hex}`;
      this.requestUpdate();
      return;
    }
    try {
      await clipboard.writeText(hex);
      this.copied = `${name} = ${hex}`;
    } catch {
      this.copyError = `复制失败，请手动复制 ${name} = ${hex}`;
    }
    this.requestUpdate();
  }
}

customElements.define('pwn2block-registers-view', Pwn2BlockRegistersView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-registers-view': Pwn2BlockRegistersView;
  }
}
