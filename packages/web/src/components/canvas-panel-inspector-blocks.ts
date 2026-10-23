import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import { valueNodeCandidates } from './canvas-panel-commands';
import type { InspectorInput } from './canvas-panel-inspector';

/**
 * 检查器里的**补充块**：字典条目与组合行。
 *
 * 它们不来自目录字段（`specOf(kind).fields`），而是节点结构本身：字典按条目、组合按行。
 * 各自对应一条现成命令（`setDictEntries` / `row-insert` + `row-remove`），所以这里只画控件、
 * 发变更，不碰文档。
 *
 * 从 `canvas-panel-inspector.ts` 拆出来的理由只有一条：那支文件已接近 400 行上限，
 * 而这两块与「目录字段」没有共享状态，搬走是零风险的（行为一字未改）。两个事件适配器
 * （`onSelect` / `onInput`）跟着这两块放在这里，只留一份，侧栏那侧从这里引用。
 */

/** 下拉的 `change`：只认 `HTMLSelectElement`，拿不到就不发变更（不硬转类型）。 */
export function onSelect(handler: (value: string) => void): (event: Event) => void {
  return (event: Event): void => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) handler(target.value);
  };
}

/** 文本输入的 `change`：同上，只认 `HTMLInputElement`。 */
export function onInput(handler: (value: string) => void): (event: Event) => void {
  return (event: Event): void => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) handler(target.value);
  };
}

/** 下拉里显示什么：变量用名字，循环用「次数循环」，其余用种类名 + id。 */
export function labelOf(node: canvas.CanvasNode): string {
  if (node.kind === 'var-decl') return `变量 ${node.name}`;
  return `${canvas.CANVAS_NODE_KIND_LABELS[node.kind]} ${node.id}`;
}

/** 字典条目：键就地改，值从数据节点里选，另加「加一条」「删」。 */
export function renderDictEntries(node: canvas.DictNode, input: InspectorInput): TemplateResult {
  const candidates = valueNodeCandidates(input.document);
  return html`<div class="block">
    <h4>字典条目（${node.entries.length} 项）</h4>
    ${node.entries.length === 0 ? html`<p class="hint">还没有条目：加一条后会指到第一个数据节点，再改键与值。</p>` : nothing}
    ${node.entries.map(
      (entry, index) => html`<div class="field">
        <input
          class="field-dict-key"
          type="text"
          .value=${entry.key.value}
          @change=${onInput((value: string) => input.onChange({ kind: 'dict-key', index, key: value }))}
        />
        <select
          class="field-dict-value"
          .value=${entry.value}
          @change=${onSelect((value: string) => input.onChange({ kind: 'dict-value', index, value }))}
        >
          ${candidates.map(
            (candidate) => html`<option value=${candidate.id} ?selected=${candidate.id === entry.value}>${labelOf(candidate)}</option>`,
          )}
        </select>
        <button class="mini field-dict-remove" @click=${() => input.onChange({ kind: 'dict-remove', index })}>删</button>
      </div>`,
    )}
    <button class="mini field-dict-add" @click=${() => input.onChange({ kind: 'dict-add' })}>加一条</button>
  </div>`;
}

/** 组合行：只读展示行列与成员，插入/删除行走命令。 */
export function renderGroupRows(node: canvas.GroupNode, input: InspectorInput): TemplateResult {
  return html`<div class="block">
    <h4>组合行（${node.rows.length} 行，共 ${canvas.groupMembers(node).length} 项）</h4>
    ${node.rows.map(
      (row, index) => html`<div class="field">
        <span>第 ${index + 1} 行</span>
        <span class="hint">${row.join('、') === '' ? '空行' : row.join('、')}</span>
        <button class="mini" @click=${() => input.onChange({ kind: 'row-insert', index })}>下方插行</button>
        <button class="mini" @click=${() => input.onChange({ kind: 'row-remove', index })}>删行</button>
      </div>`,
    )}
  </div>`;
}
