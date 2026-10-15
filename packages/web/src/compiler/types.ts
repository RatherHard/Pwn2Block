import type {
  ArchBits,
  AuthorBlock,
  BlockAction,
  PrimitiveAction,
  PublicChallenge,
} from '@pwn2block/shared';
import {
  EXPR_EVAL_STEP_LIMIT,
  LOOP_UNROLL_LIMIT,
  MAX_SUBMIT_ACTIONS,
} from '@pwn2block/shared';

/**
 * 客户端编译契约（**冻结**：D 在 D4 接这层，改动要同步 05 §3/§4 并通知 A）。
 *
 * ## 输入
 *
 * 归一化的积木树 + 题目公开包的两个字段，**就这些**：
 *
 * ```ts
 * compileProgram({ program: NormalizedWorkspace, challenge: CompilerChallenge })
 * ```
 *
 * - `NormalizedWorkspace` 是纯数据（`{ id, type, fields, inputs, next }`），**不含任何 Blockly 对象**。
 *   `blocks/workspace.ts` 负责把 Blockly workspace 归一化成它；编译器只认这份数据，
 *   所以编译器能在 node 里单测，也不需要在编译路径上加载 Blockly。
 * - `CompilerChallenge` 是 `PublicChallenge` 的结构子集（`archBits` / `allowedActions` / `authorBlocks`），
 *   直接传整个公开包即可。
 * - **不依赖页面状态**（08 §2 规则 3）：编译器不读 DOM、不读投影、不读会话。
 *   同样的树 + 同样的公开包，永远得到同样的动作序列。
 *
 * ## 输出
 *
 * ```ts
 * { ok: true,  actions: CompiledAction[], origins: ActionOrigin[], originsVersion: number }
 * { ok: false, errors: { blockId, message }[] }
 * ```
 *
 * - `ok: false` 时**没有可用的动作序列**（部分编译结果会被丢弃），D 只需要把 `errors`
 *   显示在输出区并按 `blockId` 高亮积木（05 §4）。
 * - `ok: true` 且 `actions` 为空是合法的：空程序。
 * - `origins` 是**动作 → 积木来源表**（08 §9.2）：与 `actions` 等长同序，`origins[i].index === i`。
 *   它只活在前端内存里——发给服务端的请求体只有 `actions`（用 `actionsForRequest`）。
 * - 动作只包括 8 类原子动作与出题人积木 `block`；`undo / step_back / reset` 是工具栏按钮，
 *   不是积木，编译产物里不会出现（05 §3.1）。
 *
 * ## 「开始」积木与离散块（编译入口契约，05 §3.1）
 *
 * 1. 顶层积木里必须**恰好有一个**「开始」积木（`start`），程序从它沿 `next` 往下执行。
 *    一个都没有 → `MESSAGE_NO_START_BLOCK`（`blockId` 是空串：没有具体位置可指）；
 *    多于一个 → 每个「开始」积木各报一条 `MESSAGE_MULTIPLE_START_BLOCKS`。
 * 2. 「开始」积木**不许有上一个连接**：它只能出现在顶层。出现在别的积木的输入槽或 `next`
 *    链里（旧存档、手写数据、未来的错误接线）一律报 `MESSAGE_START_BLOCK_HAS_PREVIOUS`。
 *    Blockly 的积木定义也从另一边保证这点：它没有上一个连接、没有输出连接。
 * 3. 未连到「开始」积木的**离散块**既不产生动作，也**不产生错误**：它们不参与编译
 *    （05 §3.1 的"不参与编译"就是"看不见"）。学习者把积木拖到画布上还没接好时，
 *    不应该先挨一串错。
 *
 * ## 积木树形状
 *
 * - `type`：积木类型名，取值见 `BLOCK_TYPES`（出题人积木是 `author_<id>`）。
 * - `fields`：字段值（下拉、文本、数字），键见 `FIELDS`。
 * - `inputs`：输入槽 → 连在槽上的积木；键见 `INPUTS`。**语句输入**（`DO0` / `ELSE` …）
 *   连的是语句链的表头，链的其余部分沿 `next` 走；**值输入**连单个表达式积木。
 * - `next`：语句链上的下一块。值表达式没有 `next`。
 * - `bytes_concat` 用变参输入 `item0` / `item1` / `item2` …（D2 的 mutator 按序追加）。
 *
 * ## 编译期常量模型（为什么没有"读取当前状态"的积木）
 *
 * payload 从**初始状态**回放（04 §5.1），所以"读取 RSP"在提交时读到的不是调试时看见的值。
 * 允许它只会制造"试运行能过、提交就失败"的困惑；教学上更对的做法是让学习者**算出**偏移，
 * payload 只负责证明他算对了（05 §4）。因此：
 *
 * - 表达式（含变量）全部在编译期求值成常量，`vars_set` 是编译期赋值，`vars_get` 是编译期读取。
 * - `FORBIDDEN_STATE_BLOCK_TYPES` 里的类型（任何"读寄存器 / 读内存 / 读 sp"的积木）
 *   一律编译期报错，报错文案与 shared 的 `reads_state` 语义一致（07 §5 S04）。
 * - 循环靠**展开**：`controls_repeat_ext` / `controls_whileUntil` 在编译期按常量条件展开，
 *   单个循环超过 `limits.loopUnroll`（默认 256）即编译错误。
 */

