import type { canvas } from '@pwn2block/shared';
import type { CanvasRow, Point, Rect } from './view-model-types';

/**
 * 视图模型的几何常量与尺寸估算（需求 §6.1「白框节点、彩色中关系小方框、外部连接点」）。
 *
 * 这一层只做**确定的算术**：同样的文档必然算出同样的坐标。三条约定：
 * - 端口小方框（也就是连线端点）落在盒子边界**外侧** `PORT_GAP` 处，所以端口坐标一定比盒边更靠外；
 * - 大白框的输入端口按行等距排：第 i 个在 `盒顶 + 24 + i×22`，输出端口在右边缘竖直居中；
 * - 关系方框更矮，输入端口在左侧竖直居中、相邻 10，输出在右侧竖直居中。
 *
 * 宽度用字符数估算（中文 14px、其他 8px），不测量字体：视图模型不能碰 DOM，也不该依赖浏览器。
 */

/** 端口小方框中心（也是连线端点）离盒子边缘的距离：正数表示落在盒子外侧。 */
export const PORT_GAP = 6;
/** 大白框第一个输入端口距盒顶的距离；之后每个端口 +`PORT_STEP`（与行文字大致对齐）。 */
export const PORT_FIRST_Y = 24;
/** 大白框相邻输入端口的竖直间距。 */
export const PORT_STEP = 22;
/** 关系方框相邻输入端口的竖直间距（方框更矮，所以更紧）。 */
export const RELATION_PORT_STEP = 10;

/** 组合包络在成员并集之外留的白边（需求 §6.1 任务规则 5：各边 +12）。 */
export const GROUP_PADDING = 12;
/** 转换包络在内部结构并集之外留的白边（各边 +16）。 */
export const ENVELOPE_PADDING = 16;
/** 没有任何成员、也没有 layout 可依的组合包络用的自身尺寸。 */
export const EMPTY_GROUP_WIDTH = 160;
export const EMPTY_GROUP_HEIGHT = 80;

/** 节点方框的最小尺寸；每多一行加 `NODE_ROW_HEIGHT` 高。 */
export const NODE_MIN_WIDTH = 180;
export const NODE_MIN_HEIGHT = 72;
export const NODE_ROW_HEIGHT = 22;

/** 关系方框的尺寸区间（需求：最小 44×28、最大 120×36）。 */
export const RELATION_MIN_WIDTH = 44;
export const RELATION_MIN_HEIGHT = 28;
export const RELATION_MAX_WIDTH = 120;
export const RELATION_MAX_HEIGHT = 36;

/** 运算节点的输入都没接线时，关系方框放在自己布局原点上方的高度。 */
export const RELATION_ABOVE_GAP = 40;

/** 中文与全角标点的估算宽度；其余按半角算。 */
const WIDE_CHAR_WIDTH = 14;
const NARROW_CHAR_WIDTH = 8;
/** 一行里「标签」与「值」之间留的空隙。 */
const ROW_GAP = 8;
/** 盒子左右内边距之和。 */
const BOX_PADDING = 32;
/** 关系方框左右内边距之和。 */
const RELATION_PADDING = 16;
/** 一行文字超过这个宽度就要占两行（关系方框因此高 36 而不是 28）。 */
const RELATION_ONE_LINE_WIDTH = RELATION_MAX_WIDTH - RELATION_PADDING;

/** 没有 `document.layout` 的节点按 id 排序填网格：每行 4 个，盒间留 40。 */
const GRID_COLUMNS = 4;
const GRID_GAP = 40;
const GRID_ORIGIN_X = 40;
const GRID_ORIGIN_Y = 40;
const GRID_STEP_X = NODE_MIN_WIDTH + GRID_GAP;
const GRID_STEP_Y = NODE_MIN_HEIGHT + GRID_GAP;
/** 全角字符的起点（CJK 统一表意文字、假名、全角标点都在其后）。 */
const WIDE_CHAR_FROM = 0x2e80;

/** 字符串的估算像素宽度：不测字体，只按字符宽度相加。 */
export function textWidthOf(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code >= WIDE_CHAR_FROM ? WIDE_CHAR_WIDTH : NARROW_CHAR_WIDTH;
  }
  return width;
}

/** 关系方框的尺寸：按 label 长度估算，最小 44×28、最大 120×36。 */
export function relationBoxSize(label: string): { readonly width: number; readonly height: number } {
  const text = textWidthOf(label);
  const total = text + RELATION_PADDING;
  return {
    width: Math.min(RELATION_MAX_WIDTH, Math.max(RELATION_MIN_WIDTH, total)),
    height: text > RELATION_ONE_LINE_WIDTH ? RELATION_MAX_HEIGHT : RELATION_MIN_HEIGHT,
  };
}

