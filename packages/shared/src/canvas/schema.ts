import { z } from 'zod';
import {
  CANVAS_MAX_BYTES,
  CANVAS_MAX_COLLECTION_ITEMS,
  CANVAS_MAX_FLOW_NODES,
  CANVAS_MAX_GROUP_ROWS,
  CANVAS_MAX_METHOD_ARGS,
  CANVAS_MAX_NODES,
  CANVAS_MAX_ROW_MEMBERS,
  CANVAS_MAX_TEXT_CHARS,
  CANVAS_MAX_VAR_NAME_CHARS,
} from '../limits';
import { WORKFLOW_FORMAT } from '../workflow/types';
import {
  CANVAS_FORMAT,
  CANVAS_NODE_ID_RE,
  CANVAS_VERSION,
  GROUP_MODES,
  type CanvasDocument,
} from './document';
import {
  BINARY_OPERATORS,
  ENDIANS,
  INT_TEXT_BASES,
  INT_WIDTHS,
  ROUNDING_MODES,
  TEXT_ENCODINGS,
  UNARY_OPERATORS,
} from './operators';
import { VALUE_KINDS } from './value';

/**
 * 新版画布存档的 Schema（需求 §8）。
 *
 * 存档来自 `localStorage` 与导入文件，一律不可信。这一层只管**形状**：
 * 严格对象（多一个字段就拒绝）、长度上限、坐标有限、字面值编码合法。
 * 语义问题（未知节点、类型不匹配、`main` 引用不存在的节点、成员重复归属）交给 `validate.ts`，
 * 这样两边的错误可以分别是「这份存档坏了」和「这张图还差什么」。
 *
 * 读旧存档是**明说**的失败，不是清空：`parseCanvasDocument` 先认 `format` 再认 `version`，
 * 只有两者都与本版本一致才去验形状（需求 §8「读到旧存档明确提示不兼容，不静默清空或覆盖」）。
 */

// ---------------------------------------------------------------------------
// 基本形状
// ---------------------------------------------------------------------------

/** 十进制整数文本：无前导零、允许负号；与 `value-codec.ts` 的解码口径一致。 */
const INT_TEXT_RE = /^-?(?:0|[1-9][0-9]*)$/;
/** 字节串文本：无前缀、偶数字节的 hex。 */
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/;
/** 整数编码文本的字符数上限：`CANVAS_MAX_INT_BITS` 位二进制最多 309 位十进制，512 位留足余量。 */
const MAX_INT_TEXT_CHARS = 512;

/**
 * 节点 id 的形状。
 *
 * 引用**不要求**目标存在：悬空引用是「这张图还差什么」的问题（由校验器报出来），
 * 不是「存档坏了」。所以这里只查形状。
 */
const CanvasNodeIdSchema = z
  .string()
  .regex(CANVAS_NODE_ID_RE, '节点 id 只能是字母、数字、下划线和连字符，长度 1–64');

/**
 * 输入引用字段：允许空串表示「还没接线」（见 `document.ts` 的 `UNCONNECTED`）。
 *
 * 编辑中的图必然有半接好的节点，存档要能表示这个状态；「必填端口没接线」由校验器报
 * `unconnected`，不是存档形状错误。节点自己的 `id` 仍用 `CanvasNodeIdSchema`，不允许为空。
 */
const CanvasRefSchema = z.union([z.literal(''), CanvasNodeIdSchema]);

/** 布局坐标：只影响显示，但脏存档不该带进 `Infinity` 或 1e9 这种值。 */
const COORD_LIMIT = 100_000;

export const CanvasNodeLayoutSchema = z.strictObject({
  x: z.number().finite().min(-COORD_LIMIT).max(COORD_LIMIT),
  y: z.number().finite().min(-COORD_LIMIT).max(COORD_LIMIT),
});

// ---------------------------------------------------------------------------
// 值编码
// ---------------------------------------------------------------------------

/** 字典键：整数键用十进制文本（不经 `number`），文本键按 UTF-16 码元计长。 */
export const EncodedDictKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('int'),
    // 位数是否超过 `CANVAS_MAX_INT_BITS` 由语义侧查；这里先挡住会撑爆 bigint 的超长文本。
    value: z
      .string()
      .max(MAX_INT_TEXT_CHARS, `字典整数键不能超过 ${MAX_INT_TEXT_CHARS} 个字符`)
      .regex(INT_TEXT_RE, '字典整数键必须是无前导零的十进制文本'),
  }),
  z.strictObject({
    kind: z.literal('string'),
    // 形状层按 UTF-16 码元给到 1024 的余量，128 个码点的语义上限由 `checkKey` 查。
    value: z.string().max(1024, '字典文本键不能超过 1024 个 UTF-16 码元'),
  }),
]);

