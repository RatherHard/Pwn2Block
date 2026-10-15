/**
 * 寄存器视图行投影（05 §2.4）。纯函数。
 *
 * 显示投影里的寄存器与 `ZF / CF / SF`；变化的值由差分标记；
 * 值若指向已映射区域，附上所属 VMA / 公开标注，便于在其他视图里对上号。
 */
import type { FlagsView, Label, Projection, Roles } from '@pwn2block/shared';
import { parseHex } from '@pwn2block/shared';
import { EMPTY_DIFF, type FlagName, type ProjectionDiff } from './diff';
import { formatAddr, formatDecimal } from './format';
import { labelKindName, labelAt } from './labels';
import { createProjectionReader } from './reader';

export const FLAG_NAMES: readonly FlagName[] = ['ZF', 'CF', 'SF'];

export const FLAG_DESCRIPTIONS: Readonly<Record<FlagName, string>> = {
  ZF: '零标志',
  CF: '进位标志',
  SF: '符号标志',
};

export type RegisterTargetKind = 'vma' | 'hidden' | 'unmapped';

export interface RegisterRowModel {
  readonly name: string;
  readonly hex: string;
  readonly decimal: string;
  readonly changed: boolean;
  readonly role?: 'sp' | 'bp' | 'ip';
  readonly targetKind: RegisterTargetKind;
  /** 指向说明：`stack` / `标注「buf」（缓冲区）` / `隐藏 VMA「key」`。 */
  readonly targetText: string;
}

export interface FlagRowModel {
  readonly name: FlagName;
  readonly description: string;
  readonly value: boolean;
  readonly changed: boolean;
}

export interface RegisterViewInput {
  readonly projection: Projection;
  readonly archBits: number;
  readonly roles: Roles;
  readonly labels?: readonly Label[];
  readonly diff?: ProjectionDiff;
}

export interface RegisterViewRows {
  readonly registers: readonly RegisterRowModel[];
  readonly flags: readonly FlagRowModel[];
}

function roleOf(name: string, roles: Roles): RegisterRowModel['role'] {
  if (name === roles.sp) return 'sp';
  if (name === roles.bp) return 'bp';
  if (name === roles.ip) return 'ip';
  return undefined;
}

function describeTarget(
  reader: ReturnType<typeof createProjectionReader>,
  labels: readonly Label[] | undefined,
  value: bigint,
): { kind: RegisterTargetKind; text: string } {
  const found = reader.locate(value);
  if (!found) return { kind: 'unmapped', text: '未映射' };
  if (found.bytes === undefined) return { kind: 'hidden', text: `隐藏 VMA「${found.vma.id}」（内容未下发）` };

  const label = labelAt(labels, value);
  const offset = value - found.start;
  const suffix = offset === 0n ? '' : `+${offset.toString(16)}`;
  const labelText = label ? `标注「${label.name}」（${labelKindName(label.kind)}）` : undefined;
  const vmaText = `VMA ${found.vma.id}${suffix}`;
  return { kind: 'vma', text: labelText ? `${labelText} · ${vmaText}` : vmaText };
}

export function buildRegisterRows(input: RegisterViewInput): RegisterViewRows {
  const reader = createProjectionReader(input.projection, input.archBits);
  const diff = input.diff ?? EMPTY_DIFF;

  const registers = input.projection.registers.map((item) => {
    const value = parseHex(item.value);
    const target = describeTarget(reader, input.labels, value);
    return {
      name: item.name,
      hex: formatAddr(value, input.archBits),
      decimal: formatDecimal(value),
      changed: diff.registers.has(item.name),
      role: roleOf(item.name, input.roles),
      targetKind: target.kind,
      targetText: target.text,
    };
  });

  const flags = FLAG_NAMES.map((name) => flagRow(input.projection.flags, name, diff));

  return { registers, flags };
}

export function flagRow(flags: FlagsView, name: FlagName, diff: ProjectionDiff): FlagRowModel {
  return {
    name,
    description: FLAG_DESCRIPTIONS[name],
    value: flags[name],
    changed: diff.flags.has(name),
  };
}
