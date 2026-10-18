import type { NodeKindSpec, ParamSpec, ParamValue } from './types';
import { NODE } from './kinds';

/**
 * 控制流与变量节点（06 §4.3、§5）。
 *
 * 建模决定：
 * - **容器即语句**：`control.if` / `control.repeat` / `control.while` 自己占一个执行位置，
 *   子序列放在 `regions` 里（`then`/`else`/`body`），所以画布上不需要回边，也没有任意跳转（06 §5.3）。
 * - **容器可以有结果**：`resultType` 不是 `none` 时容器带一个数据输出，值来自各分支/每轮末尾的
 *   `control.result`；声明了结果却给不出值就是编译错误（06 §5.2「各条可能到达出口的分支必须提供
 *   同类型结果」）。
 * - **循环有下标与累计值**：`control.index` 给本轮下标（从 0 开始），`control.accumulator` 读上一轮
 *   的累计值；每轮末尾的 `control.result` 是下一轮的累计值，零次循环时结果就是初始值（06 §5.3）。
 * - **变量靠名字绑定**：声明/读取/设置都用 `name` 参数，类型写在节点上，校验器把它和声明对上。
 *   这样表单、校验、编译器读的还是同一份节点描述。
 */

const TYPE_OPTIONS = [
  { value: 'int', label: '整数' },
  { value: 'bool', label: '布尔' },
  { value: 'bytes', label: '字节' },
  { value: 'text', label: '文本' },
] as const;

/** 容器结果除四类值外还可以是「没有结果」。 */
const RESULT_TYPE_OPTIONS = [{ value: 'none', label: '没有结果' }, ...TYPE_OPTIONS] as const;

const RESULT_TYPE_PARAM: ParamSpec = {
  name: 'resultType',
  label: '结果类型',
  kind: 'select',
  default: 'none',
  options: RESULT_TYPE_OPTIONS,
  help: '选了类型后，分支/循环末尾要用「结果」节点给出同类型的值',
};

const INITIAL_PARAM: ParamSpec = {
  name: 'initial',
  label: '初始累计值',
  kind: 'text',
  default: '0',
  help: '整数用十进制或 0x 十六进制；字节用十六进制串；文本原样；布尔写 true / false',
};

const NAME_PARAM: ParamSpec = {
  name: 'name',
  label: '变量名',
  kind: 'text',
  default: 'x',
  help: '字母或下划线开头，只含字母、数字和下划线',
};

const TYPE_PARAM: ParamSpec = {
  name: 'type',
  label: '类型',
  kind: 'select',
  default: 'int',
  options: TYPE_OPTIONS,
};

/** 否则如果链的容量上限：再多就该拆成变量或模块了。 */
const MAX_ELSE_IF = 3;

export const IF: NodeKindSpec = {
  kind: NODE.if,
  label: '条件分支',
  category: 'flow',
  summary: '条件成立走「成立」，否则按「否则如果」依次判断，最后走「否则」；各条路都能带同类型结果',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [
    RESULT_TYPE_PARAM,
    {
      name: 'branches',
      label: '否则如果数量',
      kind: 'int',
      default: 0,
      min: 0,
      max: MAX_ELSE_IF,
      help: '每个「否则如果」多一个条件输入与一个区域',
    },
  ],
  dynamicInputs: (params) => {
    const ports = [{ name: 'cond', label: '条件', type: 'bool' as const, required: true }];
    for (let index = 0; index < elseIfCount(params); index += 1) {
      ports.push({ name: `cond${index + 1}`, label: `否则如果 ${index + 1}`, type: 'bool', required: true });
    }
    return ports;
  },
  dynamicOutput: (params) => (params.resultType === 'none' ? undefined : typeOf(params.resultType)),
  regions: [{ name: 'then', label: '成立' }],
  dynamicRegions: (params) => {
    const regions = [{ name: 'then', label: '成立' }];
    for (let index = 0; index < elseIfCount(params); index += 1) {
      regions.push({ name: `branch${index + 1}`, label: `否则如果 ${index + 1}` });
    }
    regions.push({ name: 'else', label: '否则' });
    return regions;
  },
};

export const REPEAT: NodeKindSpec = {
  kind: NODE.repeat,
  label: '重复 N 次',
  category: 'flow',
  summary: '按次数执行循环体，提供下标、累计值，可被跳出或继续',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [
    { name: 'count', label: '次数', kind: 'int', default: 3, min: 0, port: 'int' },
    RESULT_TYPE_PARAM,
    INITIAL_PARAM,
  ],
  dynamicOutput: (params) => (params.resultType === 'none' ? undefined : typeOf(params.resultType)),
  regions: [{ name: 'body', label: '循环体' }],
  loop: true,
};

