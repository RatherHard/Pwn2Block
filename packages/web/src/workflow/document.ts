import { countOf, defaultParams, nodeParams, nodeSpec } from '@pwn2block/shared';
import type { GraphDocument, GraphNode, NodeKindSpec, ParamValues } from '@pwn2block/shared';
import type { NodeMap, NodePlacement } from './types';

/**
 * 图文档的索引工具：节点表、输入端口 → 连线的索引、执行区域里的位置。
 *
 * 校验、求值、编译和画布都要问同样的问题（"这个节点的输入连在哪""它在哪一层容器里"），
 * 所以放在一处，用纯函数算出来，避免每个调用方各写一遍遍历。
 */

/** 嵌套深度兜底：正常图远小于它，这里只防脏数据把递归拖死。 */
const MAX_WALK_DEPTH = 64;

export interface GraphLookup {
  readonly nodes: NodeMap;
  /** `edgeKey(node, port)` → 连进来的那条边。 */
  readonly incoming: ReadonlyMap<string, { readonly node: string; readonly port: string; readonly source: string; readonly sourcePort: string }>;
  /** 节点 → 它所在的执行区域位置；未被放在任何区域里的节点不在表里。 */
  readonly placements: ReadonlyMap<string, NodePlacement>;
  /** 同一个节点被放进多个区域时的节点 id（校验器报重复放置）。 */
  readonly duplicated: readonly string[];
  /** 实际达到的最深嵌套层数（顶层算 1）。 */
  readonly depth: number;
}

/** 从文档里算出一份索引；对脏数据不抛错，多余信息交给校验器报。 */
export function lookupGraph(document: GraphDocument): GraphLookup {
  const nodes = new Map<string, GraphNode>();
  for (const node of document.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  const incoming = new Map<
    string,
    { readonly node: string; readonly port: string; readonly source: string; readonly sourcePort: string }
  >();
  for (const connection of document.connections) {
    const key = edgeKeyOf(connection.to.node, connection.to.port);
    if (incoming.has(key)) continue; // 一个输入接多条线：保留第一条，校验器报错
    incoming.set(key, {
      node: connection.to.node,
      port: connection.to.port,
      source: connection.from.node,
      sourcePort: connection.from.port,
    });
  }

  const placements = new Map<string, NodePlacement>();
  const duplicated: string[] = [];
  let depth = 0;

  const walk = (ids: readonly string[], path: readonly string[], container: string | undefined, level: number): void => {
    if (level > MAX_WALK_DEPTH) return;
    depth = Math.max(depth, level);
    for (const [index, id] of ids.entries()) {
      if (placements.has(id)) {
        duplicated.push(id);
        continue;
      }
      placements.set(id, { nodeId: id, path, container, index });
      const node = nodes.get(id);
      if (node?.regions === undefined) continue;
      for (const [region, members] of Object.entries(node.regions)) {
        walk(members, [...path, `${id}/${region}`], id, level + 1);
      }
    }
  };

  walk(document.main, ['main'], undefined, 1);
  return { nodes, incoming, placements, duplicated, depth };
}

export function edgeKeyOf(nodeId: string, port: string): string {
  return `${nodeId}\u0000${port}`;
}

/** 位置路径是不是另一条路径的前缀（含相等）：「在外层」才允许被内层引用。 */
export function pathContains(outer: readonly string[], inner: readonly string[]): boolean {
  if (outer.length > inner.length) return false;
  return outer.every((segment, index) => segment === inner[index]);
}

/** 取节点定义；未知节点返回 `undefined`（由校验器决定怎么报）。 */
export function specFor(node: GraphNode): NodeKindSpec | undefined {
  return nodeSpec(node.kind);
}

/**
 * 节点参数补上默认值：文档里没写的键按目录默认值算。
 *
 * 这样新建的节点可以只存用户改过的参数，读旧存档时新增的参数也不会变成 `undefined`。
 */
export function paramsOf(node: GraphNode, spec: NodeKindSpec): ParamValues {
  return { ...defaultParams(spec), ...node.params };
}

/** 全部参数定义（含按数量派生的偏移参数），顺序稳定，表单按它渲染。 */
export function paramSpecsOf(node: GraphNode, spec: NodeKindSpec): ReturnType<typeof nodeParams> {
  return nodeParams(spec, paramsOf(node, spec));
}

/** `count` 参数取到的数量（已夹在 1..16，非法值由校验器报）。 */
export function itemCountOf(node: GraphNode): number {
  return countOf(node.params);
}
