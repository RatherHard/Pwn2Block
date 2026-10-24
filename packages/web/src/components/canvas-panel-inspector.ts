import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { specOf } from '../canvas/catalog';
import type { CanvasFieldSpec } from '../canvas/catalog';
import { valueNodeCandidates, type InspectorChange } from './canvas-panel-commands';
import { renderConvertActions } from './canvas-panel-convert';
import { labelOf, onInput, onSelect, renderDictEntries, renderGroupRows } from './canvas-panel-inspector-blocks';
import { renderRegionActions } from './canvas-panel-regions';

/**
 * 右侧检查器（需求 §6.1「简单内容节点内编辑，编码/字节序等复杂配置放侧栏」）。
 *
 * 控件来源只有一处：`specOf(kind).fields`。所以「侧栏能改什么」与目录、命令层不会各说一套；
 * 这里唯一的职责是**把语义变更描述出来**（`InspectorChange`），命令由 `canvas-panel-commands` 决定，
 * 于是这个文件里没有一条编辑命令，也不碰文档。
 *
 * 几个补充块不来自目录字段，而是结构本身：字典条目、组合行（在 `canvas-panel-inspector-blocks.ts`）、
 * 变量绑定的来源节点、流程区域按钮（在 `canvas-panel-regions.ts`）与转换包络按钮
 * （在 `canvas-panel-convert.ts`）。它们各自对应一条现成命令
 * （`setDictEntries` / `insertRowAfter`+`removeRow` / `setBinding` / `wrapInLoop` 等 / `wrapInConversion`）。
 */

/** 渲染检查器需要的输入。 */
export interface InspectorInput {
  readonly document: canvas.CanvasDocument;
  readonly authorBlocks: readonly AuthorBlock[] | undefined;
  readonly selection: readonly string[];
  readonly issuesByNode: ReadonlyMap<string, readonly string[]>;
  readonly onChange: (change: InspectorChange) => void;
}

/** 一个下拉候选项。 */
interface Option {
  readonly value: string;
  readonly label: string;
}

export function renderInspector(input: InspectorInput): TemplateResult {
  if (input.selection.length === 0) {
    return html`<aside class="inspector" aria-label="检查器">
      <h3>检查器</h3>
      <p class="hint">未选中节点。点一个节点查看它的字段；双击不能就地编辑的行也会打开这里。</p>
    </aside>`;
  }
  if (input.selection.length > 1) {
    return html`<aside class="inspector" aria-label="检查器">
      <h3>检查器</h3>
      <p class="hint">已选中 ${input.selection.length} 个节点：Delete 删除、方向键移动、点「成组」拼成一个组合。</p>
      ${renderRegionActions({ document: input.document, selection: input.selection, onChange: input.onChange })}
      ${renderConvertActions({ document: input.document, selection: input.selection, onChange: input.onChange })}
    </aside>`;
  }
  const node = findNode(input.document, input.selection[0]);
  if (node === undefined) {
    return html`<aside class="inspector" aria-label="检查器"><p class="hint">选中的节点不在文档里。</p></aside>`;
  }
  const issues = input.issuesByNode.get(node.id) ?? [];
  return html`<aside class="inspector" aria-label="检查器">
    <div class="inspector-head">
      <h3>${specOf(node.kind).label}</h3>
      <span class="inspector-id">${node.id}</span>
    </div>
    <p class="hint">${specOf(node.kind).description}</p>
    ${issues.length === 0
      ? nothing
      : html`<ul class="inspector-issues">
          ${issues.map((message) => html`<li>${message}</li>`)}
        </ul>`}
    ${specOf(node.kind).fields.map((field) => renderField(node, field, input))}
    ${renderRegionActions({ document: input.document, selection: input.selection, onChange: input.onChange })}
    ${renderConvertActions({ document: input.document, selection: input.selection, onChange: input.onChange })}
    ${node.kind === 'dict' ? renderDictEntries(node, input) : nothing}
    ${node.kind === 'group' ? renderGroupRows(node, input) : nothing}
  </aside>`;
}

// ---------------------------------------------------------------------------
// 目录字段
// ---------------------------------------------------------------------------

