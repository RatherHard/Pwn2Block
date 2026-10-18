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
import { paramsOf } from './document';
import { createEvalContext, evalNodeValue, resolveInput, type EvalContext } from './evaluate';
import type {
  CompileGraphInput,
  CompileOutcome,
  CompileTraceEntry,
  NodePreview,
  WorkflowArtifact,
  WorkflowOrigin,
} from './types';
import { WORKFLOW_ORIGIN_VERSION } from './types';
import { validateGraph } from './validate';

/** 编译产物里的动作：与现有动作协议一致（8 类原子动作 + 出题人积木）。 */
type CompiledAction = PrimitiveAction | BlockAction;

/**
 * 图 → 动作序列（06 §2「流程先完成数据计算…再生成动作序列」；07 §3「图编译」）。
 *
 * 契约：
 * - **只产出动作**：编译期求完所有数据，得到的就是现有动作协议里的原子动作；
 *   VM、投影、判题完全不用改，服务端仍做权限校验并从初态判题（01 §4）。
 * - **要么完整产物、要么带节点的错误**：任何一处失败都不发布部分动作（07 §P1）。
 * - **不推进 VM**：编译只算数据，`feed` / `step` / `run` 只是被排进序列（06 §2）。
 * - **可取消**：每个语句之间检查取消信号；取消返回 `cancelled`，不产生产物。
 * - 纯异步函数：不读 DOM、不读时间（Python 结果由注入的求值器提供）。
 */
