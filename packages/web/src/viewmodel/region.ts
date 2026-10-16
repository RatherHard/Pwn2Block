/**
 * 值区域着色（pwndbg 风格，frontend-tui 设计 §2）：根据一个数值落在哪类 VMA，
 * 给寄存器行、栈行等统一一个「区域」标签，供组件选配色。
 *
 * 隐藏优先于种类判断：隐藏 VMA 的内容不下发，但布局公开，所以仍能分类为 `hidden`，
 * 不会因为「不知道内容」就连区域都不敢说（01 §6 第 2 条）。
 */
import type { ProjectionReader } from './reader';

export type ValueRegion = 'code' | 'stack' | 'data' | 'hidden' | 'unmapped';

export function valueRegion(reader: ProjectionReader, value: bigint): ValueRegion {
  const found = reader.locate(value);
  if (!found) return 'unmapped';
  if (found.vma.hidden) return 'hidden';
  if (found.vma.kind === 'code') return 'code';
  if (found.vma.kind === 'stack') return 'stack';
  return 'data';
}
