import { CANVAS_MAX_ROW_MEMBERS, canvas } from '@pwn2block/shared';
import {
  dropGroup,
  edited,
  hasNode,
  isValidNodeId,
  nodeOf,
  refuse,
  replaceNode,
  withNodes,
  type CanvasEdit,
} from './editor-core';
import { removeNodes } from './editor-graph';

/**
 * 包络（组合）与流程序列上的编辑命令（阶段三）。
 *
 * 两类命令共用一条原则：**结构容器只描述归属与顺序，不描述值**。
 * - 组合的 `rows` 是权威行列（需求 §2.2）：插入行、删行、移动成员都写 `rows`，
 *   成员的坐标与组合自身的坐标一概不动，所以「整组移动不改值」自动成立。
 * - 流程用数组表达顺序（需求 §5.2）：语句顺序就是执行顺序，一个流程节点只能出现在一条序列里，
 *   所以「重复放置」在结构上就该被拒绝，而不是靠校验器事后发现。
 */

// ---------------------------------------------------------------------------
// 包络（组合）
// ---------------------------------------------------------------------------

/** 包络的成员规则：至少两个、不能是流程节点、不能在别的包络里、不能重复出现。 */
function groupMemberIssues(
  document: canvas.CanvasDocument,
  groupId: string,
  memberIds: readonly string[],
): readonly canvas.CanvasIssue[] {
  const issues: canvas.CanvasIssue[] = [];
  if (memberIds.length < 2) {
    issues.push(canvas.errorIssue('ownership_conflict', groupId, `包络至少要 2 个成员，收到 ${memberIds.length} 个`));
  }
  const owners = canvas.ownerMapOf(document);
  const seen = new Set<string>();
  for (const memberId of memberIds) {
    if (seen.has(memberId)) {
      issues.push(canvas.errorIssue('ownership_conflict', memberId, `成员「${memberId}」在这次的包络里出现了两次`));
      continue;
    }
    seen.add(memberId);
    const member = nodeOf(document, memberId);
    if (member === undefined) {
      issues.push(canvas.errorIssue('unknown_node', memberId, `成员「${memberId}」不存在`));
      continue;
    }
    if (canvas.isFlowNode(member)) {
      issues.push(
        canvas.errorIssue('ownership_conflict', memberId, `「${memberId}」是流程节点，不能放进包络；它只能进流程序列`),
      );
      continue;
    }
    const owner = owners.get(memberId);
    if (owner !== undefined) {
      issues.push(
        canvas.errorIssue(
          'ownership_conflict',
          memberId,
          `成员「${memberId}」已经属于包络「${owner}」，一个节点只能归属一个容器`,
        ),
      );
    }
  }
  return issues;
}

/** 建组时的默认模式：全字节串合并为字节串、全文本合并为文本，其余组成列表（需求 §2.2）。 */
function defaultGroupMode(document: canvas.CanvasDocument, memberIds: readonly string[]): canvas.GroupMode {
  const kinds: canvas.ValueKind[] = [];
  for (const memberId of memberIds) {
    const type = canvas.staticTypeOf(document, memberId);
    if (type !== undefined && type !== 'any') kinds.push(type);
  }
  return canvas.suggestGroupMode(kinds);
}

function chunk(ids: readonly string[], size: number): readonly (readonly string[])[] {
  const rows: string[][] = [];
  for (let index = 0; index < ids.length; index += size) rows.push([...ids.slice(index, index + size)]);
  return rows;
}

