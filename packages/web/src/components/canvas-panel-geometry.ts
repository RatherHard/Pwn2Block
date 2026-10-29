import { structureIds } from '../canvas/structure';
import { canvas } from '@pwn2block/shared';
import type { CanvasBox, CanvasEdgeView, CanvasLayoutView, CanvasPortView, Point, Rect } from '../canvas/view-model';
import { containsPoint, inflateRect, unionRects } from '../canvas/view-model-geometry';
import { flowBandAt, flowDropAt, type FlowDropTarget } from './canvas-panel-flow-drop';

/**
 * 画布面板的几何判断（阶段三「视图模型 → 交互」）。
 *
 * 这里只放**纯函数**：命中测试、吸附落位、正交折线。它们不碰 DOM、不读时间，
 * 所以「拖到哪里会插进哪一行」这类判断能脱离浏览器断言。
 *
 * 三条与需求 §6.1–§6.2 对齐的口径：
 * - 端口小方框是连线端点，命中半径按方框半径给（`PORT_HIT_RADIUS`），点在盒子上不算端口；
 * - 吸附命中分「插入当前行」与「新增一行」：行带由成员盒子并集算出，不依赖渲染测量的行高；
 * - 已经属于该组合的成员拖动时命中区外扩 `DROP_HALO`，这样「拖到组边外面一点点」仍算组内，
 *   真的拖远才算移出（需求 §6.2「拖动预览要清楚」）。
 */

/** 端口小方框的边长（CSS 里也是 10px），命中半径取一半多一点。 */
export const PORT_SIZE = 10;
export const PORT_HIT_RADIUS = 9;

/** 拖动开始前允许的手抖距离：小于它按「点击」处理，避免点选时误移节点。 */
export const DRAG_THRESHOLD = 4;

/** 拖动时坐标吸附到 8px 网格（方向键也是 8px，两者一致）；按住 Shift 关闭。 */
export const GRID_STEP = 8;

/** 成员在自己的组合里拖动时，命中区外扩的距离。 */
export const DROP_HALO = 32;

/** 行带下方的「新增一行」判定余量。 */
export const ROW_SLOT_GAP = 8;

/** 关系方框的配色类别（需求 §6.1「按运算符类别配色」）。 */
export type RelationTone = 'arith' | 'compare' | 'logic' | 'bitwise' | 'unary' | 'convert';

/** 比较运算的代码后缀：`int.eq`、`double.ge` 这类。 */
const COMPARE_SUFFIXES: readonly string[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];

/** 位运算的完整代码：整数类型的与、或、异或、移位。 */
const BITWISE_OPS: ReadonlySet<string> = new Set(['int.and', 'int.or', 'int.xor', 'int.shl', 'int.shr']);

/** 一个节点该用哪种颜色：关系按运算类别，一元与转换各自一色。 */
export function relationToneOf(node: canvas.CanvasNode): RelationTone {
  if (node.kind === 'unary') return 'unary';
  if (node.kind === 'convert') return 'convert';
  if (node.kind !== 'relation') return 'arith';
  if (node.op.startsWith('bool.')) return 'logic';
  if (COMPARE_SUFFIXES.some((suffix) => node.op.endsWith(`.${suffix}`))) return 'compare';
  return BITWISE_OPS.has(node.op) ? 'bitwise' : 'arith';
}

/** 点是否落在矩形里（含边界，闭合判定更适合鼠标命中）。几何原语在 `canvas/view-model-geometry`，这里再导出。 */
export { containsPoint };

/** 两个矩形是否相交（框选用）。 */
export function rectsIntersect(left: Rect, right: Rect): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

