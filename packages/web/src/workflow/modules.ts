import { NODE, WORKFLOW_MODULE_DEPTH_LIMIT, nodeSpec } from '@pwn2block/shared';
import type {
  GraphDocument,
  GraphModule,
  GraphNode,
  InputPortSpec,
  NodeKindSpec,
  PortType,
} from '@pwn2block/shared';
import { childScope, report, type EvalContext, type Scope } from './context';
import { lookupGraph, paramsOf, type GraphLookup } from './document';
import { evalNodeValue, resolveInput } from './evaluate';
import { inlineValue } from './params';
import type { ControlDeps } from './control';
import type { ValueResult } from './context';
import type { WorkflowValue } from './types';

/**
 * 模块运行（06 §7；07 §P5）。
 *
 * 模块调用是**展开**而不是跳到另一张图：绑好输入后，把模块体的语句插进当前执行流，
 * 动作与来源照常生成。这样运行时不需要新的指令，VM 也永远看不到「模块」这个概念。
 *
 * 三条硬约束：
 * - 版本固定：调用节点带 `moduleVersion`，定义升级不会改掉已有实例；
 * - 不递归：调用栈里出现同一个模块就报 `module_recursion`，深度超过
 *   `WORKFLOW_MODULE_DEPTH_LIMIT` 报 `module_depth`；
 * - 状态隔离：模块体有独立作用域与求值缓存，两次调用互不污染，预算（步数、轮次、Python 次数）
 *   仍与主图共享，避免用模块把额度翻倍。
 */

/** 调用节点与定义一致时的绑定结果。 */
export interface ModuleBinding {
  readonly module: GraphModule;
  readonly values: ReadonlyMap<string, WorkflowValue>;
}

export function moduleDocument(module: GraphModule): GraphDocument {
  return {
    format: 'pwn2block.workflow',
    version: 1,
    nodes: module.nodes,
    connections: module.connections,
    main: module.main,
    layout: module.layout,
  };
}

export function findModule(document: GraphDocument, id: string, version: number): GraphModule | undefined {
  return document.modules?.find((candidate) => candidate.id === id && candidate.version === version);
}

export function moduleInputPorts(module: GraphModule): readonly InputPortSpec[] {
  return module.inputs.map((input) => ({
    name: input.name,
    label: input.name,
    type: input.type,
    required: input.default === undefined,
  }));
}

/** 模块相关参数：id、固定版本；调用节点还可能有输出类型。 */
export function moduleRefOf(node: GraphNode): { id: string; version: number } {
  return {
    id: typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '',
    version: typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1,
  };
}

/**
 * 校验并绑定模块：找到定义、检查种类与深度、按端口求输入值。
 *
 * 返回 `ModuleBinding` 或已写入 `ctx.issues` 的失败；调用方负责跑模块体与恢复状态。
 */
export async function bindModule(
  ctx: EvalContext,
  node: GraphNode,
  expected: 'data' | 'flow',
): Promise<ModuleBinding | undefined> {
  const ref = moduleRefOf(node);
  if (ref.id === '') {
    return fail(ctx, node, 'module_missing', '模块调用没有选择模块：检查「模块」参数');
  }
  const all = ctx.document.modules ?? [];
  if (!all.some((candidate) => candidate.id === ref.id)) {
    return fail(ctx, node, 'module_missing', `找不到模块 ${ref.id}：它可能已被删除`);
  }
  const module = findModule(ctx.document, ref.id, ref.version);
  if (module === undefined) {
    return fail(
      ctx,
      node,
      'module_missing',
      `模块 ${ref.id} 没有版本 ${ref.version}：在模块列表里显式升级这个调用`,
    );
  }
  if (module.kind !== expected) {
    const wanted = expected === 'data' ? '数据模块' : '流程模块';
    return fail(ctx, node, 'module_kind_mismatch', `${ref.id} 是${module.kind === 'data' ? '数据' : '流程'}模块，不是${wanted}`);
  }
  const key = `${module.id}@${module.version}`;
  if (ctx.moduleStack.includes(key)) {
    return fail(ctx, node, 'module_recursion', `模块 ${ref.id} 递归调用了自己：模块不支持递归`);
  }
  if (ctx.moduleStack.length >= WORKFLOW_MODULE_DEPTH_LIMIT) {
    return fail(
      ctx,
      node,
      'module_depth',
      `模块嵌套超过 ${WORKFLOW_MODULE_DEPTH_LIMIT} 层（06 §7），把调用链拆短一些`,
    );
  }

  const declared = new Map(moduleInputPorts(module).map((port) => [port.name, port]));
  const values = new Map<string, WorkflowValue>();
  for (const port of declaredInputsOf(node)) {
    const definition = declared.get(port.name);
    if (definition === undefined) {
      return fail(ctx, node, 'module_ports_mismatch', `模块 ${ref.id} 没有输入 ${port.name}`);
    }
    const value = await resolveCallInput(ctx, node, port, definition.type);
    if (value === undefined) return undefined;
    values.set(port.name, value);
  }
  for (const port of declared.values()) {
    if (!values.has(port.name) && port.required) {
      return fail(ctx, node, 'module_ports_mismatch', `模块 ${ref.id} 的输入 ${port.name} 没有接线`);
    }
  }
  return { module, values };
}

