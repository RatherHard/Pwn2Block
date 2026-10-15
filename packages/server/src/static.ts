import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * 前端构建产物的静态托管（07 §7：单进程同时提供 API 与静态产物）。
 *
 * 发布边界（01 §6、08 §5 S06）在这里落地：
 * - **只服务 `staticRoot` 内的文件**，默认根是仓库根的 `packages/web/dist`。仓库根、`challenges/`、
 *   `packages/**`、`docs/**` 都在根之外，任何路径都取不到（穿越防护由 `@fastify/static` 提供，
 *   真实 HTTP 用例见 `test/c04-static.test.ts`）。
 * - **不做 SPA 回退**：这个前端是单页但**没有客户端路由**（`web/index.html` 直接挂载），
 *   所以 `index: 'index.html'` 已够用，未命中路径一律 404。回退会把 `/private.json`、
 *   `/packages/**` 这类探测变成 200 HTML，把发布边界掩盖掉。
 * - `list: false`：不提供目录列表，目录请求按未命中处理。
 * - `dotfiles: 'ignore'`：点文件按「不存在」处理，`/.env` 得到 404，而不是 403 或文件内容。
 * - `allowedPath` 再挡一层黑名单文件名，让「取不到私有材料」不完全依赖部署纪律。
 * - 静态根不存在**不是启动错误**：插件只记一条告警，静态请求逐条落成 404，`/api/**` 不受影响
 *   （D5 之前 `dist` 可能还没构建）。根存在但不是目录时跳过注册，避免在 `ready` 阶段抛异常把
 *   整个前台（含 API）带崩。
 */

/** 默认静态根：仓库根的 `packages/web/dist`（`web` 的构建产物）。 */
export function defaultStaticRoot(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

/**
 * 即使被误拷进静态目录也绝不下发的文件名（按路径最后一段判断，大小写不敏感）。
 * `private.json` 与 `solution.md` 是题目包的私有材料（04 §6、08 §5 S06），约定上不进 `dist`；
 * 这里再挡一层，让任何请求都拿不到它们。
 */
const DENIED_BASENAMES: ReadonlySet<string> = new Set(['private.json', 'solution.md']);

/** 判定请求路径是否命中发布黑名单；`@fastify/static` 的 `allowedPath` 用它。 */
export function isDeniedStaticPath(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1).toLowerCase();
  return DENIED_BASENAMES.has(last);
}

/** 静态根的状态：可用目录 / 存在但不是目录 / 不存在。 */
type RootState = 'dir' | 'other' | 'missing';

function rootState(root: string): RootState {
  try {
    return statSync(root).isDirectory() ? 'dir' : 'other';
  } catch {
    return 'missing';
  }
}

/**
 * 把静态托管挂到 `/`。挂载本身是同步的，路由在 `ready` 阶段才生效（真实 HTTP 用例用 `app.inject`）。
 */
export function registerStatic(
  app: FastifyInstance,
  staticRoot: string = defaultStaticRoot(),
): void {
  const root = resolve(staticRoot);
  // 配置指向一个文件：部署错误。跳过注册，让 API 照常工作，而不是让 `ready` 抛异常。
  if (rootState(root) === 'other') return;

  app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: 'index.html',
    list: false,
    dotfiles: 'ignore',
    allowedPath: (pathname) => !isDeniedStaticPath(pathname),
  });
}
