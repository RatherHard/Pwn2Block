import { NODE } from './kinds';
import { CONTROL_SPECS } from './catalog-control';
import type { ArchBits } from '../primitives';
import type { AuthorBlock } from '../challenge';
import type {
  InputPortSpec,
  NodeKindSpec,
  NodeLayout,
  NodePorts,
  OutputPortSpec,
  ParamSpec,
  ParamValue,
  ParamValues,
  PortType,
} from './types';

/**
 * 节点目录（06 §4、07 §P1）：工具箱、参数表单、校验和编译器读的是**同一份**描述。
 *
 * 为什么放在 `shared`：服务端校验存档、前端渲染表单、编译器取端口类型都需要它；
 * 三处各写一份必然漂移，而漂移的后果是把「表单允许、编译器拒绝」变成学习者的困惑。
 *
 * 目录里的节点按交付阶段标注 `stage`：`p2` 是基础题路径（填充/地址/拼接 + 动作），
 * `p3` 是补齐的数据节点，`p7` 是 Python 与定位序列工具。UI 只展示当前阶段可用的节点，
 * 但存档里出现更新阶段的节点时要给出明确提示，不能静默丢弃。
 */

// ---------------------------------------------------------------------------
// 节点种类标识（稳定字符串，存档里直接写它）
// ---------------------------------------------------------------------------

export { NODE, WORKFLOW_NODE_KINDS } from './kinds';
export type { NodeKind } from './kinds';

// ---------------------------------------------------------------------------
// 常用参数
// ---------------------------------------------------------------------------

const ENDIAN_OPTIONS = [
  { value: 'little', label: '小端（little）' },
  { value: 'big', label: '大端（big）' },
] as const;

const ARITHMETIC_OPTIONS = [
  { value: 'ADD', label: '加 +' },
  { value: 'MINUS', label: '减 −' },
  { value: 'MULTIPLY', label: '乘 ×' },
  { value: 'DIVIDE', label: '整除 ÷' },
  { value: 'MOD', label: '取余 mod' },
  { value: 'AND', label: '按位与 &' },
  { value: 'OR', label: '按位或 |' },
  { value: 'XOR', label: '按位异或 ^' },
  { value: 'SHL', label: '左移 <<' },
  { value: 'SHR', label: '右移 >>' },
] as const;

const COMPARE_OPTIONS = [
  { value: 'EQ', label: '等于 ==' },
  { value: 'NEQ', label: '不等于 !=' },
  { value: 'LT', label: '小于 <' },
  { value: 'LTE', label: '小于等于 <=' },
  { value: 'GT', label: '大于 >' },
  { value: 'GTE', label: '大于等于 >=' },
] as const;

const LOGIC_OPTIONS = [
  { value: 'AND', label: '并且 and' },
  { value: 'OR', label: '或者 or' },
  { value: 'XOR', label: '异或 xor' },
  { value: 'NOT', label: '取反 not' },
] as const;

const ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'latin1', label: 'Latin-1' },
  { value: 'ascii', label: 'ASCII' },
] as const;

const ALPHABET_OPTIONS = [
  { value: 'lower', label: '小写字母 a-z' },
  { value: 'upper', label: '大写字母 A-Z' },
  { value: 'digits', label: '数字 0-9' },
] as const;

const WIDTH_PARAM: ParamSpec = {
  name: 'width',
  label: '位宽（字节）',
  kind: 'int',
  default: 8,
  min: 1,
  max: 8,
  port: 'int',
  help: '1–8 字节；64 位地址用 8 字节',
};

const ENDIAN_PARAM: ParamSpec = {
  name: 'endian',
  label: '字节序',
  kind: 'select',
  default: 'little',
  options: ENDIAN_OPTIONS,
};

/** 填充 / 偏移类节点的变参计数：参数名固定为 `count`，派生参数与端口靠它。 */
const COUNT_PARAM: ParamSpec = {
  name: 'count',
  label: '数量',
  kind: 'int',
  default: 2,
  min: 1,
  max: 16,
};

