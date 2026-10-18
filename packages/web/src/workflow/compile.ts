import {
  bytesToHex,
  expandBlock,
  formatHex,
  MAX_RUN_MAX_STEPS,
  MAX_STEP_COUNT,
  MAX_SUBMIT_ACTIONS,
  nodeInputs,
  nodeSpec,
  NODE,
} from '@pwn2block/shared';
import type {
  BlockAction,
  GraphNode,
  NodeKindSpec,
  PrimitiveAction,
  WorkflowIssue,
} from '@pwn2block/shared';
import { execControl, isControlKind, type ExecSink, type FlowSignal } from './control';
import { paramsOf } from './document';
import { createEvalContext, evalNodeValue, resolveInput, type EvalContext } from './evaluate';
import type {
  CompileGraphInput,
  CompileOutcome,
  CompileTraceEntry,
  CompiledAction,
  NodePreview,
  WorkflowArtifact,
  WorkflowOrigin,
} from './types';
import { WORKFLOW_ORIGIN_VERSION } from './types';
import { validateGraph } from './validate';

/**
 * 图 → 动作序列（06 §2「流程先完成数据计算…再生成动作序列」；07 §3「图编译」）。
 *
 * 契约：
 * - **只产出动作**：编译期求完所有数据、展开分支/循环/模块，得到的就是现有动作协议里的
 *   原子动作；VM、投影、判题完全不用改，服务端仍做权限校验并从初态判题（01 §4）。
 * - **要么完整产物、要么带节点的错误**：任何一处失败都不发布部分动作（07 §P1）。
 * - **不推进 VM**：编译只算数据，`feed` / `step` / `run` 只是被排进序列（06 §2）。
 * - **可取消**：每个语句之前检查取消信号；取消返回 `cancelled`，不产生产物。
 * - 纯异步函数：不读 DOM、不读时间（Python 结果由注入的求值器提供）。
 */

/** 编译被取消：用异常穿透嵌套执行，外层统一转成 `cancelled` 问题。 */
class CompileCancelled extends Error {
  constructor(readonly nodeId: string) {
    super('编译已取消');
  }
}

export async function compileGraph(input: CompileGraphInput): Promise<CompileOutcome> {
  const validation = validateGraph(input.document, input.context);
  if (!validation.ok) return { ok: false, issues: validation.errors };

  const ctx = createEvalContext(input.document, input.context, validation.lookup);
  const sink: ExecSink = { actions: [], origins: [], trace: [] };

  try {
    const signal = await execSequence(ctx, input.document.main, ['main'], sink, input.signal);
    if (signal !== undefined) {
      ctx.issues.push({
        code: signal === 'break' ? 'break_outside_loop' : 'continue_outside_loop',
        severity: 'error',
        nodeId: '',
        message: `「${signal === 'break' ? '跳出循环' : '继续下一轮'}」只能出现在循环体内（06 §5.3）`,
      });
    }
  } catch (error) {
    if (error instanceof CompileCancelled) return { ok: false, issues: [cancelledIssue(error.nodeId)] };
    throw error;
  }

  // 取消可能发生在一次长求值（Python）中间：优先报取消，不把半途的错误当结论。
  if (input.signal?.aborted === true) return { ok: false, issues: [cancelledIssue('')] };
  if (ctx.issues.length > 0) return { ok: false, issues: [...ctx.issues] };

  if (sink.actions.length > MAX_SUBMIT_ACTIONS) {
    return {
      ok: false,
      issues: [
        {
          code: 'limit_exceeded',
          severity: 'error',
          nodeId: '',
          message: `动作数 ${sink.actions.length} 超过上限 ${MAX_SUBMIT_ACTIONS}，一次提交发不出去（04 §6）`,
        },
      ],
    };
  }

  const artifact: WorkflowArtifact = {
    actions: sink.actions,
    origins: sink.origins,
    originsVersion: WORKFLOW_ORIGIN_VERSION,
    previews: collectPreviews(ctx),
    trace: sink.trace,
    documentRevision: input.documentRevision,
  };
  return { ok: true, artifact, warnings: validation.warnings };
}

function cancelledIssue(nodeId: string): WorkflowIssue {
  return {
    code: 'cancelled',
    severity: 'error',
    nodeId,
    message: '编译已取消：没有发布任何动作',
  };
}

/**
 * 执行一层语句序列。返回循环控制信号（`break` / `continue` 由内向外冒泡），
 * 容器自己决定是消费信号（循环）还是继续往外传（分支）。
 */
