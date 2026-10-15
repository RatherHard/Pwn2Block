/**
 * 语义标注（05 §2.2 / §2.3）：`labels` 来自题目的公开包，不在投影里。
 *
 * 颜色不是唯一信息载体（05 §7）：组件同时渲染 `kindName` 文本与名称。
 */
import type { Label, LabelKind } from '@pwn2block/shared';

export const LABEL_KIND_NAMES: Readonly<Record<LabelKind, string>> = {
  func: '函数',
  buffer: '缓冲区',
  saved_bp: '保存的 bp',
  ret_addr: '返回地址',
  custom: '自定义',
};

/** 终端风格配色：每类标注一个颜色，深色背景下都能读。 */
export const LABEL_KIND_COLORS: Readonly<Record<LabelKind, string>> = {
  func: '#7ee787',
  buffer: '#79c0ff',
  saved_bp: '#e3b341',
  ret_addr: '#ff7b72',
  custom: '#d2a8ff',
};

export function labelKindName(kind: LabelKind): string {
  return LABEL_KIND_NAMES[kind];
}

export function labelKindColor(kind: LabelKind): string {
  return LABEL_KIND_COLORS[kind];
}

/** 覆盖 `addr` 的标注（左闭右开 `[addr, addr + size)`）；重叠时取第一个。 */
export function labelAt(labels: readonly Label[] | undefined, addr: bigint): Label | undefined {
  if (!labels) return undefined;
  return labels.find((label) => {
    const start = BigInt(label.addr);
    return addr >= start && addr < start + BigInt(label.size);
  });
}

/** 与 `[start, end)` 相交的标注，按地址排序，用于整行标注。 */
export function labelsInRange(
  labels: readonly Label[] | undefined,
  start: bigint,
  end: bigint,
): readonly Label[] {
  if (!labels) return [];
  return labels
    .filter((label) => {
      const labelStart = BigInt(label.addr);
      return labelStart < end && labelStart + BigInt(label.size) > start;
    })
    .slice()
    .sort((a, b) => (BigInt(a.addr) < BigInt(b.addr) ? -1 : 1));
}

/** 指令视图的函数列表（05 §2.3）。 */
export function funcLabels(labels: readonly Label[] | undefined): readonly Label[] {
  if (!labels) return [];
  return labels.filter((label) => label.kind === 'func');
}
