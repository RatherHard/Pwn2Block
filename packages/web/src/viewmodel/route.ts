/**
 * 页面路由（history 路由）：题目列表与题目页各有自己的地址，刷新、前进后退和直接打开链接
 * 都能落到对应页面。纯函数，不碰 `window.history`；读写地址栏由页面壳负责。
 *
 * - `/` 是题目列表；
 * - `/challenges/<id>` 是题目页。id 只拿来和服务器给的题目列表比对，不在列表里就显示
 *   「题目不存在」，不会被拿去请求后端；
 * - 其余地址按题目列表处理。生产环境服务端只对 `/` 和合法形状的 `/challenges/<id>` 回
 *   `index.html`（见 server/static.ts），其余地址到不了前端。
 */
import type { ControllerState } from './controller';

export type Route =
  | { readonly kind: 'list' }
  | { readonly kind: 'challenge'; readonly id: string };

export const LIST_ROUTE: Route = { kind: 'list' };

const CHALLENGE_PATH_RE = /^\/challenges\/([^/]+)\/?$/;

export function parseRoute(pathname: string): Route {
  const id = CHALLENGE_PATH_RE.exec(pathname)?.[1];
  return id === undefined ? LIST_ROUTE : { kind: 'challenge', id };
}

export function routePath(route: Route): string {
  return route.kind === 'list' ? '/' : `/challenges/${route.id}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b);
}

/**
 * 控制器当前停在哪个页面，返回对应的地址；页面还没定下来时返回 `undefined`，地址栏保持不动：
 * - `choosing` 是题目列表；
 * - 已选定 `challengeId`（打开中、就绪、打开失败）是题目页；
 * - `loading`、列表加载失败、`missing`（题目不存在）都没有自己的规范地址。
 */
export function routeOfState(state: Pick<ControllerState, 'phase' | 'challengeId'>): Route | undefined {
  if (state.phase === 'choosing') return LIST_ROUTE;
  if (state.phase === 'loading' || state.phase === 'missing' || state.challengeId === undefined) return undefined;
  return { kind: 'challenge', id: state.challengeId };
}
