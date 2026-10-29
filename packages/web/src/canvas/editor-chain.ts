import { CANVAS_MAX_ROW_MEMBERS, canvas } from '@pwn2block/shared';
import { addExistingNode, createGroup, edited, newNodeId, nodeOf, refuse, replaceNode, setBinding, withLayout, withRegionSequence, regionOfId, regionSequenceOf, type CanvasEdit } from './editor';
import { rewireInputs } from './editor-convert-wiring';
import { layoutCanvas } from './view-model';
import { structureIds } from './structure';
import { compactGroupMembers } from './editor-compact';
import { unionRects } from './view-model-geometry';

/** 关系是表达式的连接；删除关系时把所有下游引用（含容器成员）接回剩下的一端。 */
function spliceRelation(document: canvas.CanvasDocument, id: string, replacement: string): canvas.CanvasDocument {
  const rewired = rewireInputs(document, id, replacement);
  const layout = { ...rewired.layout };
  delete layout[id];
  return { ...rewired, layout, nodes: rewired.nodes.filter((node) => node.id !== id).map((node) => node.kind === 'group'
    ? { ...node, rows: node.rows.map((row) => row.map((member) => member === id ? replacement : member)) } : node) };
}

/** 脱离只移除链上的成员，前后链补位；流程节点留在画布上作为未编排语句。 */
export function detachChainMember(document: canvas.CanvasDocument, id: string): CanvasEdit {
  const node = nodeOf(document, id);
  if (node === undefined || node.kind === 'start') return edited(document);
  if (canvas.isFlowNode(node)) {
    const region = regionOfId(document, id);
    if (region === undefined) return edited(document);
    const sequence = regionSequenceOf(document, region) ?? [];
    const remaining = sequence.filter((member) => member !== id);
    const detached = withRegionSequence(document, region, remaining) ?? document;
    return edited(compactFlowAfter(detached, remaining, sequence.indexOf(id)));
  }
  const root = chainRoot(document, id);
  let next = document;
  for (const declaration of document.nodes) {
    if (declaration.kind === 'var-decl' && declaration.binding.mode !== 'none' && (declaration.id === id || declaration.binding.input === id)) {
      next = setBinding(next, declaration.id, { mode: 'none' }).document;
    }
  }
  for (const parent of document.nodes) {
    if (parent.kind === 'relation' && (parent.left === id || parent.right === id)) {
      const remaining = parent.left === id ? parent.right : parent.left;
      if (remaining !== id && remaining !== canvas.UNCONNECTED) next = spliceRelation(next, parent.id, remaining);
    }
    if (parent.kind === 'group' && canvas.groupMembers(parent).includes(id)) {
      const rows = parent.rows.map((row) => row.filter((member) => member !== id)).filter((row) => row.length > 0);
      const members = rows.flat();
      if (members.length === 0) next = spliceRelation(next, parent.id, id);
      else if (members.length === 1) next = spliceRelation(next, parent.id, members[0]);
      else {
        const group = { ...parent, rows };
        next = compactGroupMembers(replaceNode(next, group), group);
      }
    }
  }
  const remainingRoot = nodeOf(next, root) === undefined ? undefined : root;
  if (remainingRoot !== undefined) {
    const leaves = chainLeaves(next, remainingRoot);
    for (let index = 1; index < leaves.length; index += 1) next = alignAfter(next, leaves[index - 1], leaves[index]);
  }
  return edited(next);
}

function chainLeaves(document: canvas.CanvasDocument, id: string, seen = new Set<string>()): readonly string[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const node = nodeOf(document, id);
  return node?.kind === 'relation' ? [...chainLeaves(document, node.left, seen), ...chainLeaves(document, node.right, seen)] : [id];
}

function chainRoot(document: canvas.CanvasDocument, id: string): string {
  const seen = new Set<string>();
  let root = id;
  while (!seen.has(root)) {
    seen.add(root);
    const parents = document.nodes.filter((node) => (node.kind === 'relation' && (node.left === root || node.right === root)) || (node.kind === 'group' && canvas.groupMembers(node).includes(root)));
    if (parents.length !== 1) break;
    root = parents[0].id;
  }
  return root;
}

