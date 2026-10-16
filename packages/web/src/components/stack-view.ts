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
import { buildStackRows, findRowIndex, refollowBase, type StackRowModel } from '../viewmodel/stack';
import { sharedStyles, terminalTheme } from '../theme';
import { scrollRowInSlot } from './view-scroll';
import type { ViewContext } from './view-context';

export class Pwn2BlockStackView extends LitElement {
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
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-bottom: 0.3rem;
      }
      .jump input {
        width: 9rem;
      }
      table {
        font-variant-ligatures: none;
      }
      tr.changed td,
      tr.changed th {
        background: #2a2713;
      }
      th.addr {
        color: var(--p2b-accent);
        font-weight: 400;
      }
      .anchor {
        color: var(--p2b-warn);
      }
      .byte {
        display: inline-block;
        width: 1.7ch;
        text-align: center;
      }
      .byte.hidden {
        color: var(--p2b-hidden);
      }
      .byte.unmapped {
        color: #33403b;
      }
      .byte.changed {
        color: var(--p2b-changed);
        font-weight: 700;
      }
      .ascii {
        color: var(--p2b-dim);
      }
      .label {
        font-weight: 600;
      }
      .note-cell {
        color: var(--p2b-dim);
      }
      .note-cell .arrows {
        color: var(--p2b-fg);
      }
      .note-cell .hidden-tag {
        color: var(--p2b-hidden);
      }
      .legend {
        display: flex;
        gap: 0.8rem;
        margin-top: 0.3rem;
        color: var(--p2b-dim);
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

  override render() {
    const rows = this.rows();
    const sp = this.spValue();
    const following = this.jumpBase === undefined;
    return html`
      <header>
        <h2>栈视图</h2>
        <span class="note">每行 ${this.wordBytes()} 字节 · ${following ? '跟随 sp' : `已跳到 ${formatAddrShort(this.baseAddr())}`}</span>
        <span class="jump">
          <label>跳转：<input
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
          <button type="button" @click=${() => this.jumpTo(sp)}>跳到 sp</button>
          <button type="button" @click=${() => this.followSp()} ?disabled=${following}>跟随 sp</button>
        </span>
        <label
          >对齐偏移：
          <input
            type="number"
            min="0"
            max=${this.wordBytes() - 1}
            .value=${live(String(this.alignOffset))}
            aria-label="行首对齐偏移"
            @change=${(event: Event) => this.setAlign((event.target as HTMLInputElement).value)}
          />
        </label>
        ${this.inputError.length > 0 ? html`<span class="error" role="alert">${this.inputError}</span>` : ''}
      </header>
      <div class="search">
        <label>字节搜索：<input
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
        <span class=${this.searchInvalid ? 'error' : 'note'} role=${this.searchInvalid ? 'alert' : 'status'}>${this.searchMessage}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>地址</th>
            <th>锚点</th>
            <th>字节</th>
            <th>ASCII</th>
            <th>标注</th>
            <th>附注</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => this.renderRow(row))}
        </tbody>
      </table>
      <p class="legend">
        <span class="hidden-tag">?? = 隐藏 VMA（内容未下发）</span>
        <span>空白 = 未映射</span>
        <span class="changed">黄色 = 本次投影变化的字节</span>
      </p>
    `;
  }

  private renderRow(row: StackRowModel) {
    const chain = row.chain;
    return html`
      <tr data-row=${row.index} class=${`${row.changed ? 'changed' : ''} ${row.anchors.some((anchor) => anchor.role === 'sp') ? 'sp' : ''}`}>
        <th class="addr" scope="row">${row.address}</th>
        <td class="anchor">
          ${row.anchors.map((anchor) => (anchor.role ? `${anchor.role} (${anchor.name})` : anchor.name)).join(' ')}
        </td>
        <td class="bytes">
          ${row.cells.map((cell) => {
            const text = cell.text.length === 0 ? '\u00a0' : cell.text;
            const classes = `byte ${cell.state}${cell.changed ? ' changed' : ''}`;
            return html`<span class=${classes} title=${cell.vmaId ?? '未映射'}>${text}</span>`;
          })}
        </td>
        <td class="ascii">${row.ascii === undefined ? '' : `|${row.ascii}|`}</td>
        <td class="label" style=${row.label === undefined ? '' : `color:${row.label.color}`}>
          ${row.label === undefined ? '' : `${row.label.kindName}：${row.label.name}`}
        </td>
        <td class="note-cell">
          ${chain === undefined
            ? ''
            : html`<span class="arrows">${chain.arrows}</span>
                ${chain.annotation === undefined ? '' : ` ${chain.annotation}`}`}
          ${row.hiddenVmaIds.length === 0
            ? ''
            : html`<span class="hidden-tag"> 隐藏 VMA「${row.hiddenVmaIds.join('、')}」</span>`}
        </td>
      </tr>
    `;
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
      startAddr: this.jumpBase === undefined ? undefined : this.baseAddr() + BigInt(this.alignOffset),
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
    const newProjection = changed.has('context') && previous?.projection !== this.context?.projection;
    const addr = this.scrollAddr ?? (newProjection ? this.spValue() : undefined);
    this.scrollAddr = undefined;
    if (addr === undefined) return;
    const index = findRowIndex(this.rows(), addr);
    if (index !== undefined) scrollRowInSlot(this, this.renderRoot.querySelector(`[data-row="${index}"]`));
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
