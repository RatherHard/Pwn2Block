/**
 * 栈视图行投影（05 §2.2）。纯函数：输入一份投影 + 公开标注，输出可直接渲染的行。
 *
 * - 每行 W 字节（64 位为 8 字节），可设置对齐偏移；
 * - `sp` / `bp` 与任何指向本行的寄存器都作为锚点标签；
 * - `labels` 里 `buffer / saved_bp / ret_addr / custom` 对应的行带类别与名称；
 * - 右侧 pwndbg 风格附注：跳转链（最多 3 跳）、终点伪汇编、可打印 ASCII；
 * - 隐藏 VMA 的字节显示 `??` 并标出所属 VMA（内容不下发，布局公开）。
 */
import type { Label, LabelKind, Projection, Roles } from '@pwn2block/shared';
import { parseHex } from '@pwn2block/shared';
import { byteChanged, EMPTY_DIFF, type ProjectionDiff } from './diff';
import { alignDown, formatAddr, printableAsciiOfBytes } from './format';
import { labelAt, labelKindName } from './labels';
import { describePointerChain, resolvePointerChain, type PointerDescription } from './pointer';
import { createProjectionReader, type ByteState } from './reader';
import { valueRegion, type ValueRegion } from './region';

/** 默认窗口行数：够看 sp 周围的局部变量，也能看到紧邻的映射边界（隐藏区显示 `??`）。 */
export const DEFAULT_STACK_ROWS = 40;

/** 默认在 `sp` 上方留出的行数，保证调用者看到的锚点周围有上下文。 */
export const DEFAULT_ROWS_BEFORE_SP = 4;

export interface StackByteCell {
  readonly addr: bigint;
  readonly state: ByteState;
  readonly vmaId?: string;
  /** 可见时为两位 hex；隐藏为 `??`；未映射为空串。 */
  readonly text: string;
  readonly changed: boolean;
}

export interface StackAnchor {
  /** 角色锚点：`sp` / `bp`；其他寄存器只有名字。 */
  readonly role?: 'sp' | 'bp';
  readonly name: string;
}

export interface StackRowLabel {
  readonly name: string;
  readonly kind: LabelKind;
  readonly kindName: string;
}

export interface StackRowModel {
  readonly index: number;
  readonly addr: bigint;
  readonly address: string;
  readonly cells: readonly StackByteCell[];
  readonly state: ByteState;
  readonly changed: boolean;
  readonly anchors: readonly StackAnchor[];
  readonly label?: StackRowLabel;
  readonly ascii?: string;
  readonly chain?: PointerDescription;
  readonly hiddenVmaIds: readonly string[];
  /** pwndbg 风格行前缀：`00:0000`（两位十六进制行号 + 四位十六进制字节偏移）。 */
  readonly prefix: string;
  /** 该行字值指向的区域；字不可完全读取时退到 `unmapped`（不从隐藏/未映射字节推导颜色）。 */
  readonly region: ValueRegion;
}

export interface StackViewInput {
  readonly projection: Projection;
  readonly archBits: number;
  readonly roles: Roles;
  readonly labels?: readonly Label[];
  readonly diff?: ProjectionDiff;
  /** 窗口起点；省略时自动锚定到 `sp`。 */
  readonly startAddr?: bigint;
  /** 行首偏移在跟随与手动跳转时都生效。 */
  readonly alignOffset?: number;
  readonly rowCount?: number;
  readonly rowBytes?: number;
}

function registerValues(projection: Projection): ReadonlyMap<string, bigint> {
  return new Map(projection.registers.map((item) => [item.name, parseHex(item.value)]));
}

function defaultBase(
  reader: ReturnType<typeof createProjectionReader>,
  spValue: bigint,
  rowBytes: number,
): bigint {
  const raw = alignDown(spValue, rowBytes) - BigInt(DEFAULT_ROWS_BEFORE_SP * rowBytes);
  const vma = reader.locate(spValue);
  const lowerBound = vma ? vma.start : raw;
  return raw < lowerBound ? lowerBound : raw;
}

function rowLabel(labels: readonly Label[] | undefined, start: bigint, end: bigint): StackRowLabel | undefined {
  const starts = labels?.find((item) => {
    const addr = BigInt(item.addr);
    return addr >= start && addr < end;
  });
  const label = starts ?? labelAt(labels, start);
  if (!label) return undefined;
  return {
    name: label.name,
    kind: label.kind,
    kindName: labelKindName(label.kind),
  };
}

function anchorsFor(
  registers: ReadonlyMap<string, bigint>,
  roles: Roles,
  start: bigint,
  end: bigint,
): readonly StackAnchor[] {
  const out: StackAnchor[] = [];
  for (const [name, value] of registers) {
    if (value < start || value >= end) continue;
    const role = name === roles.sp ? 'sp' : name === roles.bp ? 'bp' : undefined;
    out.push(role ? { role, name } : { name });
  }
  return out;
}

