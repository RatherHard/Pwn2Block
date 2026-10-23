import { canvas } from '@pwn2block/shared';
import type { NodeSeverity } from './view-model-types';

/**
 * 预览摘要与问题分组（需求 §7、任务规则 8）。
 *
 * 两条判断都**不在这一层重算**：预览来自 `previewCanvasDocument`，问题来自
 * `validateCanvasDocument`。这里只把结果压成「一行文字」，让盒子里的行与悬停提示能直接用。
 *
 * 待执行统一显示「待执行」而不是 `previewSummary` 的长解释：框里的行很窄，长句会被截断，
 * 完整原因交给悬停提示（渲染层可以从 `issuesByNode` 或原始预览里取）。
 */

/** 每个节点最多显示几条问题：超过的留给侧栏，框里放不下。 */
const MAX_ISSUE_LINES = 2;

export interface IssueIndex {
  readonly issuesByNode: ReadonlyMap<string, readonly string[]>;
  readonly severityOf: (nodeId: string) => NodeSeverity | undefined;
}

/** 一个预览状态的一行摘要：值、「待执行」或「错误：…」。 */
export function summaryOfPreview(preview: canvas.CanvasNodePreview): string {
  if (preview.status === 'pending') return '待执行';
  return canvas.previewSummary(preview);
}

/** nodeId → 原始预览状态；只有值节点（含变量引用、循环索引）才有条目。 */
export function buildPreviewMap(
  document: canvas.CanvasDocument,
): ReadonlyMap<string, canvas.CanvasNodePreview> {
  return canvas.previewCanvasDocument(document).nodes;
}

/** 把原始预览压成「盒子里能写的那一行」：nodeId → 摘要。 */
export function buildPreviewSummaries(
  previews: ReadonlyMap<string, canvas.CanvasNodePreview>,
): ReadonlyMap<string, string> {
  const summaries = new Map<string, string>();
  for (const [nodeId, preview] of previews) summaries.set(nodeId, summaryOfPreview(preview));
  return summaries;
}

/**
 * nodeId → 问题说明与严重度。
 *
 * 同一节点同一 code 只留第一条（两个输入都没接线时，第二条只是同一类问题），
 * 最多留两条；文档级问题（`nodeId` 为空串）不进这张表，画布上也没有可标红的盒子。
 */
export function buildIssueIndex(
  document: canvas.CanvasDocument,
  methods: readonly canvas.CanvasMethodDecl[] | undefined,
): IssueIndex {
  const issues = canvas.validateCanvasDocument(document, { methods }).issues;
  const messages = new Map<string, string[]>();
  const codes = new Map<string, Set<string>>();
  const severity = new Map<string, NodeSeverity>();

  for (const issue of issues) {
    if (issue.nodeId === '') continue;
    recordSeverity(severity, issue);
    const seenCodes = codes.get(issue.nodeId) ?? new Set<string>();
    codes.set(issue.nodeId, seenCodes);
    if (seenCodes.has(issue.code)) continue;
    seenCodes.add(issue.code);
    const lines = messages.get(issue.nodeId) ?? [];
    messages.set(issue.nodeId, lines);
    if (lines.length < MAX_ISSUE_LINES) lines.push(issue.message);
  }

  return {
    issuesByNode: messages,
    severityOf: (nodeId: string) => severity.get(nodeId),
  };
}

/** error 盖过 warning：一个节点只要有一条 error，整块就标红。 */
function recordSeverity(severity: Map<string, NodeSeverity>, issue: canvas.CanvasIssue): void {
  if (issue.severity === 'error') {
    severity.set(issue.nodeId, 'error');
    return;
  }
  if (severity.get(issue.nodeId) === undefined) severity.set(issue.nodeId, 'warning');
}
