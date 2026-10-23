import { WORKFLOW_FORMAT, WORKFLOW_VERSION, defaultParams, nodeSpec } from '@pwn2block/shared';
import type {
  GraphConnection,
  GraphDocument,
  GraphModule,
  GraphNode,
  ParamValues,
} from '@pwn2block/shared';
import type { WorkflowContext } from '../src/workflow/types';

/**
 * 图测试的构造工具：把「节点 + 连线 + 执行序列」写成最短形式。
 *
 * 测试直接构造 `GraphDocument`，不经过画布：语义验收（动作、预览、错误定位）应该能脱离
 * DOM 断言（07 §6）。参数表自动补目录默认值，测试里只写关心的那几个。
 */

export const WORKFLOW_CONTEXT: WorkflowContext = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
};

/** 新建一个节点：参数按目录默认值补齐。 */
export function wfNode(
  id: string,
  kind: string,
  params: ParamValues = {},
  regions?: Readonly<Record<string, readonly string[]>>,
): GraphNode {
  const spec = nodeSpec(kind);
  const merged = spec === undefined ? { ...params } : { ...defaultParams(spec), ...params };
  return regions === undefined
    ? { id, kind, params: merged }
    : { id, kind, params: merged, regions };
}

/** 连线：`fromPort` 默认是 `out`，方便只写目标端口。 */
export function wfEdge(from: string, to: string, toPort: string, fromPort = 'out'): GraphConnection {
  return { from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

export interface WorkflowSpec {
  readonly nodes: readonly GraphNode[];
  readonly edges?: readonly GraphConnection[];
  readonly main: readonly string[];
  /** 模块定义：调用节点按 id + 版本引用。 */
  readonly modules?: readonly GraphModule[];
}

/** 组装一份完整文档；`start` 节点自动补在最前面（每个流程恰好一个入口）。 */
export function workflow(spec: WorkflowSpec): GraphDocument {
  const nodes = spec.nodes.some((node) => node.kind === 'start')
    ? spec.nodes
    : [{ id: 'start', kind: 'start', params: {} }, ...spec.nodes];
  const layout: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, index) => {
    layout[node.id] = { x: 40 + (index % 4) * 260, y: 40 + Math.floor(index / 4) * 180 };
  });
  return {
    format: WORKFLOW_FORMAT,
    version: WORKFLOW_VERSION,
    nodes,
    connections: spec.edges ?? [],
    main: spec.main,
    layout,
    ...(spec.modules === undefined ? {} : { modules: spec.modules }),
  };
}
