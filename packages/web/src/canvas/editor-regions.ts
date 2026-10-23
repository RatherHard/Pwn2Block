import { CANVAS_MAX_FLOW_DEPTH, canvas } from '@pwn2block/shared';
import {
  edited,
  hasNode,
  isValidNodeId,
  nodeOf,
  refuse,
  withLayout,
  withNodes,
  withoutLayout,
  type CanvasEdit,
} from './editor-core';
import {
  REGION_LABELS,
  regionIssue,
  regionLabel,
  regionOfId,
  regionSequenceOf,
  withRegionSequence,
} from './editor-containers';

/**
 * 流程区域的包络与解除（需求 §6.3、验收表 AT-15）。
 *
 * 四条命令：`wrapInLoop` / `wrapInBranch` 把同一序列里连续的一段语句包进新容器，
 * `unwrapLoop` / `unwrapBranch` 把区域里的语句按原顺序接回容器原来所在的位置。
 *
 * 五条边界：
 * 1. **只包连续的一段**：`from` / `to` 是那条序列上的下标且含端点，区间里的语句一条不少、
 *    一条不多地进新区域。「把不相邻的两段一起包」在结构上表达不出来，所以直接拒绝。
 * 2. **一个流程节点只属于一条序列**：包进去就是「从原序列移除、写进新区域」，不做复制。
 * 3. **深度先算后改**：包进去会让被包的那一支整体下沉一层，超过 `CANVAS_MAX_FLOW_DEPTH`
 *    就拒绝（需求 §5.2 的嵌套上限），而不是等校验器事后报错。展开只会往上提一层，深度只会变小，
 *    所以不设上限检查。
 * 4. **展开是确定的顺序拼接**：循环体接回原位置；分支按「成立分支在前、不成立分支在后」接回原位置。
 *    这是**顺序展开**，不是把两条路径合并成一个结果——需求 §6.3 明确不提供会含糊合并两条路径的
 *    一键解除，所以顺序写死在这里、也写进拒绝文案，界面只给「解除」这一个入口。
 * 5. **坐标只做最小交代**：新容器继承第一个被包语句的坐标；展开时容器自己的 `layout` 删掉，
 *    语句自己的坐标不动，于是「包进去再展开」回到原来的位置。
 */

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 包进包络的定位：`ownerId` 是这段语句所在区域的容器 id，`main` 用空串（与 `FlowRegionRef` 同一口径）。 */
export interface WrapRequest {
  readonly ownerId: string;
  /** 区间起点（含），按那条序列的下标。 */
  readonly from: number;
  /** 区间终点（含）。 */
  readonly to: number;
  /** 条件分支有两条区域，`ownerId` 指向分支时必须指明是哪一条。 */
  readonly kind?: canvas.FlowRegionKind;
}

/** 包进新循环：`count` 是次数端口的节点 id，还没接线就传 `canvas.UNCONNECTED`。 */
export interface WrapLoopRequest extends WrapRequest {
  readonly loopId: string;
  readonly count: string;
}

/** 包进新条件分支：两个区域都从空开始，被包的语句进「成立」那一支。 */
export interface WrapBranchRequest extends WrapRequest {
  readonly ifId: string;
  readonly cond: string;
}

/** 用一条已经算好的问题拒绝，与 `refuse` 同一形状（问题在辅助函数里生成时用）。 */
function refused(document: canvas.CanvasDocument, issue: canvas.CanvasIssue): CanvasEdit {
  return refuse(document, issue.code, issue.nodeId, issue.message);
}

// ---------------------------------------------------------------------------
// 区域定位与区间检查
// ---------------------------------------------------------------------------

type Resolution =
  | { readonly ok: true; readonly region: canvas.FlowRegionRef }
  | { readonly ok: false; readonly issue: canvas.CanvasIssue };

function unresolved(nodeId: string, message: string): Resolution {
  return { ok: false, issue: canvas.errorIssue('flow_error', nodeId, message) };
}

