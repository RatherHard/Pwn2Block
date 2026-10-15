/**
 * 投影差分（04 §4、05 §2.1）：相邻两份完整投影对比，得出要高亮一次的字节与寄存器。
 *
 * 每次响应都是完整投影，前端自己算差分；差分结果只用于渲染高亮，不参与任何判定。
 */
import type { FlagsView, Projection, VmaView } from '@pwn2block/shared';
import { hexToBytes } from '@pwn2block/shared';

export type FlagName = 'ZF' | 'CF' | 'SF';

export interface ProjectionDiff {
  /** 值发生变化的寄存器名。 */
  readonly registers: ReadonlySet<string>;
  readonly flags: ReadonlySet<FlagName>;
  /** vmaId → 变化的字节偏移（相对 VMA 起点）。 */
  readonly vmaBytes: ReadonlyMap<string, ReadonlySet<number>>;
  readonly statusChanged: boolean;
  readonly stepsChanged: boolean;
  readonly stdoutChanged: boolean;
  readonly stdinPosChanged: boolean;
  readonly lastStopChanged: boolean;
  readonly errorChanged: boolean;
}

export const EMPTY_DIFF: ProjectionDiff = Object.freeze({
  registers: new Set<string>(),
  flags: new Set<FlagName>(),
  vmaBytes: new Map<string, ReadonlySet<number>>(),
  statusChanged: false,
  stepsChanged: false,
  stdoutChanged: false,
  stdinPosChanged: false,
  lastStopChanged: false,
  errorChanged: false,
});

function diffVma(prev: VmaView | undefined, next: VmaView): ReadonlySet<number> {
  const changed = new Set<number>();
  if (!prev) return changed;
  if (prev.hex === undefined || next.hex === undefined) return changed;
  const before = hexToBytes(prev.hex);
  const after = hexToBytes(next.hex);
  const limit = Math.max(before.length, after.length);
  for (let i = 0; i < limit; i += 1) {
    if (before[i] !== after[i]) changed.add(i);
  }
  return changed;
}

function diffFlags(prev: FlagsView | undefined, next: FlagsView): ReadonlySet<FlagName> {
  const changed = new Set<FlagName>();
  if (!prev) return changed;
  for (const name of ['ZF', 'CF', 'SF'] as const) {
    if (prev[name] !== next[name]) changed.add(name);
  }
  return changed;
}

/** `prev` 为 undefined（首份投影）时返回空差分：首次渲染不高亮任何东西。 */
export function diffProjections(prev: Projection | undefined, next: Projection): ProjectionDiff {
  if (!prev) return EMPTY_DIFF;

  const registers = new Set<string>();
  const before = new Map(prev.registers.map((item) => [item.name, item.value]));
  for (const item of next.registers) {
    const old = before.get(item.name);
    if (old !== undefined && old !== item.value) registers.add(item.name);
  }

  const vmaBytes = new Map<string, ReadonlySet<number>>();
  const beforeVmas = new Map(prev.vmas.map((item) => [item.id, item]));
  for (const vma of next.vmas) {
    const changed = diffVma(beforeVmas.get(vma.id), vma);
    if (changed.size > 0) vmaBytes.set(vma.id, changed);
  }

  return {
    registers,
    flags: diffFlags(prev.flags, next.flags),
    vmaBytes,
    statusChanged: prev.status !== next.status,
    stepsChanged: prev.steps !== next.steps,
    stdoutChanged: (prev.stdout?.hex ?? '') !== (next.stdout?.hex ?? ''),
    stdinPosChanged: (prev.stdin?.pos ?? 0) !== (next.stdin?.pos ?? 0),
    lastStopChanged: JSON.stringify(prev.lastStop ?? null) !== JSON.stringify(next.lastStop ?? null),
    errorChanged: JSON.stringify(prev.error ?? null) !== JSON.stringify(next.error ?? null),
  };
}

export function isEmptyDiff(diff: ProjectionDiff): boolean {
  return (
    diff.registers.size === 0 &&
    diff.flags.size === 0 &&
    diff.vmaBytes.size === 0 &&
    !diff.statusChanged &&
    !diff.stepsChanged &&
    !diff.stdoutChanged &&
    !diff.stdinPosChanged
  );
}

/** 某个 VMA 的某字节是否在本次投影变化中变过。 */
export function byteChanged(diff: ProjectionDiff, vmaId: string, offset: number): boolean {
  return diff.vmaBytes.get(vmaId)?.has(offset) ?? false;
}

/** 区间 `[offset, offset + len)` 内是否有任何字节变化（指令视图高亮用）。 */
export function rangeChanged(
  diff: ProjectionDiff,
  vmaId: string,
  offset: number,
  len: number,
): boolean {
  const changed = diff.vmaBytes.get(vmaId);
  if (!changed || changed.size === 0) return false;
  for (let i = offset; i < offset + len; i += 1) {
    if (changed.has(i)) return true;
  }
  return false;
}