// ---------------------------------------------------------------------------
// 冻结的积木类型名与槽位名
// ---------------------------------------------------------------------------

/** 「开始」积木：画布上只能有一个，程序从它往下执行（05 §3.1）。 */
export const START_BLOCK_TYPE = 'start';

/**
 * 积木类型名。编译器认的就是这些字符串；`blocks/catalog.ts` 用同一份常量生成工具箱，
 * 所以两边不会各写一套字符串（D2 定义 Blockly 积木时也必须用这里的名字）。
 */
export const BLOCK_TYPES = {
  start: 'start',
  varsSet: 'vars_set',
  varsGet: 'vars_get',
  mathNumber: 'math_number',
  mathArithmetic: 'math_arithmetic',
  logicCompare: 'logic_compare',
  valueAddr: 'value_addr',
  controlsIf: 'controls_if',
  controlsRepeat: 'controls_repeat_ext',
  controlsWhileUntil: 'controls_whileUntil',
  bytesPadding: 'bytes_padding',
  bytesString: 'bytes_string',
  bytesInt: 'bytes_int',
  bytesAddr: 'bytes_addr',
  bytesRaw: 'bytes_raw',
  bytesConcat: 'bytes_concat',
  actionWriteBytes: 'action_write_bytes',
  actionPush: 'action_push',
  actionPop: 'action_pop',
  actionCall: 'action_call',
  actionRet: 'action_ret',
  actionFeed: 'action_feed',
  actionStep: 'action_step',
  actionRun: 'action_run',
} as const;

export type BlockType = (typeof BLOCK_TYPES)[keyof typeof BLOCK_TYPES];

/** 出题人积木的类型名前缀：`author_<id>`（`id` 来自 `public.json` 的 `authorBlocks[].id`）。 */
export const AUTHOR_BLOCK_PREFIX = 'author_';

export function authorBlockType(id: string): string {
  return `${AUTHOR_BLOCK_PREFIX}${id}`;
}

/** 值输入槽名（Blockly 定义积木时的输入名必须一致）。 */
export const INPUTS = {
  value: 'VALUE',
  a: 'A',
  b: 'B',
  byte: 'BYTE',
  count: 'COUNT',
  times: 'TIMES',
  addr: 'ADDR',
  bytes: 'BYTES',
  bool: 'BOOL',
  maxSteps: 'MAXSTEPS',
  /** 循环体的语句输入（Blockly 的 `controls_repeat_ext` / `controls_whileUntil` 都叫 `DO`）。 */
  body: 'DO',
  else: 'ELSE',
  do0: 'DO0',
  do1: 'DO1',
  do2: 'DO2',
  if0: 'IF0',
  if1: 'IF1',
  if2: 'IF2',
} as const;

