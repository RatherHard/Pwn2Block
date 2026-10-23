import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import {
  edited,
  insertRowAfter,
  isConversionKind,
  nodeOf,
  refuse,
  removeRow,
  renameVariable,
  replaceNode,
  setAssignTarget,
  setBinding,
  setConversion,
  setDictEntries,
  setGroupMode,
  setMethodBlock,
  setRelationOp,
  setUnaryOp,
  type CanvasEdit,
} from '../canvas/editor';

/**
 * 侧栏变更 → 编辑命令的映射（`canvas-panel-inspector.ts` 那侧只说「改了哪个字段」）。
 *
 * 与 `canvas-panel-commands.ts` 拆开的原因：那一半管「画布上的动作」（就地编辑、点方框换运算、
 * 拖动落位），这一半管「表单字段」。两边的改动理由不同，混在一起会越写越长。
 *
 * 一条硬边界：**命令层没有的能力不在这里手写**。比如没有「改变量类型」这条命令，
 * 这里就只在未绑定时改 `type` 一个字段，并写清为什么。
 */

/** 新建节点时找不到数据节点就用的兜底：第一个带数据结果的节点。 */
export function firstValueNodeId(document: canvas.CanvasDocument): string | undefined {
  return document.nodes.find((node) => canvas.isValueNode(node))?.id;
}

/** 侧栏能发出的语义变更；渲染层只描述「改了什么」，不碰命令。 */
export type InspectorChange =
  | { readonly kind: 'field'; readonly key: string; readonly value: string }
  | { readonly kind: 'conversion-kind'; readonly conversion: string }
  | { readonly kind: 'conversion-param'; readonly param: string; readonly value: string }
  | { readonly kind: 'binding-mode'; readonly mode: string }
  | { readonly kind: 'binding-input'; readonly inputId: string }
  | { readonly kind: 'dict-add' }
  | { readonly kind: 'dict-remove'; readonly index: number }
  | { readonly kind: 'dict-key'; readonly index: number; readonly key: string }
  | { readonly kind: 'dict-value'; readonly index: number; readonly value: string }
  | { readonly kind: 'row-insert'; readonly index: number }
  | { readonly kind: 'row-remove'; readonly index: number };

/** 侧栏应用变更时要读的题目上下文：出题人积木声明。 */
export interface CommandContext {
  readonly authorBlocks?: readonly AuthorBlock[];
}

/** 应用一条侧栏变更；节点种类与字段对不上时返回 `undefined`（界面不该显示那个控件）。 */
export function applyInspectorChange(
  document: canvas.CanvasDocument,
  nodeId: string,
  change: InspectorChange,
  ctx: CommandContext,
): CanvasEdit | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  switch (change.kind) {
    case 'field':
      return applyFieldChange(document, nodeId, change.key, change.value, ctx);
    case 'conversion-kind':
      return convertToKind(document, node, change.conversion);
    case 'conversion-param':
      return convertParam(document, node, change.param, change.value);
    case 'binding-mode':
      return applyBindingMode(document, node, change.mode);
    case 'binding-input':
      return applyBindingInput(document, node, change.inputId);
    case 'dict-add':
      return addDictEntry(document, node);
    case 'dict-remove':
      return node.kind === 'dict'
        ? setDictEntries(
            document,
            nodeId,
            node.entries.filter((_, index) => index !== change.index),
          )
        : undefined;
    case 'dict-key':
      return editDictEntry(document, node, change.index, change.key, undefined);
    case 'dict-value':
      return editDictEntry(document, node, change.index, undefined, change.value);
    case 'row-insert':
      return node.kind === 'group' ? insertRowAfter(document, nodeId, change.index) : undefined;
    case 'row-remove':
      return node.kind === 'group' ? removeRow(document, nodeId, change.index) : undefined;
  }
}

