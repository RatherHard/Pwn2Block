/**
 * 内嵌 Python 代码编辑器（节点画布右侧属性面板，取代「导入 .py 文件」）。
 *
 * 纯文本编辑：不执行、不解析、不联网。语法着色来自 `graph/python-highlight.ts`，
 * 用 Lit 模板把 token 渲染成 `<span>`——HTML 一律走模板插值，不拼字符串
 * （`test/tui-style.test.ts` 的禁用正则盯着这一点）。
 *
 * 三层结构：
 * - `.highlight`：`<pre>` 高亮层，`aria-hidden`，只负责颜色；
 * - `.input`：叠在上面的 `<textarea>`，文字透明、只留光标，输入与选区都在它身上；
 * - `.gutter`：行号列，随 textarea 的 `scrollTop` 同步滚动。
 * 两层的字体、行高、内边距、`white-space: pre`、`tab-size` 必须完全一致，否则光标会跑偏。
 *
 * 状态归属：`value` 与 `expanded` 都由父组件持有。组件只把用户输入派发出去
 * （`p2b-code-input` / `p2b-code-change` / `p2b-code-expand`），自己用 `text` 渲染高亮与行号；
 * 父组件写回 `value` 时再同步过来。因此切换扩大不会丢内容：文本从来不归组件所有。
 */
import { LitElement, css, html } from 'lit';
import type { PropertyValues } from 'lit';
import { applyIndent, autoIndent, tokenizePython } from '../graph/python-highlight';
import type { PythonToken } from '../graph/python-highlight';
import { sharedStyles, terminalTheme } from '../theme';

/** 一级缩进：4 空格（PEP 8），与 `python-highlight.ts` 的默认值一致。 */
const INDENT_UNIT = '    ';

/** `label` 没给时的无障碍名称。 */
const DEFAULT_LABEL = 'Python 代码';

/** 编辑结果：新文本加新选区。 */
interface Edit {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 逐 token 渲染：`plain` 直接输出文本，其余包一层带 `syn-*` 类名的 `<span>`。
 * 末尾补一个换行，让高亮层和 textarea 的尾行高度对齐（否则末行是空行时差一行）。
 */
function renderHighlight(tokens: readonly PythonToken[]): readonly unknown[] {
  const parts = tokens.map(({ kind, text }) => (kind === 'plain' ? text : html`<span class=${`syn-${kind}`}>${text}</span>`));
  return [...parts, '\n'];
}

export class Pwn2BlockCodeEditor extends LitElement {
  static override styles = [
    terminalTheme,
    sharedStyles,
    css`
      :host {
        display: block;
        min-width: 0;
        max-width: 100%;
      }

      .editor {
        display: flex;
        flex-direction: column;
        min-height: 0;
        border: var(--p2b-border) solid var(--p2b-line);
        background: var(--p2b-bg);
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.25rem 0.4rem;
        border-bottom: 1px solid var(--p2b-line);
        color: var(--p2b-dim);
      }

      .toolbar .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .body {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
      }

      /* 行号列：整块随内容滚动（scrollTop 由组件同步），等宽右对齐。 */
      .gutter {
        flex: 0 0 auto;
        margin: 0;
        padding: 0.4rem 0.4rem 0.4rem 0.5rem;
        border-right: 1px solid var(--p2b-line);
        color: var(--p2b-line);
        font: inherit;
        line-height: 1.5;
        text-align: right;
        white-space: pre;
        overflow: hidden;
        user-select: none;
      }

      .code {
        position: relative;
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
      }

      /* 高亮层与输入层共用一套排版，任何一处不同都会让光标错位。 */
      .highlight,
      .input {
        margin: 0;
        padding: 0.4rem 0.5rem;
        border: 0;
        border-radius: 0;
        font: inherit;
        line-height: 1.5;
        white-space: pre;
        tab-size: 4;
      }

      .highlight {
        position: absolute;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
        color: var(--p2b-fg);
        background: transparent;
      }

      .input {
        position: relative;
        z-index: 1;
        flex: 1 1 auto;
        width: 100%;
        color: transparent;
        caret-color: var(--p2b-fg);
        background: transparent;
        outline: none;
        overflow: auto;
        resize: none;
      }

      .syn-comment {
        color: var(--p2b-syn-comment);
      }
      .syn-string {
        color: var(--p2b-syn-string);
      }
      .syn-keyword {
        color: var(--p2b-syn-keyword);
      }
      .syn-number {
        color: var(--p2b-syn-number);
      }
      .syn-builtin {
        color: var(--p2b-syn-function);
      }
      .syn-operator {
        color: var(--p2b-fg);
      }

      /* 扩大编辑由父级放入画布区域，内部填满可用高度。 */
      :host([expanded]) .editor {
        height: 100%;
      }

      :host([expanded]) .input {
        height: 100%;
      }
    `,
  ];

