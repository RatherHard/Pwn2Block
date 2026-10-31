import type { canvas } from '@pwn2block/shared';
import { logicAttachmentHost, logicBox } from './logic-geometry';

/** 附件变为指针下的独立节点，原图保留用于点击、取消与撤销。 */
export function detachLogicAttachments(graph: canvas.LogicGraph, ids: readonly string[], point?: { x: number; y: number }): canvas.LogicGraph {
  return { ...graph, nodes: graph.nodes.map((node) => {
    if (!ids.includes(node.id) || !logicAttachmentHost(node)) return node;
    const box = logicBox(graph, node.id);
    const position = point ? { x: point.x - 90, y: point.y - 38 } : { x: box.x, y: box.y };
    if (node.kind === 'convert') {
      const { input: _input, ...rest } = node;
      return { ...rest, ...position };
    }
    if (node.kind === 'loop') {
      const { body: _body, ...rest } = node;
      return { ...rest, ...position };
    }
    return node;
  }) };
}

/** 从原附件位置拖出后，只有回到原标签上才重新附着原宿主。 */
export function returningToAttachment(original: canvas.LogicGraph | undefined, id: string, target: string,
  point?: { x: number; y: number }): boolean {
  const node = original?.nodes.find((item) => item.id === id);
  if (!original || !node || logicAttachmentHost(node) !== target || !point) return true;
  const box = logicBox(original, id);
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}
