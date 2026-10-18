import type { GraphDocument, PortContext, WorkflowIssue, WorkflowIssueCode } from '@pwn2block/shared';
import { lookupGraph, type GraphLookup } from './document';
import type { NodePreview, PreviewSegment, WorkflowContext, WorkflowValue } from './types';

/**
 * 求值上下文（06 §2、§4.1）。
 *
 * 一次编译对应一个上下文：里面缓存已求出的值、预览与累计步数。把状态放在显式上下文里
 * （而不是模块变量）才能让同一份图被并行编译、被测试反复重放。
 */

/** 求值结果：失败原因已经记进上下文，调用方只需要一个标记。 */
export type ValueResult =
  | {
      readonly ok: true;
      readonly value: WorkflowValue;
      readonly segments?: readonly PreviewSegment[];
    }
  | { readonly ok: false };

export interface EvalContext {
  readonly document: GraphDocument;
  readonly workflow: WorkflowContext;
  readonly lookup: GraphLookup;
  readonly portContext: PortContext;
  /** 节点 id → 已求出的值。 */
  readonly values: Map<string, WorkflowValue>;
  /** 节点 id → 预览（拼接/组装的分段也在这里）。 */
  readonly previews: Map<string, NodePreview>;
  /** 已产生的数据节点分段信息（预览用）。 */
  readonly segments: Map<string, readonly PreviewSegment[]>;
  readonly issues: WorkflowIssue[];
  steps: number;
  pythonCalls: number;
  failed: boolean;
}

export function createEvalContext(
  document: GraphDocument,
  workflow: WorkflowContext,
  lookup: GraphLookup = lookupGraph(document),
): EvalContext {
  return {
    document,
    workflow,
    lookup,
    portContext: { archBits: workflow.archBits, authorBlocks: workflow.authorBlocks },
    values: new Map(),
    previews: new Map(),
    segments: new Map(),
    issues: [],
    steps: 0,
    pythonCalls: 0,
    failed: false,
  };
}

export function report(
  ctx: EvalContext,
  code: WorkflowIssueCode,
  nodeId: string,
  message: string,
): ValueResult {
  ctx.failed = true;
  ctx.issues.push({ code, severity: 'error', message, nodeId });
  return { ok: false };
}
