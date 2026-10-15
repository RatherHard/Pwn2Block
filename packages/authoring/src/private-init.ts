import type { InitPatch } from '@pwn2block/shared';

/**
 * 把汇编结果的 `init` 补丁写回 `private.json`（06 §2、§3 第 2 步）。
 *
 * 为什么不用「整体 `JSON.stringify` 后覆盖」：那会把出题人手写的排版全部冲掉，
 * 每次改动都变成整文件 diff。这里只替换 `program.asm` 声明的那些段的 `init`
 * （其它 VMA 的 `init`，比如栈上的初始内容，原样保留），缩进沿用文件里已有的风格；
 * 数据没变时 `changed` 为 `false`，调用方据此不写盘，重跑 `challenge:asm` 幂等。
 */

/** 一个 `.vma` 段要写回的补丁；与 `asm.ts` 的 `AsmSegmentResult` 形状一致。 */
export interface InitSegmentPatch {
  readonly vmaId: string;
  readonly patches: readonly InitPatch[];
}

export type ApplyInitResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

/** 从已有文本里认出缩进风格（第一个缩进行），认不出就用两空格。 */
export function detectIndent(text: string): string {
  const matched = /\n([ \t]+)\S/.exec(text);
  return matched ? matched[1] : '  ';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 替换 `private.json` 里指定 VMA 的 `init`；其余字段与排版保持不变。 */
export function applyInitPatches(
  privateText: string,
  segments: readonly InitSegmentPatch[],
): ApplyInitResult {
  let raw: unknown;
  try {
    raw = JSON.parse(privateText) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `private.json 不是合法 JSON：${detail}` };
  }

  if (!isRecord(raw)) return { ok: false, message: 'private.json 的顶层必须是对象' };
  const vmas = raw.vmas;
  if (!Array.isArray(vmas)) return { ok: false, message: 'private.json 的 vmas 必须是数组' };

  const indexById = new Map<string, number>();
  vmas.forEach((vma, index) => {
    if (!isRecord(vma) || typeof vma.id !== 'string') {
      return;
    }
    if (!indexById.has(vma.id)) indexById.set(vma.id, index);
  });

  const next = vmas.map((vma) => (isRecord(vma) ? { ...vma } : vma));
  for (const segment of segments) {
    const index = indexById.get(segment.vmaId);
    if (index === undefined) {
      return { ok: false, message: `program.asm 引用了 private.json 里不存在的 VMA：${segment.vmaId}` };
    }
    const target = next[index];
    if (!isRecord(target)) {
      return { ok: false, message: `private.json 的 vmas.${index} 不是对象，无法写入 init` };
    }
    next[index] = { ...target, init: segment.patches.map((patch) => ({ at: patch.at, hex: patch.hex })) };
  }

  const indent = detectIndent(privateText);
  const newline = privateText.endsWith('\n') ? '\n' : '';
  const text = `${JSON.stringify({ ...raw, vmas: next }, null, indent)}${newline}`;
  // 「有没有变化」比的是**数据**：出题人手写的排版没变就不该重写整个文件。
  const canonicalBefore = `${JSON.stringify(raw, null, indent)}${newline}`;
  return { ok: true, text, changed: text !== canonicalBefore };
}
