import { canvas } from '@pwn2block/shared';
import { convertLabelOf, relationLabelOf, specOf } from './catalog';
import { summaryOfPreview } from './view-model-preview';
import type { CanvasBoxTone, CanvasRow, NodeSeverity } from './view-model-types';

/**
 * 盒子种类、标题与「盒子里那几行」（需求 §6.1「简单内容直接在节点内编辑，复杂配置放侧栏」）。
 *
 * 最重要的一条区分（任务规则 2）：
 * - **关系方框**只画 ops：`relation`（二元运算）、`unary`（附属操作）、`convert`（转换）。它们不出大白框，
 *   因为需求把它们画成「彩色中小方框」；`convert` 另外还有一层包络（见 `view-model-envelope.ts`）。
 * - **大白框**是其余全部种类：`value` / `group` / `dict` / `index` / `lookup` / `slice` / `repeat`
 *   （数据），`var-decl` / `var-ref` / `loop-index`（变量），`start` / `if` / `loop` / `assign`（流程），
 *   以及 `method`（带操作数的方法）。
 *
 * `editable` 的判据是「简单内容」：字面值、变量名、方法参数就地改；其余（组合模式、转换参数、
 * 绑定方式）一律走侧栏——目录里的 `CanvasFieldSpec.editor` 就是那些控件的来源。
 */

/** 只画关系方框的种类。 */
const RELATION_BOX_KINDS: readonly canvas.CanvasNodeKind[] = ['relation', 'unary', 'convert'];

/** 该节点是否只出关系方框（不出大白框）。 */
export function isRelationBoxKind(kind: canvas.CanvasNodeKind): boolean {
  return RELATION_BOX_KINDS.includes(kind);
}

/** 配色档：数据 / 变量 / 流程 / 转换 / 方法，渲染层按它取 CSS 类名。 */
export function toneOfKind(kind: canvas.CanvasNodeKind): CanvasBoxTone {
  switch (kind) {
    case 'convert':
      return 'convert';
    case 'var-decl':
    case 'var-ref':
    case 'loop-index':
      return 'variable';
    case 'start':
    case 'if':
    case 'loop':
    case 'assign':
      return 'flow';
    case 'method':
      return 'method';
    default:
      return 'data';
  }
}

/** 造标题时要知道的上下文：别人叫什么（变量名、方法名）。 */
export interface NodeContext {
  readonly nodes: ReadonlyMap<string, canvas.CanvasNode>;
  readonly methods: readonly canvas.CanvasMethodDecl[] | undefined;
}

/** 造行时要知道的上下文：再加上预览（「预览」行的文字）。 */
export interface RowsContext extends NodeContext {
  readonly previews: ReadonlyMap<string, canvas.CanvasNodePreview>;
}

/** 盒子主标题：白框里的大字，或关系方框上的运算名/转换名。 */
export function titleOfNode(node: canvas.CanvasNode, ctx: NodeContext): string {
  switch (node.kind) {
    case 'relation':
      return relationLabelOf(node.op);
    case 'unary':
      return canvas.unaryOperatorSpec(node.op).label;
    case 'convert':
      return convertLabelOf(node.spec);
    case 'var-decl':
      return `${canvas.CANVAS_NODE_KIND_LABELS['var-decl']} ${node.name}`;
    case 'var-ref': {
      const name = declNameOf(ctx, node.decl);
      if (name === undefined) return canvas.CANVAS_NODE_KIND_LABELS['var-ref'];
      return `${canvas.CANVAS_NODE_KIND_LABELS['var-ref']} ${name}`;
    }
    case 'method':
      return methodLabelOf(ctx, node.block);
    default:
      return canvas.CANVAS_NODE_KIND_LABELS[node.kind];
  }
}

/** 第二行：类型、成员数、绑定方式这类「一眼概括」，没有就留空。 */
export function subtitleOfNode(node: canvas.CanvasNode, ctx: NodeContext): string | undefined {
  switch (node.kind) {
    case 'value':
      return canvas.VALUE_KIND_LABELS[node.value.kind];
    case 'group':
      return `${canvas.GROUP_MODE_LABELS[node.mode]} · ${canvas.groupMembers(node).length} 项`;
    case 'dict':
      return `${node.entries.length} 项`;
    case 'var-decl':
      return `${canvas.VALUE_KIND_LABELS[node.type]} · ${bindingLabelOf(node.binding)}`;
    case 'var-ref': {
      const name = declNameOf(ctx, node.decl);
      return name === undefined ? undefined : `指向 ${name}`;
    }
    case 'loop-index':
      return node.loop === canvas.UNCONNECTED ? undefined : `所属循环 ${node.loop}`;
    case 'start':
      return '流程入口';
    case 'if':
      return `成立 ${node.then.length} 步 · 不成立 ${node.else.length} 步`;
    case 'loop':
      return `循环体 ${node.body.length} 步`;
    case 'assign': {
      const name = declNameOf(ctx, node.target);
      return name === undefined ? undefined : `目标 ${name}`;
    }
    case 'method':
      return `${Object.keys(node.args).length} 个参数`;
    default:
      return undefined;
  }
}

