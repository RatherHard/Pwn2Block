import { inputIdsOf, isValueNode, nodeMapOf, type CanvasDocument, type CanvasNode, type VarDeclNode } from './document';
import { evaluateCanvasNode, type CanvasEvalScope } from './evaluate';
import { fail, type CanvasResult } from './result';
import { VALUE_KIND_LABELS, valueSummary, valueTypeName, type Value } from './value';
import {
  assignedVariables,
  variableTableOf,
  type VariableTable,
} from './variables';

/**
 * 编辑期预览（需求 §7）。
 *
 * 规则只有一条：**依赖流程状态的值显示「待执行」，不猜。**
 * 纯数据表达式可以就地算出值；一旦某个变量的当前值要靠「流程赋值」或「循环索引」才能确定，
 * 它和它下游的节点都标成待执行，等用户运行后按步骤回看时再给出当时的值。
 *
 * 判据是**静态可达性**（谁依赖谁），不是「试算一次看它报不报错」：
 * 试算会在「本来能算、只是暂时读不到」时给出误导性的错误文案。
 */

export type CanvasPreviewStatus = 'value' | 'pending' | 'error';

export interface CanvasNodePreview {
  readonly status: CanvasPreviewStatus;
  readonly value?: Value;
  readonly message?: string;
}

export interface CanvasDocumentPreview {
  readonly nodes: ReadonlyMap<string, CanvasNodePreview>;
  /** 现在算不出来的数据节点：界面按「待执行」渲染。 */
  readonly pending: ReadonlySet<string>;
}

const PENDING_MESSAGE = '这个值依赖流程执行结果，运行后按步骤查看';

/** 静态判断哪些数据节点的值依赖流程状态（流程赋值、循环索引），以及它们的下游。 */
export function pendingValueNodes(document: CanvasDocument): ReadonlySet<string> {
  return pendingNodesOf(document, pendingDeclarations(document));
}

/** 一个节点的编辑期预览；`pending` 可传入已算好的集合，避免逐个节点重算。 */
export function previewCanvasNode(
  document: CanvasDocument,
  nodeId: string,
  pending: ReadonlySet<string> = pendingValueNodes(document),
): CanvasNodePreview {
  if (pending.has(nodeId)) return { status: 'pending', message: PENDING_MESSAGE };
  return toPreview(
    evaluateCanvasNode(document, nodeId, {
      scope: previewScope(document, pendingDeclarations(document)),
    }),
  );
}

/** 整张文档的预览：每个数据节点一项，供画布批量渲染。 */
export function previewCanvasDocument(document: CanvasDocument): CanvasDocumentPreview {
  const pendingDecls = pendingDeclarations(document);
  const pending = pendingNodesOf(document, pendingDecls);
  const scope = previewScope(document, pendingDecls);

  const nodes = new Map<string, CanvasNodePreview>();
  for (const node of document.nodes) {
    if (!isValueNode(node)) continue;
    nodes.set(
      node.id,
      pending.has(node.id)
        ? { status: 'pending', message: PENDING_MESSAGE }
        : toPreview(evaluateCanvasNode(document, node.id, { scope })),
    );
  }
  return { nodes, pending };
}

function toPreview(result: CanvasResult<Value>): CanvasNodePreview {
  return result.ok
    ? { status: 'value', value: result.value }
    : { status: 'error', message: result.message };
}

// ---------------------------------------------------------------------------
// 待执行的传播
// ---------------------------------------------------------------------------

/** 值要靠流程赋值才能确定的声明：被赋值过的，或绑定表达式依赖这类声明的。 */
function pendingDeclarations(document: CanvasDocument): ReadonlySet<string> {
  const table = variableTableOf(document);
  const nodes = nodeMapOf(document);
  const pending = new Set<string>(assignedVariables(document, table));

  // 不动点：绑定表达式读到待执行变量时，这个声明也跟着待执行。
  let changed = true;
  while (changed) {
    changed = false;
    for (const decl of table.declarations) {
      if (pending.has(decl.id)) continue;
      const input = decl.binding.mode === 'none' ? undefined : decl.binding.input;
      if (input === undefined) continue;
      if (dependsOnPending(nodes, input, pending, new Set())) {
        pending.add(decl.id);
        changed = true;
      }
    }
  }
  return pending;
}

