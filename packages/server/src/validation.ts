/**
 * 请求 Schema 校验失败的中文文案（04 §6 的 D5–D6 文案收口）。
 *
 * 三条硬约束：
 * 1. **文案全中文，且不含校验器措辞**：`invalid_request` 的 message 由这里的固定模板生成，
 *    绝不透出校验器的英文原文（`Invalid input: …`、`Too big: …`、`Unrecognized key: …`）、
 *    正则源码、内部堆栈或文件路径（04 §6、01 §6）。
 * 2. **不回显提交值**：模板只拼「结构化的字段路径 + 固定原因 + 契约里的上下限数字」，
 *    而字段路径只保留结构段（形如 `actions.0.count`），不像标识符的段一律折成 `?`。
 *    提交的任何**值**——尤其 `flag` 与隐藏内容——都不会出现在拒绝文案里，所以拒绝文案
 *    不能当作回显通道（01 §6 第 2 条、04 §6、06 §6）。
 * 3. **错误码与状态码不变**：这里只产出 message；`code` 恒为 `invalid_request`、
 *    HTTP 恒为 400（`API_ERROR_STATUS`；Fastify 的 413 也归一到这里）。
 *    「错误码决定 HTTP 状态码」不破例（09 §8 第 2 条）。
 *
 * 为什么按 `issue.code` 分类而不是给校验器挂中文错误映射：默认文案会随校验器版本漂移
 * （zod v3 的枚举错误会把**收到的值**拼进 message），而按 issue 类型分类既不依赖具体文案，
 * 也不会因为升级校验器就重新开始回显。代价是文案粒度到「类型 / 上下限 / 格式」，不到
 * 「哪个枚举值」——够诊断，且不泄露。
 */

/** 文案生成需要的最小 issue 形状：只描述用得到的字段，不 import 校验器（服务端不因文案多一个依赖）。 */
export interface ValidationIssueLike {
  readonly code?: unknown;
  readonly path?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly origin?: unknown;
  readonly expected?: unknown;
}

export interface ValidationErrorLike {
  readonly issues: readonly ValidationIssueLike[];
}

/** 校验器给出的类型名 → 中文。未知类型名统一说「指定类型」，不回显英文。 */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  string: '字符串',
  number: '数字',
  int: '整数',
  bigint: '整数',
  boolean: '布尔值',
  array: '数组',
  object: '对象',
  date: '日期',
  null: '空值',
  undefined: '必填值',
  NaN: '数字',
  function: '函数',
  symbol: '符号',
  map: '映射',
  set: '集合',
};

/** 字段路径最多回显几段，避免异常输入把文案撑长。 */
const MAX_PATH_SEGMENTS = 8;
/** 单段最长多少字符（契约字段名都很短；更长的必然不是结构段）。 */
const MAX_SEGMENT_LENGTH = 32;
/** 结构段：标识符或数组下标。其余（客户端自定义的键名等）一律折成 `?`。 */
const STRUCTURAL_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u;

/** 路径段 → 可回显的文本；非结构段不回显原文。 */
function segmentText(raw: unknown): string {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string' && raw.length <= MAX_SEGMENT_LENGTH && STRUCTURAL_SEGMENT.test(raw)) {
    return raw;
  }
  return '?';
}

/** `['actions', 0, 'count']` → `actions.0.count`。请求体缺字段时是空串。 */
export function fieldPathOf(path: unknown): string {
  if (!Array.isArray(path)) return '';
  return path.slice(0, MAX_PATH_SEGMENTS).map(segmentText).join('.');
}

/** 上下限数字来自 Schema 定义（不是提交内容），可以回显；非数字则不提数字。 */
function boundText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

function overLimitText(origin: unknown, maximum: unknown): string {
  const bound = boundText(maximum);
  const tail = bound === undefined ? '' : `（上限 ${bound}）`;
  if (origin === 'array') return `数量超出上限${tail}`;
  if (origin === 'string') return `长度超出上限${tail}`;
  return `数值超出上限${tail}`;
}

function underLimitText(origin: unknown, minimum: unknown): string {
  const bound = boundText(minimum);
  const tail = bound === undefined ? '' : `（下限 ${bound}）`;
  if (origin === 'array') return `数量低于下限${tail}`;
  if (origin === 'string') return `长度低于下限${tail}`;
  return `数值低于下限${tail}`;
}

/** 单条 issue → 固定中文原因。**不拼接任何提交内容**（04 §6）。 */
function reasonOf(issue: ValidationIssueLike, missing: boolean): string {
  // 「字段在提交体里根本不存在」优先于按 issue 类型给的措辞：校验器把缺字段报成类型错
  // （`invalid_type`）或联合判别失败（`invalid_union`），两者的恢复手段都是「补上这个字段」。
  if (missing) return '缺少必填字段';

  const code = typeof issue.code === 'string' ? issue.code : '';
  switch (code) {
    case 'invalid_type': {
      const label = typeof issue.expected === 'string' ? TYPE_LABELS[issue.expected] : undefined;
      return label === undefined ? '类型不正确' : `类型不正确，应为${label}`;
    }
    case 'invalid_value':
      return '取值不在允许范围内';
    case 'invalid_union':
      return '不符合允许的结构';
    case 'invalid_format':
      return '格式不合法';
    case 'not_multiple_of':
      return '数值精度不合法';
    case 'unrecognized_keys':
      // 不回显多余字段的键名：键名也是客户端提交的内容。
      return '包含不允许的字段';
    case 'invalid_key':
      return '字段名不合法';
    case 'invalid_element':
      return '数组元素不合法';
    case 'too_big':
      return overLimitText(issue.origin, issue.maximum);
    case 'too_small':
      return underLimitText(issue.origin, issue.minimum);
    default:
      return '不符合要求';
  }
}

/**
 * 该路径在提交体里是否**根本不存在**（用来把「缺字段」与「类型错」分开说）。
 *
 * 只看结构、不看值：命中就返回 true，所以不会因为值是 `null` 或空串而误判成缺失。
 * 提交体不是对象（例如 `text/plain` 被内置解析器读成字符串）时一律按「不是缺失」处理，
 * 报类型错更准确（D4 口径：`text/plain` 走 Schema 校验的 400，不是 415）。
 */
function pathMissingIn(body: unknown, path: unknown): boolean {
  if (!Array.isArray(path)) return false;
  let current: unknown = body;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return false;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || segment < 0 || segment >= current.length) return false;
      current = current[segment];
      continue;
    }
    const key = typeof segment === 'number' ? String(segment) : segment;
    if (typeof key !== 'string') return false;
    if (!Object.hasOwn(current, key)) return true;
    current = (current as Record<string, unknown>)[key];
  }
  return false;
}

/**
 * 校验失败 → 对外中文文案。只报**第一条** issue：多条并列的文案对学习者没有增量信息，
 * 而首条通常就是最靠外的结构问题（缺字段、类型错、多余字段）。
 *
 * `body` 是客户端的原始提交体，只用于判断「这个字段在不在」，**任何值都不会进入文案**。
 */
export function requestIssueMessage(error: ValidationErrorLike, body?: unknown): string {
  const first = error.issues[0];
  if (first === undefined) return '请求体不合法';
  const path = fieldPathOf(first.path);
  const reason = reasonOf(first, pathMissingIn(body, first.path));
  return path.length === 0 ? `请求体不合法：${reason}` : `请求体不合法：字段 ${path} ${reason}`;
}
