/**
 * 运行菜单按钮组（05 §1、§3）：顶部「运行」菜单与 payload 工具栏**共用同一个组件**，
 * 保证两处的按钮、禁用状态与禁用原因完全一致（05 §1 要求两处等价）。
 *
 * 组件不判定可用性：它只渲染 `RunButtonModel[]`（来自 `viewmodel/toolbar.ts`）并把
 * `RunCommand` 派发出去。所以「界面上能点的」与「控制器允许发的」是同一张表。
 */
import { LitElement, css, html } from 'lit';
import { MAX_STEP_COUNT } from '@pwn2block/shared';
import { parseStepCount } from '../viewmodel/program';
import type { RunButtonModel, RunCommand } from '../viewmodel/toolbar';
import { sharedStyles, terminalTheme } from '../theme';

/** 「编译」也是按钮，但它不是 API 命令（本地操作），所以单独一个 id。 */
export type RunMenuCommand = RunCommand | { readonly kind: 'compile' };

export class Pwn2BlockRunMenu extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .buttons {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.3rem;
      }
      .run-n {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      .run-n input {
        width: 5.5rem;
      }
      .reasons {
        margin: 0.3rem 0 0;
        color: var(--p2b-warn);
        font-size: 0.8rem;
      }
      .reasons summary { cursor: pointer; }
      .reasons ul { margin: 0.4rem 0; padding-left: 1.2rem; }
      .busy {
        margin-left: auto;
        color: var(--p2b-dim);
      }
      .count-error {
        color: var(--p2b-error);
      }
    `,
  ];

  static override properties = {
    model: { attribute: false },
    busy: { type: Boolean },
    pending: { type: Number },
    countError: { state: true },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare model: readonly RunButtonModel[];
  declare busy: boolean;
  declare pending: number;

  private countText = '10';
  private declare countError: string;

  constructor() {
    super();
    this.model = [];
    this.busy = false;
    this.pending = 0;
    this.countError = '';
  }

  override render() {
    const reasons = new Map<string, string[]>();
    for (const button of this.model) {
      if (button.enabled || button.disabledReason === undefined) continue;
      const labels = reasons.get(button.disabledReason) ?? [];
      labels.push(button.label);
      reasons.set(button.disabledReason, labels);
    }
    return html`
      <div class="buttons" role="group" aria-label="运行">
        ${this.model.map((button) => this.renderButton(button))}
        ${this.busy || this.pending > 0
          ? html`<span class="busy" role="status" aria-live="polite">
              ${this.busy ? '请求进行中…' : ''}${this.pending > 0 ? `排队 ${this.pending} 个动作` : ''}
            </span>`
          : ''}
      </div>
      ${this.countError.length === 0
        ? ''
        : html`<p id="count-error" class="count-error" role="alert">${this.countError}</p>`}
      ${reasons.size === 0
        ? ''
        : html`<details class="reasons">
            <summary>查看按钮不可用的原因</summary>
            <ul>${[...reasons].map(([reason, labels]) => html`<li>${labels.join('、')}：${reason}</li>`)}</ul>
          </details>`}
    `;
  }

  private renderButton(button: RunButtonModel) {
    if (button.id === 'run-n') return this.renderRunN(button);
    const title = button.enabled ? button.hint : `${button.hint}（不可用：${button.disabledReason ?? ''}）`;
    return html`
      <button
        type="button"
        title=${title}
        ?disabled=${!button.enabled}
        @click=${() => this.emit({ kind: button.id } as RunMenuCommand)}
      >
        ${button.label}
      </button>
    `;
  }

  private renderRunN(button: RunButtonModel) {
    const title = button.enabled ? button.hint : `${button.hint}（不可用：${button.disabledReason ?? ''}）`;
    return html`
      <span class="run-n">
        <input
          type="number"
          min="1"
          max=${MAX_STEP_COUNT}
          step="1"
          aria-label="运行步数"
          aria-invalid=${this.countError.length > 0 ? 'true' : 'false'}
          aria-describedby=${this.countError.length > 0 ? 'count-error' : ''}
          title="运行多少条指令（1–${MAX_STEP_COUNT}）"
          .value=${this.countText}
          ?disabled=${!button.enabled}
          @input=${(event: Event) => this.onCountInput(event)}
          @keydown=${(event: KeyboardEvent) => this.onCountKey(event)}
        />
        <button type="button" title=${title} ?disabled=${!button.enabled} @click=${() => this.emitRunN()}>
          ${button.label}
        </button>
      </span>
    `;
  }

  private onCountInput(event: Event): void {
    this.countText = (event.target as HTMLInputElement).value;
    this.countError = '';
  }

  private onCountKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.emitRunN();
  }

  private emitRunN(): void {
    const count = parseStepCount(this.countText, MAX_STEP_COUNT);
    if (count === undefined) {
      this.countError = `运行步数需要是 1–${MAX_STEP_COUNT} 的整数（当前输入：${this.countText || '空'}）`;
      return;
    }
    this.countError = '';
    this.emit({ kind: 'run-n', count });
  }

  private emit(command: RunMenuCommand): void {
    this.dispatchEvent(new CustomEvent<RunMenuCommand>('p2b-run', { detail: command, bubbles: true, composed: true }));
  }
}

customElements.define('pwn2block-run-menu', Pwn2BlockRunMenu);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-run-menu': Pwn2BlockRunMenu;
  }
}