/** 把「区域所属容器 + 可选区域种类」收窄成一条真实存在的序列。 */
function resolveRegion(document: canvas.CanvasDocument, request: WrapRequest): Resolution {
  if (request.ownerId === '') {
    if (request.kind !== undefined && request.kind !== 'main') {
      return unresolved('', `顶层序列没有${REGION_LABELS[request.kind]}，只有 main 这一条`);
    }
    return { ok: true, region: { ownerId: '', kind: 'main' } };
  }
  const owner = nodeOf(document, request.ownerId);
  if (owner === undefined) return unresolved(request.ownerId, `区域所属的节点「${request.ownerId}」不存在`);
  if (owner.kind === 'loop') {
    if (request.kind !== undefined && request.kind !== 'body') {
      return unresolved(request.ownerId, `「${request.ownerId}」是次数循环，只有循环体这一条区域`);
    }
    return { ok: true, region: { ownerId: request.ownerId, kind: 'body' } };
  }
  if (owner.kind === 'if') {
    if (request.kind !== 'then' && request.kind !== 'else') {
      return unresolved(request.ownerId, `「${request.ownerId}」是条件分支，有成立与不成立两条区域：请指明包进哪一条`);
    }
    return { ok: true, region: { ownerId: request.ownerId, kind: request.kind } };
  }
  return unresolved(
    request.ownerId,
    `节点「${request.ownerId}」是「${canvas.CANVAS_NODE_KIND_LABELS[owner.kind]}」，没有可以放语句的区域`,
  );
}

type Interval =
  | { readonly ok: true; readonly members: readonly string[] }
  | { readonly ok: false; readonly issue: canvas.CanvasIssue };

/** 取区间里的语句：越界、倒序、区间里夹着数据节点都算「不是同一段连续流程」。 */
function intervalOf(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  sequence: readonly string[],
  from: number,
  to: number,
): Interval {
  if (from < 0 || to < from || to >= sequence.length) {
    return {
      ok: false,
      issue: canvas.errorIssue(
        'flow_error',
        region.ownerId,
        `${regionLabel(region)}里的第 ${from}–${to} 项不是连续的一段（共 ${sequence.length} 项），只能包同一条序列里连续的一组语句`,
      ),
    };
  }
  const members = sequence.slice(from, to + 1);
  for (const memberId of members) {
    const member = nodeOf(document, memberId);
    if (member === undefined) {
      return {
        ok: false,
        issue: canvas.errorIssue('unknown_node', memberId, `区间里的「${memberId}」不存在，先修好这条序列`),
      };
    }
    if (!canvas.isFlowNode(member)) {
      return {
        ok: false,
        issue: canvas.errorIssue('flow_error', memberId, `区间里的「${memberId}」是数据节点，只能包流程语句`),
      };
    }
  }
  return { ok: true, members };
}

// ---------------------------------------------------------------------------
// 嵌套深度
// ---------------------------------------------------------------------------

/** 序列里的语句现在所处的深度：`main` 是 0，区域的成员是容器深度 + 1。 */
function sequenceDepthOf(document: canvas.CanvasDocument, region: canvas.FlowRegionRef): number {
  if (region.kind === 'main') return 0;
  return (canvas.analyzeFlow(document).depthOf.get(region.ownerId) ?? 0) + 1;
}

/** 一个节点下面还有几层：叶子 0，容器是 1 + 它子序列里最深的那一个（`visiting` 挡脏存档的环）。 */
function subtreeDepthOf(document: canvas.CanvasDocument, nodeId: string, visiting: Set<string>): number {
  if (visiting.has(nodeId)) return 0;
  const node = nodeOf(document, nodeId);
  if (node === undefined) return 0;
  visiting.add(nodeId);
  let deepest = 0;
  for (const sequence of canvas.flowChildrenOf(node)) {
    for (const child of sequence) deepest = Math.max(deepest, 1 + subtreeDepthOf(document, child, visiting));
  }
  visiting.delete(nodeId);
  return deepest;
}

/** 包进去以后最深会到几层：被包的那一支整体下沉一层，超过上限就拒绝。 */
function depthIssueOf(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  members: readonly string[],
  containerId: string,
): canvas.CanvasIssue | undefined {
  const base = sequenceDepthOf(document, region) + 1;
  let deepest = base;
  for (const memberId of members) {
    deepest = Math.max(deepest, base + subtreeDepthOf(document, memberId, new Set()));
  }
  if (deepest <= CANVAS_MAX_FLOW_DEPTH) return undefined;
  return canvas.errorIssue(
    'limit_exceeded',
    containerId,
    `包进「${containerId}」后区域嵌套深度会到 ${deepest}，超过上限 ${CANVAS_MAX_FLOW_DEPTH}`,
  );
}

