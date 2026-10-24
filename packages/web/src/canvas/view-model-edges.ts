import { canvas } from '@pwn2block/shared';
import type { BoxLayout } from './view-model-boxes';
import { flowPortPointOf, inputPointOf, outputPointOf } from './view-model-geometry';
import type {
  CanvasEdgeView,
  CanvasFlowPortView,
  CanvasPortView,
  FlowPortDirection,
  NodeSeverity,
  Rect,
} from './view-model-types';

/**
 * 端口与连线（任务几何规则 3–4、6）。
 *
 * 四条口径：
 * - **端口小方框在盒子外侧**：坐标是端口中心，同时也是连线端点，离盒边 `PORT_GAP`（需求 §6.1）。
 *   输入端口按 `inputRefsOf` 的顺序给，所以「第 i 个端口」在界面从上到下、在数组里从小到大。
 * - **每个已接线的输入一条数据边**：来源可以是大白框也可以是关系方框；`viaRect` 填关系方框的矩形，
 *   让渲染层知道这条线是「进/出运算框」而不是普通两点连线。
 * - **流程连接点也是盒子外侧的小方框**：`in` 在盒顶上方、`out` 在盒底下方各 `FLOW_PORT_GAP`，
 *   每个出现在流程序列里的节点各一个方向一个（需求 §6.1「外置流程连接点」）。
 * - **流程边不经过关系方框**：从上一条的 `out` 小方框中心接到当前条的 `in` 小方框中心，只在 `main`
 *   与各区域序列的相邻项之间。
 */

/** 流程连接点的两个方向；`buildFlowPorts` 按这个顺序每个节点各出一个，输出顺序因此是稳定的。 */
const FLOW_PORT_DIRECTIONS: readonly FlowPortDirection[] = ['in', 'out'];

/** 数据输入端口视图；没有输入端口、或节点没有盒子（悬空）时不出条目。 */
export function buildPorts(
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  layout: BoxLayout,
  severityOf: (nodeId: string) => NodeSeverity | undefined,
): readonly CanvasPortView[] {
  const ports: CanvasPortView[] = [];
  for (const node of nodes.values()) {
    const rect = layout.rectOf.get(node.id);
    if (rect === undefined) continue;
    const refs = canvas.inputRefsOf(node);
    if (refs.length === 0) continue;
    const compact = layout.relationIds.has(node.id);
    refs.forEach((ref, index) => {
      const point = inputPointOf(rect, index, refs.length, compact);
      ports.push({
        nodeId: node.id,
        name: ref.name,
        label: ref.label,
        x: point.x,
        y: point.y,
        connected: ref.id !== undefined,
        severity: severityOf(node.id),
      });
    });
  }
  return ports;
}

/**
 * 流程连接点：出现在任何流程序列里的节点，各出一个 `in`、一个 `out`。
 *
 * `connected` 的口径（只决定渲染层**画不画**，不影响坐标）：
 * - `in`：它在某条序列里、且不是那条序列的第一个 → 上面有流程线接进来；
 * - `out`：它在某条序列里、且不是那条序列的最后一个 → 下面有流程线接出去。
 *
 * 所以 `main` 的第一步只有 `out`、最后一步只有 `in`，序列首尾各有一端是空的（`false`）。
 * 一个节点同时出现在多条序列里时，只要有一处不在首/尾就算接上（例如容器节点既在 `main` 中间，
 * 又开着自己的区域序列）。渲染层跳过 `connected: false` 的那一端，否则每个节点都会多出一个悬空小方框。
 *
 * 输出顺序：按序列里**首次出现**的顺序，每个节点固定 `in` 再 `out`，所以两次布局逐字节相同。
 */
export function buildFlowPorts(
  document: canvas.CanvasDocument,
  layout: BoxLayout,
): readonly CanvasFlowPortView[] {
  const nodes = canvas.nodeMapOf(document);
  const flags = new Map<string, { readonly hasIn: boolean; readonly hasOut: boolean }>();
  for (const sequence of flowSequencesOf(document, nodes)) {
    sequence.forEach((nodeId, index) => {
      const seen = flags.get(nodeId);
      flags.set(nodeId, {
        hasIn: (seen?.hasIn ?? false) || index > 0,
        hasOut: (seen?.hasOut ?? false) || index + 1 < sequence.length,
      });
    });
  }
  const ports: CanvasFlowPortView[] = [];
  for (const [nodeId, flag] of flags) {
    const rect = layout.rectOf.get(nodeId);
    // 序列里引用了不存在（或没有盒子）的节点时跳过：没有盒子就没有「盒子外侧」可放。
    if (rect === undefined) continue;
    for (const direction of FLOW_PORT_DIRECTIONS) {
      const point = flowPortPointOf(rect, direction);
      ports.push({
        nodeId,
        direction,
        x: point.x,
        y: point.y,
        connected: direction === 'in' ? flag.hasIn : flag.hasOut,
      });
    }
  }
  return ports;
}

