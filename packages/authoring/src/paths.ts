import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根与题目包路径（E01）。所有文件 IO 都从这里出发，
 * 便于测试把「仓库根」换成一个夹具目录（`test/fixtures`），不碰真实仓库。
 */

/** 仓库根：`packages/authoring/src/paths.ts` 往上三级。 */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/** `challenges/` 目录（可能不存在：出题前 CI 也要能绿）。 */
export function challengesDir(root: string): string {
  return join(root, 'challenges');
}

/** `presets/` 目录。 */
export function presetsDir(root: string): string {
  return join(root, 'presets');
}

/** 单道题的目录：`challenges/<id>/`。 */
export function challengeDir(id: string, root: string): string {
  return join(challengesDir(root), id);
}