// ---------------------------------------------------------------------------
// 包进循环 / 条件分支
// ---------------------------------------------------------------------------

/** 按被包的成员拼出新容器节点；id 与区域归属由 `wrapRegion` 先校验过。 */
type Wrapper = (members: readonly string[]) => canvas.CanvasNode;

/** 新容器继承第一个被包语句的坐标：包进去的容器就出现在原来那段流程的起点。 */
function inheritLayout(
  document: canvas.CanvasDocument,
  nodeId: string,
  members: readonly string[],
): canvas.CanvasDocument {
  const first = members[0];
  const at = first === undefined ? undefined : document.layout[first];
  return at === undefined ? document : withLayout(document, [{ id: nodeId, x: at.x, y: at.y }]);
}

/** 包络的公共流程：校验 id、定位区域、检查区间与深度，最后写回序列并加入新节点。 */
function wrapRegion(document: canvas.CanvasDocument, request: WrapRequest, newId: string, wrap: Wrapper): CanvasEdit {
  if (!isValidNodeId(newId)) {
    return refuse(document, 'invalid_id', newId, `节点 id「${newId}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, newId)) {
    return refuse(document, 'duplicate_id', newId, `节点 id「${newId}」已经存在，换一个再包`);
  }
  const resolved = resolveRegion(document, request);
  if (!resolved.ok) return refused(document, resolved.issue);
  const region = resolved.region;
  const sequence = regionSequenceOf(document, region);
  if (sequence === undefined) return refused(document, regionIssue(document, region));
  const interval = intervalOf(document, region, sequence, request.from, request.to);
  if (!interval.ok) return refused(document, interval.issue);
  const depth = depthIssueOf(document, region, interval.members, newId);
  if (depth !== undefined) return refused(document, depth);
  const nextSequence = [...sequence.slice(0, request.from), newId, ...sequence.slice(request.to + 1)];
  const placed = withRegionSequence(document, region, nextSequence);
  if (placed === undefined) return refused(document, regionIssue(document, region));
  const positioned = inheritLayout(placed, newId, interval.members);
  return edited(withNodes(positioned, [...positioned.nodes, wrap(interval.members)]));
}

/** 把同一序列里连续的一段语句包进新循环：被包的语句按原顺序成为循环体（需求 §6.3「包络为循环」）。 */
export function wrapInLoop(document: canvas.CanvasDocument, request: WrapLoopRequest): CanvasEdit {
  return wrapRegion(document, request, request.loopId, (body) => ({
    kind: 'loop',
    id: request.loopId,
    count: request.count,
    body: [...body],
  }));
}

/** 把同一序列里连续的一段语句包进新条件分支：分支自带两个区域，只有「成立」那一支有语句。 */
export function wrapInBranch(document: canvas.CanvasDocument, request: WrapBranchRequest): CanvasEdit {
  return wrapRegion(document, request, request.ifId, (then) => ({
    kind: 'if',
    id: request.ifId,
    cond: request.cond,
    then: [...then],
    else: [],
  }));
}

// ---------------------------------------------------------------------------
// 解除循环 / 条件分支
// ---------------------------------------------------------------------------

type Placement =
  | { readonly ok: true; readonly region: canvas.FlowRegionRef; readonly sequence: readonly string[]; readonly index: number }
  | { readonly ok: false; readonly issue: canvas.CanvasIssue };

/** 容器现在落在哪条序列里：不在任何序列里时没有「原位置」可以接回。 */
function placementOf(document: canvas.CanvasDocument, containerId: string): Placement {
  const region = regionOfId(document, containerId);
  if (region === undefined) {
    return {
      ok: false,
      issue: canvas.errorIssue('flow_error', containerId, `「${containerId}」还没有接进任何序列，先把容器放进流程再解除`),
    };
  }
  const sequence = regionSequenceOf(document, region);
  const index = sequence === undefined ? -1 : sequence.indexOf(containerId);
  if (sequence === undefined || index < 0) {
    return {
      ok: false,
      issue: canvas.errorIssue('flow_error', containerId, `${regionLabel(region)}里找不到「${containerId}」`),
    };
  }
  return { ok: true, region, sequence, index };
}

/**
 * 区域里的语句只能属于**这个容器自己**的区域：脏存档里同一句同时排进两条序列时，
 * 展开会把它复制成两条，所以先拒绝。
 */
function exclusiveIssueOf(
  document: canvas.CanvasDocument,
  containerId: string,
  kinds: readonly canvas.FlowRegionKind[],
  members: readonly string[],
): canvas.CanvasIssue | undefined {
  for (const memberId of members) {
    const placed = regionOfId(document, memberId);
    if (placed === undefined) continue;
    if (placed.ownerId === containerId && kinds.includes(placed.kind)) continue;
    return canvas.errorIssue(
      'flow_error',
      memberId,
      `「${memberId}」同时出现在${regionLabel(placed)}里，先删掉重复放置再解除`,
    );
  }
  return undefined;
}

/** 写回展开后的序列，并删掉容器节点与它的坐标（需求 §6.3：`layout` 一并清理）。 */
function expandedDocument(
  document: canvas.CanvasDocument,
  region: canvas.FlowRegionRef,
  sequence: readonly string[],
  containerId: string,
): canvas.CanvasDocument {
  const written = withRegionSequence(document, region, sequence);
  if (written === undefined) return document;
  const nodes = written.nodes.filter((node) => node.id !== containerId);
  return withoutLayout({ ...written, nodes }, new Set([containerId]));
}

/** 解除循环：循环体按原顺序接回循环原来所在的位置，再删掉循环节点（需求 §6.3「解除循环 = 展开循环体」）。 */
export function unwrapLoop(document: canvas.CanvasDocument, loopId: string): CanvasEdit {
  const node = nodeOf(document, loopId);
  if (node === undefined) return refuse(document, 'unknown_node', loopId, `节点「${loopId}」不存在`);
  if (node.kind !== 'loop') {
    return refuse(
      document,
      'unknown_kind',
      loopId,
      `节点「${loopId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是次数循环，没有循环体可以展开`,
    );
  }
  const placement = placementOf(document, loopId);
  if (!placement.ok) return refused(document, placement.issue);
  const duplicate = exclusiveIssueOf(document, loopId, ['body'], node.body);
  if (duplicate !== undefined) return refused(document, duplicate);
  const expanded = [
    ...placement.sequence.slice(0, placement.index),
    ...node.body,
    ...placement.sequence.slice(placement.index + 1),
  ];
  return edited(expandedDocument(document, placement.region, expanded, loopId));
}

/**
 * 解除条件分支：**成立分支在前、不成立分支在后**，两段按各自原来的顺序接回分支原来所在的位置。
 *
 * 这是确定的顺序展开，不是「合并两条路径」：不产生新的合流节点，也不会让两条路径同时执行。
 * 需求 §6.3 明确不提供会含糊合并两条路径的一键解除，所以顺序写死在这里、也写进拒绝文案。
 */
export function unwrapBranch(document: canvas.CanvasDocument, ifId: string): CanvasEdit {
  const node = nodeOf(document, ifId);
  if (node === undefined) return refuse(document, 'unknown_node', ifId, `节点「${ifId}」不存在`);
  if (node.kind !== 'if') {
    return refuse(
      document,
      'unknown_kind',
      ifId,
      `节点「${ifId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是条件分支；只有条件分支能按「成立分支在前、不成立分支在后」的顺序展开`,
    );
  }
  const placement = placementOf(document, ifId);
  if (!placement.ok) return refused(document, placement.issue);
  const duplicate = exclusiveIssueOf(document, ifId, ['then', 'else'], [...node.then, ...node.else]);
  if (duplicate !== undefined) return refused(document, duplicate);
  const expanded = [
    ...placement.sequence.slice(0, placement.index),
    ...node.then,
    ...node.else,
    ...placement.sequence.slice(placement.index + 1),
  ];
  return edited(expandedDocument(document, placement.region, expanded, ifId));
}