// ---------------------------------------------------------------------------
// 节点定义
// ---------------------------------------------------------------------------

/** 单条字节填充。 */
const FILL: NodeKindSpec = {
  kind: NODE.fill,
  label: '填充字节',
  category: 'data',
  summary: '按数量重复一个字节，例如 "A"×16',
  version: 1,
  stage: 'p2',
  exec: false,
  params: [
    { name: 'byte', label: '字节', kind: 'int', default: 0x41, min: 0, max: 255, port: 'int' },
    { name: 'count', label: '次数', kind: 'int', default: 16, min: 0, port: 'int' },
  ],
  output: 'bytes',
};

const TEXT: NodeKindSpec = {
  kind: NODE.text,
  label: '文本转字节',
  category: 'data',
  summary: '按编码把文本变成字节，默认 UTF-8',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'text', label: '文本', kind: 'text', default: 'AAAA', port: 'text' },
    { name: 'encoding', label: '编码', kind: 'select', default: 'utf-8', options: ENCODING_OPTIONS },
  ],
  output: 'bytes',
};

const HEX: NodeKindSpec = {
  kind: NODE.hex,
  label: '十六进制字节',
  category: 'data',
  summary: '直接填原始字节（无前缀 hex）',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [{ name: 'hex', label: 'hex', kind: 'hex', default: '41414141', port: 'bytes' }],
  output: 'bytes',
};

const INT_BYTES: NodeKindSpec = {
  kind: NODE.int,
  label: '整数转字节',
  category: 'data',
  summary: '按位宽与字节序编码整数',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'value', label: '整数', kind: 'int', default: 0, port: 'int' },
    WIDTH_PARAM,
    ENDIAN_PARAM,
  ],
  output: 'bytes',
};

const ADDRESS: NodeKindSpec = {
  kind: NODE.address,
  label: '地址转字节',
  category: 'data',
  summary: '按题目位宽和字节序编码地址',
  version: 1,
  stage: 'p2',
  exec: false,
  params: [{ name: 'value', label: '地址', kind: 'int', default: 0, port: 'int' }],
  output: 'bytes',
};

const CONCAT: NodeKindSpec = {
  kind: NODE.concat,
  label: '拼接字节',
  category: 'data',
  summary: '按顺序组合多段字节，并显示各段偏移与长度',
  version: 1,
  stage: 'p2',
  exec: false,
  params: [COUNT_PARAM],
  variadicInput: { prefix: 'item', label: '片段', type: 'bytes' },
  output: 'bytes',
};

const ARITH: NodeKindSpec = {
  kind: NODE.arith,
  label: '整数计算',
  category: 'data',
  summary: '算术与位运算，结果仍是整数',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'op', label: '运算', kind: 'select', default: 'ADD', options: ARITHMETIC_OPTIONS },
    { name: 'a', label: '左值', kind: 'int', default: 0, port: 'int' },
    { name: 'b', label: '右值', kind: 'int', default: 0, port: 'int' },
  ],
  output: 'int',
};

const COMPARE: NodeKindSpec = {
  kind: NODE.compare,
  label: '比较数值',
  category: 'data',
  summary: '比较两个整数，结果为布尔',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'op', label: '比较', kind: 'select', default: 'EQ', options: COMPARE_OPTIONS },
    { name: 'a', label: '左值', kind: 'int', default: 0, port: 'int' },
    { name: 'b', label: '右值', kind: 'int', default: 0, port: 'int' },
  ],
  output: 'bool',
};

const LOGIC: NodeKindSpec = {
  kind: NODE.logic,
  label: '组合条件',
  category: 'data',
  summary: '用 and / or / xor / not 组合布尔条件',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [{ name: 'op', label: '逻辑', kind: 'select', default: 'AND', options: LOGIC_OPTIONS }],
  inputs: [
    { name: 'a', label: '条件 A', type: 'bool', required: true },
    { name: 'b', label: '条件 B', type: 'bool', required: false },
  ],
  output: 'bool',
};

