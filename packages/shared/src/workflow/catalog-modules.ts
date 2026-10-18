import { WORKFLOW_MODULE_DEPTH_LIMIT } from '../limits';
import { NODE } from './kinds';
import type { InputPortSpec, NodeKindSpec, ParamValues, PortType } from './types';

/**
 * 模块节点（06 §7；07 §P5）。
 *
 * 两个调用节点分开，是因为它们在画布上的**位置**不同：
 * - `module.data` 是数据节点（左边进、右边出），只能出现在依赖链上；
 * - `module.call` 占执行位置，像一条语句，可以放进分支/循环体。
 *
 * 调用节点的端口由 `inputs` 参数（`name:类型` 列表）声明，编译与校验再和模块定义**逐项比对**：
 * 端口是节点的本地声明，模块定义才是唯一事实来源，两者不一致就报 `module_ports_mismatch`，
 * 不会拿其中任意一边"猜"。
 */

/** 调用节点声明输入的解析：`name:类型`，可逗号或换行分隔。 */
export function declaredInputs(params: ParamValues): readonly InputPortSpec[] {
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

function asPortType(raw: string | undefined, fallback: PortType): PortType {
  return raw === 'int' || raw === 'bool' || raw === 'bytes' || raw === 'text' ? raw : fallback;
}

/** 调用节点共用的参数：模块标识、固定版本、输出类型、声明的输入。 */
const CALL_PARAMS: NodeKindSpec['params'] = [
  {
    name: 'moduleId',
    label: '模块',
    kind: 'text',
    default: '',
    help: '模块 id；从工具箱的模块列表里选，或手工填',
  },
  { name: 'moduleVersion', label: '版本', kind: 'int', default: 1, min: 1, max: 1000 },
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
    help: '每行一个 name:类型，需与模块定义一致',
  },
];

export const MODULE_DATA: NodeKindSpec = {
  kind: NODE.moduleData,
  label: '数据模块',
  category: 'data',
  summary: `调用一个数据模块（最多嵌套 ${WORKFLOW_MODULE_DEPTH_LIMIT} 层，不能递归）`,
  version: 1,
  stage: 'p5',
  exec: false,
  params: CALL_PARAMS,
  dynamicInputs: (params) => declaredInputs(params),
  dynamicOutput: (params) => asPortType(typeof params.outputType === 'string' ? params.outputType : '', 'bytes'),
};

export const MODULE_CALL: NodeKindSpec = {
  kind: NODE.moduleCall,
  label: '流程模块',
  category: 'flow',
  summary: '执行一个流程模块：内部动作按顺序追加，可带一个数据结果',
  version: 1,
  stage: 'p5',
  exec: true,
  params: [
    ...CALL_PARAMS,
    {
      name: 'hasOutput',
      label: '带结果',
      kind: 'select',
      default: 'no',
      options: [
        { value: 'no', label: '否（只做事）' },
        { value: 'yes', label: '是（一个结果）' },
      ],
    },
  ],
  dynamicInputs: (params) => declaredInputs(params),
  dynamicOutput: (params) =>
    params.hasOutput === 'yes' ? asPortType(typeof params.outputType === 'string' ? params.outputType : '', 'bytes') : undefined,
};

/**
 * 模块内的结果出口：放在模块 `main` 最后一条，读一次就算模块的输出。
 *
 * 不在容器里的 `control.result` 只在模块体内合法；主图顶层出现它会报 `result_outside_control`。
 */
export const MODULE_RETURN: NodeKindSpec = {
  kind: NODE.moduleReturn,
  label: '模块结果',
  category: 'flow',
  summary: '模块的输出值：放在模块序列最后一条',
  version: 1,
  stage: 'p5',
  exec: true,
  params: [
    {
      name: 'valueType',
      label: '结果类型',
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
  dynamicInputs: (params) => [
    {
      name: 'value',
      label: '值',
      type: asPortType(typeof params.valueType === 'string' ? params.valueType : '', 'bytes'),
      required: true,
    },
  ],
};

export const MODULE_SPECS: readonly NodeKindSpec[] = [MODULE_DATA, MODULE_CALL, MODULE_RETURN];
