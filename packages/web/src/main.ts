import { LitElement, css, html } from 'lit';

/**
 * 前端骨架（D01–D03 / H01–H02 实现）。
 *
 * D1 只验证 Vite + Lit 链路可用：整页左右 1:1 分割、终端风格主题、中文界面（05 §1）。
 * 视图管理器、四种内存视图、积木画布与编译由 D / H 在后续任务补齐。
 */
export class Pwn2BlockApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #101312;
      color: #d7e0d8;
      min-height: 100vh;
    }
    header {
      display: flex;
      gap: 1rem;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #2a3230;
    }
    main {
      display: grid;
      grid-template-columns: 1fr 1fr;
      min-height: calc(100vh - 3rem);
    }
    section {
      padding: 1rem;
      overflow: auto;
    }
    section + section {
      border-left: 1px solid #2a3230;
    }
    h2 {
      font-size: 0.9rem;
      font-weight: 600;
      color: #8fd6a8;
      margin: 0 0 0.5rem;
    }
  `;

  override render() {
    return html`
      <header>
        <strong>Pwn2Block</strong>
        <span>调试模式</span>
      </header>
      <main>
        <section aria-label="视图管理器">
          <h2>视图</h2>
          <p>栈 / 指令 / 寄存器 / 自由视图在这里（D01）。</p>
        </section>
        <section aria-label="payload 窗口">
          <h2>Payload</h2>
          <p>积木画布、程序区与输出区在这里（H01 / H02）。</p>
        </section>
      </main>
    `;
  }
}

customElements.define('pwn2block-app', Pwn2BlockApp);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-app': Pwn2BlockApp;
  }
}