async function execSequence(
  ctx: EvalContext,
  ids: readonly string[],
  path: readonly string[],
  sink: ExecSink,
  cancel: AbortSignal | undefined,
): Promise<FlowSignal> {
  for (const nodeId of ids) {
    if (cancel?.aborted === true) throw new CompileCancelled(nodeId);
    const node = ctx.lookup.nodes.get(nodeId);
    if (node === undefined) continue;
    const spec = nodeSpec(node.kind);
    if (spec === undefined) continue;
    if (node.kind === 'start') continue;
    // 「结果」不是语句：它由所在区域执行完后统一读取（06 §5.2）。
    if (node.kind === NODE.result) continue;

    if (isControlKind(node.kind)) {
      const flow = await execControl(ctx, node, spec, path, {
        sink,
        execSequence: (members, nested) => execSequence(ctx, members, nested, sink, cancel),
      });
      if (flow !== undefined) return flow;
      continue;
    }

    if (!spec.exec) {
      const result = await evalNodeValue(ctx, nodeId);
      if (result.ok) {
        const summary = ctx.previews.get(nodeId)?.summary ?? '';
        trace(sink, nodeId, path, `求值 ${spec.label}：${summary}`, ctx);
      }
      continue;
    }

    const action = await buildAction(ctx, node, spec);
    if (action === undefined) continue;
    sink.actions.push(action);
    sink.origins.push(originOf(sink, nodeId, path, ctx));
    trace(sink, nodeId, path, `动作 ${action.type}`, ctx);
  }
  return undefined;
}

/** 一次动作的字节上限：与请求体上限同一量级，避免拼出一个发不出去的 payload。 */
const MAX_ACTION_BYTES = 512 * 1024;

/** 轨迹上限：循环多时轨迹会很长，界面只需要最近的一段。 */
const MAX_TRACE_ENTRIES = 256;

async function buildAction(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
): Promise<CompiledAction | undefined> {
  switch (node.kind) {
    case NODE.feed: {
      const bytes = await inputBytes(ctx, node, spec, 'data');
      if (bytes === undefined) return undefined;
      return { type: 'feed', hex: bytesToHex(bytes) } satisfies PrimitiveAction;
    }
    case NODE.write: {
      const address = await inputNonNegative(ctx, node, spec, 'addr', '目标地址');
      if (address === undefined) return undefined;
      const bytes = await inputBytes(ctx, node, spec, 'data');
      if (bytes === undefined) return undefined;
      return { type: 'write_bytes', addr: formatHex(address), hex: bytesToHex(bytes) } satisfies PrimitiveAction;
    }
    case NODE.push: {
      const value = await inputNonNegative(ctx, node, spec, 'value', '压栈的值');
      if (value === undefined) return undefined;
      return { type: 'push', value: formatHex(value) } satisfies PrimitiveAction;
    }
    case NODE.pop:
      return { type: 'pop' } satisfies PrimitiveAction;
    case NODE.ret:
      return { type: 'ret' } satisfies PrimitiveAction;
    case NODE.call: {
      const address = await inputNonNegative(ctx, node, spec, 'addr', '调用地址');
      if (address === undefined) return undefined;
      return { type: 'call', addr: formatHex(address) } satisfies PrimitiveAction;
    }
    case NODE.step: {
      const count = await inputNonNegative(ctx, node, spec, 'count', '指令数');
      if (count === undefined) return undefined;
      const value = Number(count);
      if (value < 1 || value > MAX_STEP_COUNT) {
        return fail(ctx, node, `指令数必须在 1..${MAX_STEP_COUNT} 之间（04 §6），收到 ${count}`);
      }
      return { type: 'step', count: value } satisfies PrimitiveAction;
    }
    case NODE.run: {
      const maxSteps = await inputNonNegative(ctx, node, spec, 'maxSteps', '最多指令数');
      if (maxSteps === undefined) return undefined;
      const value = Number(maxSteps);
      if (value < 1 || value > MAX_RUN_MAX_STEPS) {
        return fail(ctx, node, `最多指令数必须在 1..${MAX_RUN_MAX_STEPS} 之间（04 §6），收到 ${maxSteps}`);
      }
      return { type: 'run', maxSteps: value } satisfies PrimitiveAction;
    }
    case NODE.author:
      return buildAuthorAction(ctx, node, spec);
    default:
      return fail(ctx, node, `节点 ${spec.label} 是数据节点，不能直接执行`);
  }
}

function fail(ctx: EvalContext, node: GraphNode, message: string): undefined {
  ctx.issues.push({ code: 'eval_failed', severity: 'error', message, nodeId: node.id });
  return undefined;
}

