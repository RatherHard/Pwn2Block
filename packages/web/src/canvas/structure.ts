import { canvas } from '@pwn2block/shared';

/** 取结构全部成员，防止整体拖动包络时把内部链条拆开。 */
export function structureIds(document: canvas.CanvasDocument, id: string): readonly string[] {
  const seen = new Set<string>();
  const visit = (current: string): void => {
    if (seen.has(current)) return;
    seen.add(current);
    const node = document.nodes.find((node) => node.id === current);
    if (node === undefined) return;
    structureChildren(node).forEach(visit);
  };
  visit(id);
  return [...seen].filter((key) => key !== canvas.UNCONNECTED);
}

/** 框选完整表达式时提升到关系根；关系是连接，不需要额外点选。 */
export function selectionRoots(document: canvas.CanvasDocument, ids: readonly string[]): readonly string[] {
  const selected = new Set(ids);
  for (let pass = 0; pass < document.nodes.length; pass += 1) {
    let changed = false;
    for (const node of document.nodes) {
      const children = node.kind === 'relation' || node.kind === 'unary' || node.kind === 'group' ? structureChildren(node) : [];
      if (!selected.has(node.id) && children.length > 0 && children.every((id) => selected.has(id))) {
        selected.add(node.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const contained = new Set([...selected].flatMap((id) => structureIds(document, id).filter((child) => child !== id)));
  return [...selected].filter((id) => !contained.has(id));
}

/** 结构归属与数据引用不同：方法参数等可共享引用不随容器移动。 */
export function structureChildren(node: canvas.CanvasNode): readonly string[] {
  switch (node.kind) {
    case 'group': return canvas.groupMembers(node);
    case 'relation': return [node.left, node.right].filter(canvas.isConnected);
    case 'unary': return [node.operand].filter(canvas.isConnected);
    case 'convert': return [node.input].filter(canvas.isConnected);
    case 'loop': case 'if': return canvas.flowChildrenOf(node).flat();
    default: return [];
  }
}