function renderField(
  node: canvas.CanvasNode,
  field: CanvasFieldSpec,
  input: InspectorInput,
): TemplateResult | typeof nothing {
  const current = fieldValueOf(node, field.key);
  const change = (value: string): void => input.onChange({ kind: 'field', key: field.key, value });
  switch (field.editor) {
    case 'text':
    case 'int':
    case 'hex-bytes':
      return textField(field.label, current, field.key, change);
    case 'bool':
      return html`<div class="field">
        <label>${field.label}</label>
        <input
          class=${`field-${field.key}`}
          type="checkbox"
          .checked=${current === 'true'}
          @change=${(event: Event) => change(checkedOf(event) ? 'true' : 'false')}
        />
      </div>`;
    case 'select':
    case 'group-mode':
    case 'variable-type':
      return selectField(field.label, current, field.options ?? [], field.key, change);
    case 'value-kind':
      return node.kind === 'value'
        ? valueKindField(field.label, current, field.options ?? [], change)
        : nothing;
    case 'relation-op':
      return selectField(field.label, current, binaryOptions(), field.key, change);
    case 'unary-op':
      return selectField(field.label, current, unaryOptions(), field.key, change);
    case 'convert':
      return node.kind === 'convert' ? renderConversion(node, input) : nothing;
    case 'method':
      return selectField(field.label, current, methodOptions(input.authorBlocks), field.key, change);
    case 'decl-ref':
      return selectField(field.label, current, declOptions(node, input.document), field.key, change);
    case 'binding-mode':
      return node.kind === 'var-decl' ? renderBinding(node, input) : nothing;
    default:
      return nothing;
  }
}

function textField(label: string, current: string, key: string, onChange: (value: string) => void): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <input class=${`field-${key}`} type="text" .value=${current} @change=${onInput(onChange)} />
  </div>`;
}

function selectField(
  label: string,
  current: string,
  options: readonly Option[],
  key: string,
  onChange: (value: string) => void,
): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <select class=${`field-${key}`} .value=${current} @change=${onSelect(onChange)}>
      ${options.map(
        (option) => html`<option value=${option.value} ?selected=${option.value === current}>${option.label}</option>`,
      )}
    </select>
  </div>`;
}

/**
 * 字面值种类选择器：下拉 + 一句说明，**不弹确认框**。
 *
 * 换种类是覆盖式重建（新种类的零值顶掉旧载荷），所以说明文字必须就在选项下面：
 * TUI 风格里没有模态确认，用户改完立刻在行文本与预览里看到结果，撤销（Ctrl+Z）就是后悔药。
 * 类名沿用现有字段（`.field` / `.field-kind` / `.hint`），不新增一套样式。
 */
function valueKindField(
  label: string,
  current: string,
  options: readonly Option[],
  onChange: (value: string) => void,
): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <div class="field-stack">
      <select class="field-kind" .value=${current} @change=${onSelect(onChange)}>
        ${options.map(
          (option) => html`<option value=${option.value} ?selected=${option.value === current}>${option.label}</option>`,
        )}
      </select>
      <p class="hint field-kind-note">切换会重置当前值：换成新类型的零值（字节串为空、整数与浮点数为 0、文本为空、布尔为假），Ctrl+Z 可撤销。</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 变量绑定
// ---------------------------------------------------------------------------

function renderBinding(node: canvas.VarDeclNode, input: InspectorInput): TemplateResult {
  const mode: Option[] = [
    { value: 'none', label: '未初始化' },
    { value: 'initial', label: '初始值' },
    { value: 'derived', label: '派生绑定' },
  ];
  const candidates = valueNodeCandidates(input.document);
  const bound = node.binding.mode === 'none' ? undefined : node.binding.input;
  return html`<div class="field">
      <label>初始化</label>
      <select
        class="field-binding"
        .value=${node.binding.mode}
        @change=${onSelect((value: string) => input.onChange({ kind: 'binding-mode', mode: value }))}
      >
        ${mode.map((option) => html`<option value=${option.value} ?selected=${option.value === node.binding.mode}>${option.label}</option>`)}
      </select>
    </div>
    ${bound === undefined
      ? nothing
      : html`<div class="field">
          <label>绑定来源</label>
          <select
            class="field-binding-input"
            .value=${bound}
            @change=${onSelect((value: string) => input.onChange({ kind: 'binding-input', inputId: value }))}
          >
            ${candidates.map(
              (candidate) => html`<option value=${candidate.id} ?selected=${candidate.id === bound}>${labelOf(candidate)}</option>`,
            )}
          </select>
        </div>`}`;
}

// ---------------------------------------------------------------------------
// 转换参数
// ---------------------------------------------------------------------------

function renderConversion(node: canvas.ConvertNode, input: InspectorInput): TemplateResult {
  const spec = node.spec;
  const changeKind = (value: string): void => input.onChange({ kind: 'conversion-kind', conversion: value });
  return html`<div class="field">
      <label>转换</label>
      <select class="field-spec" .value=${spec.kind} @change=${onSelect(changeKind)}>
        ${conversionOptions().map(
          (option) => html`<option value=${option.value} ?selected=${option.value === spec.kind}>${option.label}</option>`,
        )}
      </select>
    </div>
    ${conversionParamFields(spec, input)}`;
}

/** 转换目录的中文名（`Object.keys` 只用来列举，取标签仍走对象取值，不硬转类型）。 */
function conversionOptions(): readonly Option[] {
  return Object.entries(canvas.CONVERSION_LABELS).map(([kind, label]) => ({ value: kind, label }));
}

