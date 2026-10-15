/**
 * 自由视图（05 §2.5）。
 *
 * 列出全部 VMA 的布局（id、类别、名称、范围、权限、大小）；隐藏的标「隐藏」，
 * **只显示布局、不显示内容**；非隐藏 VMA 可选，用 hex dump 按窗口浏览。
 * 不提供任意地址读取：只能看投影里已经有的字节。
 */
import { LitElement, css, html } from 'lit';
import {
  DEFAULT_DUMP_ROWS,
  buildHexDump,
  buildVmaList,
  clampDumpOffset,
  dumpByteLength,
  dumpMaxOffset,
  hiddenNotice,
  type VmaListRow,
} from '../viewmodel/memory';
import { formatSize, parseAddrInput } from '../viewmodel/format';
import { sharedStyles, terminalTheme } from '../theme';
import type { ViewContext } from './view-context';

const DUMP_ROW_BYTES = 16;

export class Pwn2BlockMemoryView extends LitElement {
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
      tr.selected td,
      tr.selected th {
        background: #1d2a22;
      }
      th.id {
        color: var(--p2b-accent);
        font-weight: 400;
      }
      button.pick {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        cursor: pointer;
        text-decoration: underline dotted;
      }
      .perm {
        color: var(--p2b-warn);
      }
      .dump {
        margin-top: 0.5rem;
      }
      .dump-controls {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.3rem;
        flex-wrap: wrap;
      }
      .dump-controls input {
        width: 8rem;
      }
      pre {
        margin: 0;
        white-space: pre;
        overflow: auto;
        max-height: 22rem;
      }
      .ascii {
        color: var(--p2b-dim);
      }
      .hidden-notice {
        color: var(--p2b-hidden);
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

  private selectedId?: string;
  private dumpOffset = 0;
  private offsetError = '';

  override render() {
    const rows = this.context === undefined ? [] : buildVmaList(this.context.projection, this.context.archBits);
    const selected = rows.find((row) => row.id === this.selectedId);
    return html`
      <header>
        <h2>自由视图</h2>
        <span class="note">${rows.length} 个 VMA · 隐藏区只有布局</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>VMA</th>
            <th>类别</th>
            <th>名称</th>
            <th>范围</th>
            <th>权限</th>
            <th>大小</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => this.renderVmaRow(row))}
        </tbody>
      </table>
      ${selected === undefined ? html`<p class="note">选中一个非隐藏 VMA 以 hex dump 浏览。</p>` : this.renderDetail(selected)}
    `;
  }

  private renderVmaRow(row: VmaListRow) {
    const selected = row.id === this.selectedId;
    return html`
      <tr class=${selected ? 'selected' : ''}>
        <th class="id" scope="row">
          <button
            type="button"
            class="pick"
            title=${row.hasContent ? '查看内容' : '隐藏区域：只显示布局'}
            @click=${() => this.select(row)}
          >
            ${row.id}
          </button>
        </th>
        <td>${row.kindName}</td>
        <td>${row.label ?? ''}</td>
        <td>${row.range}</td>
        <td class="perm">${row.perm}</td>
        <td>${row.sizeText}</td>
        <td>
          ${row.hidden
            ? html`<span class="hidden-tag">隐藏</span>`
            : row.hasContent
              ? '可见'
              : html`<span class="empty">无内容</span>`}
        </td>
      </tr>
    `;
  }

  private renderDetail(row: VmaListRow) {
    if (!row.hasContent) {
      return html`
        <div class="dump">
          <p class="hidden-notice">${hiddenNotice(row)}</p>
          <p class="note">隐藏 VMA 的字节永远不会出现在响应里，也就不会出现在这里（01 §6 第 2 条）。</p>
        </div>
      `;
    }
    const hex = this.vmaHex(row.id);
    const byteLength = dumpByteLength(hex);
    const maxOffset = dumpMaxOffset(byteLength, DEFAULT_DUMP_ROWS, DUMP_ROW_BYTES);
    const dump = buildHexDump(hex, {
      baseAddr: row.start,
      byteOffset: this.dumpOffset,
      rows: DEFAULT_DUMP_ROWS,
      rowBytes: DUMP_ROW_BYTES,
    });
    return html`
      <div class="dump">
        <div class="dump-controls">
          <strong>${row.id}</strong>
          <button type="button" @click=${() => this.page(-1)} ?disabled=${this.dumpOffset === 0}>上一页</button>
          <button type="button" @click=${() => this.page(1)} ?disabled=${this.dumpOffset >= maxOffset}>
            下一页
          </button>
          <button type="button" @click=${() => this.setOffset(0)}>回到起点</button>
          <label
            >字节偏移：
            <input
              type="text"
              .value=${`0x${this.dumpOffset.toString(16)}`}
              aria-label="hex dump 字节偏移"
              @change=${(event: Event) => this.setOffsetText((event.target as HTMLInputElement).value)}
            />
          </label>
          <span class="note">共 ${formatSize(BigInt(byteLength))} 字节</span>
          ${this.offsetError.length === 0 ? '' : html`<span class="error" role="alert">${this.offsetError}</span>`}
        </div>
        <pre>${dump.map(
          (line) => html`<div>
<span class="mono-dim">${line.address}</span>  ${line.hex}  <span class="ascii">|${line.ascii}|</span>
</div>`,
        )}</pre>
      </div>
    `;
  }

  private vmaHex(id: string): string | undefined {
    return this.context?.projection.vmas.find((vma) => vma.id === id)?.hex;
  }

  // 选中的 VMA 与 dump 偏移不是响应式属性，改完要显式请求重绘。
  private select(row: VmaListRow): void {
    this.selectedId = row.id;
    this.dumpOffset = 0;
    this.offsetError = '';
    this.requestUpdate();
  }

  private page(delta: number): void {
    const row = this.selectedRow();
    if (row === undefined) return;
    const byteLength = dumpByteLength(this.vmaHex(row.id));
    this.dumpOffset = clampDumpOffset(
      byteLength,
      this.dumpOffset + delta * DEFAULT_DUMP_ROWS * DUMP_ROW_BYTES,
      DEFAULT_DUMP_ROWS,
      DUMP_ROW_BYTES,
    );
    this.requestUpdate();
  }

  private setOffset(offset: number): void {
    const row = this.selectedRow();
    if (row === undefined) return;
    this.dumpOffset = clampDumpOffset(
      dumpByteLength(this.vmaHex(row.id)),
      offset,
      DEFAULT_DUMP_ROWS,
      DUMP_ROW_BYTES,
    );
    this.requestUpdate();
  }

  private setOffsetText(text: string): void {
    const parsed = parseAddrInput(text);
    if (parsed === undefined) {
      this.offsetError = '偏移格式不对：写 0x 前缀的十六进制或十进制整数。';
      this.requestUpdate();
      return;
    }
    this.offsetError = '';
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    this.setOffset(Number(parsed > max ? max : parsed));
  }

  private selectedRow(): VmaListRow | undefined {
    if (this.context === undefined || this.selectedId === undefined) return undefined;
    return buildVmaList(this.context.projection, this.context.archBits).find((row) => row.id === this.selectedId);
  }
}

customElements.define('pwn2block-memory-view', Pwn2BlockMemoryView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-memory-view': Pwn2BlockMemoryView;
  }
}