export async function compileGraph(input: CompileGraphInput): Promise<CompileOutcome> {
  const validation = validateGraph(input.document, input.context);
  if (!validation.ok) return { ok: false, issues: validation.errors };

  const ctx = createEvalContext(input.document, input.context, validation.lookup);
  const actions: CompiledAction[] = [];
  const origins: WorkflowOrigin[] = [];
  const trace: CompileTraceEntry[] = [];

  for (const nodeId of input.document.main) {
    if (input.signal?.aborted === true) {
      return { ok: false, issues: [cancelledIssue(nodeId)] };
    }
    const node = validation.lookup.nodes.get(nodeId);
    if (node === undefined) continue;
    const spec = nodeSpec(node.kind);
    if (spec === undefined) continue;
    if (node.kind === 'start') continue;

    const before = ctx.issues.length;
    await compileStatement(ctx, node, spec, actions, origins, trace);
    if (ctx.issues.length > before) {
      return { ok: false, issues: [...ctx.issues] };
    }
  }

  if (actions.length > MAX_SUBMIT_ACTIONS) {
    return {
      ok: false,
      issues: [
        {
          code: 'limit_exceeded',
          severity: 'error',
          nodeId: '',
          message: `动作数 ${actions.length} 超过上限 ${MAX_SUBMIT_ACTIONS}，一次提交发不出去（04 §6）`,
        },
      ],
    };
  }

  const artifact: WorkflowArtifact = {
    actions,
    origins,
    originsVersion: WORKFLOW_ORIGIN_VERSION,
    previews: collectPreviews(ctx),
    trace,
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
 * 编译一个语句节点；数据节点放在执行位置上时只求值、不产生动作
 * （放在循环体里可以按轮次重算，见 06 §5.3）。
 */
async function compileStatement(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  actions: CompiledAction[],
  origins: WorkflowOrigin[],
  trace: CompileTraceEntry[],
): Promise<void> {
  const path = ctx.lookup.placements.get(node.id)?.path ?? ['main'];
  if (!spec.exec) {
    await evalNodeValue(ctx, node.id, path);
    const summary = ctx.previews.get(node.id)?.summary ?? '';
    trace.push({ nodeId: node.id, path, message: `求值 ${spec.label}：${summary}` });
    return;
  }

  const action = await buildAction(ctx, node, spec, path);
  if (action === undefined) return;
  actions.push(action);
  origins.push({ index: actions.length - 1, nodeId: node.id, path });
  trace.push({ nodeId: node.id, path, message: `动作 ${action.type}` });
}

/** 单个动作的字节上限：与请求体上限同一量级，避免拼出一个发不出去的 payload。 */
const MAX_ACTION_BYTES = 512 * 1024;

async function buildAction(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
): Promise<CompiledAction | undefined> {
  switch (node.kind) {
    case NODE.feed: {
      const bytes = await inputBytes(ctx, node, spec, 'data', path);
      if (bytes === undefined) return undefined;
      return { type: 'feed', hex: bytesToHex(bytes) } satisfies PrimitiveAction;
    }
    case NODE.write: {
      const address = await inputNonNegative(ctx, node, spec, 'addr', path, '目标地址');
      if (address === undefined) return undefined;
      const bytes = await inputBytes(ctx, node, spec, 'data', path);
      if (bytes === undefined) return undefined;
      return { type: 'write_bytes', addr: formatHex(address), hex: bytesToHex(bytes) } satisfies PrimitiveAction;
    }
    case NODE.push: {
      const value = await inputNonNegative(ctx, node, spec, 'value', path, '压栈的值');
      if (value === undefined) return undefined;
      return { type: 'push', value: formatHex(value) } satisfies PrimitiveAction;
    }
    case NODE.pop:
      return { type: 'pop' } satisfies PrimitiveAction;
    case NODE.ret:
      return { type: 'ret' } satisfies PrimitiveAction;
    case NODE.call: {
      const address = await inputNonNegative(ctx, node, spec, 'addr', path, '调用地址');
      if (address === undefined) return undefined;
      return { type: 'call', addr: formatHex(address) } satisfies PrimitiveAction;
    }
    case NODE.step: {
      const count = await inputNonNegative(ctx, node, spec, 'count', path, '指令数');
      if (count === undefined) return undefined;
      const value = Number(count);
      if (value < 1 || value > MAX_STEP_COUNT) {
        return fail(ctx, node, `指令数必须在 1..${MAX_STEP_COUNT} 之间（04 §6），收到 ${count}`);
      }
      return { type: 'step', count: value } satisfies PrimitiveAction;
    }
    case NODE.run: {
      const maxSteps = await inputNonNegative(ctx, node, spec, 'maxSteps', path, '最多指令数');
      if (maxSteps === undefined) return undefined;
      const value = Number(maxSteps);
      if (value < 1 || value > MAX_RUN_MAX_STEPS) {
        return fail(ctx, node, `最多指令数必须在 1..${MAX_RUN_MAX_STEPS} 之间（04 §6），收到 ${maxSteps}`);
      }
      return { type: 'run', maxSteps: value } satisfies PrimitiveAction;
    }
    case NODE.author:
      return buildAuthorAction(ctx, node, spec, path);
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
  path: readonly string[],
): Promise<Uint8Array | undefined> {
  const result = await resolveInput(ctx, node, spec, port, path);
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
  path: readonly string[],
  label: string,
): Promise<bigint | undefined> {
  const result = await resolveInput(ctx, node, spec, port, path);
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
  path: readonly string[],
): Promise<CompiledAction | undefined> {
  const id = typeof node.params.id === 'string' ? node.params.id : '';
  const block = (ctx.workflow.authorBlocks ?? []).find((candidate) => candidate.id === id);
  if (block === undefined) return fail(ctx, node, `题目没有声明出题人积木 ${id}`);

  const ports = nodeInputs(spec, paramsOf(node, spec), ctx.portContext);
  const args: Record<string, string> = {};
  for (const param of block.params) {
    const port = ports.find((candidate) => candidate.name === param.name);
    if (port === undefined) return fail(ctx, node, `出题人积木 ${id} 的参数 ${param.name} 没有对应的输入口`);
    const result = await resolveInput(ctx, node, spec, param.name, path);
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

function collectPreviews(ctx: EvalContext): readonly NodePreview[] {
  return [...ctx.previews.values()];
}