/** 单个字段 → 命令。字段名与节点属性同名（`CanvasFieldSpec.key`），所以一次 switch 就够。 */
function applyFieldChange(
  document: canvas.CanvasDocument,
  nodeId: string,
  key: string,
  value: string,
  ctx: CommandContext,
): CanvasEdit | undefined {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return undefined;
  switch (key) {
    case 'name':
      return node.kind === 'var-decl' ? renameVariable(document, nodeId, value) : undefined;
    case 'type':
      // 命令层还没有「改变量类型」：只允许在未初始化时改，避免旧初值/绑定与新类型打架。
      if (node.kind !== 'var-decl') return undefined;
      if (node.binding.mode !== 'none') {
        return refuse(document, 'variable_error', nodeId, '先解除初始化绑定，再改变量类型');
      }
      return edited(replaceNode(document, { ...node, type: toValueKind(value) }));
    case 'mode':
      return node.kind === 'group' ? setGroupMode(document, nodeId, normalizeGroupMode(value)) : undefined;
    case 'op':
      return node.kind === 'relation'
        ? setRelationOp(document, nodeId, value)
        : node.kind === 'unary'
          ? setUnaryOp(document, nodeId, value)
          : undefined;
    case 'block':
      return applyMethodBlock(document, nodeId, value, ctx);
    case 'target':
      return node.kind === 'assign' ? setAssignTarget(document, nodeId, value) : undefined;
    case 'decl':
      return node.kind === 'var-ref' ? edited(replaceDecl(document, node, value)) : undefined;
    case 'loop':
      return node.kind === 'loop-index' ? edited(replaceLoop(document, node, value)) : undefined;
    default:
      return undefined;
  }
}

/**
 * 变量类型改写：`editor.ts` 没有「改变量类型」这条命令，这里只写 `type` 一个字段，
 * 且调用点已保证绑定为空（否则新旧类型会打架）。等命令层补上后换成命令调用。
 */
function toValueKind(value: string): canvas.ValueKind {
  const known = canvas.VALUE_KINDS.find((kind) => kind === value);
  return known ?? 'int';
}

function normalizeGroupMode(value: string): canvas.GroupMode {
  return value === 'merge' ? 'merge' : 'list';
}

function applyMethodBlock(
  document: canvas.CanvasDocument,
  nodeId: string,
  blockId: string,
  ctx: CommandContext,
): CanvasEdit | undefined {
  const block = (ctx.authorBlocks ?? []).find((item) => item.id === blockId);
  if (block === undefined) return refuse(document, 'method_mismatch', nodeId, `题目没有声明方法「${blockId}」`);
  return setMethodBlock(document, nodeId, block);
}

/** 变量引用改指向：命令层的 `createReference` 只负责新建，改指向按属性写回。 */
function replaceDecl(document: canvas.CanvasDocument, node: canvas.VarRefNode, declId: string): canvas.CanvasDocument {
  return replaceNode(document, { ...node, decl: declId });
}

function replaceLoop(document: canvas.CanvasDocument, node: canvas.LoopIndexNode, loopId: string): canvas.CanvasDocument {
  return replaceNode(document, { ...node, loop: loopId });
}

// ---------------------------------------------------------------------------
// 转换参数
// ---------------------------------------------------------------------------

/** 换一种转换：参数按新种类的默认值重建（旧参数 incompatible 时不硬套）。 */
function convertToKind(document: canvas.CanvasDocument, node: canvas.CanvasNode, kind: string): CanvasEdit | undefined {
  if (node.kind !== 'convert' || !isConversionKind(kind)) return undefined;
  return setConversion(document, node.id, defaultConversionOf(kind));
}

/** 改一个转换参数；参数名不属于当前种类时返回 `undefined`。 */
function convertParam(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  param: string,
  value: string,
): CanvasEdit | undefined {
  if (node.kind !== 'convert') return undefined;
  const next = withConversionParam(node.spec, param, value);
  if (next === undefined) return undefined;
  return setConversion(document, node.id, next);
}

/** 转换种类的默认参数：与目录的 `DEFAULT_CONVERSION` 同一套取值。 */
export function defaultConversionOf(kind: canvas.ConversionKind): canvas.ConversionSpec {
  switch (kind) {
    case 'text-to-bytes':
    case 'bytes-to-text':
      return { kind, encoding: 'utf-8' };
    case 'int-to-bytes':
    case 'bytes-to-int':
      return { kind, width: 4, endian: 'little', signed: false };
    case 'double-to-int':
      return { kind, rounding: 'trunc' };
    case 'int-to-text':
    case 'text-to-int':
      return { kind, base: 10 };
    default:
      return { kind };
  }
}

