import { MAX_STEPS_PER_RUN, type AuthorBlock, type PrimitiveActionType } from '@pwn2block/shared';
import { authorBlockType } from '../compiler/types';
import { ARITHMETIC_OPS, BLOCK_TYPES, FIELDS, INPUTS, LOGIC_OPS } from '../compiler/types';

/**
 * 积木目录（05 §3.1）。
 *
 * 这里只描述"有哪些积木、长什么样"——类型名、字段名、输入槽名都取自 `compiler/types.ts`，
 * 与编译器认的字符串是同一份常量。D2 用这些描述定义真实 Blockly 积木与工具箱；
 * 详细渲染、mutator、tooltip 样式是 H01 的 D2–D3 工作。
 *
 * 目录里**没有**任何"读取当前状态"的积木（`state_read_reg` 之类）：payload 从初始状态回放，
 * 读到的不是调试时看见的值，理由见 `compiler/types.ts` 与 05 §4。
 */

export type BlockCategory = 'start' | 'generic' | 'bytes' | 'action' | 'author';

/** 值输入槽上默认挂的影子积木类型（Blockly 的 shadow，D2 定义积木时用）。 */
export const SHADOW_MATH_NUMBER = BLOCK_TYPES.mathNumber;

export interface BlockFieldSpec {
  readonly name: string;
  readonly kind: 'dropdown' | 'number' | 'text' | 'variable';
  readonly label: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string | number;
}

export interface BlockInputSpec {
  readonly name: string;
  readonly kind: 'value' | 'statement';
  readonly label: string;
  /** 值输入的影子积木类型。 */
  readonly shadow?: string;
  /**
   * 影子积木数字字段的取值（不填就用影子积木自己的默认值）。
   *
   * 为什么需要它：`step` / `run` 的输入**空着**时编译器按 04 §2 的默认值处理
   * （`step` 默认 1 条，`run` 默认跑到全局步数上限），但工具箱里挂着影子积木就永远不空，
   * 于是影子块的值就成了"默认值"。用 0 会直接撞上「步数必须在 1..10000 之间」，
   * 所以这两个输入的影子值取文档里写的默认值，而不是数字积木自己的默认 0。
   */
  readonly shadowValue?: number;
}

export interface BlockSpec {
  readonly type: string;
  /** 积木上的中文文案。 */
  readonly label: string;
  readonly category: BlockCategory;
  readonly tooltip: string;
  /** 动作积木对应的原子动作名；工具箱按 `allowedActions` 过滤时用它（04 §2）。 */
  readonly action?: PrimitiveActionType;
  readonly fields?: readonly BlockFieldSpec[];
  readonly inputs?: readonly BlockInputSpec[];
}

/** `feed` 的顺序提示：不照做就会先读到 EOF（05 §3.1）。 */
export const FEED_ORDER_TIP =
  '先喂字节再执行：把 feed 放在会触发 read 的 step / run 之前，否则程序先读到 EOF（05 §3.1）。';

/** 各分类在工具箱里的名字与配色（终端风格一套主题，05 §1）。 */
export const TOOLBOX_CATEGORY_META: Readonly<
  Record<BlockCategory, { readonly name: string; readonly colour: string }>
