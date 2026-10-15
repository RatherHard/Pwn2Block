import type { ChallengeVma, InitPatch } from '@pwn2block/shared';

/**
 * 伪汇编器（06 §2.2）：`program.asm` → code VMA 的 `init` 补丁。
 *
 * **D1 只冻结接口，不实现**（E01，D2–D3 接）。计划中的流水线：
 * 1. 按 `.vma <id>` 分段，用 `private.json` 里该 VMA 的 `start` 作为段基址；
 * 2. 第一遍扫标签，算出每个标签的绝对地址（跳转目标写标签，汇编器算地址）；
 * 3. 第二遍逐行编码：指令按 `EncodingLookup.find(op, operands)` 查 opcode，
 *    `imm` / `disp` 按 W 字节小端跟在后面；`.byte` / `.ascii` 直接落字节；
 * 4. 输出 `{ vmaId, patches }` 与地址清单（标签 → 绝对地址），CLI 写回 `private.json` 的 `init`。
 *
 * 没有宏、没有表达式求值：它只是「别手写 hex」的工具，不是真汇编器。
 * 在此之前，出题人直接手写 `private.json` 的 `init`。
 */

export interface AsmListingEntry {
  readonly label: string;
  readonly addr: string;
  readonly vma: string;
}

export type AsmResult =
  | {
      readonly ok: true;
      readonly vmaId: string;
      readonly patches: readonly InitPatch[];
      readonly listing: readonly AsmListingEntry[];
    }
  | { readonly ok: false; readonly message: string };

export const ASM_UNIMPLEMENTED_MESSAGE =
  '伪汇编器尚未实现（E01，D2–D3 接）：现在请手写 private.json 里 VMA 的 init 字节。';

/** 编译 `program.asm`。当前返回明确的未实现错误，绝不返回半成品字节。 */
export function assembleProgram(
  _source: string,
  _vmas: readonly ChallengeVma[],
): AsmResult {
  return { ok: false, message: ASM_UNIMPLEMENTED_MESSAGE };
}
