import { structureIds } from '../canvas/structure';
import { canvas } from '@pwn2block/shared';
import { regionLabel, regionRefsOf, regionSequenceOf } from '../canvas/editor';
import type { Point, Rect } from '../canvas/view-model';
import { containsPoint, inflateRect, unionRects } from '../canvas/view-model-geometry';

/**
 * 拖动落点 → 流程序列的插入位置（需求 §5.2「顺序就是执行顺序」、§6.2「拖动落位」）。
 *
 * 为什么需要这一层：命令层早就有 `insertStatement` 与 `moveStatement`，但画布上一直没有
 * 「把语句排进第几步」的入口——拖动只认组合成员，于是从工具箱加出来的方法节点永远进不了 `main`，
 * 界面拼不出可执行程序。这里补的就是缺的那半截：**落点 → （区域, 下标）**，纯函数、不碰 DOM。
 *
 * 判定顺序（每一步都只回答一个问题，越靠前越优先）：
 * 1. 只看**单节点拖动**：多选拖动不做流程吸附（一次只排一条语句）；
 * 2. 列出文档里**所有**序列：`main`、每个 `if` 的 `then`/`else`、每个 `loop` 的 `body`
 *    （区域表由 `regionRefsOf` 给，不在这里手写，免得与命令层漂移）；
 * 3. 每条序列的行带 = 成员盒子的并集，外扩 `FLOW_SNAP_HALO`（吸附光环）作为命中区；
 * 4. **末尾追加**优先于带内插位：落点在最后一个成员下方 `FLOW_APPEND_GAP` 以内就算「插到末尾」。
 *    这是最常用的操作（`tests/e2e/helpers.ts` 的 `placeInFlow` 就是把节点拖到开始节点正下方），
 *    而吸附光环正好盖住紧贴下方的 24px，不先判它就会算成「插到开头」；
 * 5. 命中多条时取**离 `point.y` 最近**的那一条（两条序列上下相邻时按纵向取近的）；
 * 6. 空序列（例如新建的 `if` 的 `else`）没有行带可算，用**容器盒子的下半部分**当命中区；
 *    同一个容器有两条空区域（`if` 的两个分支都空）时，下半部分按左右平分，
 *    否则两条命中区完全重合，`else` 永远选不到。
 *
 * `index` 的口径与组合「第几列」一致：比第 k 个成员的**盒子中心**靠左就插在 k（0 基）。
 */

/** 吸附光环：序列行带外扩这么多像素仍算命中（比组合的 `DROP_HALO` 小，流程带更窄）。 */
export const FLOW_SNAP_HALO = 24;

/** 最后一个成员下方这么远以内释放 = 插到末尾（需求：最常用的操作必须能做出来）。 */
export const FLOW_APPEND_GAP = 48;

/** 指示条粗细（竖条表示插在两句之间，横条表示追加到末尾）。 */
const SLOT_THICKNESS = 4;

/** 空区域的指示条左右各留的白边，避免与容器边框重合而看不清。 */
const EMPTY_SLOT_INSET = 8;

/** 数据节点落在流程带上的唯一一句原因：吸附提示与松手提示共用，避免两处说法不一致。 */
export const FLOW_DATA_REFUSAL = '数据节点不进流程；在侧栏配置需要它的输入来源';

/** 一次流程落位：进哪条序列、排第几步（0 基）、指示条画在哪。 */
export interface FlowDropTarget {
  readonly kind: 'flow';
  readonly region: canvas.FlowRegionRef;
  readonly index: number;
  readonly slot: Rect;
}

/** `flowDropAt` 的输入：文档、盒子的矩形表、落点与被拖节点。 */
export interface FlowDropInput {
  readonly document: canvas.CanvasDocument;
  readonly rectOf: (nodeId: string) => Rect | undefined;
  readonly point: Point;
  readonly dragged: readonly string[];
}

/** 一条序列的命中结果；`centerY` 只用于「多条带取最近」，不参与指示条。 */
interface BandHit {
  readonly region: canvas.FlowRegionRef;
  readonly index: number;
  readonly slot: Rect;
  readonly centerY: number;
}

/** 空序列的命中区：区域与它的容器下半部分（已外扩吸附光环）。 */
interface EmptyZone {
  readonly region: canvas.FlowRegionRef;
  readonly zone: Rect;
}

/**
 * 落点 → 流程插位：只命中**单节点拖动**，且被拖的必须是流程节点。
 *
 * 数据节点落在流程带上返回 `undefined`（由调用方说明「数据节点不进流程」），
 * 多选拖动同样返回 `undefined`——一次只排一条语句。
 */