  static override properties = {
    value: { attribute: false },
    label: { attribute: false },
    readOnly: { attribute: false },
    expanded: { attribute: false },
    rows: { attribute: false },
  };

  /** 响应式属性用 `declare`（原因与写法见 app-shell.ts）；默认值在构造函数里赋。 */
  declare value: string;
  /** 无障碍名称，同时用作工具条上的标题，如「Python 代码」。 */
  declare label: string;
  declare readOnly: boolean;
  /** 扩大状态由外部控制，组件只派发 `p2b-code-expand`。 */
  declare expanded: boolean;
  /** 默认可视化行数。 */
  declare rows: number;

  /** 渲染用文本：平时跟 `value` 走，用户输入时先更新它，父组件再决定何时写回 `value`。 */
  private text = '';

  constructor() {
    super();
    this.value = '';
    this.label = '';
    this.readOnly = false;
    this.expanded = false;
    this.rows = 10;
  }

  /** 无障碍名称：`label` 是 `attribute: false` 的属性，但模板里写 `label="..."` 时也认。 */
  private get caption(): string {
    return this.label || this.getAttribute('label') || DEFAULT_LABEL;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('value')) this.text = this.value ?? '';
  }

  protected override updated(): void {
    // `expanded` 不是被观察的属性（attribute: false），这里手动把它同步到宿主，
    // 让 `:host([expanded])` 的样式规则生效，同时不给外部多一套状态。
    this.toggleAttribute('expanded', this.expanded === true);
    this.syncInputValue();
    this.syncScroll();
  }

  override render() {
    const lines = this.text.split('\n').length;
    const numbers = Array.from({ length: lines }, (_, index) => index + 1).join('\n');
    const caption = this.caption;
    return html`
      <div class="editor" @keydown=${this.onEditorKeyDown}>
        <div class="toolbar">
          <span class="name">${caption}</span>
          ${this.readOnly ? '' : this.renderExpandButton()}
        </div>
        <div class="body">
          <pre class="gutter" aria-hidden="true">${numbers}</pre>
          <div class="code">
            <pre class="highlight" aria-hidden="true">${renderHighlight(tokenizePython(this.text))}</pre>
            <textarea
              class="input"
              rows=${this.rows}
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
              wrap="off"
              aria-label=${caption}
              ?readonly=${this.readOnly}
              @input=${this.onInput}
              @change=${this.onChange}
              @scroll=${this.onScroll}
              @keydown=${this.onInputKeyDown}
            ></textarea>
          </div>
        </div>
      </div>
    `;
  }

  /** 只读时不显示扩大按钮（文本仍可选中复制）；扩大状态依旧由外部 `expanded` 决定。 */
  private renderExpandButton() {
    return html`
      <button
        type="button"
        class="expand"
        aria-pressed=${this.expanded ? 'true' : 'false'}
        @click=${this.onToggleExpand}
      >
        ${this.expanded ? '返回画布' : '扩大编辑'}
      </button>
    `;
  }

  /** 当前 textarea（渲染后才有）。 */
  private get input(): HTMLTextAreaElement | undefined {
    return this.renderRoot.querySelector('textarea') ?? undefined;
  }