/**
 * 字面值节点能承载的标量。
 *
 * 列表与字典不在这里：列表由组合产生、字典由字典节点产生（需求 §2.1），
 * 所以「字面值里塞一个列表」是存档形状错误。
 */
export const EncodedScalarValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('byte'),
    hex: z
      .string()
      .max(CANVAS_MAX_BYTES * 2, `字节串 hex 不能超过 ${CANVAS_MAX_BYTES * 2} 个字符（${CANVAS_MAX_BYTES} 字节）`)
      .regex(HEX_BYTES_RE, '字节串必须是无前缀的偶数字节 hex'),
  }),
  z.strictObject({
    kind: z.literal('int'),
    value: z
      .string()
      .max(MAX_INT_TEXT_CHARS, `整数不能超过 ${MAX_INT_TEXT_CHARS} 个字符`)
      .regex(INT_TEXT_RE, '整数必须是无前导零的十进制文本'),
  }),
  z.strictObject({
    kind: z.literal('double'),
    value: z.number().finite('浮点数只能是有限值'),
  }),
  z.strictObject({
    kind: z.literal('string'),
    // 形状层按 UTF-16 码元封顶；码点数（`CANVAS_MAX_TEXT_CHARS`）由求值侧按码点再查。
    value: z.string().max(CANVAS_MAX_TEXT_CHARS * 2, `文本不能超过 ${CANVAS_MAX_TEXT_CHARS * 2} 个 UTF-16 码元`),
  }),
  z.strictObject({
    kind: z.literal('bool'),
    value: z.boolean(),
  }),
]);

// ---------------------------------------------------------------------------
// 转换参数
// ---------------------------------------------------------------------------

/** 整数 ↔ 字节串的三个参数；宽度、端序与符号参与语义，所以都必须在形状层固定。 */
const INT_BYTES_PARAMS = {
  width: z.literal(INT_WIDTHS),
  endian: z.enum(ENDIANS),
  signed: z.boolean(),
} as const;

/** 12 种转换各自的参数（需求 §4.2）：不带参数的种类也用 strictObject，多写一个字段就拒绝。 */
export const ConversionSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-to-bytes'), encoding: z.enum(TEXT_ENCODINGS) }),
  z.strictObject({ kind: z.literal('bytes-to-text'), encoding: z.enum(TEXT_ENCODINGS) }),
  z.strictObject({ kind: z.literal('int-to-bytes'), ...INT_BYTES_PARAMS }),
  z.strictObject({ kind: z.literal('bytes-to-int'), ...INT_BYTES_PARAMS }),
  z.strictObject({ kind: z.literal('int-to-double') }),
  z.strictObject({ kind: z.literal('double-to-int'), rounding: z.enum(ROUNDING_MODES) }),
  z.strictObject({ kind: z.literal('int-to-text'), base: z.literal(INT_TEXT_BASES) }),
  z.strictObject({ kind: z.literal('text-to-int'), base: z.literal(INT_TEXT_BASES) }),
  z.strictObject({ kind: z.literal('double-to-text') }),
  z.strictObject({ kind: z.literal('text-to-double') }),
  z.strictObject({ kind: z.literal('list-to-bytes') }),
  z.strictObject({ kind: z.literal('list-to-text') }),
]);

// ---------------------------------------------------------------------------
// 变量与流程的共享形状（阶段二）
// ---------------------------------------------------------------------------

/** 方法标识：与题目包 `authorBlocks[].id` 同一口径（`challenge.ts`），否则命中不了题目声明的方法。 */
const METHOD_BLOCK_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** 方法参数名：与题目包参数名同一口径，最长 16 位。 */
const METHOD_ARG_NAME_RE = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * 变量的初始化关系（需求 §3.1–3.2）。
 *
 * `mode` 决定要不要 `input`，所以用判别联合而不是「都写可选再细化」：
 * `none` 必须是空对象，多带一个 `input` 就是坏存档，不该被当作「忽略多余字段」。
 */
const VariableBindingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('initial'), input: CanvasNodeIdSchema }),
  z.strictObject({ mode: z.literal('derived'), input: CanvasNodeIdSchema }),
]);