export function buildStackRows(input: StackViewInput): readonly StackRowModel[] {
  const reader = createProjectionReader(input.projection, input.archBits);
  const rowBytes = input.rowBytes ?? reader.wordBytes;
  const rowCount = input.rowCount ?? DEFAULT_STACK_ROWS;
  const registers = registerValues(input.projection);
  const diff = input.diff ?? EMPTY_DIFF;
  const spValue = registers.get(input.roles.sp) ?? 0n;
  // `startAddr` 原样使用（调用方负责对齐，便于实现“对齐偏移”，05 §2.2）；省略时自动锚定 sp。
  const base = (input.startAddr ?? defaultBase(reader, spValue, rowBytes)) + BigInt(input.alignOffset ?? 0);
  const vmaStarts = new Map(reader.vmas.map((item) => [item.vma.id, item.start]));

  const rows: StackRowModel[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const start = base + BigInt(index * rowBytes);
    const cells = buildCells(reader, vmaStarts, start, rowBytes, diff);
    const changedCells = cells.filter((cell) => cell.changed);
    const asciiBytes = visibleBytes(cells);
    const word = reader.readWordLE(start);
    const chain =
      word === undefined
        ? undefined
        : describePointerChain(resolvePointerChain(reader, word, { labels: input.labels }));
    // 字不可完全读取（部分隐藏或跨到未映射区）时退到 unmapped：绝不从隐藏字节推导颜色（01 §6 第 2 条）。
    const region = word === undefined ? 'unmapped' : valueRegion(reader, word);
    const hiddenVmaIds = [...new Set(cells.filter((c) => c.state === 'hidden').map((c) => c.vmaId ?? '?'))];

    rows.push({
      index,
      addr: start,
      address: formatAddr(start, input.archBits),
      cells,
      state: cells[0]?.state ?? 'unmapped',
      changed: changedCells.length > 0,
      anchors: anchorsFor(registers, input.roles, start, start + BigInt(rowBytes)),
      label: rowLabel(input.labels, start, start + BigInt(rowBytes)),
      ascii: asciiBytes.length === 0 ? undefined : printableAsciiOfBytes(asciiBytes, rowBytes),
      chain,
      hiddenVmaIds,
      prefix: stackRowPrefix(index, rowBytes),
      region,
    });
  }
  return rows;
}

function buildCells(
  reader: ReturnType<typeof createProjectionReader>,
  vmaStarts: ReadonlyMap<string, bigint>,
  start: bigint,
  rowBytes: number,
  diff: ProjectionDiff,
): readonly StackByteCell[] {
  const cells: StackByteCell[] = [];
  for (let i = 0; i < rowBytes; i += 1) {
    const addr = start + BigInt(i);
    const info = reader.byteAt(addr);
    const text = info.state === 'hidden' ? '??' : info.byte === undefined ? '' : byteText(info.byte);
    const vmaStart = info.vmaId === undefined ? undefined : vmaStarts.get(info.vmaId);
    const changed =
      info.vmaId !== undefined && vmaStart !== undefined
        ? byteChanged(diff, info.vmaId, Number(addr - vmaStart))
        : false;
    cells.push({ addr, state: info.state, vmaId: info.vmaId, text, changed });
  }
  return cells;
}

/** pwndbg 风格行前缀：两位十六进制行号 + 冒号 + 四位十六进制字节偏移（`index * wordBytes`）。 */
export function stackRowPrefix(index: number, wordBytes: number): string {
  const row = index.toString(16).padStart(2, '0');
  const offset = (index * wordBytes).toString(16).padStart(4, '0');
  return `${row}:${offset}`;
}

function byteText(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0');
}

function visibleBytes(cells: readonly StackByteCell[]): Uint8Array {
  const bytes: number[] = [];
  for (const cell of cells) {
    if (cell.state !== 'visible') continue;
    bytes.push(Number.parseInt(cell.text, 16));
  }
  return new Uint8Array(bytes);
}

/** 已渲染行里包含 `addr` 的行号（自动滚动用）。 */
export function findRowIndex(rows: readonly StackRowModel[], addr: bigint): number | undefined {
  const found = rows.find((row) => {
    const end = row.addr + BigInt(row.cells.length);
    return addr >= row.addr && addr < end;
  });
  return found?.index;
}

/** 地址落在窗口外时，重新计算窗口起点（`sp` 自动跟随，05 §2.2）。 */
export function refollowBase(
  rows: readonly StackRowModel[],
  addr: bigint,
  rowBytes: number,
  rowsBefore = DEFAULT_ROWS_BEFORE_SP,
): bigint | undefined {
  if (findRowIndex(rows, addr) !== undefined) return undefined;
  return alignDown(addr, rowBytes) - BigInt(rowsBefore * rowBytes);
}
