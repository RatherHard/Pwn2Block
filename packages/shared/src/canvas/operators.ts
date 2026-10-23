import type { ValueKind } from './value';

/**
 * 运算与转换的**目录**（需求 §2.3、§4.2）。
 *
 * 这里只放「有哪些运算、叫什么、吃什么类型、吐什么类型」这类静态事实，不放计算实现：
 * 目录要被校验器、属性面板、关系方框和转换包络同时读取，所以没有副作用、也不 import 求值。
 * 实现分别在 `ops.ts`、`convert.ts`。
 *
 * 一条硬规则：**不做隐式类型转换**。整数与浮点数混用、字节串与文本混用都要显式经过转换节点，
 * 所以每个运算的左右类型都是固定种类，校验器据此直接报 `type_mismatch`。
 */

// ---------------------------------------------------------------------------
// 二元运算
// ---------------------------------------------------------------------------

/**
 * 关系方框上的二元运算。
 *
 * 命名 `<接收类型>.<运算>` 而不是 `add` 加一个类型参数：类型不匹配时错误信息能直接说清
 * 「`整数加` 需要两边都是整数」，界面也能按前缀分组。
 */
export const BINARY_OPERATORS = [
  // 整数算术与位运算
  'int.add',
  'int.sub',
  'int.mul',
  'int.div',
  'int.mod',
  'int.and',
  'int.or',
  'int.xor',
  'int.shl',
  'int.shr',
  // 浮点算术
  'double.add',
  'double.sub',
  'double.mul',
  'double.div',
  // 数字比较
  'int.eq',
  'int.ne',
  'int.lt',
  'int.le',
  'int.gt',
  'int.ge',
  'double.eq',
  'double.ne',
  'double.lt',
  'double.le',
  'double.gt',
  'double.ge',
  // 布尔（与、或短路，见 ops.ts）
  'bool.and',
  'bool.or',
] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

export interface BinaryOperatorSpec {
  readonly op: BinaryOperator;
  /** 中文名：侧栏、错误文案与关系方框的悬停说明。 */
  readonly label: string;
  /** 关系方框上的符号。不能只靠颜色区分运算，所以方框一定有文字。 */
  readonly symbol: string;
  readonly left: ValueKind;
  readonly right: ValueKind;
  readonly result: ValueKind;
  /** 短路运算：右侧只在左侧不决定结果时才求值（需求 §2.3）。 */
  readonly shortCircuit?: boolean;
}

const BINARY_SPECS: readonly BinaryOperatorSpec[] = [
  { op: 'int.add', label: '整数加', symbol: '+', left: 'int', right: 'int', result: 'int' },
  { op: 'int.sub', label: '整数减', symbol: '−', left: 'int', right: 'int', result: 'int' },
  { op: 'int.mul', label: '整数乘', symbol: '×', left: 'int', right: 'int', result: 'int' },
  { op: 'int.div', label: '整数整除', symbol: '÷', left: 'int', right: 'int', result: 'int' },
  { op: 'int.mod', label: '整数取余', symbol: '%', left: 'int', right: 'int', result: 'int' },
  { op: 'int.and', label: '按位与', symbol: '&', left: 'int', right: 'int', result: 'int' },
  { op: 'int.or', label: '按位或', symbol: '|', left: 'int', right: 'int', result: 'int' },
  { op: 'int.xor', label: '按位异或', symbol: '^', left: 'int', right: 'int', result: 'int' },
  { op: 'int.shl', label: '左移', symbol: '<<', left: 'int', right: 'int', result: 'int' },
  { op: 'int.shr', label: '右移', symbol: '>>', left: 'int', right: 'int', result: 'int' },
  { op: 'double.add', label: '浮点加', symbol: '+', left: 'double', right: 'double', result: 'double' },
  { op: 'double.sub', label: '浮点减', symbol: '−', left: 'double', right: 'double', result: 'double' },
  { op: 'double.mul', label: '浮点乘', symbol: '×', left: 'double', right: 'double', result: 'double' },
  { op: 'double.div', label: '浮点除', symbol: '÷', left: 'double', right: 'double', result: 'double' },
  { op: 'int.eq', label: '整数等于', symbol: '=', left: 'int', right: 'int', result: 'bool' },
  { op: 'int.ne', label: '整数不等于', symbol: '≠', left: 'int', right: 'int', result: 'bool' },
  { op: 'int.lt', label: '整数小于', symbol: '<', left: 'int', right: 'int', result: 'bool' },
  { op: 'int.le', label: '整数小于等于', symbol: '≤', left: 'int', right: 'int', result: 'bool' },
  { op: 'int.gt', label: '整数大于', symbol: '>', left: 'int', right: 'int', result: 'bool' },
  { op: 'int.ge', label: '整数大于等于', symbol: '≥', left: 'int', right: 'int', result: 'bool' },
  { op: 'double.eq', label: '浮点等于', symbol: '=', left: 'double', right: 'double', result: 'bool' },
  { op: 'double.ne', label: '浮点不等于', symbol: '≠', left: 'double', right: 'double', result: 'bool' },
  { op: 'double.lt', label: '浮点小于', symbol: '<', left: 'double', right: 'double', result: 'bool' },
  { op: 'double.le', label: '浮点小于等于', symbol: '≤', left: 'double', right: 'double', result: 'bool' },
  { op: 'double.gt', label: '浮点大于', symbol: '>', left: 'double', right: 'double', result: 'bool' },
  { op: 'double.ge', label: '浮点大于等于', symbol: '≥', left: 'double', right: 'double', result: 'bool' },
  { op: 'bool.and', label: '布尔与', symbol: '且', left: 'bool', right: 'bool', result: 'bool', shortCircuit: true },
  { op: 'bool.or', label: '布尔或', symbol: '或', left: 'bool', right: 'bool', result: 'bool', shortCircuit: true },
];

