import { canvas } from '@pwn2block/shared';
import { edited, nodeOf, refuse, type CanvasEdit } from './editor-core';
import {
  moveStatement,
  regionIssue,
  regionLabel,
  regionOfId,
  regionSequenceOf,
  withRegionSequence,
} from './editor-containers';

/**
 * 语句在**序列之间**的移动（阶段三「拖动落位 → 命令」的跨区域那一半）。
 *
 * 为什么还需要一条命令：`moveStatement` 只在一条序列内换位（区域 + 来源下标 + 目标下标），
 * 而画布上的拖动可以把一句话从 `main` 拖进 `loop1` 的循环体。跨序列 = 从原序列移除 + 插进目标序列，
 * 是结构写入，所以留在命令层，和 `insertStatement` / `moveStatement` 一样先做能表达性检查，
 * 而不是在面板里对着 `withRegionSequence` 手写一遍。
 *
 * 三条边界：
 * 1. **同一条序列交给 `moveStatement`**：换位语义只有一份实现，也共用它的拒绝文案；
 * 2. **越界夹到末尾**：目标下标超出目标序列长度时追加到最后一项，与 `insertStatement` 同口径；
 * 3. **容器不能进自己的区域**：把 `if1` 拖进 `if1` 的成立分支会让它成为自己的后代，
 *    结构上表达不出来，先拒绝并说清原因（脏存档里的同类结构由 `analyzeFlow` 报 `flow_error`）。
 */

/** 一句话的落点：哪条序列的第几项（0 基，与 `FlowRegionRef` 同一口径）。 */
export interface StatementSlot {
  readonly region: canvas.FlowRegionRef;
  readonly index: number;
}

/** 拖动落位用的一条命令：把 `from` 位置上的语句挪到 `to` 位置，跨序列也行。 */
export function moveStatementTo(
  document: canvas.CanvasDocument,
  from: StatementSlot,
  to: StatementSlot,
): CanvasEdit {
  const source = regionSequenceOf(document, from.region);
  if (source === undefined) return { document, issues: [regionIssue(document, from.region)] };
  if (from.index < 0 || from.index >= source.length) {
    const message = `${regionLabel(from.region)}里没有第 ${from.index} 项（共 ${source.length} 项）`;
    return refuse(document, 'flow_error', from.region.ownerId, message);
  }
  const movedId = source[from.index];
  const moved = nodeOf(document, movedId);
  if (moved === undefined || !canvas.isFlowNode(moved)) {
    return refuse(document, 'flow_error', movedId, `「${movedId}」不是流程节点，不能排进流程序列`);
  }
  if (sameRegion(from.region, to.region)) return moveStatement(document, from.region, from.index, to.index);
  return movedAcross(document, movedId, from.region, source, to);
}

/** 同一个区域：`ownerId` 与种类都一样才算（`main` 的 owner 是空串，也照这条走）。 */
function sameRegion(left: canvas.FlowRegionRef, right: canvas.FlowRegionRef): boolean {
  return left.ownerId === right.ownerId && left.kind === right.kind;
}

/** 跨序列移动：先查目标区域与「不能套住自己」，再移除、插入（两步写在同一份新文档里）。 */
function movedAcross(
  document: canvas.CanvasDocument,
  movedId: string,
  from: canvas.FlowRegionRef,
  source: readonly string[],
  to: StatementSlot,
): CanvasEdit {
  const target = regionSequenceOf(document, to.region);
  if (target === undefined) return { document, issues: [regionIssue(document, to.region)] };
  const cycle = cycleIssueOf(document, movedId, to.region);
  if (cycle !== undefined) return { document, issues: [cycle] };
  const removed = withRegionSequence(
    document,
    from,
    source.filter((id) => id !== movedId),
  );
  if (removed === undefined) return { document, issues: [regionIssue(document, from)] };
  const at = clampIndex(to.index, target.length);
  const written = withRegionSequence(removed, to.region, [
    ...target.slice(0, at),
    movedId,
    ...target.slice(at),
  ]);
  return written === undefined ? { document, issues: [regionIssue(document, to.region)] } : edited(written);
}

/** 目标下标：负数按 0、超出按末尾（与 `insertStatement` 同口径）。 */
function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index)) return length;
  return Math.max(0, Math.min(index, length));
}

/**
 * 「容器不能进自己的区域」：从目标区域的容器往上走，走到自己就是环。
 *
 * 沿用 `analyzeFlow` 的 `regionOf` 口径（一条序列一个归属），并用 `visited` 挡住脏存档里的
 * 互相引用，保证任何输入都能走完。
 */
function cycleIssueOf(
  document: canvas.CanvasDocument,
  movedId: string,
  region: canvas.FlowRegionRef,
): canvas.CanvasIssue | undefined {
  const visited = new Set<string>();
  let current = region.ownerId;
  while (current !== '' && !visited.has(current)) {
    if (current === movedId) {
      return canvas.errorIssue(
        'flow_error',
        movedId,
        `不能把「${movedId}」放进${regionLabel(region)}：那里属于它自己的子树，容器不能套住自己`,
      );
    }
    visited.add(current);
    current = regionOfId(document, current)?.ownerId ?? '';
  }
  return undefined;
}
