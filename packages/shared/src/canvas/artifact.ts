/**
 * 画布**产物**契约里沿用到新版画布的两组类型：端口类型与编译问题。
 *
 * 来源：`shared/src/workflow/types.ts`（旧画布已整体删除，搬来的是原文，不是重写）。
 * 为什么必须搬：这两组不属于图文档，而属于编译产物——
 * - `PortType` 是预览标签的取值域（web 的 `canvas/artifact.ts` 里
 *   `PreviewType = PortType | 'canvas'`），界面的端口形状与配色表以它为键；
 * - `WorkflowIssue` 是「代码 + 等级 + 文案 + 节点 id」的统一定位结构，新画布的编译失败与
 *   警告仍用它承载，`web/src/canvas/compile.ts` 的问题代码映射表以
 *   `WorkflowIssue['code']` 的字面量为值。
 *
 * 成员**一个不改**：删掉任一问题代码，上表就会编译不过；这张表约定等 web 侧产物模块改名
 * 时一起收敛。命名保留 `Workflow*` 也是同一个原因（web 的产物模块还叫这个名字）。
 *
 * 它与新画布自己的 `CanvasIssue`（`canvas/issues.ts`）并存：后者是校验器与求值器的内部
 * 诊断，前者是对外（界面、网络、回放）共用的产物形状。
 */

/**
 * 端口类型（06 §6：只传这四类，不传任意对象）。
 *
 * 新版画布把值放宽到列表与字典，但这四类仍是**产物预览**的标注口径。
 */
export const PORT_TYPES = ['int', 'bool', 'bytes', 'text'] as const;

export type PortType = (typeof PORT_TYPES)[number];

/** 类型的中文名，UI 与错误文案共用。 */
export const PORT_TYPE_LABELS: Readonly<Record<PortType, string>> = {
  int: '整数',
  bool: '布尔',
  bytes: '字节',
  text: '文本',
};

/** 问题等级：`error` 阻止编译；`warning` 只提示（例如「未使用」）。 */
export type IssueSeverity = 'error' | 'warning';

/**
 * 问题代码。UI 按它决定图标和分组，测试按它精确断言（不比较中文文案）。
 *
 * 取值里大部分只对旧画布有意义（`module_*`、`break_outside_loop` 之类），保留下来的理由
 * 是**不破坏产物问题的类型兼容**：新画布目前只用到其中一部分，收敛要等 web 侧一起改。
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
  'result_outside_control',
  'missing_region_result',
  'region_result_type_mismatch',
  'break_outside_loop',
  'continue_outside_loop',
  'index_outside_loop',
  'undeclared_variable',
  'duplicate_variable',
  'variable_type_mismatch',
  'port_mode_conflict',
  'module_missing',
  'module_duplicate',
  'module_kind_mismatch',
  'module_ports_mismatch',
  'module_recursion',
  'module_depth',
  'module_has_action',
] as const;

export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

/**
 * 一条问题：定位到节点（容器内的问题再带区域路径），并给出可执行的中文说明。
 *
 * `path` 是容器路径，例如 `['if-1/then', 'repeat-2/body']`，供 UI 展开并高亮嵌套位置。
 * 新版画布只有一条顶层序列，所以它通常不带 `path`；字段保留是为了形状不变。
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
