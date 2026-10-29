import { html, nothing, type TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import { editableTextOf, valueNodeCandidates } from './canvas-panel-commands';
import { onInput, onSelect, labelOf } from './canvas-panel-inspector-blocks';
import type { InspectorInput } from './canvas-panel-inspector';

/** 字面值和数据来源全部在侧栏编辑，画布只显示内容。 */
export function renderDataInputs(node: canvas.CanvasNode, input: InspectorInput): TemplateResult | typeof nothing {
  if (node.kind === 'value') {
    return html`<label class="field">值<input class="field-value" type="text"
      .value=${editableTextOf(input.document, node.id, '值') ?? ''}
      @change=${onInput((value) => input.onChange({ kind: 'literal', value }))} /></label>`;
  }
  // 这三种结构已有专用编辑块，避免出现两套相同字段。
  if (node.kind === 'group' || node.kind === 'dict' || node.kind === 'var-decl') return nothing;
  const candidates = valueNodeCandidates(input.document).filter((candidate) => candidate.id !== node.id);
  return html`${canvas.inputRefsOf(node).map((ref) => html`<label class="field">${ref.label}
    <select class=${`field-input field-param-${ref.name}`} data-input=${ref.name} .value=${ref.id ?? ''}
      @change=${onSelect((source) => input.onChange({ kind: 'input-ref', port: ref.name, source }))}>
      <option value="" ?selected=${ref.id === undefined}>未连接</option>
      ${candidates.map((candidate) => html`<option value=${candidate.id} ?selected=${ref.id === candidate.id}>${labelOf(candidate)}</option>`)}
    </select>
  </label>`)}`;
}
