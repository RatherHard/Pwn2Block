import { z } from 'zod';
import type { CanvasDocument } from './document';

/** The editor stores relationships as edges; envelopes only own members. */
export const LOGIC_TYPES = ['int', 'double', 'string', 'bytes', 'bool'] as const;
export type LogicType = (typeof LOGIC_TYPES)[number];
export const LOGIC_OPERATORS = [
  'assign',
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  'and',
  'or',
] as const;
// 兼容旧存档的 concat；新建连接统一使用 + 表示加法或拼接。
export type LogicOperator = (typeof LOGIC_OPERATORS)[number] | 'concat';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const literal = z.strictObject({ type: z.enum(LOGIC_TYPES), text: z.string().max(131072) });
const base = { id, x: z.number().finite(), y: z.number().finite() };
export const LogicNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('constant'), value: literal }),
  z.strictObject({ ...base, kind: z.literal('variable'), name: z.string().max(64) }),
  z.strictObject({
    ...base,
    kind: z.literal('convert'),
    value: literal,
    target: z.enum(LOGIC_TYPES),
    input: id.optional(),
    width: z.enum(['1', '2', '4', '8']).default('8'),
    endian: z.enum(['little', 'big']).default('little'),
    signed: z.boolean().default(false),
  }),
  z.strictObject({ ...base, kind: z.literal('start') }),
  z.strictObject({ ...base, kind: z.literal('branch') }),
  z.strictObject({ ...base, kind: z.literal('loop'), count: z.string().max(512), body: id.optional() }),
  z.strictObject({ ...base, kind: z.literal('method'), method: z.string().max(128) }),
  z.strictObject({
    ...base,
    kind: z.literal('envelope'),
    category: z.enum(['data', 'flow']),
    members: z.array(id).max(512),
    title: z.string().max(80),
  }),
]);
export type LogicNode = z.infer<typeof LogicNodeSchema>;
export type LogicLiteral = z.infer<typeof literal>;
export const LogicEdgeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('data'), from: id, to: id, op: z.enum([...LOGIC_OPERATORS, 'concat']) }),
  z.strictObject({
    id, kind: z.literal('flow'), from: id, to: id, outlet: z.enum(['next', 'then', 'else']),
    points: z.array(z.strictObject({ x: base.x, y: base.y })).max(128).optional(),
  }),
  z.strictObject({ id, kind: z.literal('reference'), from: id, to: id, port: z.string().max(128) }),
]);
export type LogicEdge = z.infer<typeof LogicEdgeSchema>;
export const LogicGraphSchema = z.strictObject({
  version: z.literal(1),
  nodes: z.array(LogicNodeSchema).max(512),
  edges: z.array(LogicEdgeSchema).max(2048),
});
export type LogicGraph = z.infer<typeof LogicGraphSchema>;
export function newLogicDocument(): CanvasDocument {
  return {
    format: 'pwn2block.canvas',
    version: 2,
    nodes: [],
    layout: {},
    main: [],
    logic: { version: 1, nodes: [{ id: 'start', kind: 'start', x: 100, y: 100 }], edges: [] },
    logicView: { layerOrder: ['start'] },
  };
}
export function logicCategory(node: LogicNode): 'data' | 'flow' {
  if (node.kind === 'envelope') return node.category;
  return ['constant', 'variable', 'convert'].includes(node.kind) ? 'data' : 'flow';
}
export function logicMembers(graph: LogicGraph, id: string, seen = new Set<string>()): Set<string> {
  if (seen.has(id)) return seen;
  seen.add(id);
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.kind === 'envelope') for (const member of node.members) logicMembers(graph, member, seen);
  return seen;
}
export function logicHasAssignment(graph: LogicGraph, id: string): boolean {
  const members = logicMembers(graph, id);
  return graph.edges.some((e) => e.kind === 'data' && e.op === 'assign' && members.has(e.to));
}
export function logicIsFlow(graph: LogicGraph, node: LogicNode): boolean {
  return logicCategory(node) === 'flow' || (node.kind === 'envelope' && logicHasAssignment(graph, node.id));
}
export function logicOwner(graph: LogicGraph, id: string): LogicNode | undefined {
  return graph.nodes.find((n) => n.kind === 'envelope' && n.members.includes(id));
}