export const WHILE: NodeKindSpec = {
  kind: NODE.while,
  label: '条件循环',
  category: 'flow',
  summary: '每轮先判断条件；可设为「当条件成立」或「直到条件成立」',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [
    {
      name: 'mode',
      label: '模式',
      kind: 'select',
      default: 'while',
      options: [
        { value: 'while', label: '当条件成立时循环' },
        { value: 'until', label: '直到条件成立' },
      ],
    },
    RESULT_TYPE_PARAM,
    INITIAL_PARAM,
  ],
  inputs: [{ name: 'cond', label: '条件', type: 'bool', required: true }],
  dynamicOutput: (params) => (params.resultType === 'none' ? undefined : typeOf(params.resultType)),
  regions: [{ name: 'body', label: '循环体' }],
  loop: true,
};

export const BREAK: NodeKindSpec = {
  kind: NODE.break,
  label: '跳出循环',
  category: 'flow',
  summary: '结束最近一层循环（循环外使用会报错）',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [],
};

export const CONTINUE: NodeKindSpec = {
  kind: NODE.continue,
  label: '继续下一轮',
  category: 'flow',
  summary: '跳过本轮剩下的语句（循环外使用会报错）',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [],
};

/** `control.result` 的 `type` 决定输入口类型；与容器声明的结果类型必须一致。 */
export const RESULT: NodeKindSpec = {
  kind: NODE.result,
  label: '结果',
  category: 'flow',
  summary: '放在分支或循环体末尾，给出这个容器/这一轮的结果',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [TYPE_PARAM],
  dynamicInputs: (params) => [
    { name: 'value', label: '结果值', type: typeOf(params.type), required: true },
  ],
};

export const INDEX: NodeKindSpec = {
  kind: NODE.index,
  label: '循环下标',
  category: 'flow',
  summary: '当前轮次的下标（从 0 开始）；只放在循环体里才有值',
  version: 1,
  stage: 'p4',
  exec: false,
  params: [],
  output: 'int',
};

export const ACCUMULATOR: NodeKindSpec = {
  kind: NODE.accumulator,
  label: '累计值',
  category: 'flow',
  summary: '本轮开始时的累计值（第一轮是循环的初始值）',
  version: 1,
  stage: 'p4',
  exec: false,
  params: [TYPE_PARAM],
  dynamicOutput: (params) => typeOf(params.type),
};

export const VAR_DECLARE: NodeKindSpec = {
  kind: NODE.varDeclare,
  label: '声明变量',
  category: 'flow',
  summary: '在当前作用域声明一个带类型和初始值的变量',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [NAME_PARAM, TYPE_PARAM, { ...INITIAL_PARAM, name: 'initial', label: '初始值' }],
};

export const VAR_GET: NodeKindSpec = {
  kind: NODE.varGet,
  label: '读取变量',
  category: 'flow',
  summary: '读当前作用域里可见的变量值',
  version: 1,
  stage: 'p4',
  exec: false,
  params: [NAME_PARAM, TYPE_PARAM],
  dynamicOutput: (params) => typeOf(params.type),
};

export const VAR_SET: NodeKindSpec = {
  kind: NODE.varSet,
  label: '设置变量',
  category: 'flow',
  summary: '按执行顺序更新一个已声明的变量',
  version: 1,
  stage: 'p4',
  exec: true,
  params: [NAME_PARAM, TYPE_PARAM],
  dynamicInputs: (params) => [
    { name: 'value', label: '新值', type: typeOf(params.type), required: true },
  ],
};

export const CONTROL_SPECS: readonly NodeKindSpec[] = [
  IF,
  REPEAT,
  WHILE,
  BREAK,
  CONTINUE,
  RESULT,
  INDEX,
  ACCUMULATOR,
  VAR_DECLARE,
  VAR_GET,
  VAR_SET,
];

/** 参数里的类型名 → 端口类型；非法值退回 `int`，真正的报错由校验器给。 */
function typeOf(raw: unknown): 'int' | 'bool' | 'bytes' | 'text' {
  return raw === 'bool' || raw === 'bytes' || raw === 'text' ? raw : 'int';
}

/** 「否则如果」数量：夹在 0..上限之间，脏数据不会把区域算爆。 */
function elseIfCount(params: Readonly<Record<string, ParamValue>>): number {
  const raw = params.branches;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_ELSE_IF, Math.trunc(value)));
}