/** 节点方框尺寸：按行文本长度估算，最小 180×72；每多一行 +22 高。 */
export function nodeBoxSize(
  rows: readonly CanvasRow[],
  title: string,
): { readonly width: number; readonly height: number } {
  let widest = textWidthOf(title);
  for (const row of rows) {
    const width = textWidthOf(row.label) + ROW_GAP + textWidthOf(row.value);
    widest = Math.max(widest, width);
  }
  return {
    width: Math.max(NODE_MIN_WIDTH, widest + BOX_PADDING),
    height: NODE_MIN_HEIGHT + Math.max(0, rows.length - 1) * NODE_ROW_HEIGHT,
  };
}

/**
 * 每个节点在画布上的布局原点：优先 `document.layout`，缺的按 id 排序逐行排布（每行 4 个、间距 40）。
 *
 * 不用随机数、也不用「第一个空位」搜索：同样的文档必须给出同样的坐标，否则每次刷新整张图都会跳。
 * 重复 id 只算第一个（与 `nodeMapOf` 同口径）。
 */
export function canvasPositionsOf(
  document: canvas.CanvasDocument,
): ReadonlyMap<string, canvas.CanvasNodeLayout> {
  const positions = new Map<string, canvas.CanvasNodeLayout>();
  const missing: string[] = [];
  for (const node of document.nodes) {
    if (positions.has(node.id)) continue;
    const placed = document.layout[node.id];
    if (placed === undefined) {
      missing.push(node.id);
      // 先占位，等收集完全部缺 layout 的 id 再统一排序填格，保证顺序与文档顺序无关。
      positions.set(node.id, { x: GRID_ORIGIN_X, y: GRID_ORIGIN_Y });
      continue;
    }
    positions.set(node.id, placed);
  }
  missing.sort();
  missing.forEach((id, index) => {
    positions.set(id, {
      x: GRID_ORIGIN_X + (index % GRID_COLUMNS) * GRID_STEP_X,
      y: GRID_ORIGIN_Y + Math.floor(index / GRID_COLUMNS) * GRID_STEP_Y,
    });
  });
  return positions;
}

/** 节点自身位置的锚框：位置来自 layout（缺省时用确定网格），尺寸取最小节点尺寸 180×72。 */
export function anchorRectOf(position: canvas.CanvasNodeLayout): Rect {
  return { x: position.x, y: position.y, width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
}

/**
 * 节点在画布上的布局锚框。
 *
 * 它是**拖拽、命中与回退用的锚框**：位置来自 `document.layout`（没有就用确定网格），尺寸是最小节点
 * 尺寸 180×72，不含预览行。渲染用的精确盒子（含「预览」行后的真实宽高）见 `layoutCanvas().boxes`。
 * 之所以不在这里算精确盒子：那要先求预览与校验，而这两个输入不属于这个签名。
 */
export function rectOfNode(document: canvas.CanvasDocument, nodeId: string): Rect | undefined {
  const position = canvasPositionsOf(document).get(nodeId);
  return position === undefined ? undefined : anchorRectOf(position);
}

/** 输出点：右边缘外 `PORT_GAP`，竖直居中（大白框与关系方框同一条规则）。 */
export function outputPointOf(rect: Rect): Point {
  return { x: rect.x + rect.width + PORT_GAP, y: rect.y + rect.height / 2 };
}

/**
 * 第 `index` 个输入端口的位置（端口小方框中心，也就是连线终点）。
 *
 * - 大白框：左边缘外 `PORT_GAP`，y 从 `盒顶 + 24` 起每个 +22（需求 §6.1）；
 * - 关系方框（`compact`）：左边缘外 `PORT_GAP`，在竖直方向上均匀分开、整体居中。
 */
export function inputPointOf(rect: Rect, index: number, count: number, compact: boolean): Point {
  const x = rect.x - PORT_GAP;
  if (!compact) return { x, y: rect.y + PORT_FIRST_Y + index * PORT_STEP };
  const offset = (index - (count - 1) / 2) * RELATION_PORT_STEP;
  return { x, y: Math.round(rect.y + rect.height / 2 + offset) };
}

/** 两点中点；取整是为了让图坐标保持整数（渲染与测试都更好读）。 */
export function midpointOf(from: Point, to: Point): Point {
  return { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
}

/** 矩形中心。 */
export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** 以某个中心点放一个已知尺寸的盒子。 */
export function rectAround(center: Point, size: { readonly width: number; readonly height: number }): Rect {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

/** 若干矩形的并集；空数组返回 `undefined`（调用方据此决定回退）。 */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 各边外扩 `padding`（包络白边）。 */
export function inflateRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}