const BYTES_TO_INT: NodeKindSpec = {
  kind: NODE.bytesToInt,
  label: '字节转整数',
  category: 'data',
  summary: '按位宽与字节序解码，长度不符时报错',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [WIDTH_PARAM, ENDIAN_PARAM],
  inputs: [{ name: 'bytes', label: '字节', type: 'bytes', required: true }],
  output: 'int',
};

const SLICE: NodeKindSpec = {
  kind: NODE.slice,
  label: '截取字节',
  category: 'data',
  summary: '按偏移与长度截取一段字节',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'offset', label: '偏移', kind: 'int', default: 0, min: 0, port: 'int' },
    { name: 'length', label: '长度', kind: 'int', default: 8, min: 0, port: 'int' },
  ],
  inputs: [{ name: 'bytes', label: '字节', type: 'bytes', required: true }],
  output: 'bytes',
};

const ASSEMBLE: NodeKindSpec = {
  kind: NODE.assemble,
  label: '按偏移组装',
  category: 'data',
  summary: '按位置放置各段，空隙用填充字节补齐，重叠时报错',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    { name: 'count', label: '段数', kind: 'int', default: 2, min: 1, max: 16 },
    { name: 'fill', label: '空隙填充', kind: 'int', default: 0x90, min: 0, max: 255 },
  ],
  /** 每段一个偏移参数：`offset0`、`offset1`…（可内填，也可接线）。 */
  paramsFromCount: (count) => offsetParams(count),
  variadicInput: { prefix: 'item', label: '段', type: 'bytes' },
  output: 'bytes',
};

const SELECT: NodeKindSpec = {
  kind: NODE.select,
  label: '条件选值',
  category: 'data',
  summary: '按条件输出两个同类型候选值之一',
  version: 1,
  stage: 'p3',
  exec: false,
  params: [
    {
      name: 'type',
      label: '候选类型',
      kind: 'type',
      default: 'bytes',
      options: [
        { value: 'bytes', label: '字节' },
        { value: 'int', label: '整数' },
        { value: 'text', label: '文本' },
        { value: 'bool', label: '布尔' },
      ],
    },
  ],
  /** 候选值的类型跟 `type` 参数走，所以端口是动态的。 */
  dynamicInputs: (params) => {
    const type = selectType(params);
    return [
      { name: 'cond', label: '条件', type: 'bool', required: true },
      { name: 'a', label: '条件成立时', type, required: true },
      { name: 'b', label: '否则', type, required: true },
    ];
  },
  dynamicOutput: (params) => selectType(params),
};

/** 定位序列：与 pwntools `cyclic` 同一语义（de Bruijn，n=4）。 */
const CYCLIC: NodeKindSpec = {
  kind: NODE.cyclic,
  label: '生成定位序列',
  category: 'data',
  summary: '生成 de Bruijn 定位序列（默认小写字母，n=4）',
  version: 1,
  stage: 'p7',
  exec: false,
  params: [
    { name: 'length', label: '长度', kind: 'int', default: 64, min: 0, port: 'int' },
    { name: 'alphabet', label: '字母表', kind: 'select', default: 'lower', options: ALPHABET_OPTIONS },
  ],
  output: 'bytes',
};

/** 查找序列偏移：与 pwntools `cyclic_find` 同一语义。 */
const FIND: NodeKindSpec = {
  kind: NODE.find,
  label: '查找序列偏移',
  category: 'data',
  summary: '在定位序列里查找这段字节的偏移，未找到时明确提示',
  version: 1,
  stage: 'p7',
  exec: false,
  params: [
    { name: 'alphabet', label: '字母表', kind: 'select', default: 'lower', options: ALPHABET_OPTIONS },
  ],
  inputs: [{ name: 'needle', label: '要找的字节', type: 'bytes', required: true }],
  output: 'int',
};

