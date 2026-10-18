import {
  bytesToHex,
  encodeBool,
  encodeBytes,
  encodeInt,
  encodeText,
  nodeInputs,
  nodeOutput,
  nodeSpec,
  WORKFLOW_EVAL_STEP_LIMIT,
} from '@pwn2block/shared';
import type { EncodedValue, GraphConnection, GraphNode, NodeKindSpec } from '@pwn2block/shared';
import { computeNode, type EvalHelpers } from './compute-nodes';
import { createEvalContext, report, type EvalContext, type ValueResult } from './context';
import { edgeKeyOf, paramsOf } from './document';
import { inlineValue } from './params';
import type { NodePreview, PreviewSegment, WorkflowValue } from './types';

/**
 * 数据节点的求值（06 §2、§4.1）。
 *
 * 求值规则：
 * - **按依赖求值**：只有被动作（或其它数据节点）需要的节点才计算；没被选中分支里的节点不执行
 *   （06 §2「未选中分支中的 Python 不执行」）。
 * - **纯函数式**：数据节点只读自己的参数与上游结果，不读 VM 状态（06 §2），所以同样的图
 *   得到同样的字节——这也是编译能脱离 VM 单测的原因。
 * - **每次求值只算一次**：同一节点在一次编译里缓存结果；带轮次/变量的节点由调用方按轮次
 *   传不同的缓存键（P4）。
 * - 错误一律变成带节点 id 的 `WorkflowIssue`，不抛异常：编译要能一次报出多处问题。
 *
 * 具体节点的计算在 `compute-nodes.ts`；本文件只负责缓存、步数上限、预览与递归，把递归
 * 收在一处避免模块之间互相 import。
 */

export { createEvalContext };
export type { EvalContext, ValueResult };

/** 求一个数据节点的值；不是数据节点或参数有问题时返回失败。 */
export async function evalNodeValue(
  ctx: EvalContext,
  nodeId: string,
  path: readonly string[] = ['main'],
): Promise<ValueResult> {
  const cached = ctx.values.get(nodeId);
  if (cached !== undefined) {
    const segments = ctx.segments.get(nodeId);
    return segments === undefined ? { ok: true, value: cached } : { ok: true, value: cached, segments };
  }

  const node = ctx.lookup.nodes.get(nodeId);
  if (node === undefined) return report(ctx, 'unknown_node', nodeId, `节点 ${nodeId} 不存在`);
  const spec = nodeSpec(node.kind);
  if (spec === undefined) return report(ctx, 'unknown_kind', nodeId, `未知节点类型：${node.kind}`);
  if (nodeOutput(spec, paramsOf(node, spec)) === undefined) {
    return report(ctx, 'eval_failed', nodeId, `节点 ${spec.label} 没有数据输出，不能当作值使用`);
  }

  ctx.steps += 1;
  if (ctx.steps > WORKFLOW_EVAL_STEP_LIMIT) {
    return report(
      ctx,
      'limit_exceeded',
      nodeId,
      `求值超过上限 ${WORKFLOW_EVAL_STEP_LIMIT} 步（06 §5.3），把图拆小一些`,
    );
  }

  const result = await computeNode(ctx, node, spec, path, helpersFor(ctx));
  if (!result.ok) return result;

  ctx.values.set(nodeId, result.value);
  if (result.segments !== undefined) ctx.segments.set(nodeId, result.segments);
  ctx.previews.set(nodeId, makePreview(nodeId, result.value, result.segments));
  return result;
}

function helpersFor(ctx: EvalContext): EvalHelpers {
  return {
    resolve: (node, spec, port, path) => resolveInput(ctx, node, spec, port, path),
    encode: encodeValue,
  };
}

function makePreview(
  nodeId: string,
  value: WorkflowValue,
  segments: readonly PreviewSegment[] | undefined,
): NodePreview {
  const base: NodePreview = { nodeId, type: value.kind, summary: summaryOf(value) };
  const extra =
    value.kind === 'bytes'
      ? {
          length: value.bytes.length,
          hex: bytesToHex(value.bytes.slice(0, 64)),
          text: readableText(value.bytes),
        }
      : {};
  return segments === undefined ? { ...base, ...extra } : { ...base, ...extra, segments };
}

/** 预览摘要：与 shared 的 `encodedValueSummary` 同一口径，但直接读内部值类型。 */
export function summaryOf(value: WorkflowValue): string {
  switch (value.kind) {
    case 'int':
      return value.value >= 0n && value.value < 1n << 64n
        ? `${value.value}（0x${value.value.toString(16)}）`
        : value.value.toString(10);
    case 'bool':
      return value.value ? '真' : '假';
    case 'bytes':
      return value.bytes.length === 0
        ? '0 字节（空）'
        : `${value.bytes.length} 字节：${bytesToHex(value.bytes.slice(0, 16))}${value.bytes.length > 16 ? '…' : ''}`;
    case 'text':
      return JSON.stringify(value.text.length > 32 ? `${value.text.slice(0, 32)}…` : value.text);
  }
}

/** 可打印就用文本展示，否则不给（避免把二进制当乱码塞进界面）。 */
function readableText(bytes: Uint8Array): string | undefined {
  let text = '';
  for (const byte of bytes.slice(0, 64)) {
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text;
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

/** 取一个输入口的值：接了线用上游结果，没接线用节点内填的参数。 */
export async function resolveInput(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  portName: string,
  path: readonly string[],
): Promise<ValueResult> {
  const params = paramsOf(node, spec);
  const port = nodeInputs(spec, params, ctx.portContext).find((candidate) => candidate.name === portName);
  if (port === undefined) {
    return report(ctx, 'unknown_port', node.id, `节点 ${spec.label} 没有输入端口 ${portName}`);
  }

  const edge = connectionInto(ctx, node.id, portName);
  if (edge !== undefined) {
    const upstream = await evalNodeValue(ctx, edge.from.node, path);
    if (!upstream.ok) return upstream;
    if (upstream.value.kind !== port.type) {
      return report(
        ctx,
        'eval_failed',
        node.id,
        `输入 ${portName} 需要${port.type}，但上游 ${edge.from.node} 给的是${upstream.value.kind}`,
      );
    }
    return upstream;
  }

  const inline = inlineValue(node.params[portName] ?? defaultParamOf(spec, portName), port.type);
  if (!inline.ok) {
    return report(ctx, 'invalid_param', node.id, `${spec.label} 的「${portName}」不对：${inline.message}`);
  }
  return inline;
}

function defaultParamOf(spec: NodeKindSpec, portName: string) {
  return spec.params.find((param) => param.name === portName)?.default;
}

function connectionInto(ctx: EvalContext, nodeId: string, portName: string): GraphConnection | undefined {
  const incoming = ctx.lookup.incoming.get(edgeKeyOf(nodeId, portName));
  if (incoming === undefined) return undefined;
  return {
    from: { node: incoming.source, port: incoming.sourcePort },
    to: { node: incoming.node, port: incoming.port },
  };
}

function encodeValue(value: WorkflowValue): EncodedValue {
  switch (value.kind) {
    case 'int':
      return encodeInt(value.value);
    case 'bool':
      return encodeBool(value.value);
    case 'bytes':
      return encodeBytes(value.bytes);
    case 'text':
      return encodeText(value.text);
  }
}

/** 内部值 → 传输编码（Python 输入）。 */
export const encodeWorkflowValue = encodeValue;