/**
 * 数据依赖边：`from` 是来源节点的输出点，`to` 是目标端口点。
 *
 * `viaRect` 的优先级是**目标优先**：连线要进到关系方框里时先填目标的矩形；目标是大白框时再看来源
 * 是不是关系方框（这时线从运算框出来）；两者都不是就是 `undefined`，由渲染层按两点位置决定直线还是直角。
 */
export function buildDataEdges(
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  layout: BoxLayout,
): readonly CanvasEdgeView[] {
  const edges: CanvasEdgeView[] = [];
  for (const node of nodes.values()) {
    const target = layout.rectOf.get(node.id);
    if (target === undefined) continue;
    const refs = canvas.inputRefsOf(node);
    const compact = layout.relationIds.has(node.id);
    refs.forEach((ref, index) => {
      if (ref.id === undefined) return;
      const source = layout.rectOf.get(ref.id);
      if (source === undefined) return;
      edges.push({
        from: { nodeId: ref.id, ...outputPointOf(source) },
        to: { nodeId: node.id, ...inputPointOf(target, index, refs.length, compact) },
        viaRect: viaRectOf(layout, node.id, ref.id, target, source),
        kind: 'data',
      });
    });
  }
  return edges;
}

/** 流程边：`main` 与各区域序列里相邻两步之间各一条，从上一条底部到当前条顶部。 */
export function buildFlowEdges(
  document: canvas.CanvasDocument,
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  layout: BoxLayout,
): readonly CanvasEdgeView[] {
  const edges: CanvasEdgeView[] = [];
  for (const sequence of flowSequencesOf(document, nodes)) {
    for (let index = 0; index + 1 < sequence.length; index += 1) {
      const edge = flowEdgeOf(sequence[index], sequence[index + 1], layout);
      if (edge !== undefined) edges.push(edge);
    }
  }
  return edges;
}

/**
 * 一条流程边：`from` 是上一条的 `out` 小方框中心，`to` 是当前条的 `in` 小方框中心。
 * 任一端没有盒子（不在画布上）时返回 `undefined`。
 */
function flowEdgeOf(fromId: string, toId: string, layout: BoxLayout): CanvasEdgeView | undefined {
  const from = layout.rectOf.get(fromId);
  const to = layout.rectOf.get(toId);
  if (from === undefined || to === undefined) return undefined;
  return {
    from: { nodeId: fromId, ...flowPortPointOf(from, 'out') },
    to: { nodeId: toId, ...flowPortPointOf(to, 'in') },
    viaRect: undefined,
    kind: 'flow',
  };
}

/**
 * 所有流程序列：`main` 与每个容器（`if` 的两条、`loop` 的一条）的区域。
 *
 * 同一个容器只展开一次，所以脏存档里「容器区域包含自己」也会停下来；序列元素可以是任意 id
 * （不合法的地方由 `validateCanvasDocument` 报），这里只管把相邻关系列出来。
 */
function flowSequencesOf(
  document: canvas.CanvasDocument,
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
): readonly (readonly string[])[] {
  const sequences: (readonly string[])[] = [document.main];
  const expanded = new Set<string>();
  const pending: (readonly string[])[] = [document.main];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const id of current) {
      if (expanded.has(id)) continue;
      expanded.add(id);
      const node = nodes.get(id);
      if (node === undefined) continue;
      for (const children of canvas.flowChildrenOf(node)) {
        sequences.push(children);
        pending.push(children);
      }
    }
  }
  return sequences;
}

/** `viaRect` 的取舍：目标关系方框优先，其次来源关系方框，都没有就 `undefined`。 */
function viaRectOf(
  layout: BoxLayout,
  targetId: string,
  sourceId: string,
  target: Rect,
  source: Rect,
): Rect | undefined {
  if (layout.relationIds.has(targetId)) return target;
  if (layout.relationIds.has(sourceId)) return source;
  return undefined;
}