/** 创建一个包络：成员摆成一行（超过单行上限时自动换行），模式缺省按成员静态类型定。 */
export function createGroup(
  document: canvas.CanvasDocument,
  memberIds: readonly string[],
  id: string,
  mode?: canvas.GroupMode,
): CanvasEdit {
  if (!isValidNodeId(id)) {
    return refuse(document, 'invalid_id', id, `节点 id「${id}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, id)) return refuse(document, 'duplicate_id', id, `节点 id「${id}」已经存在`);
  if (mode !== undefined && !isGroupModeSince(mode)) {
    return refuse(document, 'unknown_kind', id, `未知的组合模式「${String(mode)}」`);
  }
  const issues = groupMemberIssues(document, id, memberIds);
  if (issues.length > 0) return { document, issues };
  const node: canvas.GroupNode = {
    kind: 'group',
    id,
    mode: mode ?? defaultGroupMode(document, memberIds),
    rows: chunk(memberIds, CANVAS_MAX_ROW_MEMBERS),
  };
  return edited(withNodes(document, [...document.nodes, node]));
}

/** 模式参数在界面里是字符串下拉，写进文档前收窄一次，免得脏值进存档。 */
function isGroupModeSince(mode: canvas.GroupMode): boolean {
  return canvas.GROUP_MODES.some((known) => known === mode);
}

/** 找组合节点；不存在或种类不对时给出一条可直接显示的问题。 */
function groupTarget(
  document: canvas.CanvasDocument,
  groupId: string,
): { readonly ok: true; readonly group: canvas.GroupNode } | { readonly ok: false; readonly issue: canvas.CanvasIssue } {
  const node = nodeOf(document, groupId);
  if (node === undefined) {
    return { ok: false, issue: canvas.errorIssue('unknown_node', groupId, `组合「${groupId}」不存在`) };
  }
  if (node.kind !== 'group') {
    return {
      ok: false,
      issue: canvas.errorIssue(
        'unknown_kind',
        groupId,
        `节点「${groupId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是组合`,
      ),
    };
  }
  return { ok: true, group: node };
}

/** 解除包络：成员回到顶层（不再有归属），组合节点与它的坐标一起删掉（需求 §6.3）。 */
export function dissolveGroup(document: canvas.CanvasDocument, groupId: string): CanvasEdit {
  const target = groupTarget(document, groupId);
  if (!target.ok) return { document, issues: [target.issue] };
  return edited(dropGroup(document, groupId).document);
}

/** 在指定行之后插入一个空行：`atIndex` 越界就追加到末尾。 */
export function insertRowAfter(
  document: canvas.CanvasDocument,
  groupId: string,
  atIndex: number = Number.MAX_SAFE_INTEGER,
): CanvasEdit {
  const target = groupTarget(document, groupId);
  if (!target.ok) return { document, issues: [target.issue] };
  const rows = target.group.rows.map((row) => [...row]);
  const at = Math.max(-1, Math.min(atIndex, rows.length - 1));
  rows.splice(at + 1, 0, []);
  return edited(replaceNode(document, { ...target.group, rows }));
}

/** 删掉一行；删空最后一行时整个组合失去成员，于是组合也一起删（否则留着 `group_empty`）。 */
export function removeRow(document: canvas.CanvasDocument, groupId: string, rowIndex: number): CanvasEdit {
  const target = groupTarget(document, groupId);
  if (!target.ok) return { document, issues: [target.issue] };
  if (rowIndex < 0 || rowIndex >= target.group.rows.length) return edited(document);
  const rows = target.group.rows.filter((_, index) => index !== rowIndex);
  if (rows.every((row) => row.length === 0)) return edited(dropGroup(document, groupId).document);
  return edited(replaceNode(document, { ...target.group, rows }));
}

/** 把成员挪到指定行列：源行空了整行移除，目标行越界就新开一行（需求 §6.2 拖动落位）。 */
export function moveMember(
  document: canvas.CanvasDocument,
  groupId: string,
  memberId: string,
  rowIndex: number,
  columnIndex: number,
): CanvasEdit {
  const target = groupTarget(document, groupId);
  if (!target.ok) return { document, issues: [target.issue] };
  const rows = target.group.rows;
  if (!canvas.groupMembers(target.group).includes(memberId)) {
    return refuse(document, 'ownership_conflict', memberId, `「${memberId}」不在组合「${groupId}」里，不能移动`);
  }
  const rest = rows.map((row) => row.filter((member) => member !== memberId)).filter((row) => row.length > 0);
  const atRow = Math.max(0, Math.min(rowIndex, rest.length));
  return edited(replaceNode(document, { ...target.group, rows: insertMember(rest, atRow, columnIndex, memberId) }));
}

/** 往第 `rowIndex` 行第 `columnIndex` 列插一个成员；`rowIndex` 等于行数时新开一行。 */
function insertMember(
  rows: readonly (readonly string[])[],
  rowIndex: number,
  columnIndex: number,
  memberId: string,
): readonly (readonly string[])[] {
  if (rowIndex >= rows.length) return [...rows, [memberId]];
  return rows.map((row, index) => {
    if (index !== rowIndex) return row;
    const at = Math.max(0, Math.min(columnIndex, row.length));
    return [...row.slice(0, at), memberId, ...row.slice(at)];
  });
}

// ---------------------------------------------------------------------------
// 流程序列
// ---------------------------------------------------------------------------

const REGION_LABELS: Readonly<Record<canvas.FlowRegionKind, string>> = {
  main: '顶层序列',
  then: '成立分支',
  else: '不成立分支',
  body: '循环体',
};

/** 一条序列的当前内容；区域种类与容器对不上、或容器不存在时返回 `undefined`。 */
export function regionSequenceOf(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
): readonly string[] | undefined {
  if (region.kind === 'main') return region.ownerId === '' ? document.main : undefined;
  const owner = nodeOf(document, region.ownerId);
  if (owner === undefined) return undefined;
  if (region.kind === 'body') return owner.kind === 'loop' ? owner.body : undefined;
  if (owner.kind !== 'if') return undefined;
  return region.kind === 'then' ? owner.then : owner.else;
}

/** 写回一条序列；区域不合法时返回 `undefined`，由调用方报 `flow_error`。 */
export function withRegionSequence(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  ids: readonly string[],
): canvas.CanvasDocument | undefined {
  if (region.kind === 'main') return region.ownerId === '' ? { ...document, main: ids } : undefined;
  const owner = nodeOf(document, region.ownerId);
  if (owner === undefined) return undefined;
  if (region.kind === 'body') return owner.kind === 'loop' ? replaceNode(document, { ...owner, body: ids }) : undefined;
  if (owner.kind !== 'if') return undefined;
  return replaceNode(document, region.kind === 'then' ? { ...owner, then: ids } : { ...owner, else: ids });
}

/** 文档里所有可放语句的区域：`main` 加每个分支的两条、每个循环的一条（按文档顺序）。 */
export function regionRefsOf(document: canvas.CanvasDocument): readonly canvas.FlowRegionRef[] {
  const refs: canvas.FlowRegionRef[] = [{ ownerId: '', kind: 'main' }];
  for (const node of document.nodes) {
    if (node.kind === 'if') {
      refs.push({ ownerId: node.id, kind: 'then' }, { ownerId: node.id, kind: 'else' });
    } else if (node.kind === 'loop') {
      refs.push({ ownerId: node.id, kind: 'body' });
    }
  }
  return refs;
}

/** 一个流程节点现在落在哪条序列里；不在任何序列里返回 `undefined`。 */
export function regionOfId(
  document: canvas.CanvasDocument,
  nodeId: string,
): canvas.FlowRegionRef | undefined {
  for (const region of regionRefsOf(document)) {
    const ids = regionSequenceOf(document, region);
    if (ids !== undefined && ids.includes(nodeId)) return region;
  }
  return undefined;
}

function regionLabel(region: canvas.FlowRegionRef): string {
  return region.kind === 'main' ? '顶层序列' : `「${region.ownerId}」的${REGION_LABELS[region.kind]}`;
}

/** 区域不合法时的说明：容器不存在与容器种类不对是两件事，分开说。 */
function regionIssue(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
): canvas.CanvasIssue {
  if (region.kind === 'main') {
    return canvas.errorIssue('flow_error', region.ownerId, `顶层序列的 ownerId 必须是空串，收到「${region.ownerId}」`);
  }
  const owner = nodeOf(document, region.ownerId);
  if (owner === undefined) {
    return canvas.errorIssue('flow_error', region.ownerId, `区域所属的节点「${region.ownerId}」不存在`);
  }
  return canvas.errorIssue(
    'flow_error',
    region.ownerId,
    `节点「${region.ownerId}」是「${canvas.CANVAS_NODE_KIND_LABELS[owner.kind]}」，没有${REGION_LABELS[region.kind]}这个区域`,
  );
}

/**
 * 往一条序列里插一条语句。
 *
 * 只做「能表达」这一层判断：节点得是流程节点、不能已经被别的序列引用、区域得真实存在；
 * `index` 越界就追加到末尾。开始节点是否在 `main` 第一位、区域嵌套深度这类语义规则
 * 交给 `validateCanvasDocument`，命令层不抢它的活。
 */
export function insertStatement(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  index: number,
  nodeId: string,
): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (!canvas.isFlowNode(node)) {
    return refuse(document, 'flow_error', nodeId, `「${nodeId}」是数据节点，只能接在语句的输入上，不能放进流程序列`);
  }
  const placed = regionOfId(document, nodeId);
  if (placed !== undefined) {
    return refuse(
      document,
      'flow_error',
      nodeId,
      `流程节点「${nodeId}」已经在${regionLabel(placed)}里，一个流程节点只能出现在一条序列里`,
    );
  }
  const sequence = regionSequenceOf(document, region);
  if (sequence === undefined) return { document, issues: [regionIssue(document, region)] };
  const at = index >= 0 && index <= sequence.length ? index : sequence.length;
  const next = withRegionSequence(document, region, [...sequence.slice(0, at), nodeId, ...sequence.slice(at)]);
  return next === undefined ? { document, issues: [regionIssue(document, region)] } : edited(next);
}

/** 便捷入口：把一条语句追加到 `main` 末尾。 */
export function appendStatement(document: canvas.CanvasDocument, nodeId: string): CanvasEdit {
  return insertStatement(document, { ownerId: '', kind: 'main' }, Number.MAX_SAFE_INTEGER, nodeId);
}

/** 同一条序列内移动：`to` 越界就夹到末尾，挪完没变化时原样返回。 */
export function moveStatement(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  from: number,
  to: number,
): CanvasEdit {
  const sequence = regionSequenceOf(document, region);
  if (sequence === undefined) return { document, issues: [regionIssue(document, region)] };
  if (from < 0 || from >= sequence.length) {
    return refuse(
      document,
      'flow_error',
      region.ownerId,
      `${regionLabel(region)}里没有第 ${from} 项（共 ${sequence.length} 项）`,
    );
  }
  const moved = sequence[from];
  const rest = sequence.filter((_, index) => index !== from);
  const at = Math.max(0, Math.min(to, rest.length));
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
  const unchanged = next.length === sequence.length && next.every((id, index) => id === sequence[index]);
  if (unchanged) return edited(document);
  const applied = withRegionSequence(document, region, next);
  return applied === undefined ? { document, issues: [regionIssue(document, region)] } : edited(applied);
}

/** 删一条语句：连带删掉它的区域成员与引用它的语句，和删节点同一套连带删除规则。 */
export function removeStatement(document: canvas.CanvasDocument, nodeId: string): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (!canvas.isFlowNode(node)) {
    return refuse(document, 'flow_error', nodeId, `「${nodeId}」不是流程节点，删数据节点请用 removeNodes`);
  }
  return edited(removeNodes(document, [nodeId]).document);
}