const PYTHON: NodeKindSpec = {
  kind: NODE.python,
  label: 'Python 处理',
  category: 'data',
  summary: '对显式输入执行 Python 代码，返回一个有类型的结果',
  version: 1,
  stage: 'p7',
  exec: false,
  params: [
    {
      name: 'code',
      label: '代码',
      kind: 'code',
      default: '# 输入：in0、in1…  结果：result\nresult = in0 + in1\n',
    },
    {
      name: 'outputType',
      label: '输出类型',
      kind: 'type',
      default: 'bytes',
      options: [
        { value: 'bytes', label: '字节' },
        { value: 'int', label: '整数' },
        { value: 'text', label: '文本' },
        { value: 'bool', label: '布尔' },
      ],
    },
    {
      name: 'inputs',
      label: '输入',
      kind: 'portList',
      default: [],
      help: '每行一个 name:类型，例如 a:int',
    },
  ],
  dynamicInputs: (params) => pythonInputs(params),
  dynamicOutput: (params) => asPortType(params.outputType, 'bytes'),
};

// ---------------------------------------------------------------------------
// 动作节点
// ---------------------------------------------------------------------------

const FEED: NodeKindSpec = {
  kind: NODE.feed,
  label: '输入数据',
  category: 'action',
  summary: '把字节追加到 VM 的输入队列（推进 VM 由「执行指令」「运行程序」负责）',
  version: 1,
  stage: 'p2',
  exec: true,
  params: [],
  inputs: [{ name: 'data', label: '数据', type: 'bytes', required: true }],
  action: 'feed',
};

const WRITE: NodeKindSpec = {
  kind: NODE.write,
  label: '写入内存',
  category: 'action',
  summary: '把字节写进目标地址',
  version: 1,
  stage: 'p2',
  exec: true,
  params: [{ name: 'addr', label: '目标地址', kind: 'int', default: 0, port: 'int' }],
  inputs: [{ name: 'data', label: '数据', type: 'bytes', required: true }],
  action: 'write_bytes',
};

const PUSH: NodeKindSpec = {
  kind: NODE.push,
  label: '压栈',
  category: 'action',
  summary: '把一个值压入栈',
  version: 1,
  stage: 'p3',
  exec: true,
  params: [{ name: 'value', label: '值', kind: 'int', default: 0, port: 'int' }],
  action: 'push',
};

const POP: NodeKindSpec = {
  kind: NODE.pop,
  label: '出栈',
  category: 'action',
  summary: '从栈顶弹出一个值',
  version: 1,
  stage: 'p3',
  exec: true,
  params: [],
  action: 'pop',
};

const CALL: NodeKindSpec = {
  kind: NODE.call,
  label: '调用',
  category: 'action',
  summary: '把返回地址压栈并跳到目标地址',
  version: 1,
  stage: 'p3',
  exec: true,
  params: [{ name: 'addr', label: '目标地址', kind: 'int', default: 0, port: 'int' }],
  action: 'call',
};

const RET: NodeKindSpec = {
  kind: NODE.ret,
  label: '返回',
  category: 'action',
  summary: '从栈顶弹出地址并跳过去',
  version: 1,
  stage: 'p3',
  exec: true,
  params: [],
  action: 'ret',
};

const STEP: NodeKindSpec = {
  kind: NODE.step,
  label: '执行指令',
  category: 'action',
  summary: '让 VM 执行指定数量的指令',
  version: 1,
  stage: 'p2',
  exec: true,
  params: [{ name: 'count', label: '指令数', kind: 'int', default: 1, min: 1, port: 'int' }],
  action: 'step',
};

const RUN: NodeKindSpec = {
  kind: NODE.run,
  label: '运行程序',
  category: 'action',
  summary: '让 VM 一直运行到停下或达到步数上限',
  version: 1,
  stage: 'p2',
  exec: true,
  params: [{ name: 'maxSteps', label: '最多指令数', kind: 'int', default: 10_000, min: 1, port: 'int' }],
  action: 'run',
};

