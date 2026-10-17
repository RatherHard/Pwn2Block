/**
 * 指令视图（05 §2.3，排版见 frontend-tui 设计 §3.3）。
 *
 * 每行 `► 0x400000 <vuln+0>  <机器码>  <伪汇编>`。数据直接来自投影 `disasm`，**前端不解码**。
 * `target` 渲染成可点击的 `<win>`（不在本次反汇编窗口时给出提示）；`ip` 所在行以 `►` 开头、
 * 整行用 `--p2b-ip` 并自动滚入视野；函数列表由公开标注里 `kind = func` 的条目生成，放在命令栏。
 */
import { LitElement, css, html, nothing } from 'lit';
import { parseHex } from '@pwn2block/shared';
import { buildDisasmRows, findDisasmRow, type DisasmRowModel } from '../viewmodel/disasm';
import { formatAddrShort } from '../viewmodel/format';
import { funcLabels } from '../viewmodel/labels';
import { roleValue } from '../viewmodel/roles';
import { sharedStyles, terminalTheme } from '../theme';
import { rowStyles } from './view-rows';
import { scrollRowInBody } from './view-scroll';
import type { ViewContext } from './view-context';

export class Pwn2BlockDisasmView extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    rowStyles,
    css`
      .rows {
        grid-template-columns: repeat(5, max-content);
      }
      .row.focused {
        outline: 1px dashed var(--p2b-focus);
      }
      .row.changed .text {
        color: var(--p2b-changed);
      }
      .sym {
        color: var(--p2b-code);
      }
      .mark {
        width: 1ch;
      }
      .text {
        white-space: pre;
      }
      button.target {
        margin-left: 1ch;
        color: var(--p2b-code);
      }
      /*
       * 当前指令整行用 --p2b-ip（设计 §3.3），盖过 .addr / .sym / .dim 与跳转目标的颜色。
       * .row.changed .text 是 (0,3,0)，比 .row.ip > *（(0,2,0)）高，所以另写同为 (0,3,0) 的
       * .row.ip .text 并排在它之后：同一行既变化又是 ip 时，以 ► 与 ip 色为准。
       * 跳转目标用 :where 压到与 button.target 相同的 (0,1,1)：盖过代码色，但不盖过共享样式的悬停反显。
       */
      .row.ip,
      .row.ip > *,
      .row.ip .text,
      :where(.row.ip) button.target {
        color: var(--p2b-ip);
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
  /** 是否为当前标签；隐藏时不滚动，切回时补做一次跟随。 */
  declare active: boolean;

  private focusedAddr?: bigint;
  private focusMiss = '';

  constructor() {
    super();
    this.active = true;
  }

  override render() {
    const notice = this.context?.disasmNotice;
    if (notice !== undefined) {
      return html`
        <p class="error" role="status" aria-live="polite">${notice}</p>
        <p class="dim">
          录像帧不带逐帧反汇编（09 §3.4），代码段在回放中被改写后无法保证这一帧的指令；
          前端不解码，也不会继续显示过期反汇编（03 §4）。回放里的寄存器与栈视图不受影响。
        </p>
      `;
    }
    const rows = this.disasmRows();
    return html`
      ${this.renderCmd(rows.length)}
      <div class="rows" role="list" aria-label="指令：地址、符号、机器码、伪汇编">
        ${rows.map((row) => this.renderRow(row))}
      </div>
      <p class="dim">
        没有断点：想停在某条指令前，用「运行 N 步」冲过去再 step_back 倒回来，或者点上面的跳转目标。
      </p>
    `;
  }

  private renderCmd(count: number) {
    const funcs = funcLabels(this.context?.labels);
    return html`
      <div class="cmd">
        <span class="dim">${count} 条 · 伪汇编来自服务端投影</span>
        ${funcs.length === 0
          ? ''
          : html`<span class="dim">函数</span>
              ${funcs.map(
                (label) =>
                  html`<button type="button" @click=${() => this.jumpTo(parseHex(label.addr))}>${label.name}</button>`,
              )}`}
        ${this.focusMiss.length === 0 ? '' : html`<span class="error" role="alert">${this.focusMiss}</span>`}
      </div>
    `;
  }

  private renderRow(row: DisasmRowModel) {
    const classes = [
      'row',
      row.isIp ? 'ip' : '',
      this.focusedAddr === row.addr ? 'focused' : '',
      row.changed ? 'changed' : '',
    ]
      .filter((item) => item.length > 0)
      .join(' ');
    return html`
      <div class=${classes} role="listitem" aria-current=${row.isIp ? 'true' : nothing}>
        <span class="mark">${row.isIp ? '►' : ''}</span>
        <span class="addr">${row.address}</span>
        <span class="sym">${row.symbol === undefined ? '' : `<${row.symbol}>`}</span>
        <span class="dim">${row.bytesText}</span>
        <span class="text">${row.text}${this.renderTarget(row)}</span>
      </div>
    `;
  }

  private renderTarget(row: DisasmRowModel) {
    const target = row.target;
    if (target === undefined) return '';
    return html`<button
      type="button"
      class="target"
      title="跳到 ${formatAddrShort(target)}"
      @click=${() => this.jumpTo(target)}
    >&lt;${row.targetText}&gt;</button>`;
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

  /** `ip` 行高亮的值：只认上下文里的角色映射（等于 `projection.roles`，08 §9.2），不猜 `RIP`。 */
  private ipValue(): bigint | undefined {
    if (this.context === undefined) return undefined;
    return roleValue(this.context.projection, this.context.roles, 'ip');
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

  /** 新投影恢复 ip 跟随，普通界面重绘保留用户手动选择的目标。 */
  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('context') || this.context === undefined) return;
    const previous = changed.get('context') as ViewContext | undefined;
    if (previous?.projection === this.context.projection) return;
    this.focusedAddr = undefined;
    this.focusMiss = '';
  }

  /** 在标签主体区内显示 ip 或刚点过的目标行（05 §2.3）；切回本标签时也跟随一次。 */
  override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this.active) return;
    const previous = changed.get('context') as ViewContext | undefined;
    // 只有切回标签与同投影的 context 变化落在同一次更新里时才起作用：否则下一行不会提前返回。
    const reactivated = changed.get('active') === false;
    if (!reactivated && changed.has('context') && previous?.projection === this.context?.projection) return;
    const selector = this.focusedAddr === undefined ? '.row.ip' : '.row.focused';
    scrollRowInBody(this, this.renderRoot.querySelector(selector));
  }
}

customElements.define('pwn2block-disasm-view', Pwn2BlockDisasmView);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-disasm-view': Pwn2BlockDisasmView;
  }
}