/** 两点之间的矩形（框选用）。 */
export function rectBetween(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** 盒子矩形（`CanvasBox` 自带坐标，这里只做投影，避免到处写四个字段）。 */
export function rectOfBox(box: CanvasBox): Rect {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** 画布内容的外接框：用于决定工作面尺寸，末尾留一屏的空白好继续摆节点。 */
export function surfaceSizeOf(boxes: readonly CanvasBox[]): { readonly width: number; readonly height: number } {
  const union = unionRects(boxes.map(rectOfBox));
  if (union === undefined) return { width: 1200, height: 800 };
  return {
    width: Math.max(1200, Math.ceil(union.x + union.width + 240)),
    height: Math.max(800, Math.ceil(union.y + union.height + 240)),
  };
}

/** 命中一个端口：取距离最近且在命中半径内的那一个。 */
export function portAtPoint(ports: readonly CanvasPortView[], point: Point): CanvasPortView | undefined {
  let best: CanvasPortView | undefined;
  let bestDistance = PORT_HIT_RADIUS;
  for (const port of ports) {
    const distance = Math.hypot(port.x - point.x, port.y - point.y);
    if (distance > bestDistance) continue;
    best = port;
    bestDistance = distance;
  }
  return best;
}

/** 命中一个节点盒子（后画的在上，所以从后往前找；包络框不参与命中）。 */
export function boxAtPoint(boxes: readonly CanvasBox[], point: Point): CanvasBox | undefined {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index];
    if (box.kind === 'group' || box.kind === 'envelope') continue;
    if (containsPoint(rectOfBox(box), point)) return box;
  }
  return undefined;
}

/** 一行成员在画布上占的带：行带由成员盒子并集算出，不依赖渲染测量。 */
export interface RowBand {
  readonly rowIndex: number;
  readonly rect: Rect;
  readonly memberIds: readonly string[];
}

/** 把组合的 `rows` 翻译成屏幕上的行带；成员一个盒子都算不出来（悬空）的行直接跳过。 */
export function rowBandsOf(
  rows: readonly (readonly string[])[],
  rectOfMember: (nodeId: string) => Rect | undefined,
): readonly RowBand[] {
  const bands: RowBand[] = [];
  rows.forEach((row, rowIndex) => {
    const rects: Rect[] = [];
    for (const memberId of row) {
      const rect = rectOfMember(memberId);
      if (rect !== undefined) rects.push(rect);
    }
    const union = unionRects(rects);
    if (union === undefined) return;
    bands.push({ rowIndex, rect: union, memberIds: [...row] });
  });
  return bands;
}

/**
 * 吸附落位的结果：进哪一组、第几行第几列、是不是新开一行，或者进哪条流程序列的第几步，
 * 以及指示条画在哪。
 */
export type DropTarget =
  | {
      readonly kind: 'group';
      readonly groupId: string;
      readonly rowIndex: number;
      readonly columnIndex: number;
      readonly newRow: boolean;
      readonly slot: Rect;
    }
  | { readonly kind: 'node'; readonly nodeId: string; readonly slot: Rect }
  | { readonly kind: 'stage'; readonly slot: Rect }
  /** 落在流程带上、而且被拖的是流程节点：可以插进去（判定见 `canvas-panel-flow-drop`）。 */
  | FlowDropTarget
  /**
   * 落在流程带上、但被拖的不是流程节点（数据节点、组合……）：文档不变，只给一句原因。
   * 单独一种落位是为了让「这里为什么不能放」在松手前就能说清，而不是静默当成普通拖动。
   */
  | { readonly kind: 'flow-blocked'; readonly slot: Rect };

/** `dropTargetOf` 的输入：全部来自当前视图模型，函数本身不再回查文档。 */
export interface DropQuery {
  readonly point: Point;
  readonly boxes: readonly CanvasBox[];
  /** nodeId → 盒子矩形；组合包络也在这张表里（`group:<id>` 的键是组合 id）。 */
  readonly rectOf: (nodeId: string) => Rect | undefined;
  readonly rowsOf: (groupId: string) => readonly (readonly string[])[] | undefined;
  /** 正在拖的节点（多选拖动时多于一个，此时不做吸附）。 */
  readonly dragged: readonly string[];
  /** 节点当前的归属组合（不属于任何组合时返回 `undefined`）。 */
  readonly ownerOf: (nodeId: string) => string | undefined;
  /** 已经算好的流程落点（流程带要看文档，所以由 `dropTargetFor` 先算）：它排在自己组合之后、别的节点之前。 */
  readonly flow?: DropTarget | undefined;
}

/**
 * 算出松手会落到哪里。
 *
 * 优先级：**自己所属组合的行带** → **流程带** → 普通节点（吸附成组）→ 空白（只移动）。
 * 流程带排在普通节点之前，是因为语句之间的落点比「和它成组」更重要：流程节点根本进不了组合，
 * 而数据节点落在流程带上要给原因（`flow-blocked`），不能悄悄拼成组。
 * 拖进「别人的组合」不算命中：组合成员只能靠 `createGroup` 整体建立，
 * 命令层没有「往已有组合里加一个成员」这条命令（见 `canvas-panel-commands` 的说明）。
 */