/** ≤50 行的入口：数据模块求值（供 `evaluate.ts` 调用）。 */
export async function evalDataModule(ctx: EvalContext, node: GraphNode): Promise<ValueResult> {
  const binding = await bindModule(ctx, node, 'data');
  if (binding === undefined) return { ok: false };
  const value = await runDataModule(ctx, node, binding);
  return value === undefined ? { ok: false } : { ok: true, value };
}

/** ≤50 行的入口：流程模块执行（供 `compile.ts` 调用）。 */
export async function execFlowModule(
  ctx: EvalContext,
  node: GraphNode,
  path: readonly string[],
  deps: ControlDeps,
): Promise<WorkflowValue | undefined> {
  const binding = await bindModule(ctx, node, 'flow');
  if (binding === undefined) return undefined;
  const saved = enterModule(ctx, binding);
  try {
    const signal = await deps.execSequence(binding.module.main, path);
    if (signal !== undefined) {
      return fail(ctx, node, 'eval_failed', `模块 ${binding.module.id} 里不能在顶层使用「${signal}」`);
    }
    const output = binding.module.output;
    if (output === undefined) return undefined;
    const value = producedReturn(ctx, binding.module);
    if (value === undefined) {
      return fail(ctx, node, 'module_missing', `模块 ${binding.module.id} 没有执行「模块结果」`);
    }
    if (value.kind !== output.type) {
      return fail(
        ctx,
        node,
        'module_ports_mismatch',
        `模块 ${binding.module.id} 声明的结果是${output.type}，实际产出${value.kind}`,
      );
    }
    return value;
  } finally {
    exitModule(ctx, saved);
  }
}

interface SavedState {
  readonly document: GraphDocument;
  readonly lookup: GraphLookup;
  readonly scope: Scope;
  readonly values: EvalContext['values'];
  readonly produced: EvalContext['produced'];
  readonly loops: EvalContext['loops'];
  readonly accumulators: EvalContext['accumulators'];
  readonly segments: EvalContext['segments'];
}

/** 进入模块：换文档、换作用域、清掉求值缓存；预算是共享的，不重置。 */
export function enterModule(ctx: EvalContext, binding: ModuleBinding): SavedState {
  const saved: SavedState = {
    document: ctx.document,
    lookup: ctx.lookup,
    scope: ctx.scope,
    values: ctx.values,
    produced: ctx.produced,
    loops: ctx.loops,
    accumulators: ctx.accumulators,
    segments: ctx.segments,
  };
  ctx.document = moduleDocument(binding.module);
  ctx.lookup = lookupGraph(ctx.document);
  ctx.values.clear();
  ctx.produced.clear();
  ctx.loops.clear();
  ctx.accumulators.clear();
  ctx.segments.clear();
  ctx.scope = childScope(
    ctx.scope,
    `module:${binding.module.id}@${binding.module.version}`,
  );
  for (const [name, value] of binding.values) {
    ctx.scope.vars.set(name, { type: valueToType(value), value });
  }
  ctx.moduleStack.push(`${binding.module.id}@${binding.module.version}`);
  return saved;
}

export function exitModule(ctx: EvalContext, saved: SavedState): void {
  ctx.moduleStack.pop();
  ctx.document = saved.document;
  ctx.lookup = saved.lookup;
  ctx.scope = saved.scope;
  ctx.values.clear();
  ctx.produced.clear();
  ctx.loops.clear();
  ctx.accumulators.clear();
  ctx.segments.clear();
}

