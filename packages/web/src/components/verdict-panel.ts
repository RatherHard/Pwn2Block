/**
 * 判题结果模式（05 §6）：通过横幅 / 编码不足 / 失败 / 被拒绝四种结论 + flag + 回放时间线。
 *
 * - 四种结论的文案与定位来自 `viewmodel/verdict.ts`（纯函数，可单测）；
 * - 时间线拖动改的是 `position`，页面壳据此把左侧视图切到录像的对应帧；
 * - 「回到调试」随时可用：调试实例的状态从来没有被提交改动（05 §6）。
 *   诚实提醒：文案里不出现剩余次数，提交不限次数（05 §6）。
 */
import { LitElement, css, html } from 'lit';
import type { ReplayView } from '@pwn2block/shared';
import type { ControllerState } from '../viewmodel/controller';
import { actionInstructionsAt } from '../viewmodel/replay';
import { positionSummary, verdictModel, type VerdictModel } from '../viewmodel/verdict';
import { statusMarker } from '../viewmodel/session';
import { sharedStyles, terminalTheme } from '../theme';

export class Pwn2BlockVerdictPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        padding: 0.85rem 1rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
        border-bottom: var(--p2b-border) solid var(--p2b-line);
        background: var(--p2b-bg);
      }
      .banner {
        display: flex;
        align-items: baseline;
        gap: 0.55rem;
        margin: 0;
        flex-wrap: wrap;
      }
      .banner .mark {
        font-size: inherit;
      }
      .banner strong {
        font-size: inherit;
        letter-spacing: 0.04em;
      }
      .ok .mark,
      .ok strong {
        color: var(--p2b-ip);
      }
      .warn .mark,
      .warn strong {
        color: var(--p2b-changed);
      }
      .error .mark,
      .error strong {
        color: var(--p2b-error);
      }
      .detail {
        white-space: pre-wrap;
      }
      .emphasize {
        margin: 0.55rem 0 0;
        padding: 0.55rem 0.7rem;
        border-left: 3px solid var(--p2b-changed);
        border-radius: 0;
        color: var(--p2b-changed);
        background: var(--p2b-bg);
      }
      .flag {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
        margin-top: 0.65rem;
      }
      .flag code {
        padding: 0.35rem 0.65rem;
        border: var(--p2b-border) solid var(--p2b-ip);
        border-radius: 0;
        color: var(--p2b-ip);
        background: var(--p2b-bg);
        user-select: all;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
        margin-top: 0.65rem;
      }
      .timeline {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        flex-wrap: wrap;
        margin-top: 0.7rem;
        padding-top: 0.7rem;
        border-top: var(--p2b-border) solid var(--p2b-line);
      }
      input[type='range'] {
        flex: 1;
        min-width: 12rem;
        accent-color: var(--p2b-fg);
      }
      .pos {
        color: var(--p2b-dim);
      }
      .spacer {
        margin-left: auto;
      }
    `,
  ];

  static override properties = {
    state: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）。 */
  declare state: ControllerState;

  private copied = '';

  override render() {
    const verdict = this.state?.verdict;
    if (verdict === undefined) {
      return html`
        <div class="meta">
          <h2>判题结果</h2>
          <span class="note">还没有提交过：点「提交判题」后，这里显示判定结论与回放录像。</span>
          <span class="spacer"></span>
          <button type="button" @click=${this.backToDebug}>回到调试</button>
        </div>
      `;
    }
    const model = verdictModel({
      response: verdict.response,
      origins: verdict.origins,
      originsVersion: verdict.originsVersion,
    });
    const replay = verdict.response.replay;
    const last = replay.frames.length;
    return html`
      <p class="banner ${model.tone}" role="status" aria-live="polite">
        <span class="mark" aria-hidden="true">${statusMarker(model.tone)}</span>
        <strong>${model.title}</strong>
        <span class="detail">${model.detail}</span>
      </p>
      ${model.emphasizeIncomplete
        ? html`<p class="emphasize">
            payload 跑完了，但没有达成目标——不是写错了，是还差东西：回放完整跑完，成功条件仍未满足。
          </p>`
        : ''}
      ${this.renderFlag(model)}
      ${this.renderRejected(model)}
      <div class="meta">
        <span class="note"
          >提交 ${model.attempted} 个动作，实际生效 ${model.executed} 个（被拒绝的不计，一个 block 算一个）</span
        >
        <span class="spacer"></span>
        <button type="button" @click=${this.backToDebug}>回到调试</button>
      </div>
      <div class="timeline">
        <label for="replay-range">回放时间线</label>
        <button
          type="button"
          title="上一帧"
          aria-label="上一帧"
          ?disabled=${verdict.position <= 0}
          @click=${() => this.move(verdict.position - 1)}
        >
          ◀
        </button>
        <input
          id="replay-range"
          type="range"
          min="0"
          max=${last}
          step="1"
          .value=${String(verdict.position)}
          aria-valuetext=${positionSummary(replay, verdict.position)}
          @input=${(event: Event) => this.move(Number((event.target as HTMLInputElement).value))}
        />
        <button
          type="button"
          title="下一帧"
          aria-label="下一帧"
          ?disabled=${verdict.position >= last}
          @click=${() => this.move(verdict.position + 1)}
        >
          ▶
        </button>
        <span class="pos" role="status" aria-live="polite">${positionSummary(replay, verdict.position)}</span>
      </div>
      ${this.renderInstructions(replay, verdict.position)}
      <p class="note">
        回放是判题实例留下的历史录像：拖动时间线只切换显示，不用当前图重新计算；从来源定位会展开并选中节点，但不会重放 Python 求值。
      </p>
      <p class="note">提交不限次数：这里不显示剩余次数，也没有任何劝阻。判题实例与调试实例互不影响。</p>
    `;
  }

  /**
   * 选中帧所属的动作一共经过了哪些指令记录（09 §3.4）：引擎在动作执行期间就 push
   * `instruction` 帧，所以夹在两个 `action` 帧之间的中间帧属于**后一个**动作。
   */
  private renderInstructions(replay: ReplayView, position: number) {
    const info = actionInstructionsAt(replay, position);
    if (info === undefined) return '';
    const labels = info.labels;
    return html`<p class="note">
      当前选中帧属于第 ${info.action + 1} 个动作：它执行途中留下 ${labels.length} 条指令记录${
        labels.length === 0 ? '' : `（${labels.join(' → ')}）`
      }。
    </p>`;
  }

  private renderFlag(model: VerdictModel) {
    if (model.flag === undefined) return '';
    const flag = model.flag;
    return html`
      <div class="flag">
        <span class="label">flag</span>
        <code>${flag}</code>
        <button type="button" @click=${() => this.copy(flag)}>复制 flag</button>
        ${this.copied === '' ? '' : html`<span role="status" aria-live="polite">${this.copied}</span>`}
        <span class="note">把它提交到 CTF 平台。</span>
      </div>
    `;
  }

  private renderRejected(model: VerdictModel) {
    const rejected = model.rejected;
    if (rejected === undefined) return '';
    // 闭包里 TS 不保留收窄，先取出再进模板。
    const blockId = rejected.blockId;
    return html`
      <div class="meta">
        <span>被拒绝的动作：第 ${rejected.actionIndex + 1} 个 ${rejected.action}</span>
        ${blockId === undefined
          ? html`<span class="note">来源表里没有对应积木，无法自动定位</span>`
          : html`<button type="button" @click=${() => this.highlight(blockId)}>
              在画布上高亮产生它的积木
            </button>`}
      </div>
    `;
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = '已复制到剪贴板';
    } catch {
      this.copied = '复制失败：请手动选中上面的 flag';
    }
    this.requestUpdate();
  }

  private move(position: number): void {
    this.dispatchEvent(
      new CustomEvent<{ readonly position: number }>('p2b-position', {
        detail: { position },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private backToDebug(): void {
    this.dispatchEvent(new CustomEvent('p2b-back-to-debug', { bubbles: true, composed: true }));
  }

  private highlight(blockId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ readonly blockId: string }>('p2b-block-select', {
        detail: { blockId },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define('pwn2block-verdict-panel', Pwn2BlockVerdictPanel);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-verdict-panel': Pwn2BlockVerdictPanel;
  }
}
