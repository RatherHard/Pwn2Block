import type { GraphDocument, PortContext, PortType, WorkflowIssue, WorkflowIssueCode } from '@pwn2block/shared';
import { lookupGraph, type GraphLookup } from './document';
import type { NodePreview, PreviewSegment, WorkflowContext, WorkflowValue } from './types';

/**
 * 求值上下文（06 §2、§4.1、§5）。
 *
 * 一次编译对应一个上下文：缓存、变量作用域、循环轮次、预览与预算都放在这里。
 * 把状态放在显式上下文里（而不是模块变量）才能让同一份图被并行编译、被测试反复重放。
 *
 * 缓存的键**不是节点 id**：同一个节点在循环里每轮、在分支里每个作用域都可能不同，
 * 只按 id 缓存会把第一轮的值复用到后面几轮（07 §P4 明确禁止）。`cacheKeyOf` 把
 * 作用域路径、循环轮次和变量版本拼进键里。
 */

/** 求值结果：失败原因已经记进上下文，调用方只需要一个标记。 */
export type ValueResult =
  | {
      readonly ok: true;
      readonly value: WorkflowValue;
      readonly segments?: readonly PreviewSegment[];
    }
  | { readonly ok: false };

/** 一个变量绑定：类型在声明时固定，值随「设置变量」更新。 */
export interface VarBinding {
  readonly type: PortType;
  value: WorkflowValue;
}

/** 作用域：分支、循环体各开一层；模块调用再开一层（06 §5.4）。 */
export interface Scope {
  readonly parent?: Scope;
  /** 作用域标识（区域路径），进缓存键与错误定位。 */
  readonly path: string;
  readonly vars: Map<string, VarBinding>;
}

export interface EvalContext {
  document: GraphDocument;
  readonly workflow: WorkflowContext;
  lookup: GraphLookup;
  readonly portContext: PortContext;
  /** 缓存键 → 已求出的值（含循环轮次与作用域）。 */
  readonly values: Map<string, WorkflowValue>;
  /** 节点 id → 预览（拼接/组装的分段也在这里）。 */
  readonly previews: Map<string, NodePreview>;
  /** 缓存键 → 分段信息。 */
  readonly segments: Map<string, readonly PreviewSegment[]>;
  readonly issues: WorkflowIssue[];
  /** 当前作用域（执行到哪一层）。 */
  scope: Scope;
  /** 循环节点 id → 当前轮次（从 0 开始）。 */
  readonly loops: Map<string, number>;
  /** 循环节点 id → 进入本轮时的累计值。 */
  readonly accumulators: Map<string, WorkflowValue>;
  /** 已执行完的容器节点结果（容器带数据输出时由依赖方读取）。 */
  readonly produced: Map<string, WorkflowValue>;
  steps: number;
  /** 已执行的循环轮次总数：所有嵌套循环共享（06 §5.3）。 */
  iterations: number;
  pythonCalls: number;
  failed: boolean;
  /** 变量声明/赋值次数：变化的变量会换掉缓存键。 */
  revision: number;
  /** 当前模块调用栈（`id@版本`）：检测递归、限制嵌套深度，也写进动作来源。 */
  readonly moduleStack: string[];
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
    scope: { path: 'main', vars: new Map() },
    loops: new Map(),
    accumulators: new Map(),
    produced: new Map(),
    steps: 0,
    iterations: 0,
    pythonCalls: 0,
    failed: false,
    revision: 0,
    moduleStack: [],
  };
}

/** 缓存键：节点 + 作用域 + 循环轮次 + 变量版本。 */
export function cacheKeyOf(ctx: EvalContext, nodeId: string): string {
  const loops = [...ctx.loops.entries()].map(([id, round]) => `${id}=${round}`).join(',');
  return `${nodeId}|${ctx.scope.path}|${loops}|r${ctx.revision}`;
}

/** 进入一层作用域（分支/循环体/模块）。 */
export function childScope(parent: Scope, path: string): Scope {
  return { parent, path, vars: new Map() };
}

/** 找一个可见绑定：从当前作用域往外找，返回绑定与它所在的作用域。 */
export function findVar(
  scope: Scope,
  name: string,
): { readonly scope: Scope; readonly binding: VarBinding } | undefined {
  let current: Scope | undefined = scope;
  while (current !== undefined) {
    const binding = current.vars.get(name);
    if (binding !== undefined) return { scope: current, binding };
    current = current.parent;
  }
  return undefined;
}

/** 当前作用域可见的全部变量（表单与错误提示用）。 */
export function visibleVars(scope: Scope): ReadonlyMap<string, PortType> {
  const visible = new Map<string, PortType>();
  const chain: Scope[] = [];
  let current: Scope | undefined = scope;
  while (current !== undefined) {
    chain.unshift(current);
    current = current.parent;
  }
  for (const level of chain) {
    for (const [name, binding] of level.vars) visible.set(name, binding.type);
  }
  return visible;
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
