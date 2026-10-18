/**
 * 节点画布的数据模型（06 §2、§3；07 §3「图文档」）。
 *
 * 这一层只描述**可序列化的文档**：节点、参数、数据连接、结构化执行区域、布局。
 * 它不 import 任何画布库、不碰 DOM，也不依赖求值实现——画布、编译器、存档和 Python
 * 协议都从这份定义出发，所以「表单、编译器、存档用同一份描述」（07 §P1）。
 *
 * 三条建模决定：
 * - **数据连接表达值的依赖**：`connections` 是端口到端口的边，数据从左向右流。
 * - **执行顺序用包含关系表达**：`main` 是顶层语句序列，容器节点用 `regions` 保存自己的
 *   子序列（分支/循环体）。没有任意回边，结构化循环靠区域表达（06 §5.3、§5.2）。
 * - **语义与布局分开**：`layout` 只影响显示，拖动节点不会让编译产物过期（07 §P1）。
 */

import type { ActionName } from '../actions';
import type { AuthorBlock } from '../challenge';
import type { ArchBits } from '../primitives';

/** 存档格式标识：写进文档，读的时候先认它。 */
export const WORKFLOW_FORMAT = 'pwn2block.workflow';

/** 文档格式版本。不兼容的改动必须进位，读旧版本时给出明确错误而不是猜。 */
export const WORKFLOW_VERSION = 1;

/** 端口类型（06 §6：Python 只传这四类，不传任意对象）。 */
export const PORT_TYPES = ['int', 'bool', 'bytes', 'text'] as const;
export type PortType = (typeof PORT_TYPES)[number];

/** 类型的中文名，UI 与错误文案共用。 */
export const PORT_TYPE_LABELS: Readonly<Record<PortType, string>> = {
  int: '整数',
  bool: '布尔',
  bytes: '字节',
  text: '文本',
};

/**
 * 参数的取值：整数、文本、下拉、十六进制串，以及「一组字符串」（Python 节点的命名输入）。
 * 数组只用于声明端口列表，不用于承载任意对象（06 §6）。
 */
export type ParamValue = string | number | readonly string[];

/** 节点参数表。键是参数名，见各节点定义（`catalog.ts`）。 */
export type ParamValues = Readonly<Record<string, ParamValue>>;

/** 节点在画布上的位置（语义无关，只影响显示）。 */
export interface NodeLayout {
  readonly x: number;
  readonly y: number;
  /** 容器节点折叠后只显示外壳（06 §3）。 */
  readonly collapsed?: boolean;
}

/** 一个节点：标识 + 种类 + 参数 + 容器区域。 */
export interface GraphNode {
  /** 稳定 id，存档、来源定位和错误都指向它。 */
  readonly id: string;
  /** 节点种类，取值见 `WORKFLOW_NODE_KINDS`。 */
  readonly kind: string;
  /** 参数当前值。缺省参数按节点定义补默认值，不靠"没写就是默认"的隐含约定。 */
  readonly params: ParamValues;
  /** 容器节点的子序列：区域名 → 有序语句 id（分支/循环体，见 `regions`）。 */
  readonly regions?: Readonly<Record<string, readonly string[]>>;
}

/** 数据连接：上游输出端口 → 下游输入端口。 */
export interface ConnectionEndpoint {
  readonly node: string;
  readonly port: string;
}

export interface GraphConnection {
  readonly from: ConnectionEndpoint;
  readonly to: ConnectionEndpoint;
}

/**
 * 一张图（一份用户名下的流程）。
 *
 * `main` 是顶层执行序列；容器节点（条件分支、循环）把自己的语句放在 `regions` 里，
 * 因此不需要执行边，也不会出现「任意回边」。
 */
export interface GraphDocument {
  readonly format: typeof WORKFLOW_FORMAT;
  readonly version: number;
  readonly nodes: readonly GraphNode[];
  readonly connections: readonly GraphConnection[];
  readonly main: readonly string[];
  readonly layout: Readonly<Record<string, NodeLayout>>;
}

// ---------------------------------------------------------------------------
// 诊断信息
// ---------------------------------------------------------------------------

/** 问题等级：`error` 阻止编译；`warning` 只提示（例如「未使用」）。 */
export type IssueSeverity = 'error' | 'warning';

/**
 * 问题代码。UI 按它决定图标和分组，测试按它精确断言（不比较中文文案）。
 */
export const WORKFLOW_ISSUE_CODES = [
  'unknown_kind',
  'unknown_node',
  'duplicate_id',
  'invalid_id',
  'missing_start',
  'multiple_start',
  'start_has_input',
  'unknown_port',
  'unknown_region',
  'duplicate_edge',
  'self_edge',
  'input_has_multiple_edges',
  'type_mismatch',
  'data_cycle',
  'unplaced_node',
  'duplicate_placement',
  'cross_region_reference',
  'invalid_param',
  'missing_input',
  'action_not_allowed',
  'undeclared_author_block',
  'unused_node',
  'limit_exceeded',
  'eval_failed',
  'cancelled',
  'python_unavailable',
  'python_failed',
  'result_outside_control',
  'missing_region_result',
  'region_result_type_mismatch',
  'break_outside_loop',
  'continue_outside_loop',
  'index_outside_loop',
  'undeclared_variable',
  'duplicate_variable',
  'variable_type_mismatch',
] as const;
export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