/** 两个同类数据结构吸附：数值/布尔运算、串连接、列表组装、变量赋值。 */
export function snapData(document: canvas.CanvasDocument, targetId: string, memberId: string): CanvasEdit {
  const member = nodeOf(document, memberId);
  const target = nodeOf(document, targetId);
  if (member === undefined || target === undefined || memberId === targetId) return edited(document);
  if (!canvas.isValueNode(member) || (!canvas.isValueNode(target) && target.kind !== 'var-decl')) return edited(document);
  if (structureIds(document, targetId).includes(memberId) || structureIds(document, memberId).includes(targetId)) return edited(document);
  const detached = detachChainMember(document, memberId).document;
  if (target.kind === 'var-decl') {
    const bound = setBinding(detached, targetId, { mode: 'initial', input: memberId });
    return bound.issues.length > 0 ? { ...bound, document } : edited(alignAfter(bound.document, memberId, targetId));
  }
  const root = chainRoot(detached, targetId);
  const rootNode = nodeOf(detached, root);
  if (rootNode === undefined) return edited(document);
  let result: CanvasEdit;
  if (rootNode.kind === 'group') {
    const rows = rootNode.rows.map((row) => [...row]);
    if (rows.length === 0) rows.push([]);
    if (rows[rows.length - 1].length >= CANVAS_MAX_ROW_MEMBERS) rows.push([]);
    rows[rows.length - 1].push(memberId);
    const type = canvas.staticTypeOf(detached, memberId);
    const mode = rootNode.mode === 'merge' && type !== canvas.staticTypeOf(detached, root) ? 'list' : rootNode.mode;
    result = edited(replaceNode(detached, { ...rootNode, mode, rows }));
  } else {
    const left = canvas.staticTypeOf(detached, root);
    const right = canvas.staticTypeOf(detached, memberId);
    const op = left === right ? left === 'int' ? 'int.add' : left === 'double' ? 'double.add' : left === 'bool' ? 'bool.and' : undefined : undefined;
    const id = newNodeId(detached, op === undefined ? 'group' : 'relation');
    result = op === undefined ? createGroup(detached, [root, memberId], id)
      : addExistingNode(detached, { id, kind: 'relation', op, left: root, right: memberId }, detached.layout[root] ?? { x: 40, y: 40 });
    if (result.issues.length > 0) return { ...result, document };
    // 原链已经被方法或变量使用时，下游继续读扩展后的整体结果。
    const nodes = result.document.nodes;
    const rewired = rewireInputs({ ...result.document, nodes: nodes.filter((node) => node.id !== id) }, root, id);
    result = edited({ ...rewired, nodes: [...rewired.nodes, ...nodes.filter((node) => node.id === id)] });
  }
  const invalid = canvas.validateCanvasDocument(result.document).issues.find((issue) => issue.code === 'input_cycle' || issue.code === 'ownership_conflict');
  if (invalid !== undefined) return refuse(document, invalid.code, memberId, invalid.message);
  const group = nodeOf(result.document, root);
  return edited(group?.kind === 'group' ? compactGroupMembers(result.document, group) : alignAfter(result.document, root, memberId));
}

/** 留出关系框与两边间距，移动整个右侧结构以保留嵌套布局。 */
function alignAfter(document: canvas.CanvasDocument, left: string, right: string): canvas.CanvasDocument {
  const view = layoutCanvas({ document });
  const leftIds = structureIds(document, left).filter((id) => !structureIds(document, right).includes(id));
  const rightIds = structureIds(document, right);
  const leftRect = unionRects(view.boxes.filter((box) => leftIds.includes(box.nodeId) && box.kind !== 'relation'));
  const rightRect = unionRects(view.boxes.filter((box) => rightIds.includes(box.nodeId) && box.kind !== 'relation'));
  if (leftRect === undefined || rightRect === undefined) return document;
  const dx = leftRect.x + leftRect.width + 112 - rightRect.x;
  const dy = leftRect.y - rightRect.y;
  return withLayout(document, rightIds.map((id) => ({ id, x: (document.layout[id]?.x ?? rightRect.x) + dx, y: (document.layout[id]?.y ?? rightRect.y) + dy })));
}

/** 仅收拢被抽走成员之后的流程，前链保持原位。 */
function compactFlowAfter(document: canvas.CanvasDocument, sequence: readonly string[], index: number): canvas.CanvasDocument {
  let next = document;
  for (let cursor = Math.max(1, index); cursor < sequence.length; cursor += 1) {
    const view = layoutCanvas({ document: next });
    const previous = structureIds(next, sequence[cursor - 1]);
    const current = structureIds(next, sequence[cursor]);
    const before = unionRects(view.boxes.filter((box) => previous.includes(box.nodeId)));
    const after = unionRects(view.boxes.filter((box) => current.includes(box.nodeId)));
    if (before === undefined || after === undefined) continue;
    const moves = current.flatMap((id) => {
      const point = next.layout[id];
      return point === undefined ? [] : [{ id, x: point.x + before.x - after.x, y: point.y + before.y + before.height + 48 - after.y }];
    });
    next = withLayout(next, moves);
  }
  return next;
}
