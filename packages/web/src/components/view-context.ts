/**
 * 视图数据上下文：所有视图共用同一份最新投影（05 §2.1）。
 *
 * 组件只接收这个对象，自己调 `src/viewmodel/**` 的纯函数排版；
 * 差分在页面壳里算一次，避免每个视图各算一遍。
 */
import type { Label, Projection, Roles } from '@pwn2block/shared';
import type { ProjectionDiff } from '../viewmodel/diff';

export interface ViewContext {
  readonly projection: Projection;
  readonly previous?: Projection;
  readonly archBits: number;
  readonly roles: Roles;
  readonly labels: readonly Label[];
  readonly diff: ProjectionDiff;
}