export const BINARY_OPERATOR_SPECS: Readonly<Record<BinaryOperator, BinaryOperatorSpec>> = Object.fromEntries(
  BINARY_SPECS.map((spec) => [spec.op, spec]),
) as Record<BinaryOperator, BinaryOperatorSpec>;

export function binaryOperatorSpec(op: BinaryOperator): BinaryOperatorSpec {
  return BINARY_OPERATOR_SPECS[op];
}

/** 次序索引：界面「点击关系方框切换运算」按目录顺序轮换。 */
export function binaryOperatorIndex(op: BinaryOperator): number {
  return BINARY_OPERATORS.indexOf(op);
}

// ---------------------------------------------------------------------------
// 一元运算与附属操作
// ---------------------------------------------------------------------------

/**
 * 一元的运算与附属操作。
 *
 * `bool.not` 对应「布尔节点自带取反」：界面上它贴在布尔节点上，语义上就是一个一元关系。
 * `length` 是集合的附属操作（需求 §2.3「长度」）。
 */
export const UNARY_OPERATORS = ['bool.not', 'length'] as const;
export type UnaryOperator = (typeof UNARY_OPERATORS)[number];

export interface UnaryOperatorSpec {
  readonly op: UnaryOperator;
  readonly label: string;
  readonly symbol: string;
  /** 接受的输入值种类；类型不匹配由校验器报。 */
  readonly accepts: readonly ValueKind[];
  readonly result: ValueKind;
}

const UNARY_SPECS: readonly UnaryOperatorSpec[] = [
  { op: 'bool.not', label: '取反', symbol: '非', accepts: ['bool'], result: 'bool' },
  { op: 'length', label: '长度', symbol: '#', accepts: ['byte', 'string', 'list'], result: 'int' },
];

export const UNARY_OPERATOR_SPECS: Readonly<Record<UnaryOperator, UnaryOperatorSpec>> = Object.fromEntries(
  UNARY_SPECS.map((spec) => [spec.op, spec]),
) as Record<UnaryOperator, UnaryOperatorSpec>;

export function unaryOperatorSpec(op: UnaryOperator): UnaryOperatorSpec {
  return UNARY_OPERATOR_SPECS[op];
}

// ---------------------------------------------------------------------------
// 转换目录
// ---------------------------------------------------------------------------

export const TEXT_ENCODINGS = ['utf-8', 'ascii'] as const;
export type TextEncoding = (typeof TEXT_ENCODINGS)[number];
export const TEXT_ENCODING_LABELS: Readonly<Record<TextEncoding, string>> = {
  'utf-8': 'UTF-8',
  ascii: 'ASCII',
};

/** 整数与字节串互转的宽度；字节串长度必须与它精确匹配（需求 §4.2）。 */
export const INT_WIDTHS = [1, 2, 4, 8] as const;
export type IntWidth = (typeof INT_WIDTHS)[number];

export const ENDIANS = ['little', 'big'] as const;
export type Endian = (typeof ENDIANS)[number];
export const ENDIAN_LABELS: Readonly<Record<Endian, string>> = { little: '小端', big: '大端' };