  /** 父组件换了 `value`：把文本灌回 textarea，光标位置按新长度夹紧。 */
  private syncInputValue(): void {
    const input = this.input;
    if (input === undefined || input.value === this.text) return;
    const start = Math.min(input.selectionStart ?? 0, this.text.length);
    const end = Math.min(input.selectionEnd ?? start, this.text.length);
    input.value = this.text;
    input.setSelectionRange(start, end);
  }

  /** 滚动同步：高亮层跟 textarea 的横纵滚动，行号列只跟纵向。 */
  private syncScroll(): void {
    const input = this.input;
    if (input === undefined) return;
    const highlight = this.renderRoot.querySelector('pre.highlight');
    const gutter = this.renderRoot.querySelector('pre.gutter');
    if (highlight !== null) {
      highlight.scrollTop = input.scrollTop;
      highlight.scrollLeft = input.scrollLeft;
    }
    if (gutter !== null) gutter.scrollTop = input.scrollTop;
  }

  private emitInput(): void {
    this.dispatchEvent(
      new CustomEvent('p2b-code-input', { detail: { value: this.text }, bubbles: true, composed: true }),
    );
  }

  /** 结构性编辑（Tab 缩进、Enter 自动缩进）要立刻提交：代码不再是用户这次输入的内容。 */
  private emitChange(value: string): void {
    this.dispatchEvent(
      new CustomEvent('p2b-code-change', { detail: { value }, bubbles: true, composed: true }),
    );
  }

  /** 写回一次编辑：文本、textarea 的值与选区、高亮层一起更新，再通知父组件。 */
  private applyEdit(edit: Edit): void {
    const input = this.input;
    this.text = edit.text;
    if (input !== undefined) {
      input.value = edit.text;
      input.setSelectionRange(edit.start, edit.end);
    }
    this.requestUpdate();
    this.emitInput();
    // 直接写 `input.value` 会清掉 textarea 的脏标记，浏览器随后不会在失焦时补发 `change`，
    // 所以 Tab / Enter 这类自己改文本的编辑必须在这里显式提交一次，否则缩进只看得见、存不下来。
    this.emitChange(edit.text);
  }

  private onInput = (event: Event): void => {
    const input = event.currentTarget as HTMLTextAreaElement;
    this.text = input.value;
    this.requestUpdate();
    this.emitInput();
  };

  private onChange = (event: Event): void => {
    const input = event.currentTarget as HTMLTextAreaElement;
    this.emitChange(input.value);
  };

  private onScroll = (): void => {
    this.syncScroll();
  };

  private onToggleExpand = (): void => {
    this.dispatchEvent(
      new CustomEvent('p2b-code-expand', { detail: { expanded: !this.expanded }, bubbles: true, composed: true }),
    );
  };

  /** Escape 在整组里都算取消（父组件据此退出扩大或关掉编辑器）。 */
  private onEditorKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    this.emitChange(this.text);
    this.dispatchEvent(new CustomEvent('p2b-code-cancel', { bubbles: true, composed: true }));
  };

  /** Tab / Shift+Tab / Enter 自己处理，其余按键交还给浏览器。 */
  private onInputKeyDown = (event: KeyboardEvent): void => {
    // 输入法组词中的 Enter / Tab 属于候选确认，不能当成换行或缩进。
    if (this.readOnly || event.isComposing) return;
    const input = this.input;
    if (input === undefined) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;

    if (event.key === 'Tab') {
      event.preventDefault();
      this.applyEdit(applyIndent(input.value, start, end, event.shiftKey, INDENT_UNIT));
      return;
    }

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      // autoIndent 只认一个插入点：先把选区删掉，再在光标处补缩进。
      const joined = input.value.slice(0, start) + input.value.slice(end);
      const next = autoIndent(joined, start, INDENT_UNIT);
      this.applyEdit({ text: next.text, start: next.caret, end: next.caret });
    }
  };
}

customElements.define('pwn2block-code-editor', Pwn2BlockCodeEditor);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-code-editor': Pwn2BlockCodeEditor;
  }
}