/** 节点内的行；每个值节点在末尾补一行「预览」（需求 §7，任务规则 7 从 `value` 起，这里统一到所有值节点）。 */
export function rowsOfNode(node: canvas.CanvasNode, ctx: RowsContext): readonly CanvasRow[] {
  const content = contentRowsOf(node, ctx);
  const preview = ctx.previews.get(node.id);
  if (preview === undefined) return content;
  return [...content, makeRow(node.id, '预览', summaryOfPreview(preview), false)];
}

/** 给一个节点的全部行加上严重度：问题是节点级的，所以整块一起标。 */
export function withSeverity(
  rows: readonly CanvasRow[],
  severity: NodeSeverity | undefined,
): readonly CanvasRow[] {
  if (severity === undefined) return rows;
  return rows.map((row) => ({ ...row, severity }));
}

/** 各种类自己的行（不含「预览」）；不进 `rows` 的属性就是端口或侧栏字段。 */
function contentRowsOf(node: canvas.CanvasNode, ctx: RowsContext): readonly CanvasRow[] {
  switch (node.kind) {
    case 'value':
      return [makeRow(node.id, '值', literalText(node.value), true)];
    case 'group':
      return [
        makeRow(node.id, '模式', canvas.GROUP_MODE_LABELS[node.mode], false),
        makeRow(node.id, '成员', `${canvas.groupMembers(node).length} 项`, false),
      ];
    case 'dict':
      return dictRows(node);
    case 'relation':
      return [makeRow(node.id, '运算', relationLabelOf(node.op), false)];
    case 'unary':
      return [makeRow(node.id, '操作', canvas.unaryOperatorSpec(node.op).label, false)];
    case 'slice':
      return sliceRows(node);
    case 'repeat':
      return [makeRow(node.id, '次数', refText(node.count), false)];
    case 'convert':
      return convertRows(node);
    case 'var-decl':
      return varDeclRows(node);
    case 'var-ref':
      return [makeRow(node.id, '变量', declNameOf(ctx, node.decl) ?? '未选择', false)];
    case 'loop-index':
      return [makeRow(node.id, '所属循环', refText(node.loop), false)];
    case 'if':
    case 'loop':
    case 'assign':
      return flowRows(node, ctx);
    case 'method':
      return methodRows(node, ctx);
    case 'index':
    case 'lookup':
    case 'start':
      // 没有可读属性：内容都在端口上（下标、键）或根本没有（开始节点）。
      return [];
  }
}

/** 流程节点的行：条件/次数这类输入引用，加上各区域有几条语句。 */
function flowRows(
  node: Extract<canvas.CanvasNode, { kind: 'if' | 'loop' | 'assign' }>,
  ctx: NodeContext,
): readonly CanvasRow[] {
  switch (node.kind) {
    case 'if':
      return [
        makeRow(node.id, '条件', refText(node.cond), false),
        makeRow(node.id, '成立分支', `${node.then.length} 步`, false),
        makeRow(node.id, '不成立分支', `${node.else.length} 步`, false),
      ];
    case 'loop':
      return [
        makeRow(node.id, '次数', refText(node.count), false),
        makeRow(node.id, '循环体', `${node.body.length} 步`, false),
      ];
    case 'assign':
      return [
        makeRow(node.id, '目标', declNameOf(ctx, node.target) ?? '未选择', false),
        makeRow(node.id, '值', refText(node.value), false),
      ];
  }
}

function dictRows(node: Extract<canvas.CanvasNode, { kind: 'dict' }>): readonly CanvasRow[] {
  if (node.entries.length === 0) return [makeRow(node.id, '条目', '还没有条目', false)];
  return node.entries.map((entry) =>
    makeRow(node.id, `「${dictKeyText(entry.key)}」`, refText(entry.value), false),
  );
}

function sliceRows(node: Extract<canvas.CanvasNode, { kind: 'slice' }>): readonly CanvasRow[] {
  return [
    makeRow(node.id, '起点', refTextOr(node.start, '默认'), false),
    makeRow(node.id, '终点', refTextOr(node.end, '默认'), false),
    makeRow(node.id, '步长', refTextOr(node.step, '默认'), false),
  ];
}

function convertRows(node: Extract<canvas.CanvasNode, { kind: 'convert' }>): readonly CanvasRow[] {
  return [
    makeRow(node.id, '转换', convertLabelOf(node.spec), false),
    ...conversionParamRows(node.spec).map((item) => makeRow(node.id, item.label, item.value, false)),
  ];
}

