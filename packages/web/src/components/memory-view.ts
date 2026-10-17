/**
 * 自由视图（05 §2.5，排版见 frontend-tui 设计 §3.3）。
 *
 * VMA 列表每行 `起始 结束 权限 大小 名称`，整行按区域着色；隐藏的标「隐藏」，
 * **只显示布局、不显示内容**；非隐藏 VMA 可选，下方用 hexdump（`地址  16 字节  |ASCII|`）按窗口浏览。
 * 不提供任意地址读取：只能看投影里已经有的字节。
 */
import { LitElement, css, html } from 'lit';
import { live } from 'lit/directives/live.js';
import {
  DEFAULT_DUMP_ROWS,
  buildHexDump,
  buildVmaList,
  clampDumpOffset,
  dumpByteLength,
  dumpMaxOffset,
  hiddenNotice,
  type HexDumpRow,
  type VmaListRow,
} from '../viewmodel/memory';
import { formatSize, parseAddrInput } from '../viewmodel/format';
import { vmaRegion } from '../viewmodel/region';
import { sharedStyles, terminalTheme } from '../theme';
import { regionClass, rowStyles } from './view-rows';
import type { ViewContext } from './view-context';

const DUMP_ROW_BYTES = 16;

/** 整行着色直接取自这一行 VMA 的公开布局：隐藏优先，其次按种类（设计 §3.3）。 */
function regionOf(row: VmaListRow): string {
  return regionClass(vmaRegion(row));
}

export class Pwn2BlockMemoryView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    rowStyles,
    css`
      .rows {
        grid-template-columns: repeat(7, max-content);
      }
      .row.selected {
        font-weight: 700;
      }
      .dump {
        margin-top: 0.5rem;
      }
      .dump .cmd {
        border-top: 1px solid var(--p2b-line);
        padding-top: 0.3rem;
      }
      /* hexdump 每行是一段定宽原文，列间距就是文本里的空格，不走 grid。 */
      .dump .lines {
        overflow-x: auto;
        font-variant-ligatures: none;
      }
      .dump .row {
        display: block;
        white-space: pre;
      }
      p {
        margin: 0.3rem 0 0;
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
      <div class="cmd"><span class="dim">${rows.length} 个 VMA · 隐藏区只有布局 · 点名称看 hexdump</span></div>
      <div class="rows" role="list" aria-label="VMA：起始、结束、权限、大小、名称">
        <div class="cols" aria-hidden="true">
          <span>起始</span><span>结束</span><span>权限</span><span>大小</span><span>名称</span><span></span><span></span>
        </div>
        ${rows.map((row) => this.renderVmaRow(row, regionOf(row)))}
      </div>
      ${selected === undefined ? html`<p class="dim">选中一个非隐藏 VMA 以 hexdump 浏览。</p>` : this.renderDetail(selected)}
    `;
  }

  private renderVmaRow(row: VmaListRow, region: string) {
    const selected = row.id === this.selectedId;
    const classes = ['row', region, selected ? 'selected' : ''].filter((item) => item.length > 0).join(' ');
    return html`
      <div class=${classes} role="listitem">
        <span>${row.startText}</span>
        <span>${row.endText}</span>
        <span>${row.perm}</span>
        <span>${row.sizeText}</span>
        <span><button
          type="button"
          aria-pressed=${selected ? 'true' : 'false'}
          title=${row.hasContent ? '查看内容' : '隐藏区域：只显示布局'}
          @click=${() => this.select(row)}
        >${row.id}</button></span>
        <span class="dim">${row.label ?? ''} ${row.kindName}</span>
        <span>${row.hidden ? '隐藏' : row.hasContent ? '' : html`<span class="dim">无内容</span>`}</span>
      </div>
    `;
  }

  private renderDetail(row: VmaListRow) {
    if (!row.hasContent) {
      return html`
        <div class="dump">
          <p class="r-hidden">${hiddenNotice(row)}</p>
          <p class="dim">隐藏 VMA 的字节永远不会出现在响应里，也就不会出现在这里（01 §6 第 2 条）。</p>
        </div>
      `;
    }
    const hex = this.vmaHex(row.id);
    const dump = buildHexDump(hex, {
      baseAddr: row.start,
      byteOffset: this.dumpOffset,
      rows: DEFAULT_DUMP_ROWS,
      rowBytes: DUMP_ROW_BYTES,
    });
    return html`
      <div class="dump">
        ${this.renderDumpCmd(row, dumpByteLength(hex))}
        <div class="lines" role="list" aria-label=${`${row.id} 的 hexdump：地址、16 字节、ASCII`}>
          ${dump.map((line) => this.renderDumpLine(line))}
        </div>
      </div>
    `;
  }

  private renderDumpCmd(row: VmaListRow, byteLength: number) {
    const maxOffset = dumpMaxOffset(byteLength, DEFAULT_DUMP_ROWS, DUMP_ROW_BYTES);
    return html`
      <div class="cmd">
        <strong>${row.id}</strong>
        <button type="button" @click=${() => this.page(-1)} ?disabled=${this.dumpOffset === 0}>上一页</button>
        <button type="button" @click=${() => this.page(1)} ?disabled=${this.dumpOffset >= maxOffset}>下一页</button>
        <button type="button" @click=${() => this.setOffset(0)}>回到起点</button>
        <label>偏移 <input
          type="text"
          .value=${live(`0x${this.dumpOffset.toString(16)}`)}
          aria-label="hex dump 字节偏移"
          @change=${(event: Event) => this.setOffsetText((event.target as HTMLInputElement).value)}
        /></label>
        <span class="dim">共 ${formatSize(BigInt(byteLength))} 字节</span>
        ${this.offsetError.length === 0 ? '' : html`<span class="error" role="alert">${this.offsetError}</span>`}
      </div>
    `;
  }

  /** 一行就是 `地址  16 字节  |ASCII|` 的原文：模板写在一行里，不让缩进混进文本。 */
  private renderDumpLine(line: HexDumpRow) {
    return html`<div class="row" role="listitem"><span class="addr">${line.address}</span>  <span>${line.hex}</span>  <span class="dim">|${line.ascii}|</span></div>`;
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
    this.offsetError = '';
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
    this.offsetError = '';
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
