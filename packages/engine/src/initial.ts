import { formatHex, hexToBytes, parseHex } from '@pwn2block/shared';
import type {
  ChallengeVma,
  Fd,
  PrivateChallenge,
  VmaInit,
  VmaLayout,
} from '@pwn2block/shared';
import { maskTo } from './state';

/**
 * 题目包 → 引擎初始化数据的纯转换（02 §2、§3、§5.3）。
 *
 * 这里不碰内存实现，也不做跨包校验（那是 `shared/validate.ts` 的职责）：
 * 输入是已经解析并校验过的公开 / 私有包，输出是 `MemoryApi.create` 与初态需要的结构。
 */

/** 私有包 VMA → `VmaInit[]`，`init` 补丁解析成整数地址 + 字节。 */
export function toVmaInits(vmas: readonly ChallengeVma[]): VmaInit[] {
  return vmas.map((vma) => ({
    id: vma.id,
    kind: vma.kind,
    label: vma.label,
    start: parseHex(vma.start),
    size: Number(parseHex(vma.size)),
    perm: vma.perm,
    hidden: vma.hidden,
    init: (vma.init ?? []).map((patch) => ({
      at: parseHex(patch.at),
      bytes: hexToBytes(patch.hex),
    })),
  }));
}

/** 公开布局：顺序即题目包声明顺序，隐藏区只给布局、不给内容（02 §3、04 §4）。 */
export function buildVmaLayout(vmas: readonly ChallengeVma[]): VmaLayout[] {
  return vmas.map((vma) => ({
    id: vma.id,
    kind: vma.kind,
    label: vma.label,
    start: formatHex(parseHex(vma.start)),
    size: formatHex(parseHex(vma.size)),
    perm: vma.perm,
    hidden: vma.hidden,
  }));
}

/** 初始寄存器：按 `initRegisters` 初始化，未列出为 0，全部按位宽掩蔽（03 §2）。 */
export function initialRegisters(priv: PrivateChallenge, mask: bigint): Record<string, bigint> {
  const registers: Record<string, bigint> = {};
  for (const name of priv.registers) {
    const raw = priv.initRegisters?.[name];
    registers[name] = raw === undefined ? 0n : maskTo(parseHex(raw), mask);
  }
  return registers;
}

/** 初始文件读偏移：每个 `file` fd 从 0 开始（02 §5.3）。 */
export function initialFileOffsets(fds: readonly Fd[] | undefined): Record<number, number> {
  const offsets: Record<number, number> = {};
  for (const fd of fds ?? []) {
    if (fd.kind === 'file') offsets[fd.fd] = 0;
  }
  return offsets;
}
