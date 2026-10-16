/**
 * 指令视图行投影（05 §2.3）。
 *
 * **数据只来自投影 `disasm`，前端不解码**（02 §4）：这里是排版（地址 / 机器码 / 伪汇编）、
 * `ip` 高亮、变化高亮与 `target` 解析，没有任何取指或解码逻辑。
 */
import type { Label, Projection } from '@pwn2block/shared';
import { parseHex } from '@pwn2block/shared';
import { EMPTY_DIFF, rangeChanged, type ProjectionDiff } from './diff';
import { formatAddr, formatAddrShort, formatHexSpaced } from './format';
import { labelAt } from './labels';
import { createProjectionReader } from './reader';

/** 命中 `kind = func` 标注时给出 `名字+十进制偏移`（`vuln+4`）；未命中或非函数标注返回 undefined。 */
export function symbolAt(labels: readonly Label[] | undefined, addr: bigint): string | undefined {
  const label = labelAt(labels, addr);
  if (!label || label.kind !== 'func') return undefined;
  const offset = addr - parseHex(label.addr);
  return `${label.name}+${offset.toString(10)}`;
}

export interface DisasmRowModel {
  readonly index: number;
  readonly addr: bigint;
  readonly address: string;
  /** `c9 c3 0f 0e` */
  readonly bytesText: string;
  readonly text: string;
  readonly target?: bigint;
  /** `target` 的显示文本：公开标注名优先，否则紧凑地址。 */
  readonly targetText?: string;
  /** 命中 `kind = func` 标注的起始地址。 */
  readonly funcName?: string;
  readonly isIp: boolean;
  readonly changed: boolean;
  /** pwndbg 风格符号：`vuln+4`；只认 func 标注，见 `symbolAt`。 */
  readonly symbol?: string;
}

export interface DisasmViewInput {
  readonly projection: Projection;
  readonly archBits: number;
  /** `roles.ip` 对应寄存器的当前值，用于行高亮与自动滚动。 */
  readonly ip?: bigint;
  readonly diff?: ProjectionDiff;
  readonly labels?: readonly Label[];
}

export function buildDisasmRows(input: DisasmViewInput): readonly DisasmRowModel[] {
  const reader = createProjectionReader(input.projection, input.archBits);
  const diff = input.diff ?? EMPTY_DIFF;
  const starts = new Map(input.projection.vmas.map((vma) => [vma.id, parseHex(vma.start)]));

  return input.projection.disasm.map((entry, index) => {
    const addr = parseHex(entry.addr);
    const found = reader.locate(addr);
    const vmaStart = found ? starts.get(found.vma.id) : undefined;
    const byteLength = Math.floor(entry.bytes.length / 2);
    const changed =
      found !== undefined && vmaStart !== undefined
        ? rangeChanged(diff, found.vma.id, Number(addr - vmaStart), byteLength)
        : false;
    const label = labelAt(input.labels, addr);
    return {
      index,
      addr,
      address: formatAddr(addr, input.archBits),
      bytesText: formatHexSpaced(entry.bytes),
      text: entry.text,
      target: entry.target === undefined ? undefined : parseHex(entry.target),
      targetText:
        entry.target === undefined
          ? undefined
          : (labelAt(input.labels, parseHex(entry.target))?.name ??
            formatAddrShort(parseHex(entry.target))),
      funcName: label?.kind === 'func' ? label.name : undefined,
      isIp: input.ip !== undefined && addr === input.ip,
      changed,
      symbol: symbolAt(input.labels, addr),
    };
  });
}

/** 目标地址在本次反汇编窗口内的行号；不在窗口内时返回 undefined（05 §2.3）。 */
export function findDisasmRow(
  rows: readonly DisasmRowModel[],
  addr: bigint,
): DisasmRowModel | undefined {
  return rows.find((row) => row.addr === addr);
}

/** 有 `target` 的行都可以点击跳转；这里只判断渲染条件。 */
export function isClickableTarget(row: DisasmRowModel): boolean {
  return row.target !== undefined;
}
