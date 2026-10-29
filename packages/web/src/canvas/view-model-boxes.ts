import { canvas } from '@pwn2block/shared';
import {
  anchorRectOf,
  canvasPositionsOf,
  centerOf,
  inflateRect,
  nodeBoxSize,
  rectsOverlap,
  relationBoxSize,
  unionRects,
  RELATION_ABOVE_GAP,
  RELATION_CLEARANCE,
  RELATION_DODGE_COLUMN,
  RELATION_DODGE_STEPS,
  RELATION_GAP,
} from './view-model-geometry';
import { isRelationBoxKind, toneOfKind } from './view-model-rows';
import type { CanvasBox, CanvasRow, Rect } from './view-model-types';

/**
 * 盒子的位置与尺寸（任务几何规则 1–3）。
 *
 * 位置来自 `document.layout`；没有 layout 的节点用确定网格（`canvasPositionsOf`）兜底，不用随机数。
 * 关系方框的位置要**递归依赖**它的输入来源（来源也可能是另一个关系方框），所以这里是一个带记忆的
 * 小型求值器：`rectOf` 缓存每个节点的矩形，`visiting` 挡住脏存档里的引用环（遇到环就当这一支没有盒子，
 * 让外层退回「放在自己上方 40」的规则），保证任何输入都能算完、且结果只取决于文档。
 */

/** 一个节点的标题与副标题：由 `view-model-rows.ts` 算好，盒子只负责摆位置。 */
export interface NodeDeck {
  readonly title: string;
  readonly subtitle?: string;
}

/** 盒子布局的结果：两类盒子的绘制顺序 + 每个节点的矩形（端口与连线都读它）。 */
export interface BoxLayout {
  /** 大白框，按文档顺序。 */
  readonly nodeBoxes: readonly CanvasBox[];
  /** 关系方框，按文档顺序。 */
  readonly relationBoxes: readonly CanvasBox[];
  /** 节点 id → 它自己的盒子矩形（大白框或关系方框）。 */
  readonly rectOf: ReadonlyMap<string, Rect>;
  /** 只出关系方框的节点 id：端口排布与连线途经都用它判断。 */
  readonly relationIds: ReadonlySet<string>;
}

/** 求值器状态：位置表、矩形缓存、防环集合与三份查表。 */
interface ResolverState {
  readonly nodes: ReadonlyMap<string, canvas.CanvasNode>;
  readonly positions: ReadonlyMap<string, canvas.CanvasNodeLayout>;
  readonly rects: Map<string, Rect>;
  readonly visiting: Set<string>;
  readonly rowsByNode: ReadonlyMap<string, readonly CanvasRow[]>;
  readonly decks: ReadonlyMap<string, NodeDeck>;
}

/** 装盒子的两个数组加关系方框集合；只在本文件内部累积，对外是只读视图。 */
interface BoxSink {
  readonly nodeBoxes: CanvasBox[];
  readonly relationBoxes: CanvasBox[];
  readonly relationIds: Set<string>;
}

/** 算出全部盒子。`boxes` 的最终顺序由 `layoutCanvas` 拼（包络在前）。 */
export function resolveBoxLayout(
  document: canvas.CanvasDocument,
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  rowsByNode: ReadonlyMap<string, readonly CanvasRow[]>,
  decks: ReadonlyMap<string, NodeDeck>,
): BoxLayout {
  const state: ResolverState = {
    nodes,
    positions: canvasPositionsOf(document),
    rects: new Map<string, Rect>(),
    visiting: new Set<string>(),
    rowsByNode,
    decks,
  };
  const sink: BoxSink = { nodeBoxes: [], relationBoxes: [], relationIds: new Set<string>() };
  for (const node of nodes.values()) appendBox(state, node, sink);
  return {
    nodeBoxes: sink.nodeBoxes,
    relationBoxes: sink.relationBoxes,
    rectOf: state.rects,
    relationIds: sink.relationIds,
  };
}

/** 一个节点：算矩形、分到「大白框」或「关系方框」。 */
function appendBox(state: ResolverState, node: canvas.CanvasNode, sink: BoxSink): void {
  const rect = rectOf(state, node.id);
  if (rect === undefined) return;
  const deck = state.decks.get(node.id);
  const title = deck?.title ?? canvas.CANVAS_NODE_KIND_LABELS[node.kind];
  const tone = toneOfKind(node.kind);
  if (isRelationBoxKind(node.kind)) {
    sink.relationIds.add(node.id);
    sink.relationBoxes.push({
      id: `relation:${node.id}`,
      nodeId: node.id,
      kind: 'relation',
      ...rect,
      title,
      subtitle: deck?.subtitle,
      tone,
    });
    return;
  }
  sink.nodeBoxes.push({
    id: `node:${node.id}`,
    nodeId: node.id,
    kind: 'node',
    ...rect,
    title,
    subtitle: deck?.subtitle,
    tone,
  });
}

/** 节点的盒子矩形（记忆化）；环上的节点返回 `undefined`，让调用方走回退规则。 */
function rectOf(state: ResolverState, nodeId: string): Rect | undefined {
  const cached = state.rects.get(nodeId);
  if (cached !== undefined) return cached;
  if (state.visiting.has(nodeId)) return undefined;
  const node = state.nodes.get(nodeId);
  if (node === undefined) return undefined;
  state.visiting.add(nodeId);
  const rect = isRelationBoxKind(node.kind)
    ? relationRectOf(state, node)
    : nodeRectOf(state, node);
  state.visiting.delete(nodeId);
  state.rects.set(nodeId, rect);
  return rect;
}

