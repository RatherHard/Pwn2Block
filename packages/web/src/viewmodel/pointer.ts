/**
 * 跳转链解析（05 §2.2）：把栈槽 / 寄存器里的值当指针跟随，最多 3 跳。
 *
 * pwndbg 风格附注的三个来源都在这里汇总：
 * - 跳转链 `→ 0x… → 0x…`（最多 `MAX_POINTER_HOPS` 跳）；
 * - 链落到可执行区域时的伪汇编——**取自投影 `disasm`，前端不解码**；
 * - 可打印字节的 ASCII。
 *
 * 跟随的每一步都必须落在投影里已映射的地址上（含隐藏 VMA：布局公开，只是读不到内容），
 * 这样既不会把随机数据当地址乱跟，也不会绕过“隐藏即不下发”。
 */
import type { Label } from '@pwn2block/shared';
import { formatAddrShort } from './format';
import { labelAt } from './labels';
import type { ByteState, ProjectionReader } from './reader';

export const MAX_POINTER_HOPS = 3;

/** 低于一页的值不当作地址跟随（0 与小整数在内存里到处都是）。 */
export const MIN_POINTER_VALUE = 0x1000n;

export type PointerStop = 'limit' | 'unmapped' | 'hidden' | 'boundary' | 'not-address';

export interface PointerHop {
  readonly addr: bigint;
  readonly state: ByteState;
  readonly vmaId?: string;
  /** 从该地址读出的字（解引用结果）；不可读时省略。 */
  readonly word?: bigint;
}

export interface PointerChain {
  readonly start: bigint;
  readonly hops: readonly PointerHop[];
  readonly stop: PointerStop;
  /** 终点处可打印字节。 */
  readonly ascii?: string;
  /** 终点落在可执行区域时的伪汇编，取自投影 `disasm`。 */
  readonly text?: string;
  /** 终点命中的公开标注名。 */
  readonly label?: string;
}

export interface PointerChainOptions {
  readonly maxHops?: number;
  readonly labels?: readonly Label[];
}

function isFollowable(reader: ProjectionReader, word: bigint): boolean {
  return word >= MIN_POINTER_VALUE && reader.locate(word) !== undefined;
}

export function resolvePointerChain(
  reader: ProjectionReader,
  start: bigint,
  options: PointerChainOptions = {},
): PointerChain {
  const maxHops = Math.max(1, options.maxHops ?? MAX_POINTER_HOPS);
  const hops: PointerHop[] = [];
  let current = start;
  let derefs = 0;
  let stop: PointerStop;

  for (;;) {
    const info = reader.byteAt(current);
    const word = info.state === 'visible' ? reader.readWordLE(current) : undefined;
    hops.push({ addr: current, state: info.state, vmaId: info.vmaId, word });

    if (info.state === 'hidden') {
      stop = 'hidden';
      break;
    }
    if (info.state === 'unmapped') {
      stop = 'unmapped';
      break;
    }
    if (word === undefined) {
      stop = 'boundary';
      break;
    }
    if (!isFollowable(reader, word)) {
      stop = 'not-address';
      break;
    }
    if (derefs >= maxHops) {
      stop = 'limit';
      break;
    }
    derefs += 1;
    current = word;
  }

  const last = hops[hops.length - 1];
  const chain: PointerChain = { start, hops, stop };
  if (!last || last.state !== 'visible') {
    return { ...chain, label: last ? labelAt(options.labels, last.addr)?.name : undefined };
  }

  const vma = reader.locate(last.addr)?.vma;
  const text = vma?.perm.includes('x') ? reader.disasmAt(last.addr)?.text : undefined;
  return {
    ...chain,
    ascii: reader.readString(last.addr, 8),
    text,
    label: labelAt(options.labels, last.addr)?.name,
  };
}

export interface PointerDescription {
  /** `→ 0x7fffff00 → 0x4141414141414141` 这样的链文本。 */
  readonly arrows: string;
  /** 终点说明：伪汇编 / 标注名 / ASCII / 隐藏 VMA。 */
  readonly annotation?: string;
  /** 终点处是否隐藏（内容不下发，只能显示布局）。 */
  readonly hidden: boolean;
}

/**
 * 生成可直接渲染的附注。
 *
 * 返回 undefined 表示这个值不像指针（首跳就未映射），视图不应显示跳转链。
 * 隐藏 VMA 只标注“隐藏”与 VMA id，**不显示任何字节**。
 */
export function describePointerChain(chain: PointerChain): PointerDescription | undefined {
  const first = chain.hops[0];
  if (!first || first.state === 'unmapped') return undefined;

  const arrows = chain.hops.map((hop) => formatAddrShort(hop.addr)).join(' → ');
  const last = chain.hops[chain.hops.length - 1];
  const parts: string[] = [];
  if (last) {
    if (last.state === 'hidden') parts.push(`隐藏 VMA「${last.vmaId ?? '?'}」`);
    if (chain.text) parts.push(chain.text);
    if (chain.label) parts.push(chain.label);
    if (chain.ascii) parts.push(`"${chain.ascii}"`);
  }
  return {
    arrows: `→ ${arrows}`,
    annotation: parts.length > 0 ? parts.join(' · ') : undefined,
    hidden: chain.hops.some((hop) => hop.state === 'hidden'),
  };
}