/** 字段名（Blockly 定义积木时的字段名必须一致）。 */
export const FIELDS = {
  num: 'NUM',
  op: 'OP',
  variable: 'VAR',
  addr: 'ADDR',
  text: 'TEXT',
  hex: 'HEX',
  width: 'WIDTH',
  endian: 'ENDIAN',
  mode: 'MODE',
} as const;

/** `bytes_concat` 的变参输入前缀：`item0`、`item1`… 按数字升序拼接。 */
export const CONCAT_ITEM_PREFIX = 'item';

/** `math_arithmetic` 的运算符字段取值。 */
export const ARITHMETIC_OPS = ['ADD', 'MINUS', 'MULTIPLY', 'DIVIDE'] as const;

/** `logic_compare` 的比较符字段取值；结果为 1（真）或 0（假）。 */
export const LOGIC_OPS = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE'] as const;

/** `controls_whileUntil` 的模式字段取值。 */
export const LOOP_MODES = ['WHILE', 'UNTIL'] as const;

// ---------------------------------------------------------------------------
// 归一化积木树
// ---------------------------------------------------------------------------

/** 字段值：Blockly 的文本 / 下拉字段给字符串，数字字段给数字。 */
export type BlockFieldValue = string | number;

/** 归一化积木：纯数据，可序列化，不含 Blockly 对象（08 §2 规则 3）。 */
export interface NormalizedBlock {
  /** Blockly 的块 id，用于把编译错误定位回画布上的积木（05 §4）。 */
  readonly id: string;
  /** 积木类型名，见 `BLOCK_TYPES`。 */
  readonly type: string;
  /** 字段值，键见 `FIELDS`。 */
  readonly fields: Readonly<Record<string, BlockFieldValue>>;
  /** 输入槽 → 连接的积木；键见 `INPUTS`，变参见 `CONCAT_ITEM_PREFIX`。 */
  readonly inputs: Readonly<Record<string, NormalizedBlock | undefined>>;
  /** 语句链上的下一块。 */
  readonly next?: NormalizedBlock;
}

/**
 * 画布内容：顶层积木链（含各自的 `next` 链）。
 * 未连到「开始」积木的积木会被编译器忽略（05 §3.1）。
 */
export interface NormalizedWorkspace {
  readonly blocks: readonly NormalizedBlock[];
}

// ---------------------------------------------------------------------------
// 编译输入输出
// ---------------------------------------------------------------------------

/** 编译产物：8 类原子动作 + 出题人积木（展开由服务端完成，03 §3）。 */
export type CompiledAction = PrimitiveAction | BlockAction;

/**
 * 动作来源：`CompileResult.actions[i]` 是由哪块积木产生的（05 §3、08 §9.2）。
 *
 * 前端用它把程序区 / 录像里的某一步跳回画布上的积木；它**不进网络 payload**。
 */
export interface ActionOrigin {
  /** 在 `CompileResult.actions` 里的下标（显式写出来，便于前端建索引时自证对齐）。 */
  readonly index: number;
  /**
   * 产生该动作的积木 id。
   * 循环展开出的每一次迭代都指向**同一个**循环积木（不是循环体里那一块）：
   * 前端点某一步时要能跳回「就是这个循环」。
   */
  readonly blockId: string;
}

/** 来源表格式版本：与产物版本不一致时按「来源未知」处理，不做猜测式定位。 */
export const ACTION_ORIGIN_VERSION = 1;

export interface CompileError {
  /** 出错积木的 id；`blockId` 可能指向「开始」积木（例如整棵树没有开始块时用空串）。 */
  readonly blockId: string;
  readonly message: string;
}

export type CompileResult =
  | {
      readonly ok: true;
      readonly actions: readonly CompiledAction[];
      /** 与 `actions` 等长、同序；`origins[i].index === i` 是不变式。 */
      readonly origins: readonly ActionOrigin[];
      readonly originsVersion: number;
    }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

