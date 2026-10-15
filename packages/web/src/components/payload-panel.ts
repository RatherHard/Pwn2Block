/**
 * Payload 窗口（05 §3）——**右半，H 的开发区**。
 *
 * D1 只搭三段式骨架：积木画布（Blockly 由 H01 挂到 `#blockly-host`）、程序区（编译产物）、
 * 输出区（动作结果与错误解释）。这里不 import `src/blocks/**` 或 `src/compiler/**`：
 * 图与编译器的接线在 D4（08 §3 D4 行）。
 */
import { LitElement, css, html } from 'lit';
import { sharedStyles, terminalTheme } from '../theme';

export class Pwn2BlockPayloadPanel extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        overflow: auto;
        padding: 0.4rem 0.6rem;
      }
      .canvas {
        min-height: 14rem;
        display: grid;
        place-items: center;
        border: 1px dashed var(--p2b-line);
        border-radius: 3px;
        color: var(--p2b-dim);
        text-align: center;
        padding: 1rem;
      }
      .program,
      .output {
        min-height: 5rem;
        border: 1px solid var(--p2b-line);
        border-radius: 3px;
        background: var(--p2b-panel);
        padding: 0.4rem;
        color: var(--p2b-dim);
        white-space: pre-wrap;
      }
    `,
  ];

  override render() {
    return html`
      <h2>Payload</h2>
      <div class="canvas" id="blockly-host">
        <p>
          积木画布：Blockly 由 H01 挂载到 <code>#blockly-host</code>。<br />
          未连到「开始」积木的积木不参与编译（05 §3.1）。
        </p>
      </div>
      <h3>程序区</h3>
      <div class="program">编译得到的原子动作序列在这里逐行显示，当前执行位置高亮（D02）。</div>
      <h3>输出区</h3>
      <div class="output" role="status" aria-live="polite">
        每个动作的结果（成功 / 拒绝 / 异常）与错误解释在这里显示（D02）。<br />
        会话被回收后接口返回 404：<code>src/api.ts</code> 会把它标成 <code>session_expired</code>
        （<code>isSessionExpired</code>），这里提示「会话已失效，请重新开始」并回到未开始状态。
      </div>
      <p class="note">
        前七个按钮只作用于调试实例；「提交判题」才走 <code>/submit</code>。调试实例满足成功条件也只是提示，不发 flag（04 §1）。
      </p>
    `;
  }
}

customElements.define('pwn2block-payload-panel', Pwn2BlockPayloadPanel);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-payload-panel': Pwn2BlockPayloadPanel;
  }
}