export function flowDropAt(input: FlowDropInput): FlowDropTarget | undefined {
  const draggedId = singleIdOf(input.dragged);
  if (draggedId === undefined) return undefined;
  const node = input.document.nodes.find((item) => item.id === draggedId);
  if (node === undefined || !canvas.isFlowNode(node)) return undefined;
  return flowBandAt(input);
}

/**
 * 只看落点、不看被拖节点种类的版本。
 *
 * 调用方用它区分两件事：流程节点可以插进去（`flowDropAt` 有值），数据节点只是「落在流程带上」
 * （`flowBandAt` 有值而 `flowDropAt` 没有）——后者要给一句原因，而不是静默当成普通拖动。
 * 仍然只认**单节点拖动**：多选时一次只排一条语句说不清，不能给提示。
 */
export function flowBandAt(input: FlowDropInput): FlowDropTarget | undefined {
  if (singleIdOf(input.dragged) === undefined) return undefined;
  const hit = nearestHitOf(bandHitsOf(input), input.point);
  return hit === undefined ? undefined : { kind: 'flow', region: hit.region, index: hit.index, slot: hit.slot };
}

/** 吸附与松手共用的文案：`插入第 2 步` / `放进「if1」的成立分支第 1 步`。 */
export function flowDropLabelOf(target: FlowDropTarget): string {
  const step = `第 ${target.index + 1} 步`;
  return target.region.kind === 'main' ? `插入${step}` : `放进${regionLabel(target.region)}${step}`;
}

/** 单节点拖动才做流程吸附：重复 id 也算多选（拖动集来自选中集，不会重复，这里只做保守判断）。 */
function singleIdOf(dragged: readonly string[]): string | undefined {
  return dragged.length === 1 ? dragged[0] : undefined;
}

/** 全部候选：有成员的序列出行带，空序列出容器下半部分。 */
function bandHitsOf(input: FlowDropInput): readonly BandHit[] {
  const hits: BandHit[] = [];
  const empty: EmptyZone[] = [];
  const excluded = new Set(input.dragged.flatMap((id) => structureIds(input.document, id)));
  for (const region of regionRefsOf(input.document)) {
    if (excluded.has(region.ownerId)) continue;
    const sequence = regionSequenceOf(input.document, region);
    if (sequence === undefined) continue;
    const rects = memberRectsOf(sequence, input.rectOf);
    if (rects.length > 0) {
      const hit = filledHitOf(region, rects, input.point);
      if (hit !== undefined) hits.push(hit);
      continue;
    }
    const zone = emptyZoneOf(region, input.rectOf);
    if (zone !== undefined) empty.push(zone);
  }
  return [...hits, ...emptyHitsOf(empty, input.point)];
}

/** 成员盒子的矩形按序列顺序；算不出盒子的成员（悬空引用）跳过，不参与行带。 */
function memberRectsOf(sequence: readonly string[], rectOf: (nodeId: string) => Rect | undefined): readonly Rect[] {
  const rects: Rect[] = [];
  for (const nodeId of sequence) {
    const rect = rectOf(nodeId);
    if (rect !== undefined) rects.push(rect);
  }
  return rects;
}

/** 有成员的序列：先判末尾追加，再判吸附光环内的插位；两者都够不上就不算命中。 */
function filledHitOf(region: canvas.FlowRegionRef, rects: readonly Rect[], point: Point): BandHit | undefined {
  const band = unionRects(rects);
  if (band === undefined) return undefined;
  const bottom = band.y + band.height;
  const centerY = band.y + band.height / 2;
  if (isAppendPoint(point, band, bottom)) {
    return { region, index: rects.length, slot: appendSlotOf(band, bottom), centerY };
  }
  if (!containsPoint(inflateRect(band, FLOW_SNAP_HALO), point)) return undefined;
  const index = insertIndexOf(rects, point);
  return { region, index, slot: insertSlotOf(rects, band, index), centerY };
}

/** 末尾追加：落点在最后一个成员下方 48px 以内，横向没跑出吸附光环。 */
function isAppendPoint(point: Point, band: Rect, bottom: number): boolean {
  if (point.y <= bottom || point.y > bottom + FLOW_APPEND_GAP) return false;
  return point.x >= band.x - FLOW_SNAP_HALO && point.x <= band.x + band.width + FLOW_SNAP_HALO;
}