/**
 * 一条问题：定位到节点（容器内的问题再带区域路径），并给出可执行的中文说明。
 *
 * `path` 是容器路径，例如 `['if-1/then', 'repeat-2/body']`，供 UI 展开并高亮嵌套位置。
 */
export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  readonly severity: IssueSeverity;
  readonly message: string;
  /** 出问题的节点 id；整图级问题（缺少开始）用空串。 */
  readonly nodeId: string;
  /** 出问题的端口名（连线类问题）。 */
  readonly port?: string;
  /** 容器路径，由外向里。 */
  readonly path?: readonly string[];
}

// ---------------------------------------------------------------------------
// 节点目录的描述类型（工具箱、参数表单、校验器和编译器共用）
// ---------------------------------------------------------------------------

/**
 * 参数输入形态。
 *
 * `int` / `text` / `hex` 是可直接填写的值；`select` 是封闭下拉；`type` 是端口类型下拉；
 * `code` 是 Python 代码（侧栏编辑）；`portList` 是「一组 name:类型」声明；
 * `authorBlock` 是从题目声明的出题人积木里选一个。
 */
export type ParamKind =
  | 'int'
  | 'text'
  | 'hex'
  | 'select'
  | 'type'
  | 'code'
  | 'portList'
  | 'authorBlock';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** 一个参数：默认值、可输入形态，以及是否可切换成连接输入。 */
export interface ParamSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: ParamKind;
  readonly default: ParamValue;
  readonly options?: readonly SelectOption[];
  /** 可切换为连接输入时的端口类型（06 §3）。 */
  readonly port?: PortType;
  readonly min?: number;
  readonly max?: number;
  readonly help?: string;
}

/** 一个输入端口。`required` 为假表示可以不连（例如 `not` 只用 `a`）。 */
export interface InputPortSpec {
  readonly name: string;
  readonly label: string;
  readonly type: PortType;
  readonly required: boolean;
}

export interface OutputPortSpec {
  readonly name: 'out';
  readonly label: string;
  readonly type: PortType;
}

export interface NodePorts {
  readonly inputs: readonly InputPortSpec[];
  readonly output?: OutputPortSpec;
}

/** 节点分类：流程入口、数据、动作。工具箱按它分组。 */
export type NodeCategory = 'flow' | 'data' | 'action';

/** 交付阶段：与 07 的 P2 / P3 / P7 对应，工具箱按阶段开放。 */
export type NodeStage = 'p2' | 'p3' | 'p4' | 'p5' | 'p7';

/**
 * 一种节点的定义。**目录即契约**：表单、校验、编译、工具箱都从这里读，
 * 不允许各自写一份节点清单。
 */
export interface NodeKindSpec {
  readonly kind: string;
  readonly label: string;
  readonly category: NodeCategory;
  readonly summary: string;
  readonly version: number;
  readonly stage: NodeStage;
  /** 语句节点（占一个执行位置）；数据节点为假。 */
  readonly exec: boolean;
  readonly params: readonly ParamSpec[];
  /** 按 `count` 参数派生的参数（按偏移组装的 `offset0`…）。 */
  readonly paramsFromCount?: (count: number) => readonly ParamSpec[];
  /** 固定输入端口（不含由参数派生的那些）。 */
  readonly inputs?: readonly InputPortSpec[];
  /** 变参输入：`item0`…，数量由 `count` 参数决定。 */
  readonly variadicInput?: {
    readonly prefix: string;
    readonly label: string;
    readonly type: PortType;
  };
  /** 端口类型依赖参数的节点（条件选值、Python、出题人积木）。 */
  readonly dynamicInputs?: (
    params: ParamValues,
    context: {
      readonly archBits: ArchBits;
      readonly authorBlocks?: readonly AuthorBlock[];
    },
  ) => readonly InputPortSpec[];
  /** 固定输出类型。 */
  readonly output?: PortType;
  /** 输出类型由参数声明的节点（条件选值、Python）。 */
  readonly dynamicOutput?: (params: ParamValues) => PortType | undefined;
  /** 容器区域（条件分支、循环体）。 */
  readonly regions?: readonly {
    readonly name: string;
    readonly label: string;
  }[];
  /** 区域数量依赖参数的容器（否则如果链）。 */
  readonly dynamicRegions?: (params: ParamValues) => readonly {
    readonly name: string;
    readonly label: string;
  }[];
  /** 循环容器：`break`/`continue` 只能出现在它里面（06 §5.3）。 */
  readonly loop?: boolean;
  /** 动作节点要求的权限名，对应题目的 `allowedActions`。 */
  readonly action?: ActionName;
  /** 出题人积木：参数与端口由题目包声明。 */
  readonly authorBlock?: boolean;
}