const AUTHOR: NodeKindSpec = {
  kind: NODE.author,
  label: '题目专用动作',
  category: 'action',
  summary: '题目声明的出题人积木，参数与展开由题目包决定',
  version: 1,
  stage: 'p3',
  exec: true,
  /** `id` 的可选值来自题目的 `authorBlocks`，目录本身给空列表。 */
  params: [{ name: 'id', label: '积木', kind: 'authorBlock', default: '' }],
  dynamicInputs: (params, context) => authorInputs(params, context),
  action: 'block',
  authorBlock: true,
};

const START: NodeKindSpec = {
  kind: NODE.start,
  label: '开始',
  category: 'flow',
  summary: '每个流程恰好一个入口，程序从顶层序列的第一条开始',
  version: 1,
  stage: 'p2',
  exec: true,
  params: [],
};

/** 目录顺序就是工具箱顺序：先流程，再数据（由浅入深），最后动作。 */
export const NODE_SPECS: readonly NodeKindSpec[] = [
  START,
  ...CONTROL_SPECS,
  FILL,
  ADDRESS,
  CONCAT,
  TEXT,
  HEX,
  INT_BYTES,
  ARITH,
  COMPARE,
  LOGIC,
  BYTES_TO_INT,
  SLICE,
  ASSEMBLE,
  SELECT,
  CYCLIC,
  FIND,
  PYTHON,
  FEED,
  WRITE,
  PUSH,
  POP,
  CALL,
  RET,
  STEP,
  RUN,
  AUTHOR,
];

const SPECS_BY_KIND = new Map<string, NodeKindSpec>(NODE_SPECS.map((spec) => [spec.kind, spec]));

export function nodeSpec(kind: string): NodeKindSpec | undefined {
  return SPECS_BY_KIND.get(kind);
}

/** 当前交付阶段：目录里更晚阶段的节点不会出现在工具箱，但存档读入时要给出原因。 */
export const CURRENT_STAGE: NodeKindSpec['stage'] = 'p4';

const STAGE_ORDER: readonly NodeKindSpec['stage'][] = ['p2', 'p3', 'p4', 'p5', 'p7'];

export function stageAvailable(stage: NodeKindSpec['stage'], stageNow = CURRENT_STAGE): boolean {
  return STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(stageNow);
}

/** 工具箱内容：只给当前阶段可用的节点。 */
export function availableNodeSpecs(stageNow = CURRENT_STAGE): readonly NodeKindSpec[] {
  return NODE_SPECS.filter((spec) => stageAvailable(spec.stage, stageNow));
}

// ---------------------------------------------------------------------------
// 端口与参数推导
// ---------------------------------------------------------------------------

/** 端口推导需要的题目上下文：位宽、出题人积木声明。 */
export interface PortContext {
  readonly archBits: ArchBits;
  readonly authorBlocks?: readonly AuthorBlock[];
}

/** 节点全部参数定义（含按 `count` 派生的偏移参数）。 */
export function nodeParams(spec: NodeKindSpec, params: ParamValues): readonly ParamSpec[] {
  if (spec.paramsFromCount === undefined) return spec.params;
  const count = countOf(params);
  return [...spec.params, ...spec.paramsFromCount(count)];
}

/** 节点全部输入端口：可接线的参数、固定输入、变参输入、动态输入。 */
export function nodeInputs(
  spec: NodeKindSpec,
  params: ParamValues,
  context: PortContext,
): readonly InputPortSpec[] {
  const ports: InputPortSpec[] = [];
  for (const param of nodeParams(spec, params)) {
    if (param.port === undefined) continue;
    // 参数派生的端口可以**不接**：不接时用节点内填的值（06 §3），所以不算缺输入。
    ports.push({ name: param.name, label: `${param.label}（或在节点内填写）`, type: param.port, required: false });
  }
  for (const input of spec.inputs ?? []) ports.push(input);
  if (spec.variadicInput !== undefined) {
    const { prefix, label, type } = spec.variadicInput;
    for (let index = 0; index < countOf(params); index += 1) {
      ports.push({ name: `${prefix}${index}`, label: `${label} ${index + 1}`, type, required: true });
    }
  }
  for (const input of spec.dynamicInputs?.(params, context) ?? []) ports.push(input);
  return ports;
}