/** 大白框：布局原点 + 行数算出的尺寸（需求 §6.1「白框节点」）。 */
function nodeRectOf(state: ResolverState, node: canvas.CanvasNode): Rect {
  const position = state.positions.get(node.id) ?? { x: 0, y: 0 };
  const size = nodeBoxSize(state.rowsByNode.get(node.id) ?? [], state.decks.get(node.id)?.title ?? '');
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/**
 * 关系方框（需求 §6.1「与两个数据节点均留有间距」）：
 * - 有已接线的来源 → 方框放在**所有来源右边缘再往右 `RELATION_GAP`**，竖直对齐来源中心的平均值。
 *   旧规则取两个输出点的中点，来源上下排时方框会正好压在两个白框之间、甚至盖住它们；
 *   放在来源右侧的空隙里，进线一定是「来源 → 方框」的短横线，出线再接到下游。
 * - 一个都没接 → 放在自己锚点上方 40 处，x 与锚点对齐。
 *
 * 两种情况最后都过一遍避让（`dodge`）：与任何大白框或已经摆好的关系方框留出 `RELATION_CLEARANCE`。
 * 避让只按「上下交替、再往右挪一列」的固定顺序试，同一份文档永远落在同一个位置。
 */
function relationRectOf(state: ResolverState, node: canvas.CanvasNode): Rect {
  const size = relationBoxSize(node.kind === 'relation' ? canvas.binaryOperatorSpec(node.op).symbol : state.decks.get(node.id)?.title ?? '');
  const sources = sourceRectsOf(state, node);
  if (sources.length === 0) {
    const anchor = anchorRectOf(state.positions.get(node.id) ?? { x: 0, y: 0 });
    const above = { x: anchor.x, y: anchor.y - RELATION_ABOVE_GAP - size.height, ...size };
    return dodge(state, node.id, above);
  }
  if (node.kind === 'relation' && sources.length === 2) {
    const [left, right] = sources;
    const gap = right.x - (left.x + left.width);
    if (gap >= size.width + 16) return { x: left.x + left.width + (gap - size.width) / 2, y: (left.y + left.height / 2 + right.y + right.height / 2 - size.height) / 2, ...size };
  }
  const right = Math.max(...sources.map((rect) => rect.x + rect.width));
  const middle = sources.reduce((sum, rect) => sum + centerOf(rect).y, 0) / sources.length;
  const preferred = { x: right + RELATION_GAP, y: Math.round(middle - size.height / 2), ...size };
  return dodge(state, node.id, preferred);
}

/** 已接线输入来源的矩形（按输入顺序）；来源没有盒子（悬空或成环）时跳过。 */
function sourceRectsOf(state: ResolverState, node: canvas.CanvasNode): readonly Rect[] {
  const rects: Rect[] = [];
  for (const ref of canvas.inputRefsOf(node)) {
    if (ref.id === undefined) continue;
    const source = node.kind === 'relation' ? structureRectOf(state, ref.id, new Set()) : rectOf(state, ref.id);
    if (source !== undefined) rects.push(source);
  }
  return rects;
}

/**
 * 避让：从首选位置起，竖直方向按 0、+1、−1、+2、−2… 档（每档一个方框高 + 空隙）试，
 * 一整列都撞上就往右挪一列再试；全部撞上时退回首选位置（宁可重叠也不跑到看不见的地方）。
 */
function structureRectOf(state: ResolverState, id: string, seen: Set<string>): Rect | undefined {
  if (seen.has(id)) return undefined;
  seen.add(id);
  const node = state.nodes.get(id);
  if (node?.kind !== 'relation' && node?.kind !== 'group') return rectOf(state, id);
  return unionRects(canvas.inputRefsOf(node).flatMap((ref) => ref.id === undefined ? [] : structureRectOf(state, ref.id, seen) ?? [])) ?? rectOf(state, id);
}

function dodge(state: ResolverState, nodeId: string, preferred: Rect): Rect {
  const obstacles = obstaclesOf(state, nodeId);
  const step = preferred.height + RELATION_CLEARANCE;
  for (let column = 0; column < RELATION_DODGE_STEPS; column += 1) {
    for (let index = 0; index <= RELATION_DODGE_STEPS * 2; index += 1) {
      const offset = index === 0 ? 0 : Math.ceil(index / 2) * (index % 2 === 1 ? 1 : -1);
      const candidate = { ...preferred, x: preferred.x + column * RELATION_DODGE_COLUMN, y: preferred.y + offset * step };
      const padded = inflateRect(candidate, RELATION_CLEARANCE);
      if (!obstacles.some((rect) => rectsOverlap(padded, rect))) return candidate;
    }
  }
  return preferred;
}

/** 方框要躲开的东西：全部大白框（只看布局，不依赖关系方框），加上已经摆好的其它关系方框。 */
function obstaclesOf(state: ResolverState, nodeId: string): readonly Rect[] {
  const rects: Rect[] = [];
  for (const node of state.nodes.values()) {
    if (node.id === nodeId) continue;
    if (!isRelationBoxKind(node.kind)) {
      rects.push(nodeRectOf(state, node));
      continue;
    }
    const placed = state.rects.get(node.id);
    if (placed !== undefined) rects.push(placed);
  }
  return rects;
}