/** 数据模块的求值：只允许数据节点（校验期已拦动作/控制），最后一条是「模块结果」。 */
async function runDataModule(
  ctx: EvalContext,
  node: GraphNode,
  binding: ModuleBinding,
): Promise<WorkflowValue | undefined> {
  const saved = enterModule(ctx, binding);
  try {
    for (const id of binding.module.main) {
      const statement = ctx.lookup.nodes.get(id);
      if (statement === undefined) {
        return fail(ctx, node, 'unknown_node', `模块 ${binding.module.id} 引用了不存在的节点 ${id}`);
      }
      if (statement.kind === NODE.moduleReturn) {
        return await readReturn(ctx, node, binding.module, statement);
      }
      const spec = nodeSpec(statement.kind);
      if (spec === undefined) {
        return fail(ctx, node, 'unknown_kind', `模块 ${binding.module.id} 里有未知节点 ${statement.kind}`);
      }
      if (spec.exec) {
        return fail(
          ctx,
          node,
          'module_has_action',
          `数据模块 ${binding.module.id} 里不能放「${spec.label}」：数据模块只做计算`,
        );
      }
      const result = await evalNodeValue(ctx, id);
      if (!result.ok) return undefined;
    }
    return fail(ctx, node, 'module_missing', `数据模块 ${binding.module.id} 缺少「模块结果」`);
  } finally {
    exitModule(ctx, saved);
  }
}

async function readReturn(
  ctx: EvalContext,
  call: GraphNode,
  module: GraphModule,
  statement: GraphNode,
): Promise<WorkflowValue | undefined> {
  const output = module.output;
  if (output === undefined) {
    return fail(ctx, call, 'module_ports_mismatch', `数据模块 ${module.id} 没有声明结果`);
  }
  const spec = nodeSpec(NODE.moduleReturn);
  if (spec === undefined) return fail(ctx, call, 'unknown_kind', '模块结果节点没有定义');
  const value = await resolveInput(ctx, statement, spec, 'value');
  if (!value.ok) return undefined;
  if (value.value.kind !== output.type) {
    return fail(
      ctx,
      call,
      'module_ports_mismatch',
      `模块 ${module.id} 的结果声明为${output.type}，实际是${value.value.kind}`,
    );
  }
  return value.value;
}

function producedReturn(ctx: EvalContext, module: GraphModule): WorkflowValue | undefined {
  const last = module.main[module.main.length - 1];
  return last === undefined ? undefined : ctx.produced.get(last);
}

function declaredInputsOf(node: GraphNode): readonly InputPortSpec[] {
  const spec = nodeSpec(node.kind);
  if (spec === undefined) return [];
  if (spec.dynamicInputs !== undefined) return spec.dynamicInputs(paramsOf(node, spec), { archBits: 64 });
  return spec.inputs ?? [];
}

/** 调用的输入：优先连线的值，其次模块声明的默认值。 */
async function resolveCallInput(
  ctx: EvalContext,
  node: GraphNode,
  port: InputPortSpec,
  type: PortType,
): Promise<WorkflowValue | undefined> {
  const hasEdge = ctx.lookup.incoming.has(`${node.id}\u0000${port.name}`);
  if (!hasEdge) {
    const module = findModuleRef(ctx.document, node);
    const declared = module?.inputs.find((input) => input.name === port.name);
    if (declared?.default !== undefined) {
      const inline = inlineValue(declared.default, type);
      if (!inline.ok) {
        fail(ctx, node, 'invalid_param', `模块输入 ${port.name} 的默认值不对：${inline.message}`);
        return undefined;
      }
      return inline.value;
    }
  }
  const result = await resolveInput(ctx, node, nodeSpec(node.kind) as NodeKindSpec, port.name);
  if (!result.ok) return undefined;
  if (result.value.kind !== type) {
    fail(ctx, node, 'module_ports_mismatch', `输入 ${port.name} 需要${type}，实际是${result.value.kind}`);
    return undefined;
  }
  return result.value;
}

function findModuleRef(document: GraphDocument, node: GraphNode): GraphModule | undefined {
  const ref = moduleRefOf(node);
  return findModule(document, ref.id, ref.version);
}

function valueToType(value: WorkflowValue): PortType {
  return value.kind;
}

function fail(
  ctx: EvalContext,
  node: GraphNode,
  code: Parameters<typeof report>[1],
  message: string,
): undefined {
  report(ctx, code, node.id, message);
  return undefined;
}