/** 插到第几步：比第 k 个成员的盒子中心靠左就插在 k。 */
function insertIndexOf(rects: readonly Rect[], point: Point): number {
  const vertical = isVertical(rects);
  let index = 0;
  for (const rect of rects) {
    if (vertical ? rect.y + rect.height / 2 < point.y : rect.x + rect.width / 2 < point.x) index += 1;
  }
  return index;
}

/** 带内插位的指示条：竖条画在前后两个成员中间（首尾贴着行带两端）。 */
function insertSlotOf(rects: readonly Rect[], band: Rect, index: number): Rect {
  const previous = index === 0 ? undefined : rects[index - 1];
  const next = index >= rects.length ? undefined : rects[index];
  if (isVertical(rects)) {
    const top = previous === undefined ? band.y : previous.y + previous.height;
    const bottom = next === undefined ? band.y + band.height : next.y;
    return { x: band.x, y: (top + bottom) / 2, width: band.width, height: SLOT_THICKNESS };
  }
  const left = previous === undefined ? band.x : previous.x + previous.width;
  const right = next === undefined ? band.x + band.width : next.x;
  return {
    x: Math.round((left + right) / 2 - SLOT_THICKNESS / 2),
    y: Math.round(band.y - FLOW_SNAP_HALO / 2),
    width: SLOT_THICKNESS,
    height: Math.round(band.height + FLOW_SNAP_HALO),
  };
}

/** 末尾追加的指示条：横条画在最后一个成员下方。 */
function appendSlotOf(band: Rect, bottom: number): Rect {
  return {
    x: Math.round(band.x),
    y: Math.round(bottom + FLOW_APPEND_GAP / 4),
    width: Math.round(band.width),
    height: SLOT_THICKNESS,
  };
}

/** 空序列的命中区：容器盒子的下半部分 + 吸附光环；容器盒子算不出来就没有命中区。 */
function emptyZoneOf(region: canvas.FlowRegionRef, rectOf: (nodeId: string) => Rect | undefined): EmptyZone | undefined {
  if (region.ownerId === '') return undefined;
  const owner = rectOf(region.ownerId);
  if (owner === undefined) return undefined;
  const lowerHalf: Rect = { x: owner.x, y: owner.y + owner.height / 2, width: owner.width, height: owner.height / 2 };
  return { region, zone: inflateRect(lowerHalf, FLOW_SNAP_HALO) };
}

/** 同一个容器的空区域平分下半部分（左「成立」、右「不成立」），否则两条命中区完全重合。 */
function emptyHitsOf(zones: readonly EmptyZone[], point: Point): readonly BandHit[] {
  const byOwner = new Map<string, EmptyZone[]>();
  for (const entry of zones) {
    const list = byOwner.get(entry.region.ownerId);
    if (list === undefined) byOwner.set(entry.region.ownerId, [entry]);
    else list.push(entry);
  }
  const hits: BandHit[] = [];
  for (const list of byOwner.values()) {
    list.forEach((entry, index) => {
      const slice = sliceOf(entry.zone, list.length, index);
      if (!containsPoint(slice, point)) return;
      hits.push({ region: entry.region, index: 0, slot: emptySlotOf(slice), centerY: slice.y + slice.height / 2 });
    });
  }
  return hits;
}

/** 把一块区域按左右平分成 `count` 份，取第 `index` 份。 */
function sliceOf(rect: Rect, count: number, index: number): Rect {
  if (count <= 1) return rect;
  const width = rect.width / count;
  return { x: rect.x + width * index, y: rect.y, width, height: rect.height };
}

/** 空区域的指示条：横条画在下半部分正中。 */
function emptySlotOf(slice: Rect): Rect {
  return {
    x: Math.round(slice.x + EMPTY_SLOT_INSET),
    y: Math.round(slice.y + slice.height / 2),
    width: Math.max(0, Math.round(slice.width - EMPTY_SLOT_INSET * 2)),
    height: SLOT_THICKNESS,
  };
}

/** 多条序列同时命中时取纵向最近的一条；顺序相同（同一个容器的两条空区域）时取先出现的那条。 */
function nearestHitOf(hits: readonly BandHit[], point: Point): BandHit | undefined {
  let best: BandHit | undefined;
  for (const hit of hits) {
    if (best === undefined || distanceOf(hit, point) < distanceOf(best, point)) best = hit;
  }
  return best;
}

function distanceOf(hit: BandHit, point: Point): number {
  return Math.abs(point.y - hit.centerY);
}

function isVertical(rects: readonly Rect[]): boolean {
  if (rects.length < 2) return false;
  const xs = rects.map((rect) => rect.x + rect.width / 2);
  const ys = rects.map((rect) => rect.y + rect.height / 2);
  return Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
}