/** 在当前转换上改一个参数；种类与参数对不上时返回 `undefined`。 */
function withConversionParam(
  spec: canvas.ConversionSpec,
  param: string,
  value: string,
): canvas.ConversionSpec | undefined {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'bytes-to-text':
      return param === 'encoding' && (value === 'utf-8' || value === 'ascii') ? { ...spec, encoding: value } : undefined;
    case 'int-to-bytes':
    case 'bytes-to-int':
      return withIntBytesParam(spec, param, value);
    case 'double-to-int':
      return param === 'rounding' && isRounding(value) ? { ...spec, rounding: value } : undefined;
    case 'int-to-text':
    case 'text-to-int':
      return param === 'base' && (value === '10' || value === '16')
        ? { ...spec, base: value === '16' ? 16 : 10 }
        : undefined;
    default:
      return undefined;
  }
}

function withIntBytesParam(
  spec: Extract<canvas.ConversionSpec, { readonly kind: 'int-to-bytes' | 'bytes-to-int' }>,
  param: string,
  value: string,
): canvas.ConversionSpec | undefined {
  if (param === 'width') {
    const width = Number(value);
    if (width !== 1 && width !== 2 && width !== 4 && width !== 8) return undefined;
    return { ...spec, width };
  }
  if (param === 'endian' && (value === 'little' || value === 'big')) return { ...spec, endian: value };
  if (param === 'signed') return { ...spec, signed: value === 'yes' };
  return undefined;
}

function isRounding(value: string): value is canvas.RoundingMode {
  return canvas.ROUNDING_MODES.some((mode) => mode === value);
}

// ---------------------------------------------------------------------------
// 变量绑定与字典
// ---------------------------------------------------------------------------

/** 绑定方式：解绑直接允许；改成初始值/派生绑定要有一个能接的表达式。 */
function applyBindingMode(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  mode: string,
): CanvasEdit | undefined {
  if (node.kind !== 'var-decl') return undefined;
  if (mode !== 'initial' && mode !== 'derived') {
    return mode === 'none' ? setBinding(document, node.id, { mode: 'none' }) : undefined;
  }
  const existing = node.binding.mode === 'none' ? firstValueNodeId(document) : node.binding.input;
  if (existing === undefined) {
    return refuse(document, 'variable_error', node.id, '还没有可以绑定的数据节点，先摆一个值节点');
  }
  return setBinding(document, node.id, { mode, input: existing });
}

function applyBindingInput(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  inputId: string,
): CanvasEdit | undefined {
  if (node.kind !== 'var-decl') return undefined;
  const mode = node.binding.mode === 'none' ? 'initial' : node.binding.mode;
  return setBinding(document, node.id, { mode, input: inputId });
}

/** 加一条字典项：键先给字符串 `key`，值取第一个数据节点（选了才有意义）。 */
function addDictEntry(document: canvas.CanvasDocument, node: canvas.CanvasNode): CanvasEdit | undefined {
  if (node.kind !== 'dict') return undefined;
  const value = firstValueNodeId(document);
  if (value === undefined) return refuse(document, 'invalid_value', node.id, '还没有可以当作字典值的节点');
  return setDictEntries(document, node.id, [...node.entries, { key: { kind: 'string', value: 'key' }, value }]);
}

/** 改字典项的键或值：键按「纯数字 = 整数键，其余 = 文本键」解析。 */
function editDictEntry(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  index: number,
  keyText: string | undefined,
  valueId: string | undefined,
): CanvasEdit | undefined {
  if (node.kind !== 'dict') return undefined;
  const current = node.entries[index];
  if (current === undefined) return undefined;
  const next = node.entries.map((entry, entryIndex) =>
    entryIndex === index
      ? { key: keyText === undefined ? entry.key : parseDictKey(keyText), value: valueId ?? entry.value }
      : entry,
  );
  return setDictEntries(document, node.id, next);
}

function parseDictKey(text: string): canvas.EncodedDictKey {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? { kind: 'int', value: trimmed } : { kind: 'string', value: trimmed };
}