/** 执行区域（分支的 `then`/`else`、循环的 `body`）：语句顺序即执行顺序，条数不得超过流程节点上限。 */
const RegionSequenceSchema = z
  .array(CanvasNodeIdSchema)
  .max(CANVAS_MAX_FLOW_NODES, `执行区域最多 ${CANVAS_MAX_FLOW_NODES} 项`);

/**
 * 方法参数表：键是题目声明的参数名、值是数据节点 id。
 *
 * 键的形状在这里查（否则名字根本对不上题目声明）；「参数名是否真的属于该方法」是语义，
 * 由 `validate.ts` 查。个数上限与题目声明的参数上限同源。
 * 注意 zod 对 record 键的报错是通用英文文案（`Invalid key in record`），正则上的中文只作意图说明。
 */
const MethodArgsSchema = z
  .record(
    z.string().regex(METHOD_ARG_NAME_RE, '参数名只能以小写字母开头，含小写字母、数字和下划线，长度 1–16'),
    CanvasRefSchema,
  )
  .refine((args) => Object.keys(args).length <= CANVAS_MAX_METHOD_ARGS, `方法参数最多 ${CANVAS_MAX_METHOD_ARGS} 个`);

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/** 组合的一行：成员顺序就是「先行后列」的展开顺序（需求 §2.2）。 */
const GroupRowSchema = z
  .array(CanvasNodeIdSchema)
  .max(CANVAS_MAX_ROW_MEMBERS, `组合每行最多 ${CANVAS_MAX_ROW_MEMBERS} 个成员`);

/** 字典的一条：键是字面键，值是另一个节点的 id。 */
const DictEntrySchema = z.strictObject({
  key: EncodedDictKeySchema,
  value: CanvasRefSchema,
});

/**
 * 十八种节点，每种都是 strictObject：阶段一十种数据节点 + 阶段二八种变量与流程节点。
 *
 * `id` 写在每个分支里而不是外层：`z.discriminatedUnion` 的分支必须是完整对象，
 * 而 `id` 在所有分支上形状相同，集中写一个 schema 就够。
 */
export const CanvasNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: CanvasNodeIdSchema, kind: z.literal('value'), value: EncodedScalarValueSchema }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('group'),
    mode: z.enum(GROUP_MODES),
    rows: z.array(GroupRowSchema).max(CANVAS_MAX_GROUP_ROWS, `组合最多 ${CANVAS_MAX_GROUP_ROWS} 行`),
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('dict'),
    entries: z.array(DictEntrySchema).max(CANVAS_MAX_COLLECTION_ITEMS, `字典最多 ${CANVAS_MAX_COLLECTION_ITEMS} 条`),
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('relation'),
    op: z.enum(BINARY_OPERATORS),
    left: CanvasRefSchema,
    right: CanvasRefSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('unary'),
    op: z.enum(UNARY_OPERATORS),
    operand: CanvasRefSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('index'),
    target: CanvasRefSchema,
    index: CanvasRefSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('lookup'),
    target: CanvasRefSchema,
    key: CanvasRefSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('slice'),
    target: CanvasRefSchema,
    start: CanvasRefSchema.optional(),
    end: CanvasRefSchema.optional(),
    step: CanvasRefSchema.optional(),
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('repeat'),
    target: CanvasRefSchema,
    count: CanvasRefSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('convert'),
    spec: ConversionSpecSchema,
    input: CanvasRefSchema,
  }),
  // —— 阶段二：变量（需求 §3）。声明就是节点，没有单独的 `vars` 字段。——
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('var-decl'),
    name: z
      .string()
      .min(1, '变量名不能为空')
      .max(CANVAS_MAX_VAR_NAME_CHARS, `变量名不能超过 ${CANVAS_MAX_VAR_NAME_CHARS} 个字符`),
    type: z.enum(VALUE_KINDS),
    binding: VariableBindingSchema,
  }),
  z.strictObject({ id: CanvasNodeIdSchema, kind: z.literal('var-ref'), decl: CanvasRefSchema }),
  z.strictObject({ id: CanvasNodeIdSchema, kind: z.literal('loop-index'), loop: CanvasRefSchema }),
  // —— 阶段二：流程（需求 §5）。区域用数组表达顺序，结构上就写不出回边。——
  z.strictObject({ id: CanvasNodeIdSchema, kind: z.literal('start') }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('if'),
    cond: CanvasRefSchema,
    then: RegionSequenceSchema,
    else: RegionSequenceSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('loop'),
    count: CanvasRefSchema,
    body: RegionSequenceSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('method'),
    // 空串表示「还没选方法」：新加的方法节点在校验期报 `method_mismatch`，存档形状仍合法。
    block: z.union([
      z.literal(''),
      z.string().regex(METHOD_BLOCK_RE, '方法标识只能以小写字母开头，含小写字母、数字和下划线，长度 1–32'),
    ]),
    args: MethodArgsSchema,
  }),
  z.strictObject({
    id: CanvasNodeIdSchema,
    kind: z.literal('assign'),
    target: CanvasRefSchema,
    value: CanvasRefSchema,
  }),
]);

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export const CanvasDocumentSchema = z.strictObject({
  format: z.literal(CANVAS_FORMAT),
  version: z.literal(CANVAS_VERSION),
  nodes: z.array(CanvasNodeSchema).max(CANVAS_MAX_NODES, `节点数不能超过 ${CANVAS_MAX_NODES}`),
  /**
   * 布局：键是节点 id，但**允许已删除节点的残留条目**——删节点与删布局是两条路径，
   * 残留一条坐标不该让整份存档判坏（反而是下次保存时自然收敛的东西）。
   */
  layout: z.record(z.string(), CanvasNodeLayoutSchema).default({}),
  /** 流程执行序列（阶段二写入）；缺省为空，不因为「没有 main」判坏。 */
  main: z.array(CanvasNodeIdSchema).max(CANVAS_MAX_FLOW_NODES, `流程序列最多 ${CANVAS_MAX_FLOW_NODES} 项`).default([]),
});

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type ParseCanvasFailureReason = 'legacy' | 'format' | 'version' | 'invalid';

