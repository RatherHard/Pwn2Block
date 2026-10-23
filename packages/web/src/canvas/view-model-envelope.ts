import { canvas } from '@pwn2block/shared';
import { convertLabelOf } from './catalog';
import {
  canvasPositionsOf,
  EMPTY_GROUP_HEIGHT,
  EMPTY_GROUP_WIDTH,
  ENVELOPE_PADDING,
  GROUP_PADDING,
  inflateRect,
  unionRects,
} from './view-model-geometry';
import type { CanvasBox, Rect } from './view-model-types';

/**
 * 包络框（任务几何规则 5）：
 * - **组合**（`group`）：成员盒子的并集，各边 +12；成员为空时用自身 layout 给 160×80。
 * - **转换**（`convert`）：`convert.input` 引用节点（或它包住的那个组合）的矩形，各边 +16。
 *
 * 归属只看成员关系、不看坐标（需求 §4.1「包络是结构容器，不是按坐标判断成员的视觉选框」）。
 * 嵌套靠递归：内层组合先算出包络，外层再把内层包络当成员盒子用；`visiting` 挡住把两个组合互相
 * 记成成员的脏存档，避免死循环。包络永远画在节点下面，所以返回前按面积从大到小排（外层在前）。
 */

/** 包络求值状态：位置表、组合包络缓存、防环集合与「节点自己的盒子」。 */
interface EnvelopeState {
  readonly nodes: ReadonlyMap<string, canvas.CanvasNode>;
  readonly positions: ReadonlyMap<string, canvas.CanvasNodeLayout>;
  readonly boxRectOf: (nodeId: string) => Rect | undefined;
  readonly groupRects: Map<string, Rect>;
  readonly visiting: Set<string>;
}

/** 算出全部包络框（组合与转换），已按绘制顺序排好。 */
export function buildEnvelopeBoxes(
  document: canvas.CanvasDocument,
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  boxRectOf: (nodeId: string) => Rect | undefined,
): readonly CanvasBox[] {
  const state: EnvelopeState = {
    nodes,
    positions: canvasPositionsOf(document),
    boxRectOf,
    groupRects: new Map<string, Rect>(),
    visiting: new Set<string>(),
  };
  const boxes: CanvasBox[] = [];
  for (const node of nodes.values()) {
    const box = envelopeOf(state, node);
    if (box !== undefined) boxes.push(box);
  }
  return sortEnvelopes(boxes);
}

/** 一个节点对应的包络；不是组合、也没有可包住的内部结构时返回 `undefined`。 */
function envelopeOf(state: EnvelopeState, node: canvas.CanvasNode): CanvasBox | undefined {
  if (node.kind === 'group') {
    const rect = groupRectOf(state, node.id);
    if (rect === undefined) return undefined;
    return {
      id: `group:${node.id}`,
      nodeId: node.id,
      kind: 'group',
      ...rect,
      title: canvas.CANVAS_NODE_KIND_LABELS.group,
      subtitle: canvas.GROUP_MODE_LABELS[node.mode],
      tone: 'data',
    };
  }
  if (node.kind !== 'convert' || node.input === canvas.UNCONNECTED) return undefined;
  const inner = drawableRectOf(state, node.input);
  if (inner === undefined) return undefined;
  return {
    id: `envelope:${node.id}`,
    nodeId: node.id,
    kind: 'envelope',
    ...inflateRect(inner, ENVELOPE_PADDING),
    title: convertLabelOf(node.spec),
    subtitle: canvas.CANVAS_NODE_KIND_LABELS.convert,
    tone: 'convert',
  };
}

/** 组合包络（记忆化）；成环或不是组合时返回 `undefined`。 */
function groupRectOf(state: EnvelopeState, nodeId: string): Rect | undefined {
  const cached = state.groupRects.get(nodeId);
  if (cached !== undefined) return cached;
  if (state.visiting.has(nodeId)) return undefined;
  const node = state.nodes.get(nodeId);
  if (node === undefined || node.kind !== 'group') return undefined;

  state.visiting.add(nodeId);
  const members: Rect[] = [];
  for (const memberId of canvas.groupMembers(node)) {
    const rect = drawableRectOf(state, memberId);
    if (rect !== undefined) members.push(rect);
  }
  state.visiting.delete(nodeId);

  const union = unionRects(members);
  const rect = union === undefined ? ownRectOf(state, nodeId) : inflateRect(union, GROUP_PADDING);
  state.groupRects.set(nodeId, rect);
  return rect;
}

/** 一个成员占的地方：组合成员用它自己的包络，其余用它自己的盒子。 */
function drawableRectOf(state: EnvelopeState, nodeId: string): Rect | undefined {
  const node = state.nodes.get(nodeId);
  return node?.kind === 'group' ? groupRectOf(state, nodeId) : state.boxRectOf(nodeId);
}

/** 没有成员时组合包络用自身 layout 给 160×80（任务规则 5）。 */
function ownRectOf(state: EnvelopeState, nodeId: string): Rect {
  const position = state.positions.get(nodeId) ?? { x: 0, y: 0 };
  return { x: position.x, y: position.y, width: EMPTY_GROUP_WIDTH, height: EMPTY_GROUP_HEIGHT };
}

/** 面积从大到小（外层在前），同面积按 id 升序：绘制顺序必须确定。 */
function sortEnvelopes(boxes: readonly CanvasBox[]): readonly CanvasBox[] {
  return [...boxes].sort((left, right) => {
    const areaGap = right.width * right.height - left.width * left.height;
    if (areaGap !== 0) return areaGap;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}
