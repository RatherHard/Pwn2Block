/**
 * 寄存器视图（05 §2.4，排版见 frontend-tui 设计 §3.3）。
 *
 * 每行 `*RAX  0x1337  (4919)  —▸ …`：本次投影变化的寄存器行首加 `*`，值用 `--p2b-changed`
 * （颜色不是唯一信息载体，05 §7）；值按所指区域着色。最后一行 `FLAGS [ ZF cf sf ]`。
 * 点击值复制到剪贴板。
 */
import { LitElement, css, html } from 'lit';
import { buildRegisterRows, flagsLine, type FlagRowModel, type RegisterRowModel } from '../viewmodel/registers';
import { sharedStyles, terminalTheme } from '../theme';
import { regionClass, rowStyles } from './view-rows';
import type { ViewContext } from './view-context';

/**
 * FLAGS 行下方的可见说明：`大写 = 置位 · ZF 零标志 · CF 进位标志 · SF 符号标志`。
 * 变化的标志在名字后写「（本次变化）」，颜色之外还有文字（05 §7）。
 */
function flagsNote(flags: readonly FlagRowModel[]): string {
  const parts = flags.map((flag) => `${flag.name} ${flag.description}${flag.changed ? '（本次变化）' : ''}`);
  return ['大写 = 置位，小写 = 清零', ...parts].join(' · ');
}

export class Pwn2BlockRegistersView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    rowStyles,
    css`
      .rows {
        grid-template-columns: repeat(5, max-content);
      }
      .row button.value {
        cursor: copy;
      }
      .role {
        color: var(--p2b-dim);
      }
      .flags {
        grid-column: 1 / -1;
      }
      .copied {
        color: var(--p2b-ip);
      }
      .flags-note {
        margin: 0.2rem 0 0;
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
    const changedFlags = rows.flags.filter((flag) => flag.changed).map((flag) => flag.name);
    return html`
      <div class="cmd">
        <span class="dim">点击值复制 · * = 本次变化</span>
        ${this.copied.length === 0 ? '' : html`<span class="copied" role="status">已复制 ${this.copied}</span>`}
        ${this.copyError.length === 0 ? '' : html`<span class="error" role="alert">${this.copyError}</span>`}
      </div>
      <div class="rows" role="list" aria-label="寄存器：名称、值、十进制、指向">
        ${rows.registers.map((row) => this.renderRow(row))}
        <div class="row" role="listitem">
          <span class=${changedFlags.length === 0 ? 'flags' : 'flags changed'}>${flagsLine(rows.flags)}</span>
        </div>
      </div>
      <p class="dim flags-note">${flagsNote(rows.flags)}</p>
    `;
  }

  private renderRow(row: RegisterRowModel) {
    // 区域类与 `.changed` 同为单类名 (0,1,0)，rowStyles 里 `.changed` 排在 `.r-*` 之后，所以变化色优先；
    // 行内按钮的基础样式用 `:where(.row) button` 压到 (0,0,1)，不会盖过这两类颜色。
    const valueClass = `value ${regionClass(row.region)}${row.changed ? ' changed' : ''}`;
    return html`
      <div class="row" role="listitem">
        <span class=${row.changed ? 'changed' : ''}>${row.changed ? '*' : ''}${row.name}</span>
        <button
          type="button"
          class=${valueClass}
          title="复制 ${row.name} = ${row.hex}"
          @click=${() => this.copy(row.name, row.hex)}
        >${row.hex}</button>
        <span class="dim">(${row.decimal})</span>
        <span class=${regionClass(row.region)}>${row.targetKind === 'unmapped' ? '' : `—▸ ${row.targetText}`}</span>
        <span class="role">${row.role === undefined ? '' : row.role}</span>
      </div>
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