export type ParseCanvasResult =
  | { readonly ok: true; readonly document: CanvasDocument }
  | { readonly ok: false; readonly reason: ParseCanvasFailureReason; readonly message: string };

/** 旧存档的提示文案：明确告诉学习者「不兼容」和接下来做什么，不尝试迁移、不清空。 */
const LEGACY_MESSAGE = `这是旧版画布存档（${WORKFLOW_FORMAT}），新版画布不兼容；请先导出旧文件，再新建画布`;

/**
 * 解析一份存档：先认格式与版本，再验形状；不做语义校验（那是 `validate.ts` 的事）。
 *
 * 顺序是刻意的：旧格式先认，否则它会被当成「格式不对」；`format` 存在但不同 → `format`；
 * `version` 存在但不同 → `version`；剩下的形状问题一律 `invalid`，并带上出错路径。
 */
export function parseCanvasDocument(raw: unknown): ParseCanvasResult {
  const record = asRecord(raw);
  if (record?.format === WORKFLOW_FORMAT) {
    return { ok: false, reason: 'legacy', message: LEGACY_MESSAGE };
  }
  if (record !== undefined && record.format !== undefined && record.format !== CANVAS_FORMAT) {
    return {
      ok: false,
      reason: 'format',
      message: `存档格式是 ${String(record.format)}，不是新版画布格式 ${CANVAS_FORMAT}；请新建画布后再保存`,
    };
  }
  if (record !== undefined && record.version !== undefined && record.version !== CANVAS_VERSION) {
    return {
      ok: false,
      reason: 'version',
      message: `存档版本 ${String(record.version)} 不受支持，当前只认版本 ${CANVAS_VERSION}`,
    };
  }
  const parsed = CanvasDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', message: invalidMessage(parsed.error) };
  }
  // 编译期互检：Schema 推出来的形状必须能赋给 `document.ts` 的 `CanvasDocument`。
  // 少一个必填字段、宽度写错、把 `rows` 写成 `string[]` 都会在这一行报类型错。
  const document: CanvasDocument = parsed.data;
  return { ok: true, document };
}

/** 只有「非数组的对象」才谈得上认格式与版本；数组、`null`、原始值直接落到形状校验。 */
function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * 形状错误的文案：**带出错路径**，否则一份大存档只说「格式不对」等于没说。
 *
 * zod 自带的原因是英文（`Unrecognized key: "foo"`），保留原文并补上中文前缀：
 * 它包含字段名与限制值，翻译反而更容易丢信息。
 */
function invalidMessage(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first !== undefined && first.path.length > 0 ? `（${first.path.join('.')}）` : '';
  return `存档格式不对${where}：${first?.message ?? '未知原因'}`;
}