/** 浮点转整数的舍入方式（需求 §4.2）。 */
export const ROUNDING_MODES = ['trunc', 'floor', 'ceil', 'nearest'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];
export const ROUNDING_LABELS: Readonly<Record<RoundingMode, string>> = {
  trunc: '向零',
  floor: '向下',
  ceil: '向上',
  nearest: '最近',
};

/** 数字与文本互转的进制：十进制之外，整数额外支持十六进制（需求 §4.2）。 */
export const INT_TEXT_BASES = [10, 16] as const;
export type IntTextBase = (typeof INT_TEXT_BASES)[number];

/** 整数 ↔ 字节串共用的参数。 */
export interface IntBytesOptions {
  readonly width: IntWidth;
  readonly endian: Endian;
  readonly signed: boolean;
}

export type ConversionSpec =
  | { readonly kind: 'text-to-bytes'; readonly encoding: TextEncoding }
  | { readonly kind: 'bytes-to-text'; readonly encoding: TextEncoding }
  | ({ readonly kind: 'int-to-bytes' } & IntBytesOptions)
  | ({ readonly kind: 'bytes-to-int' } & IntBytesOptions)
  | { readonly kind: 'int-to-double' }
  | { readonly kind: 'double-to-int'; readonly rounding: RoundingMode }
  | { readonly kind: 'int-to-text'; readonly base: IntTextBase }
  | { readonly kind: 'text-to-int'; readonly base: IntTextBase }
  | { readonly kind: 'double-to-text' }
  | { readonly kind: 'text-to-double' }
  | { readonly kind: 'list-to-bytes' }
  | { readonly kind: 'list-to-text' };

export type ConversionKind = ConversionSpec['kind'];

export const CONVERSION_LABELS: Readonly<Record<ConversionKind, string>> = {
  'text-to-bytes': '文本转字节串',
  'bytes-to-text': '字节串转文本',
  'int-to-bytes': '整数转字节串',
  'bytes-to-int': '字节串转整数',
  'int-to-double': '整数转浮点数',
  'double-to-int': '浮点数转整数',
  'int-to-text': '整数转文本',
  'text-to-int': '文本转整数',
  'double-to-text': '浮点数转文本',
  'text-to-double': '文本转浮点数',
  'list-to-bytes': '字节串列表转字节串',
  'list-to-text': '文本列表转文本',
};

/** 转换节点的输入种类：校验器据此判断「这个转换能不能接这个结构」（字典一律不能）。 */
export function conversionInputKind(spec: ConversionSpec): ValueKind {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'text-to-int':
    case 'text-to-double':
      return 'string';
    case 'bytes-to-text':
    case 'bytes-to-int':
      return 'byte';
    case 'int-to-bytes':
    case 'int-to-double':
    case 'int-to-text':
      return 'int';
    case 'double-to-int':
    case 'double-to-text':
      return 'double';
    case 'list-to-bytes':
    case 'list-to-text':
      return 'list';
  }
}

export function conversionOutputKind(spec: ConversionSpec): ValueKind {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'int-to-bytes':
    case 'list-to-bytes':
      return 'byte';
    case 'bytes-to-text':
    case 'int-to-text':
    case 'double-to-text':
    case 'list-to-text':
      return 'string';
    case 'bytes-to-int':
    case 'double-to-int':
    case 'text-to-int':
      return 'int';
    case 'int-to-double':
    case 'text-to-double':
      return 'double';
  }
}

/** 转换参数的一行摘要：显示在转换节点上（需求 §4.2「参数在节点上显示摘要」）。 */
export function conversionSummary(spec: ConversionSpec): string {
  switch (spec.kind) {
    case 'text-to-bytes':
    case 'bytes-to-text':
      return TEXT_ENCODING_LABELS[spec.encoding];
    case 'int-to-bytes':
    case 'bytes-to-int':
      return `${spec.width} 字节 ${ENDIAN_LABELS[spec.endian]} ${spec.signed ? '有符号' : '无符号'}`;
    case 'int-to-double':
      return '精确表示';
    case 'double-to-int':
      return ROUNDING_LABELS[spec.rounding];
    case 'int-to-text':
    case 'text-to-int':
      return spec.base === 16 ? '十六进制' : '十进制';
    case 'double-to-text':
    case 'text-to-double':
      return '十进制';
    case 'list-to-bytes':
    case 'list-to-text':
      return '按顺序合并';
  }
}

/** 两个转换的参数是否相同：属性面板切换种类时用它决定要不要保留参数。 */
export function sameConversion(left: ConversionSpec, right: ConversionSpec): boolean {
  if (left.kind !== right.kind) return false;
  return conversionSummary(left) === conversionSummary(right);
}
