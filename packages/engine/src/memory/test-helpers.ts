import type { MemResult, Perm, VmaId, VmaInit, VmaInitPatch } from '@pwn2block/shared';

/** 构造一个合法的 `VmaInit`：测试只写差异部分。 */
export function vma(
  id: VmaId,
  start: bigint,
  size: number,
  perm: Perm,
  extra: Partial<VmaInit> = {},
): VmaInit {
  return {
    id,
    kind: 'custom',
    label: `label-${id}`,
    start,
    size,
    perm,
    hidden: false,
    init: [],
    ...extra,
  };
}

/** 初始内容补丁。 */
export function patch(at: bigint, values: readonly number[]): VmaInitPatch {
  return { at, bytes: Uint8Array.from(values) };
}

/** 取成功结果里的字节，便于逐字节精确断言；失败时抛出，避免模糊断言。 */
export function bytesOf(result: MemResult): number[] {
  if (!result.ok) {
    throw new Error(`期望访问成功，实际失败：${result.reason} @ ${result.addr}`);
  }
  return [...result.bytes];
}
