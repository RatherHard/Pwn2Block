import { z } from 'zod';
import {
  MAX_BYTE_CONSTRUCTION_BYTES,
  WORKFLOW_MAX_CONNECTIONS,
  WORKFLOW_MAX_MODULES,
  WORKFLOW_MAX_NODES,
  WORKFLOW_MAX_REGION_ITEMS,
} from '../limits';
import { MODULE_KINDS, PORT_TYPES, WORKFLOW_FORMAT, WORKFLOW_VERSION, type GraphDocument } from './types';

/**
 * 图文档的 Schema（07 §P1）。
 *
 * 存档来自 `localStorage` / 导入文件，一律不可信：先过 Schema，再过 `validateGraph` 的结构校验。
 * 这一层只管**形状**（严格对象、长度、坐标有限），语义问题（未知节点、类型不匹配、数据环）
 * 交给校验器，这样两者的错误文案可以分别是「这份存档坏了」和「这张图还差什么」。
 */

/** 节点 id：稳定、可读、能放进 CSS 选择器。 */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 端口名：`out`、`data`、`item0`、用户声明的 Python 输入名。 */
export const PORT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const ParamValueSchema = z.union([
  z.string().max(MAX_BYTE_CONSTRUCTION_BYTES),
  z.number().finite(),
  z.array(z.string().max(64)).max(16),
]);

export const GraphNodeSchema = z.strictObject({
  id: z.string().regex(NODE_ID_RE, '节点 id 只能是字母、数字、下划线和连字符'),
  kind: z.string().min(1).max(40),
  params: z.record(z.string(), ParamValueSchema).default({}),
  regions: z.record(z.string(), z.array(z.string().regex(NODE_ID_RE)).max(WORKFLOW_MAX_REGION_ITEMS)).optional(),
});

export const ConnectionEndpointSchema = z.strictObject({
  node: z.string().regex(NODE_ID_RE),
  port: z.string().regex(PORT_NAME_RE),
});

export const GraphConnectionSchema = z.strictObject({
  from: ConnectionEndpointSchema,
  to: ConnectionEndpointSchema,
});

export const NodeLayoutSchema = z.strictObject({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  collapsed: z.boolean().optional(),
});

export const ModulePortSchema = z.strictObject({
  name: z.string().regex(PORT_NAME_RE, '端口名只能是字母、数字和下划线'),
  type: z.enum(PORT_TYPES),
  default: ParamValueSchema.optional(),
});

/** 模块体是一张独立的小图：节点、连线、序列与布局都与主图同构。 */
const ModuleBodySchema = {
  nodes: z.array(GraphNodeSchema).max(WORKFLOW_MAX_NODES),
  connections: z.array(GraphConnectionSchema).max(WORKFLOW_MAX_CONNECTIONS),
  main: z.array(z.string().regex(NODE_ID_RE)).max(WORKFLOW_MAX_REGION_ITEMS),
  layout: z.record(z.string(), NodeLayoutSchema).default({}),
};

export const GraphModuleSchema = z.strictObject({
  id: z.string().regex(NODE_ID_RE, '模块 id 只能是字母、数字、下划线和连字符'),
  name: z.string().min(1).max(40),
  summary: z.string().max(200),
  kind: z.enum(MODULE_KINDS),
  version: z.number().int().min(1).max(1000),
  inputs: z.array(ModulePortSchema).max(16),
  output: ModulePortSchema.optional(),
  ...ModuleBodySchema,
});

export const GraphGroupSchema = z.strictObject({
  id: z.string().regex(NODE_ID_RE),
  name: z.string().min(1).max(40),
  members: z.array(z.string().regex(NODE_ID_RE)).min(1).max(256),
});

export const GraphDocumentSchema = z.strictObject({
  format: z.literal(WORKFLOW_FORMAT),
  version: z.number().int().min(1),
  nodes: z.array(GraphNodeSchema).max(WORKFLOW_MAX_NODES),
  connections: z.array(GraphConnectionSchema).max(WORKFLOW_MAX_CONNECTIONS),
  main: z.array(z.string().regex(NODE_ID_RE)).max(WORKFLOW_MAX_REGION_ITEMS),
  layout: z.record(z.string(), NodeLayoutSchema).default({}),
  groups: z.array(GraphGroupSchema).max(128).default([]),
  modules: z.array(GraphModuleSchema).max(WORKFLOW_MAX_MODULES).default([]),
});

export type ParsedGraphDocument = z.infer<typeof GraphDocumentSchema>;

export type ParseGraphResult =
  | { readonly ok: true; readonly document: GraphDocument }
  | { readonly ok: false; readonly message: string };

/**
 * 解析一份存档。**不做语义校验**（那是 `validateGraph` 的事），但版本号必须精确匹配：
 * 未来版本里可能有本版本读不懂的字段，猜着读只会把用户的图改坏（07 §P8）。
 */
export function parseGraphDocument(raw: unknown): ParseGraphResult {
  const parsed = GraphDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `（${first.path.join('.')}）` : '';
    return { ok: false, message: `存档格式不对${where}：${first?.message ?? '未知原因'}` };
  }
  if (parsed.data.version !== WORKFLOW_VERSION) {
    return {
      ok: false,
      message: `存档版本 ${parsed.data.version} 不受支持，当前只认版本 ${WORKFLOW_VERSION}`,
    };
  }
  return { ok: true, document: parsed.data };
}

/** 新建一份空图：只有一个「开始」节点，顶层序列为空。 */
export function emptyGraphDocument(): GraphDocument {
  return {
    format: WORKFLOW_FORMAT,
    version: WORKFLOW_VERSION,
    nodes: [{ id: 'start', kind: 'start', params: {} }],
    connections: [],
    main: [],
    layout: { start: { x: 40, y: 40 } },
  };
}