/** 当前转换的参数控件：编码、宽度、字节序、符号、取整、进制。 */
function conversionParamFields(spec: canvas.ConversionSpec, input: InspectorInput): TemplateResult | typeof nothing {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'bytes-to-text':
      return paramSelect('编码', 'encoding', spec.encoding, input, [
        { value: 'utf-8', label: 'UTF-8' },
        { value: 'ascii', label: 'ASCII' },
      ]);
    case 'int-to-bytes':
    case 'bytes-to-int':
      return html`${paramSelect('宽度', 'width', String(spec.width), input, [
          { value: '1', label: '1 字节' },
          { value: '2', label: '2 字节' },
          { value: '4', label: '4 字节' },
          { value: '8', label: '8 字节' },
        ])}
        ${paramSelect('字节序', 'endian', spec.endian, input, [
          { value: 'little', label: '小端' },
          { value: 'big', label: '大端' },
        ])}
        ${paramSelect('符号', 'signed', spec.signed ? 'yes' : 'no', input, [
          { value: 'no', label: '无符号' },
          { value: 'yes', label: '有符号' },
        ])}`;
    case 'double-to-int':
      return paramSelect(
        '取整',
        'rounding',
        spec.rounding,
        input,
        canvas.ROUNDING_MODES.map((mode) => ({ value: mode, label: canvas.ROUNDING_LABELS[mode] })),
      );
    case 'int-to-text':
    case 'text-to-int':
      return paramSelect('进制', 'base', String(spec.base), input, [
        { value: '10', label: '十进制' },
        { value: '16', label: '十六进制' },
      ]);
    default:
      // 无参数的转换（整数↔浮点、列表合并等）只显示转换名。
      return nothing;
  }
}

function paramSelect(
  label: string,
  param: string,
  current: string,
  input: InspectorInput,
  options: readonly Option[],
): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <select
      class=${`field-param-${param}`}
      .value=${current}
      @change=${onSelect((value: string) => input.onChange({ kind: 'conversion-param', param, value }))}
    >
      ${options.map(
        (option) => html`<option value=${option.value} ?selected=${option.value === current}>${option.label}</option>`,
      )}
    </select>
  </div>`;
}

// ---------------------------------------------------------------------------
// 取值与候选
// ---------------------------------------------------------------------------

/** 字段当前值：字段名与节点属性同名，所以一次 switch 就够（不做动态属性读取）。 */
function fieldValueOf(node: canvas.CanvasNode, key: string): string {
  switch (node.kind) {
    case 'value':
      // 字面值唯一的侧栏字段是种类，取值在 `node.value` 里（节点种类恒为 `'value'`）。
      return key === 'kind' ? node.value.kind : '';
    case 'group':
      return key === 'mode' ? node.mode : '';
    case 'relation':
      return key === 'op' ? node.op : '';
    case 'unary':
      return key === 'op' ? node.op : '';
    case 'var-decl':
      if (key === 'name') return node.name;
      if (key === 'type') return node.type;
      return node.binding.mode;
    case 'var-ref':
      return key === 'decl' ? node.decl : '';
    case 'loop-index':
      return key === 'loop' ? node.loop : '';
    case 'assign':
      return key === 'target' ? node.target : '';
    case 'method':
      return key === 'block' ? node.block : '';
    default:
      return '';
  }
}

function binaryOptions(): readonly Option[] {
  return canvas.BINARY_OPERATORS.map((op) => ({ value: op, label: canvas.binaryOperatorSpec(op).label }));
}

function unaryOptions(): readonly Option[] {
  return canvas.UNARY_OPERATORS.map((op) => ({ value: op, label: canvas.unaryOperatorSpec(op).label }));
}

function methodOptions(authorBlocks: readonly AuthorBlock[] | undefined): readonly Option[] {
  return (authorBlocks ?? []).map((block) => ({ value: block.id, label: `${block.label}（${block.params.length} 参数）` }));
}

/**
 * 「选一个已存在的节点」的候选。
 *
 * 变量引用与赋值目标只能选**声明**，循环索引只能选**循环**：候选表按属性语义收窄，
 * 不让界面给出一个必然被命令层拒绝的选项。
 */
function declOptions(node: canvas.CanvasNode, document: canvas.CanvasDocument): readonly Option[] {
  const wanted = node.kind === 'loop-index' ? 'loop' : 'var-decl';
  return document.nodes
    .filter((candidate) => (wanted === 'loop' ? candidate.kind === 'loop' : candidate.kind === 'var-decl'))
    .map((candidate) => ({ value: candidate.id, label: labelOf(candidate) }));
}

/** 按 id 取节点：侧栏只渲染单个选中节点，找不到就是「不在文档里」。 */
function findNode(document: canvas.CanvasDocument, nodeId: string): canvas.CanvasNode | undefined {
  return document.nodes.find((node) => node.id === nodeId);
}

function checkedOf(event: Event): boolean {
  const target = event.currentTarget;
  return target instanceof HTMLInputElement ? target.checked : false;
}