export function dropTargetOf(query: DropQuery): DropTarget {
  const owner = query.dragged.length === 1 ? query.ownerOf(query.dragged[0]) : undefined;
  if (owner !== undefined) {
    const groupBox = query.boxes.find((box) => box.kind === 'group' && box.nodeId === owner);
    if (groupBox !== undefined) {
      const region = inflateRect(rectOfBox(groupBox), DROP_HALO);
      if (containsPoint(region, query.point)) {
        const rows = query.rowsOf(owner) ?? [];
        return groupDropOf(owner, rows, query);
      }
    }
  }
  if (query.flow !== undefined) return query.flow;
  const box = [...query.boxes].reverse().find((candidate) => !query.dragged.includes(candidate.nodeId) && candidate.kind === 'node' && containsPoint(inflateRect(candidate, DROP_HALO), query.point));
  if (box !== undefined && !query.dragged.includes(box.nodeId)) {
    return { kind: 'node', nodeId: box.nodeId, slot: rectOfBox(box) };
  }
  return {
    kind: 'stage',
    slot: { x: query.point.x - 24, y: query.point.y - 8, width: 48, height: 16 },
  };
}

/** 组合内落位：命中最近的行带，低于最后一条行带就「新增一行」。 */
function groupDropOf(
  groupId: string,
  rows: readonly (readonly string[])[],
  query: DropQuery,
): DropTarget {
  const bands = rowBandsOf(rows, query.rectOf);
  if (bands.length === 0) {
    const rect = query.rectOf(groupId);
    const slot = rect === undefined ? { x: 0, y: 0, width: 0, height: 0 } : { ...rect, height: 24 };
    return { kind: 'group', groupId, rowIndex: 0, columnIndex: 0, newRow: true, slot };
  }
  const last = bands[bands.length - 1];
  const lastBottom = last.rect.y + last.rect.height;
  if (query.point.y > lastBottom + ROW_SLOT_GAP) {
    const slot: Rect = { x: last.rect.x, y: lastBottom + ROW_SLOT_GAP / 2, width: last.rect.width, height: 24 };
    return { kind: 'group', groupId, rowIndex: rows.length, columnIndex: 0, newRow: true, slot };
  }
  let nearest = bands[0];
  let nearestDistance = Math.abs(query.point.y - (bands[0].rect.y + bands[0].rect.height / 2));
  for (const band of bands) {
    const distance = Math.abs(query.point.y - (band.rect.y + band.rect.height / 2));
    if (distance >= nearestDistance) continue;
    nearest = band;
    nearestDistance = distance;
  }
  return {
    kind: 'group',
    groupId,
    rowIndex: nearest.rowIndex,
    columnIndex: columnOf(nearest, query),
    newRow: false,
    slot: nearest.rect,
  };
}

/** 落到第几列：行内成员圆心比落点靠左的个数就是插入位置。 */
function columnOf(band: RowBand, query: DropQuery): number {
  let column = 0;
  for (const memberId of band.memberIds) {
    const rect = query.rectOf(memberId);
    if (rect === undefined) continue;
    if (rect.x + rect.width / 2 < query.point.x) column += 1;
  }
  return column;
}

/** 吸附提示的中文文案（需求 §6.2 的两种落位）。 */
export function dropLabelOf(target: DropTarget): string | undefined {
  if (target.kind === 'group') return target.newRow ? '新增一行' : '插入当前行';
  if (target.kind === 'node') return '与它成组';
  return undefined;
}

/**
 * 从「文档 + 视图」直接算落位：把盒子矩形、组合行、归属与流程带先查好，再交给 `dropTargetOf`。
 *
 * 之所以单独一层：`dropTargetOf` 只认已经摊平的输入（便于单测），而交互层手上只有文档与视图；
 * 中间这层四处查表就收在这里，交互层不必知道 `ownerMapOf`、包络盒子、流程带怎么找。
 */