> = {
  start: { name: '开始', colour: '#7fb08a' },
  generic: { name: '通用', colour: '#8fa8d6' },
  bytes: { name: '字节', colour: '#d6b98f' },
  action: { name: '动作', colour: '#d69f9f' },
  author: { name: '出题人积木', colour: '#b39fd6' },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const valueInput = (
  name: string,
  label: string,
  shadow?: string,
  shadowValue?: number,
): BlockInputSpec => ({
  name,
  kind: 'value',
  label,
  ...(shadow === undefined ? {} : { shadow }),
  ...(shadowValue === undefined ? {} : { shadowValue }),
});

const statementInput = (name: string, label: string): BlockInputSpec => ({
  name,
  kind: 'statement',
  label,
});

const dropdown = (
  name: string,
  label: string,
  options: readonly (readonly [string, string])[],
  defaultValue: string,
): BlockFieldSpec => ({
  name,
  kind: 'dropdown',
  label,
  options: options.map(([value, text]) => ({ value, label: text })),
  defaultValue,
});

const numberField = (name: string, label: string, defaultValue: number): BlockFieldSpec => ({
  name,
  kind: 'number',
  label,
  defaultValue,
});

const textField = (name: string, label: string, defaultValue = ''): BlockFieldSpec => ({
  name,
  kind: 'text',
  label,
  defaultValue,
});

const variableField = (name: string, label: string): BlockFieldSpec => ({
  name,
  kind: 'variable',
  label,
});

/** 数字输入槽默认挂 `math_number` 影子块，学习者不用先拖一个数字积木。
 *  `shadowValue` 只在"空着有默认含义"的输入上给（见 `BlockInputSpec.shadowValue`）。 */
const numberInput = (name: string, label: string, shadowValue?: number): BlockInputSpec =>
  valueInput(name, label, SHADOW_MATH_NUMBER, shadowValue);

/** 运算符中文名按 `ARITHMETIC_OPS` / `LOGIC_OPS` 一一对应：契约里新增运算符时这里会编译报错。 */
const ARITHMETIC_TEXT: Readonly<Record<(typeof ARITHMETIC_OPS)[number], string>> = {
  ADD: '加',
  MINUS: '减',
  MULTIPLY: '乘',
  DIVIDE: '除',
};

const LOGIC_TEXT: Readonly<Record<(typeof LOGIC_OPS)[number], string>> = {
  EQ: '=',
  NEQ: '≠',
  LT: '<',
  LTE: '≤',
  GT: '>',
  GTE: '≥',
};

const ARITHMETIC_LABELS: readonly (readonly [string, string])[] = ARITHMETIC_OPS.map(
  (op) => [op, ARITHMETIC_TEXT[op]] as const,
);

const LOGIC_LABELS: readonly (readonly [string, string])[] = LOGIC_OPS.map(
  (op) => [op, LOGIC_TEXT[op]] as const,
);

const ENDIAN_LABELS: readonly (readonly [string, string])[] = [
  ['LITTLE', '小端'],
  ['BIG', '大端'],
];

const LOOP_MODE_LABELS: readonly (readonly [string, string])[] = [
  ['WHILE', '当条件成立时重复'],
  ['UNTIL', '直到条件成立'],
];

// ---------------------------------------------------------------------------
// 积木目录
// ---------------------------------------------------------------------------

export const BLOCK_SPECS: readonly BlockSpec[] = [
  {
    type: BLOCK_TYPES.start,
    label: '开始',
    category: 'start',
    tooltip: '程序从这里往下执行。画布上只能有一个开始积木，没连到它的积木不参与编译（05 §3.1）。',
  },

  // --- 通用 ---------------------------------------------------------------
  {
    type: BLOCK_TYPES.varsSet,
    label: '把变量设为',
    category: 'generic',
    tooltip: '变量在编译期求值：payload 从初始状态回放，运行期没有可读的变量（05 §4）。',
    fields: [variableField(FIELDS.variable, '变量')],
    inputs: [valueInput(INPUTS.value, '值', SHADOW_MATH_NUMBER)],
  },
  {
    type: BLOCK_TYPES.varsGet,
    label: '变量',
    category: 'generic',
    tooltip: '读取前面用「把变量设为」赋过的值；没赋过值就报编译错误。',
    fields: [variableField(FIELDS.variable, '变量')],
  },
  {
    type: BLOCK_TYPES.mathNumber,
    label: '数字',
    category: 'generic',
    tooltip: '整数常量。地址与偏移都应该是你算出来的字面值。',
    fields: [numberField(FIELDS.num, '数值', 0)],
  },
  {
    type: BLOCK_TYPES.mathArithmetic,
    label: '算术',
    category: 'generic',
    tooltip: '加减乘除，编译期算完；除数为 0 会报编译错误。',
    fields: [dropdown(FIELDS.op, '运算符', ARITHMETIC_LABELS, 'ADD')],
    inputs: [numberInput(INPUTS.a, '左'), numberInput(INPUTS.b, '右')],
  },
  {
    type: BLOCK_TYPES.logicCompare,
    label: '比较',
    category: 'generic',
    tooltip: '编译期比较，成立为 1、不成立为 0，用作条件或循环条件。',
    fields: [dropdown(FIELDS.op, '比较', LOGIC_LABELS, 'EQ')],
    inputs: [numberInput(INPUTS.a, '左'), numberInput(INPUTS.b, '右')],
  },
  {
    type: BLOCK_TYPES.controlsIf,
    label: '如果',
    category: 'generic',
    tooltip: '条件在编译期求值，只有命中的分支会被编译进去（05 §4）。',
    inputs: [
      numberInput(INPUTS.if0, '条件'),
      statementInput(INPUTS.do0, '那么'),
      valueInput(INPUTS.if1, '否则如果', SHADOW_MATH_NUMBER),
      statementInput(INPUTS.do1, '那么'),
      valueInput(INPUTS.if2, '否则如果', SHADOW_MATH_NUMBER),
      statementInput(INPUTS.do2, '那么'),
      statementInput(INPUTS.else, '否则'),
    ],
  },
  {
    type: BLOCK_TYPES.controlsRepeat,
    label: '重复次数',
    category: 'generic',
    tooltip: '循环在编译期展开，次数上限 256（05 §4）。',
    inputs: [numberInput(INPUTS.times, '次数'), statementInput(INPUTS.body, '执行')],
  },
  {
    type: BLOCK_TYPES.controlsWhileUntil,
    label: '循环',
    category: 'generic',
    tooltip: '条件在编译期求值，循环在编译期展开，上限 256 次（05 §4）。',
    fields: [dropdown(FIELDS.mode, '模式', LOOP_MODE_LABELS, 'WHILE')],
    inputs: [numberInput(INPUTS.bool, '条件'), statementInput(INPUTS.body, '执行')],
  },

  // --- 字节 ---------------------------------------------------------------
  {
    type: BLOCK_TYPES.bytesPadding,
    label: 'padding(byte, n)',
    category: 'bytes',
    tooltip: 'n 个重复字节：padding(0x41, 16) 就是 16 个 A。',
    inputs: [numberInput(INPUTS.byte, '字节'), numberInput(INPUTS.count, '个数')],
  },
  {
    type: BLOCK_TYPES.bytesString,
    label: 'string(s)',
    category: 'bytes',
    tooltip: '字符串按 UTF-8 编码成字节。',
    fields: [textField(FIELDS.text, '字符串')],
  },
  {
    type: BLOCK_TYPES.bytesInt,
    label: 'int(v, width, endian)',
    category: 'bytes',
    tooltip: '定宽整数：默认小端、宽度 W（一个字）。小端序是本题的核心考点。',
    fields: [numberField(FIELDS.width, '宽度(字节)', 8), dropdown(FIELDS.endian, '端序', ENDIAN_LABELS, 'LITTLE')],
    inputs: [numberInput(INPUTS.value, '数值')],
  },
  {
    type: BLOCK_TYPES.bytesAddr,
    label: 'addr(v)',
    category: 'bytes',
    tooltip: '等价于 int(v, W, little)：把地址按小端序写进 payload。',
    inputs: [numberInput(INPUTS.value, '地址')],
  },
  {
    type: BLOCK_TYPES.bytesRaw,
    label: 'raw(hex)',
    category: 'bytes',
    tooltip: '原始 hex 字节，偶数个十六进制字符，不带 0x 前缀。',
    fields: [textField(FIELDS.hex, 'hex')],
  },
  {
    type: BLOCK_TYPES.bytesConcat,
    label: 'concat(…)',
    category: 'bytes',
    tooltip: '按顺序拼接字节片段；D2 的 mutator 会按 item0 / item1 / … 追加输入槽。',
    inputs: [valueInput('item0', '片段 1'), valueInput('item1', '片段 2')],
  },

  // --- 动作 ---------------------------------------------------------------
  {
    type: BLOCK_TYPES.actionWriteBytes,
    label: 'write_bytes(addr, bytes)',
    category: 'action',
    action: 'write_bytes',
    tooltip: '往指定地址写字节。地址段必须落在已映射、非隐藏、可写的区域（04 §2）。',
    inputs: [valueInput(INPUTS.addr, '地址'), valueInput(INPUTS.bytes, '字节')],
  },
  {
    type: BLOCK_TYPES.actionPush,
    label: 'push(value)',
    category: 'action',
    action: 'push',
    tooltip: '把一个字压栈：栈指针会减小一个 W。',
    inputs: [numberInput(INPUTS.value, '值')],
  },
  {
    type: BLOCK_TYPES.actionPop,
    label: 'pop()',
    category: 'action',
    action: 'pop',
    tooltip: '从栈顶弹出一个字：栈指针增加一个 W，读到的栈槽必须可读（04 §2）。',
  },
  {
    type: BLOCK_TYPES.actionCall,
    label: 'call(addr)',
    category: 'action',
    action: 'call',
    tooltip: '直接操纵栈与 ip 跳到地址，不执行指令（04 §2）。',
    inputs: [valueInput(INPUTS.addr, '地址')],
  },
  {
    type: BLOCK_TYPES.actionRet,
    label: 'ret()',
    category: 'action',
    action: 'ret',
    tooltip: '从栈上取返回地址并跳过去：return address 就是这样被劫持的（04 §2）。',
  },
  {
    type: BLOCK_TYPES.actionFeed,
    label: 'feed(bytes)',
    category: 'action',
    action: 'feed',
    tooltip: FEED_ORDER_TIP,
    inputs: [valueInput(INPUTS.bytes, '字节')],
  },
  {
    type: BLOCK_TYPES.actionStep,
    label: 'step(count)',
    category: 'action',
    action: 'step',
    tooltip: '执行 count 条指令，默认 1 条（04 §2）。',
    // 影子值 = 文档里的默认值 1：挂了影子块就永远不空，用 0 会撞上「步数必须在 1..10000 之间」。
    inputs: [numberInput(INPUTS.count, '步数', 1)],
  },
  {
    type: BLOCK_TYPES.actionRun,
    label: 'run(maxSteps)',
    category: 'action',
    action: 'run',
    tooltip: '连续执行到程序退出、异常或达到步数上限（04 §2）。',
    // 影子值取「单次运行的全局上限」：`run` 省略 `maxSteps` 就是跑到上限，显式写出同一个数
    // 在语义上等价（程序退出/异常都会提前停），但让画布上的输入不像"漏填"。
    inputs: [numberInput(INPUTS.maxSteps, '最大步数', MAX_STEPS_PER_RUN)],
  },
];

// ---------------------------------------------------------------------------
// 按题目生成
// ---------------------------------------------------------------------------

/** 出题人积木的积木描述：类型名 `author_<id>`，输入槽名就是参数名（与编译器一致）。 */
export function authorBlockSpec(block: AuthorBlock): BlockSpec {
  return {
    type: authorBlockType(block.id),
    label: block.label,
    category: 'author',
    tooltip: block.tooltip ?? `${block.label}（出题人积木，动作由服务端展开，03 §3）`,
    inputs: block.params.map((param) => valueInput(param.name, `${param.name}（${param.type}）`)),
  };
}

/** 本题可见的积木：动作按 `allowedActions` 过滤，出题人积木按 `authorBlocks` 动态生成（05 §3.1）。 */
export function blocksForChallenge(challenge: {
  readonly allowedActions: readonly string[];
  readonly authorBlocks?: readonly AuthorBlock[];
}): readonly BlockSpec[] {
  const allowed = new Set(challenge.allowedActions);
  const staticSpecs = BLOCK_SPECS.filter(
    (spec) => spec.action === undefined || allowed.has(spec.action),
  );
  const authorSpecs = (challenge.authorBlocks ?? []).map(authorBlockSpec);
  return [...staticSpecs, ...authorSpecs];
}

/** 动作积木里被本题禁用、因而不会出现在工具箱里的动作名。 */
export function disabledActionTypes(challenge: {
  readonly allowedActions: readonly string[];
}): readonly PrimitiveActionType[] {
  const allowed = new Set(challenge.allowedActions);
  const disabled: PrimitiveActionType[] = [];
  for (const spec of BLOCK_SPECS) {
    if (spec.action !== undefined && !allowed.has(spec.action)) disabled.push(spec.action);
  }
  return disabled;
}