async function inputBytes(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
): Promise<Uint8Array | undefined> {
  const result = await resolveInput(ctx, node, spec, port);
  if (!result.ok) return undefined;
  if (result.value.kind !== 'bytes') {
    ctx.issues.push({
      code: 'eval_failed',
      severity: 'error',
      nodeId: node.id,
      message: `输入 ${port} 需要字节，收到${result.value.kind}`,
    });
    return undefined;
  }
  if (result.value.bytes.length > MAX_ACTION_BYTES) {
    ctx.issues.push({
      code: 'limit_exceeded',
      severity: 'error',
      nodeId: node.id,
      message: `单个动作的字节数 ${result.value.bytes.length} 超过上限 ${MAX_ACTION_BYTES}`,
    });
    return undefined;
  }
  return result.value.bytes;
}

async function inputNonNegative(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
  label: string,
): Promise<bigint | undefined> {
  const result = await resolveInput(ctx, node, spec, port);
  if (!result.ok) return undefined;
  if (result.value.kind !== 'int') {
    ctx.issues.push({
      code: 'eval_failed',
      severity: 'error',
      nodeId: node.id,
      message: `${label}需要整数，收到${result.value.kind}`,
    });
    return undefined;
  }
  if (result.value.value < 0n) {
    ctx.issues.push({
      code: 'eval_failed',
      severity: 'error',
      nodeId: node.id,
      message: `${label}不能为负，收到 ${result.value.value}`,
    });
    return undefined;
  }
  return result.value.value;
}

/**
 * 出题人积木：编译成 `{ type: 'block', id, args }`，**展开仍然由服务端完成**（03 §3）。
 * 本地先调一次同一个展开器，把「参数形式对但展开必被拒」的情况在编译期就报出来。
 */
async function buildAuthorAction(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
): Promise<CompiledAction | undefined> {
  const id = typeof node.params.id === 'string' ? node.params.id : '';
  const block = (ctx.workflow.authorBlocks ?? []).find((candidate) => candidate.id === id);
  if (block === undefined) return fail(ctx, node, `题目没有声明出题人积木 ${id}`);

  const ports = nodeInputs(spec, paramsOf(node, spec), ctx.portContext);
  const args: Record<string, string> = {};
  for (const param of block.params) {
    const port = ports.find((candidate) => candidate.name === param.name);
    if (port === undefined) return fail(ctx, node, `出题人积木 ${id} 的参数 ${param.name} 没有对应的输入口`);
    const result = await resolveInput(ctx, node, spec, param.name);
    if (!result.ok) return undefined;
    if (param.type === 'bytes') {
      if (result.value.kind !== 'bytes') return fail(ctx, node, `参数 ${param.name} 需要字节`);
      args[param.name] = bytesToHex(result.value.bytes);
      continue;
    }
    if (result.value.kind !== 'int') return fail(ctx, node, `参数 ${param.name} 需要整数`);
    if (result.value.value < 0n) return fail(ctx, node, `参数 ${param.name} 不能为负`);
    args[param.name] = formatHex(result.value.value);
  }

  const action: BlockAction = { type: 'block', id, args };
  const expansion = expandBlock({ authorBlocks: ctx.workflow.authorBlocks }, action);
  if (!expansion.ok) return fail(ctx, node, `出题人积木 ${id} 的参数无法展开：${expansion.detail}`);
  return action;
}

function originOf(
  sink: ExecSink,
  nodeId: string,
  path: readonly string[],
  ctx: EvalContext,
): WorkflowOrigin {
  const rounds = roundsOf(ctx);
  return {
    index: sink.actions.length - 1,
    nodeId,
    path,
    ...(rounds === undefined ? {} : { rounds }),
  };
}

function trace(
  sink: ExecSink,
  nodeId: string,
  path: readonly string[],
  message: string,
  ctx: EvalContext,
): void {
  if (sink.trace.length >= MAX_TRACE_ENTRIES) return;
  const rounds = roundsOf(ctx);
  sink.trace.push({ nodeId, path, message, ...(rounds === undefined ? {} : { rounds }) });
}

/** 当时所有活跃循环的轮次；没有循环就不带这个字段。 */
function roundsOf(ctx: EvalContext): Readonly<Record<string, number>> | undefined {
  if (ctx.loops.size === 0) return undefined;
  const rounds: Record<string, number> = {};
  for (const [nodeId, round] of ctx.loops) rounds[nodeId] = round;
  return rounds;
}

function collectPreviews(ctx: EvalContext): readonly NodePreview[] {
  return [...ctx.previews.values()];
}

/** 供测试与画布判断「这条轨迹是否来自某个循环轮次」。 */
export type { CompileTraceEntry };
