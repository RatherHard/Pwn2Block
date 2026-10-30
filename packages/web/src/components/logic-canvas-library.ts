import { html, type TemplateResult } from 'lit';
import type { canvas } from '@pwn2block/shared';

export type LibraryCategory = 'data' | 'flow' | 'methods';
export interface LogicLibraryState { category?: LibraryCategory; page: number }
export type AddableLogicKind = 'constant' | 'variable' | 'convert' | 'branch' | 'loop' | 'method';
interface LibraryOption {
  kind: AddableLogicKind;
  label: string;
  title: string;
  summary: string;
  description: string;
  method?: string;
}
const PAGE_SIZE = 4;
const categories = [
  { id: 'data', label: '数据节点' },
  { id: 'flow', label: '流程节点' },
  { id: 'methods', label: '题目方法' },
] as const;
function optionsOf(category: LibraryCategory, methods: readonly canvas.CanvasMethodDecl[]): LibraryOption[] {
  if (category === 'data') return [
    { kind: 'constant', label: '+ 常量', title: '常量 · int', summary: 'int 0', description: '提供整数、小数、字符串、字节串或布尔值。' },
    { kind: 'variable', label: '+ 变量', title: '变量', summary: '未赋值', description: '同名变量共享值，首次赋值确定类型。' },
    { kind: 'convert', label: '+ 类型转换', title: '类型转换 → bytes', summary: 'int → bytes', description: '转换数据类型，也可附着在数据包络上。' },
  ];
  if (category === 'flow') return [
    { kind: 'loop', label: '+ 次数循环', title: '次数循环', summary: '1 次', description: '按指定次数执行附着的流程包络。' },
    { kind: 'branch', label: '+ 条件分支', title: '条件分支', summary: 'true / false', description: '根据布尔条件选择执行出口。' },
  ];
  return methods.map((method) => ({ kind: 'method', method: method.id, label: method.label,
    title: method.label, summary: method.params.map((p) => p.name).join(' · ') || '无参数',
    description: '调用本题公开方法；在属性栏连接参数。' }));
}

export function renderLogicLibrary(input: {
  state: LogicLibraryState;
  methods: readonly canvas.CanvasMethodDecl[];
  change: (state: LogicLibraryState) => void;
  add: (kind: AddableLogicKind, method?: string) => void;
  drag: (event: PointerEvent, kind: AddableLogicKind, method?: string) => void;
}): TemplateResult {
  const { state, methods, change, add, drag } = input;
  const category = categories.find((c) => c.id === state.category);
  if (!category) return html`<aside class="library" aria-label="节点库">
    <h3>节点库</h3>
    <nav aria-label="节点分类">${categories.map((c) => html`<button class="library-category" data-category=${c.id}
      @click=${() => change({ category: c.id, page: 0 })}>
      <span>${c.label}</span><span>${optionsOf(c.id, methods).length} →</span>
    </button>`)}</nav>
    <p class="hint">节点拖近：预览吸附<br />普通拖动：框选<br />Space + 拖动：平移画布<br />滚轮：缩放<br />包络内节点随所属包络移动<br />赋值目标携带完整表达式<br />流程连接：先点左侧入口，再点右侧出口<br />Shift 点击：多选<br />Ctrl+G：包络<br />Ctrl+C / X / V：复制 / 剪切 / 粘贴<br />Esc：取消当前操作</p>
  </aside>`;
  const options = optionsOf(category.id, methods);
  const pages = Math.max(1, Math.ceil(options.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, state.page), pages - 1);
  return html`<aside class="library" aria-label="节点库">
    <button class="library-back" @click=${() => change({ page: 0 })}>← 返回分类</button>
    <h3>${category.label}</h3>
    <div class="library-options">${options.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((option) => html`
      <button class="library-option" aria-label=${option.label} @click=${() => add(option.kind, option.method)}
        @pointerdown=${(event: PointerEvent) => drag(event, option.kind, option.method)}
        @dragstart=${(event: Event) => event.preventDefault()}>
        <span class="library-option-label">${option.label}</span>
        <span class="library-preview" data-preview-kind=${option.kind} aria-hidden="true">
          <span class="preview-title">${option.title}</span><span class="preview-summary">${option.summary}</span>
        </span>
        <span class="preview-description">${option.description}</span>
      </button>`)}
      ${options.length ? '' : html`<p class="hint">本题没有公开方法。</p>`}
    </div>
    <nav class="library-pager" aria-label="节点分页">
      <button aria-label="上一页" ?disabled=${page === 0} @click=${() => change({ ...state, page: page - 1 })}>←</button>
      <span role="status">第 ${page + 1} / ${pages} 页</span>
      <button aria-label="下一页" ?disabled=${page === pages - 1} @click=${() => change({ ...state, page: page + 1 })}>→</button>
    </nav>
  </aside>`;
}
