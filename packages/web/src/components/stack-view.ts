/**
 * 栈视图（05 §2.2）。
 *
 * 每行 W 字节；`sp` / `bp` 与其他指向本行的寄存器作为锚点标签；
 * 右侧是 pwndbg 风格附注（跳转链最多 3 跳、终点伪汇编、可打印 ASCII）；
 * 隐藏 VMA 的字节显示 `??` 并标出所属 VMA，未映射显示为空。
 *
 * 数据全部来自 `viewmodel/stack.ts`；组件只管排版、地址跳转与自动跟随 `sp`。
 */
import { LitElement, css, html } from 'lit';
import { live } from 'lit/directives/live.js';
import { alignDown, formatAddrShort, parseAddrInput } from '../viewmodel/format';
import { searchVisibleBytes, type ByteSearchMode } from '../viewmodel/search';
import { roleValue } from '../viewmodel/roles';
import {
  buildStackRows,
  findRowIndex,
  refollowBase,
  type StackByteCell,
  type StackRowModel,
} from '../viewmodel/stack';
import { sharedStyles, terminalTheme } from '../theme';
import { regionClass, rowStyles } from './view-rows';
import { scrollRowInBody } from './view-scroll';
import type { ViewContext } from './view-context';

export class Pwn2BlockStackView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    rowStyles,
    css`
      .rows {
        grid-template-columns: repeat(6, max-content);
      }
      .anchor {
        color: var(--p2b-changed);
      }
      .byte {
        display: inline-block;
        width: 2ch;
        margin-right: 1ch;
      }
      .byte:last-child {
        margin-right: 0;
      }
      .byte.hidden {
        color: var(--p2b-hidden);
      }
      .byte.changed {
        color: var(--p2b-changed);
        font-weight: 700;
      }
      .label {
        font-weight: 700;
      }
      p.dim {
        margin: 0.3rem 0 0;
      }
    `,
  ];

  static override properties = {
    context: { attribute: false },
    active: { type: Boolean },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare context: ViewContext;
  /** 是否为当前标签；非当前时只记下待跟随，不在隐藏状态下滚动。 */
  declare active: boolean;

  /** 手动跳转后的窗口起点；undefined 表示跟随 `sp`。 */
  private jumpBase?: bigint;
  /** 对齐偏移（05 §2.2）：窗口起点再往后挪几字节。 */
  private alignOffset = 0;
  private inputText = '';
  private inputError = '';
  private searchText = '';
  private searchMode: ByteSearchMode = 'hex';
  private searchMessage = '';
  private searchInvalid = false;
  private scrollAddr?: bigint;
  /** 有新投影或刚切回标签，下次可见时要把 sp 行滚进主体区。 */
  private followPending = false;

  constructor() {
    super();
    this.active = true;
  }

  override render() {
    return html`
      <div class="cmd">${this.renderJump()} ${this.renderSearch()}</div>
      <div class="rows" role="list" aria-label="栈：行号:偏移、锚点、地址、字节、指针链、标注">
        ${this.rows().map((row) => this.renderRow(row))}
      </div>
      <p class="dim">?? = 隐藏 VMA（内容未下发） · 空白 = 未映射 · 黄色 = 本次投影变化的字节</p>
    `;
  }

  private renderJump() {
    const following = this.jumpBase === undefined;
    return html`
      <span class="dim">每行 ${this.wordBytes()} 字节 · ${following ? '跟随 sp' : `已跳到 ${formatAddrShort(this.baseAddr())}`}</span>
      <label>跳转 <input
        type="text"
        .value=${this.inputText}
        placeholder="0x7fffff00"
        aria-label="跳转到地址"
        @input=${(event: Event) => {
          this.inputText = (event.target as HTMLInputElement).value;
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter') this.jump();
        }}
      /></label>
      <button type="button" @click=${() => this.jump()}>跳转</button>
      <button type="button" @click=${() => this.jumpTo(this.spValue())}>跳到 sp</button>
      <button type="button" @click=${() => this.followSp()} ?disabled=${following}>跟随 sp</button>
      <label>对齐 <input
        type="number"
        min="0"
        max=${this.wordBytes() - 1}
        .value=${live(String(this.alignOffset))}
        aria-label="行首对齐偏移"
        @change=${(event: Event) => this.setAlign((event.target as HTMLInputElement).value)}
      /></label>
      ${this.inputError.length > 0 ? html`<span class="error" role="alert">${this.inputError}</span>` : ''}
    `;
  }

  private renderSearch() {
    return html`
      <label>搜索 <input
        aria-label="搜索字节序列" placeholder="41 42"
        @input=${(event: Event) => { this.searchText = (event.target as HTMLInputElement).value; }}
        @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter') this.search(); }}
      /></label>
      <select aria-label="搜索编码" @change=${(event: Event) => {
        this.searchMode = (event.target as HTMLSelectElement).value === 'ascii' ? 'ascii' : 'hex';
      }}>
        <option value="hex">hex</option><option value="ascii">ASCII</option>
      </select>
      <button type="button" @click=${() => this.search()}>搜索</button>
      <span class=${this.searchInvalid ? 'error' : 'dim'} role=${this.searchInvalid ? 'alert' : 'status'}>${this.searchMessage}</span>
    `;
  }

  /** `NN:OOOO│ <锚点> <地址>  <W 个字节>  <链/附注>  <标注名>`（设计 §3.3）。 */
  private renderRow(row: StackRowModel) {
    const isSp = row.anchors.some((anchor) => anchor.role === 'sp');
    return html`
      <div class=${isSp ? 'row sp' : 'row'} role="listitem" data-row=${row.index}>
        <span class="dim">${row.prefix}│</span>
        <span class="anchor">${row.anchors.map((anchor) => (anchor.role ? `${anchor.role} (${anchor.name})` : anchor.name)).join(' ')}</span>
        <span class="addr">${row.address}</span>
        <span class=${`value ${regionClass(row.region)}`}>${row.cells.map((cell) => this.renderCell(cell))}</span>
        <span>${this.renderNote(row)}</span>
        <span class="label">${row.label === undefined ? '' : `${row.label.kindName}：${row.label.name}`}</span>
      </div>
    `;
  }

  /** 未映射的字节格留空（不换成任何字符），宽度由 CSS 的 2ch 撑住。 */
  private renderCell(cell: StackByteCell) {
    const classes = `byte ${cell.state}${cell.changed ? ' changed' : ''}`;
    return html`<span class=${classes} title=${cell.vmaId ?? '未映射'}>${cell.text}</span>`;
  }

  /** 指针链优先；不像指针时退到本行可打印 ASCII；隐藏字节只标所属 VMA，不给内容。 */
  private renderNote(row: StackRowModel) {
    const chain = row.chain;
    const hidden = row.hiddenVmaIds.length === 0
      ? ''
      : html` <span class="r-hidden">隐藏 VMA「${row.hiddenVmaIds.join('、')}」</span>`;
    if (chain !== undefined) {
      const annotation = chain.annotation === undefined ? '' : html` <span class="dim">${chain.annotation}</span>`;
      return html`${chain.arrows}${annotation}${hidden}`;
    }
    return html`${row.ascii === undefined ? '' : html`<span class="dim">'${row.ascii}'</span>`}${hidden}`;
  }

  private wordBytes(): number {
    return this.context === undefined ? 8 : Math.max(1, Math.floor(this.context.archBits / 8));
  }

  /**
   * `sp` 的当前值：只认上下文里的角色映射（`createViewContext` 保证它等于 `projection.roles`，08 §9.2）。
   * 题目没下发这个寄存器时按 0 处理——窗口起点退化成未映射区，而不是猜 `RSP`。
   */
  private spValue(): bigint {
    if (this.context === undefined) return 0n;
    return roleValue(this.context.projection, this.context.roles, 'sp') ?? 0n;
  }

  private baseAddr(): bigint {
    if (this.jumpBase !== undefined) return this.jumpBase;
    return alignDown(this.spValue(), this.wordBytes()) - BigInt(4 * this.wordBytes());
  }

  private rows(): readonly StackRowModel[] {
    if (this.context === undefined) return [];
    return buildStackRows({
      projection: this.context.projection,
      archBits: this.context.archBits,
      roles: this.context.roles,
      labels: this.context.labels,
      diff: this.context.diff,
      startAddr: this.jumpBase,
      alignOffset: this.alignOffset,
    });
  }

  /** 表格没有虚拟滚动，一次 40 行；`sp` 移出窗口时自动回到跟随状态（05 §2.2）。 */
  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('context') || this.context === undefined) return;
    const previous = changed.get('context') as ViewContext | undefined;
    if (previous?.projection === this.context.projection) return;
    this.searchMessage = '';
    this.searchInvalid = false;
    if (this.jumpBase === undefined) return;
    const rows = this.rows();
    if (refollowBase(rows, this.spValue(), this.wordBytes()) !== undefined) this.jumpBase = undefined;
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get('context') as ViewContext | undefined;
    if (changed.has('context') && previous?.projection !== this.context?.projection) this.followPending = true;
    // active 由 false 变 true：切回本标签，补做一次跟随。
    if (changed.get('active') === false) this.followPending = true;
    if (!this.active) return;
    const addr = this.scrollAddr ?? (this.followPending ? this.spValue() : undefined);
    this.scrollAddr = undefined;
    this.followPending = false;
    if (addr === undefined) return;
    const index = findRowIndex(this.rows(), addr);
    if (index !== undefined) scrollRowInBody(this, this.renderRoot.querySelector(`[data-row="${index}"]`));
  }

  // 内部状态（跳转起点、对齐偏移、错误文案）不是响应式属性，改完要显式请求重绘。
  private jump(): void {
    const parsed = parseAddrInput(this.inputText);
    if (parsed === undefined) {
      this.inputError = '地址格式不对：写 0x 前缀的十六进制或十进制整数。';
      this.requestUpdate();
      return;
    }
    this.jumpTo(parsed);
  }

  private jumpTo(addr: bigint): void {
    this.scrollAddr = addr;
    this.inputError = '';
    this.jumpBase = alignDown(addr, this.wordBytes());
    this.inputText = formatAddrShort(addr);
    this.requestUpdate();
  }

  private followSp(): void {
    this.scrollAddr = this.spValue();
    this.inputError = '';
    this.jumpBase = undefined;
    this.inputText = '';
    this.requestUpdate();
  }

  private search(): void {
    if (this.context === undefined) return;
    const result = searchVisibleBytes(this.context.projection, this.searchText, this.searchMode);
    this.searchInvalid = result.kind === 'invalid';
    if (result.kind === 'found') {
      // 搜索目标可能落在字内；恢复对齐以确保命中字节在窗口中。
      this.alignOffset = 0;
      this.jumpTo(result.addr);
      this.searchMessage = `已跳到 ${formatAddrShort(result.addr)}（首个匹配）。`;
    } else {
      this.searchMessage = result.kind === 'invalid'
        ? result.message : '当前可见 VMA 内未找到匹配（不搜索隐藏区域，不跨 VMA）。';
    }
    this.requestUpdate();
  }

  private setAlign(text: string): void {
    const parsed = Number.parseInt(text, 10);
    const max = this.wordBytes() - 1;
    this.alignOffset = Number.isFinite(parsed) ? Math.min(Math.max(0, parsed), max) : 0;
    this.requestUpdate();
  }
}

customElements.define('pwn2block-stack-view', Pwn2BlockStackView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-stack-view': Pwn2BlockStackView;
  }
}