/** 编译需要的公开包字段：`PublicChallenge` 结构上满足它，直接传整个公开包即可。 */
export interface CompilerChallenge {
  readonly archBits: ArchBits;
  readonly allowedActions: readonly string[];
  readonly authorBlocks?: readonly AuthorBlock[];
}

/** 编译期保证 `PublicChallenge` 可以直接当编译输入用（D4 接线时不需要造中间对象）。 */
type CompatibleChallenge<T extends CompilerChallenge> = T;
export type PublicChallengeIsCompilerChallenge = CompatibleChallenge<PublicChallenge>;

export interface CompilerLimits {
  /** 单个循环的展开次数上限（05 §4）。 */
  readonly loopUnroll: number;
  /** 表达式求值步数上限（05 §4）：整次编译累计，含循环展开中的每一次求值。 */
  readonly exprEvalSteps: number;
  /** 编译产物动作数上限：超过就无法在一次 `submit` 里发出（04 §6）。 */
  readonly actions: number;
  /** 最多报告多少条错误，避免画布全乱时刷屏。 */
  readonly errors: number;
  /** 语句访问次数兜底，防止调用方传进环状 `next` 导致死循环；正常程序远达不到。 */
  readonly statementVisits: number;
}

/** 错误条数上限：UI 只需要前几条就能定位问题。 */
export const MAX_COMPILE_ERRORS = 16;

/** 语句访问兜底：正常编译最多几千次，这里只是防退化输入的护栏。 */
export const MAX_STATEMENT_VISITS = 1_000_000;

/** 默认上限：数值来自 shared 的全局常量，不在这里另写一份（07 §2）。 */
export const DEFAULT_COMPILER_LIMITS: CompilerLimits = {
  loopUnroll: LOOP_UNROLL_LIMIT,
  exprEvalSteps: EXPR_EVAL_STEP_LIMIT,
  actions: MAX_SUBMIT_ACTIONS,
  errors: MAX_COMPILE_ERRORS,
  statementVisits: MAX_STATEMENT_VISITS,
};

export interface CompileInput {
  readonly program: NormalizedWorkspace;
  readonly challenge: CompilerChallenge;
}

/** 只给测试与极端题目用：单项覆盖上限，其余取默认值。 */
export interface CompileOptions {
  readonly limits?: Partial<CompilerLimits>;
}

/**
 * 读状态类积木的**保留类型名**：05 §4 禁止 payload 含这类构造。
 * 工具箱不会生成它们（`blocks/catalog.ts` 里根本没有），但如果树里出现（旧存档、
 * 手写数据、未来误加），编译期直接报错而不是静默当成 0（07 §5 S04）。
 */
export const FORBIDDEN_STATE_BLOCK_TYPES: readonly string[] = [
  'state_read_reg',
  'state_get_reg',
  'state_read_memory',
  'state_get_sp',
  'state_get_bp',
  'state_get_ip',
  'state_read_stdin',
];

// ---------------------------------------------------------------------------
// 编译错误文案（集中在这里，方便测试与 UI 复用）
// ---------------------------------------------------------------------------

export const MESSAGE_NO_START_BLOCK = '画布上需要一个「开始」积木，程序从它往下执行（05 §3.1）';
export const MESSAGE_MULTIPLE_START_BLOCKS =
  '画布上只能有一个「开始」积木，请把多余的删掉或连成一条链（05 §3.1）';
export const MESSAGE_START_BLOCK_HAS_PREVIOUS =
  '「开始」积木不能接在别的积木下面：它没有上一个连接，只能是画布上的顶层积木（05 §3.1）';
export const MESSAGE_READS_STATE =
  'payload 不能读取当前状态：提交时从初始状态回放，读到的不是调试时看见的值（05 §4）';
export const MESSAGE_ACTION_NOT_ALLOWED = (name: string): string =>
  `本题不允许动作 ${name}，它不在 allowedActions 里（04 §2）`;
export const MESSAGE_UNKNOWN_BLOCK = (type: string): string => `未知积木类型：${type}`;
export const MESSAGE_UNDECLARED_AUTHOR_BLOCK = (id: string): string =>
  `题目没有声明出题人积木 ${id}（03 §1）`;
