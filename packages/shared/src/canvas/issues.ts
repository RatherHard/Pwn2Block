/**
 * 新版画布的问题代码（需求 §7「结构错误与类型错误阻止生成」）。
 *
 * 界面按代码分组与定位，测试按代码精确断言，不比较中文文案；文案只负责给人看。
 * 代码集合是封闭的：新增能力时先在这里加代码，再让校验器/求值器使用。
 */
export const CANVAS_ISSUE_CODES = [
  /** 引用了不存在的节点 id。 */
  'unknown_node',
  /** 节点种类不在新版目录里（例如旧存档的 `data.*`）。 */
  'unknown_kind',
  /** 同一份文档里出现重复节点 id。 */
  'duplicate_id',
  /** 节点 id 不符合 `CANVAS_NODE_ID_RE`。 */
  'invalid_id',
  /** 节点直接或间接引用自己。 */
  'self_reference',
  /** 数据引用成环。 */
  'input_cycle',
  /** 静态类型不匹配（不可隐式转换）。 */
  'type_mismatch',
  /** 组合没有任何成员，给不出整体结果。 */
  'group_empty',
  /** 合并为串的组合里成员类型不一致。 */
  'group_mode_conflict',
  /** 字典出现重复键。 */
  'dict_duplicate_key',
  /** 转换不接受该输入（例如字典不参与转换）。 */
  'conversion_unsupported',
  /** 字面值的编码不合法。 */
  'invalid_value',
  /** 求值失败（除零、越界、非法编码、步长为 0 等）。 */
  'eval_failed',
  /** 超出容量或预算上限。 */
  'limit_exceeded',
  /** 一个节点被多个组合占有。 */
  'ownership_conflict',
] as const;

export type CanvasIssueCode = (typeof CANVAS_ISSUE_CODES)[number];

export type CanvasIssueSeverity = 'error' | 'warning';

/** 一条问题：定位到节点 id，附一条可执行的中文说明。 */
export interface CanvasIssue {
  readonly code: CanvasIssueCode;
  readonly severity: CanvasIssueSeverity;
  readonly message: string;
  readonly nodeId: string;
}

export function errorIssue(code: CanvasIssueCode, nodeId: string, message: string): CanvasIssue {
  return { code, severity: 'error', message, nodeId };
}

/** 按「代码 + 节点 + 文案」去重：同一个坏节点被多处引用时只报一次。 */
export function dedupeIssues(issues: readonly CanvasIssue[]): readonly CanvasIssue[] {
  const seen = new Set<string>();
  const out: CanvasIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.nodeId}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}