function varDeclRows(node: Extract<canvas.CanvasNode, { kind: 'var-decl' }>): readonly CanvasRow[] {
  return [
    makeRow(node.id, '名称', node.name, true),
    makeRow(node.id, '类型', canvas.VALUE_KIND_LABELS[node.type], false),
    makeRow(node.id, '绑定', bindingLabelOf(node.binding), false),
  ];
}

function methodRows(node: Extract<canvas.CanvasNode, { kind: 'method' }>, ctx: NodeContext): readonly CanvasRow[] {
  return [
    makeRow(node.id, '方法', methodLabelOf(ctx, node.block), false),
    ...Object.entries(node.args).map(([name, id]) => makeRow(node.id, name, refText(id), true)),
  ];
}

/** 转换参数：编码、宽度、字节序、进制这类「复杂配置」只读展示，改去侧栏（需求 §6.1）。 */
function conversionParamRows(
  spec: canvas.ConversionSpec,
): readonly { readonly label: string; readonly value: string }[] {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'bytes-to-text':
      return [{ label: '编码', value: canvas.TEXT_ENCODING_LABELS[spec.encoding] }];
    case 'int-to-bytes':
    case 'bytes-to-int':
      return [
        { label: '宽度', value: `${spec.width} 字节` },
        { label: '字节序', value: canvas.ENDIAN_LABELS[spec.endian] },
        { label: '有符号', value: spec.signed ? '是' : '否' },
      ];
    case 'double-to-int':
      return [{ label: '取整', value: canvas.ROUNDING_LABELS[spec.rounding] }];
    case 'int-to-text':
    case 'text-to-int':
      return [{ label: '进制', value: `${spec.base} 进制` }];
    default:
      // 无参数的转换（int-to-double、text-to-double、list-to-*）只显示转换名。
      return [];
  }
}

function makeRow(nodeId: string, label: string, value: string, editable: boolean): CanvasRow {
  return { nodeId, label, value, editable };
}

/** 字面值的显示文本：字节串给 hex、文本加引号、布尔用「真/假」。 */
function literalText(value: canvas.EncodedScalarValue): string {
  switch (value.kind) {
    case 'byte':
      return value.hex === '' ? '空字节串' : value.hex;
    case 'int':
      return value.value;
    case 'double':
      return String(value.value);
    case 'string':
      return `「${value.value}」`;
    case 'bool':
      return value.value ? '真' : '假';
  }
}

/** 字典键的显示文本：与共享层的存档表示一致（整数按十进制、文本加引号）。 */
function dictKeyText(key: canvas.EncodedDictKey): string {
  return key.kind === 'int' ? key.value : `"${key.value}"`;
}

/** 引用目标的显示文本：没接线时说「未接线」，接了就写对方 id（框里放不下名字）。 */
function refText(id: string): string {
  return id === canvas.UNCONNECTED ? '未接线' : id;
}

function refTextOr(id: string | undefined, fallback: string): string {
  return id === undefined ? fallback : refText(id);
}

/** 变量的初始化关系（需求 §3.1–3.2）；文案取目录里 `binding` 字段的选项，不另写一份。 */
function bindingLabelOf(binding: canvas.VariableBinding): string {
  const mode = BINDING_MODE_LABELS.get(binding.mode) ?? binding.mode;
  if (binding.mode === 'none') return mode;
  return `${mode}：${refText(binding.input)}`;
}

/** 某个下拉字段的「值 → 中文标签」表：选项表只有一份，在节点目录里。 */
function optionLabelsOf(kind: canvas.CanvasNodeKind, key: string): ReadonlyMap<string, string> {
  const field = specOf(kind).fields.find((item) => item.key === key);
  const pairs: [string, string][] = (field?.options ?? []).map((option) => [option.value, option.label]);
  return new Map(pairs);
}

const BINDING_MODE_LABELS = optionLabelsOf('var-decl', 'binding');

/** 声明 id（或引用视图）指向的变量名；悬空、未接线时返回 `undefined`。 */
function declNameOf(ctx: NodeContext, declId: string): string | undefined {
  const node = ctx.nodes.get(declId);
  return node?.kind === 'var-decl' ? node.name : undefined;
}

/** 方法节点的标题：题目声明里的显示名；没有声明或没选方法时退回种类名/标识。 */
function methodLabelOf(ctx: NodeContext, block: string): string {
  if (block === canvas.UNCONNECTED) return canvas.CANVAS_NODE_KIND_LABELS.method;
  const declared = ctx.methods === undefined ? undefined : canvas.canvasMethodById(ctx.methods, block);
  return declared?.label ?? block;
}