export function dropTargetFor(
  document: canvas.CanvasDocument,
  view: CanvasLayoutView,
  point: Point,
  dragged: readonly string[],
): DropTarget | undefined {
  const rects = new Map<string, Rect>();
  for (const box of view.boxes) {
    if (box.kind !== 'relation' || !rects.has(box.nodeId)) rects.set(box.nodeId, rectOfBox(box));
  }
  const excluded = new Set(dragged.flatMap((id) => structureIds(document, id)));
  const owners = canvas.ownerMapOf(document);
  const rectOf = (nodeId: string): Rect | undefined => rects.get(nodeId);
  return dropTargetOf({
    point,
    boxes: view.boxes.filter((box) => {
      if (excluded.has(box.nodeId)) return false;
      if (box.kind === 'group') return true;
      const source = document.nodes.find((node) => node.id === dragged[0]);
      const target = document.nodes.find((node) => node.id === box.nodeId);
      return source !== undefined && target !== undefined && canvas.isValueNode(source) && (canvas.isValueNode(target) || target.kind === 'var-decl');
    }),
    rectOf,
    rowsOf: (groupId: string) => {
      const node = document.nodes.find((item) => item.id === groupId);
      return node === undefined || node.kind !== 'group' ? undefined : node.rows;
    },
    dragged,
    ownerOf: (nodeId: string) => owners.get(nodeId),
    flow: flowTargetOf(document, rectOf, point, dragged),
  });
}

/**
 * 流程带落点：被拖的是流程节点 → 可插的 `flow`；别的节点压在同一条带上 → `flow-blocked`（要给原因）。
 *
 * 优先级不在这里判：`dropTargetOf` 先看自己所属组合的行带，没命中才会读这个 `flow`。
 */
function flowTargetOf(
  document: canvas.CanvasDocument,
  rectOf: (nodeId: string) => Rect | undefined,
  point: Point,
  dragged: readonly string[],
): DropTarget | undefined {
  const input = { document, rectOf, point, dragged };
  const flow = flowDropAt(input);
  if (flow !== undefined) return flow;
  const band = flowBandAt(input);
  return band === undefined ? undefined : { kind: 'flow-blocked', slot: band.slot };
}

/** 数据边与流程边都画成正交折线；`viaRect` 决定从关系方框的哪一侧进出。 */
export function orthogonalPath(edge: CanvasEdgeView): string {
  if (edge.kind === 'flow') return flowPath(edge.from, edge.to);
  const leaving = edge.viaRect !== undefined && nearRightEdge(edge.viaRect, edge.from);
  const entering = edge.viaRect !== undefined && nearLeftEdge(edge.viaRect, edge.to);
  if (leaving && edge.viaRect !== undefined) {
    const stubX = Math.round(edge.viaRect.x + edge.viaRect.width + 12);
    return `M ${edge.from.x} ${edge.from.y} L ${stubX} ${edge.from.y} L ${stubX} ${edge.to.y} L ${edge.to.x} ${edge.to.y}`;
  }
  if (entering && edge.viaRect !== undefined) {
    const stubX = Math.round(edge.viaRect.x - 12);
    return `M ${edge.from.x} ${edge.from.y} L ${stubX} ${edge.from.y} L ${stubX} ${edge.to.y} L ${edge.to.x} ${edge.to.y}`;
  }
  return plainPath(edge.from, edge.to);
}

/**
 * 流程边：从上一条盒子底部往下拐，再水平走到下一条盒子顶部。
 * 同一列时画直线，免得出现三段重合的折线（视觉上像加了粗）。
 */
function flowPath(from: Point, to: Point): string {
  if (Math.abs(from.x - to.x) < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midY = Math.round(from.y + 16);
  return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
}

/** 普通两点：正向走 H-V-H；来源在目标右边时绕一圈（H-V-H-V-H），避免压住两个盒子。 */
function plainPath(from: Point, to: Point): string {
  if (from.x <= to.x) {
    const midX = Math.round((from.x + to.x) / 2);
    return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
  }
  const outX = Math.round(from.x + 12);
  const inX = Math.round(to.x - 12);
  const midY = Math.round((from.y + to.y) / 2);
  return `M ${from.x} ${from.y} L ${outX} ${from.y} L ${outX} ${midY} L ${inX} ${midY} L ${inX} ${to.y} L ${to.x} ${to.y}`;
}

function nearRightEdge(rect: Rect, point: Point): boolean {
  return Math.abs(point.x - (rect.x + rect.width)) <= 10;
}

function nearLeftEdge(rect: Rect, point: Point): boolean {
  return Math.abs(point.x - rect.x) <= 10;
}

/** 坐标吸附：取整到 8px 网格；`enabled` 为假时只取整，方便按住 Shift 自由摆放。 */
export function snapCoordinate(value: number, enabled: boolean): number {
  if (!enabled) return Math.round(value);
  return Math.round(value / GRID_STEP) * GRID_STEP;
}
