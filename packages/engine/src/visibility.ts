import { hasPerm } from '@pwn2block/shared';
import type { VisibleRead, VmState, VmaId } from '@pwn2block/shared';
import type { EngineEnv } from './env';
import { isRegionVisible, regionById, regionOf } from './layout';

/**
 * 可见性读取（01 §6 第 2 条、04 §4）。
 *
 * 隐藏 VMA 的**内容**永远不从这里出去：隐藏且未 `reveal` 时直接拒绝，
 * 连长度、字节数和错误差异都不带。布局（地址、大小、权限、`hidden`）是公开的，
 * 所以区分 `hidden` / `unmapped` / `permission` 不泄露任何东西。
 *
 * 请求区间必须完整落在一个 VMA 内——跨区间的读取会绕过“单区可见性”的判断。
 */

export function readVisible(
  env: EngineEnv,
  state: VmState,
  addr: bigint,
  len: number,
): VisibleRead {
  if (!Number.isSafeInteger(len) || len < 0) return { ok: false, reason: 'unmapped' };

  const start = addr & env.mask;
  const region = regionOf(env.layoutIndex, start);
  if (region === undefined) return { ok: false, reason: 'unmapped' };
  if (!isRegionVisible(state, region)) return { ok: false, reason: 'hidden' };
  if (start + BigInt(len) > region.end) return { ok: false, reason: 'unmapped' };
  if (!hasPerm(region.perm, 'r')) return { ok: false, reason: 'permission' };

  const result = env.memory.read(state.memory, start, len);
  if (!result.ok) {
    return { ok: false, reason: result.reason === 'permission' ? 'permission' : 'unmapped' };
  }
  return { ok: true, bytes: result.bytes };
}

/** 按 VMA 读可见内容：隐藏且未 `reveal` 时回 `undefined`（布局仍公开）。 */
export function readVmaVisible(env: EngineEnv, state: VmState, vmaId: VmaId): Uint8Array | undefined {
  const region = regionById(env.layoutIndex, vmaId);
  if (region === undefined) return undefined;
  if (!isRegionVisible(state, region)) return undefined;
  return env.memory.readVma(state.memory, vmaId);
}