/** 数据节点本身待执行：循环索引，或读到待执行变量的引用视图，或输入里有待执行的值。 */
function pendingNodesOf(
  document: CanvasDocument,
  pendingDecls: ReadonlySet<string>,
): ReadonlySet<string> {
  const pending = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of document.nodes) {
      if (pending.has(node.id)) continue;
      if (!isValueNode(node)) continue;
      if (isPendingNode(node, pendingDecls, pending)) {
        pending.add(node.id);
        changed = true;
      }
    }
  }
  return pending;
}

function isPendingNode(
  node: CanvasNode,
  pendingDecls: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): boolean {
  if (node.kind === 'loop-index') return true;
  if (node.kind === 'var-ref') return pendingDecls.has(node.decl);
  return inputIdsOf(node).some((input) => pending.has(input));
}

/** 从某个数据节点出发，是否读到待执行的声明或循环索引（传递闭包，遇到环就停）。 */
function dependsOnPending(
  nodes: ReadonlyMap<string, CanvasNode>,
  nodeId: string,
  pendingDecls: ReadonlySet<string>,
  seen: Set<string>,
): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);
  const node = nodes.get(nodeId);
  if (node === undefined) return false;
  if (node.kind === 'loop-index') return true;
  if (node.kind === 'var-ref') return pendingDecls.has(node.decl);
  return inputIdsOf(node).some((input) => dependsOnPending(nodes, input, pendingDecls, seen));
}

// ---------------------------------------------------------------------------
// 预览作用域
// ---------------------------------------------------------------------------

function previewScope(
  document: CanvasDocument,
  pendingDecls: ReadonlySet<string>,
): CanvasEvalScope {
  const table: VariableTable = variableTableOf(document);
  const memo = new Map<string, CanvasResult<Value>>();
  const reading = new Set<string>();

  const readVariable = (declId: string): CanvasResult<Value> => {
    const decl = table.byId.get(declId);
    if (decl === undefined) return fail(`变量声明 ${declId} 不存在`);
    if (pendingDecls.has(declId)) return fail(`变量「${decl.name}」依赖流程赋值，待执行`);
    const cached = memo.get(declId);
    if (cached !== undefined) return cached;
    if (reading.has(declId)) return fail(`变量「${decl.name}」的绑定绕回了自己`);
    if (decl.binding.mode === 'none') {
      return fail(`变量「${decl.name}」还没初始化：给它一个初始值，或等流程给它赋值`);
    }

    reading.add(declId);
    const evaluated = evaluateBinding(document, decl, readVariable);
    reading.delete(declId);
    const resolved: CanvasResult<Value> =
      evaluated.ok && evaluated.value.kind !== decl.type
        ? fail(
            `变量「${decl.name}」声明为${VALUE_KIND_LABELS[decl.type]}，绑定得到${valueTypeName(evaluated.value)}`,
          )
        : evaluated;
    memo.set(declId, resolved);
    return resolved;
  };

  return {
    mode: 'preview',
    readVariable,
    readLoopIndex: () => fail('循环索引要等循环执行时才有值'),
  };
}

/** 绑定表达式求值：嵌套读到别的变量时仍走同一个 `readVariable`，不需要整份作用域。 */
function evaluateBinding(
  document: CanvasDocument,
  decl: VarDeclNode,
  readVariable: (declId: string) => CanvasResult<Value>,
): CanvasResult<Value> {
  if (decl.binding.mode === 'none') return fail(`变量「${decl.name}」没有绑定表达式`);
  return evaluateCanvasNode(document, decl.binding.input, {
    scope: {
      mode: 'preview',
      readVariable,
      readLoopIndex: () => fail('循环索引要等循环执行时才有值'),
    },
  });
}

/** 便于界面显示的一行摘要：值本身，或状态原因。 */
export function previewSummary(preview: CanvasNodePreview): string {
  if (preview.status === 'pending') return preview.message ?? '待执行';
  if (preview.status === 'error') return `错误：${preview.message ?? '未知原因'}`;
  return preview.value === undefined ? '' : valueSummary(preview.value);
}