/** 节点输出端口（纯数据节点才有）。 */
export function nodeOutput(
  spec: NodeKindSpec,
  params: ParamValues,
): OutputPortSpec | undefined {
  const type = spec.dynamicOutput?.(params) ?? spec.output;
  return type === undefined ? undefined : { name: 'out', label: '结果', type };
}

/** 容器区域：数量可以依赖参数（否则如果链）。 */
export function nodeRegions(
  spec: NodeKindSpec,
  params: ParamValues,
): readonly { readonly name: string; readonly label: string }[] {
  return spec.dynamicRegions?.(params) ?? spec.regions ?? [];
}

/** 一次算清输入与输出端口。 */
export function nodePorts(
  spec: NodeKindSpec,
  params: ParamValues,
  context: PortContext,
): NodePorts {
  return { inputs: nodeInputs(spec, params, context), output: nodeOutput(spec, params) };
}

/** 参数默认值表：新建节点、补缺字段、UI 重置都用它。 */
export function defaultParams(spec: NodeKindSpec): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const param of spec.params) params[param.name] = param.default;
  for (const param of spec.paramsFromCount?.(countOf(params)) ?? []) params[param.name] = param.default;
  return params;
}

/** 新建节点的初始布局：由加入顺序决定（UI 会覆盖成鼠标位置）。 */
export function initialLayout(index: number): NodeLayout {
  return { x: 40 + (index % 4) * 260, y: 40 + Math.floor(index / 4) * 180 };
}

// ---------------------------------------------------------------------------
// 内部：按参数推导端口的小工具
// ---------------------------------------------------------------------------

function offsetParams(count: number): readonly ParamSpec[] {
  const params: ParamSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    params.push({
      name: `offset${index}`,
      label: `第 ${index + 1} 段偏移`,
      kind: 'int',
      default: index * 8,
      min: 0,
      port: 'int',
    });
  }
  return params;
}

/** `count` 参数的整数取值：非法时按 1 处理，真正的报错交给校验器。 */
export function countOf(params: ParamValues): number {
  const raw = params.count;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, 16);
}

function selectType(params: ParamValues): PortType {
  return asPortType(params.type, 'bytes');
}

function asPortType(raw: ParamValue | undefined, fallback: PortType): PortType {
  return raw === 'int' || raw === 'bool' || raw === 'bytes' || raw === 'text' ? raw : fallback;
}

/** Python 节点的命名输入：`name:类型` 一行一个。 */
export function pythonInputs(params: ParamValues): readonly InputPortSpec[] {
  const raw = params.inputs;
  const entries: readonly string[] = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? raw.split(/[\n,]/)
      : [];
  const ports: InputPortSpec[] = [];
  for (const entry of entries) {
    const [name, type] = entry.split(':').map((part: string) => part.trim());
    if (name === undefined || name === '' || !/^[a-z][a-z0-9_]{0,15}$/.test(name)) continue;
    ports.push({ name, label: name, type: asPortType(type, 'bytes'), required: true });
  }
  return ports;
}

/** 出题人积木的输入端口由 `authorBlocks` 声明决定；未声明时只留 `id` 参数。 */
function authorInputs(params: ParamValues, context: PortContext): readonly InputPortSpec[] {
  const id = typeof params.id === 'string' ? params.id : '';
  const block = (context.authorBlocks ?? []).find((candidate) => candidate.id === id);
  if (block === undefined) return [];
  return block.params.map((param) => ({
    name: param.name,
    label: param.name,
    type: param.type === 'bytes' ? 'bytes' : 'int',
    required: true,
  }));
}
