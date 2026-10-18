import { nodeRegions, nodeSpec } from '@pwn2block/shared';
import type { GraphDocument, GraphNode } from '@pwn2block/shared';

/**
 * 折叠容器的可见性（06 §3；07 §P4）。
 *
 * 折叠是**纯显示**状态：子节点在画布上隐藏，但 `regions` 与执行顺序原样保留。
 * 隐藏是传递的——折叠外层容器时，里面嵌套的容器与它们的子节点也一起隐藏；
 * 数据/执行连线只要一端被隐藏就不画，避免线穿过不可见的节点。
 */

/** 有区域的容器节点（只有它们能折叠）。 */
export function isContainer(node: GraphNode): boolean {
  const spec = nodeSpec(node.kind);
  return spec !== undefined && nodeRegions(spec, node.params).length > 0;
}

/** 已折叠的容器 id。 */
export function collapsedContainers(document: GraphDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const node of document.nodes) {
    if (document.layout[node.id]?.collapsed === true && isContainer(node)) ids.add(node.id);
  }
  return ids;
}

/** 被折叠容器隐藏的节点 id（沿区域递归，处理嵌套）。 */
export function hiddenByCollapse(document: GraphDocument): ReadonlySet<string> {
  const hidden = new Set<string>();
  const collapsed = collapsedContainers(document);
  const walk = (node: GraphNode): void => {
    for (const members of Object.values(node.regions ?? {})) {
      for (const id of members) {
        if (hidden.has(id)) continue;
        hidden.add(id);
        const child = document.nodes.find((candidate) => candidate.id === id);
        if (child !== undefined) walk(child);
      }
    }
  };
  for (const node of document.nodes) {
    if (collapsed.has(node.id)) walk(node);
  }
  return hidden;
}

/** 折叠容器的副标题：告诉学习者里面还有多少条语句，而不是空白一块。 */
export function collapsedSummary(node: GraphNode): string {
  const count = Object.values(node.regions ?? {}).reduce((total, members) => total + members.length, 0);
  return `已折叠 · ${count} 条语句`;
}

/** 缩放小于这个值时隐藏端口名与副标题，只留节点骨架（06 §3「缩放简化显示」）。 */
export const SIMPLIFY_ZOOM = 0.55;
