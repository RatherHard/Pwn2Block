/**
 * 视图数据上下文（05 §2.1）：所有视图共用同一份最新投影 + 同一份公开包。
 *
 * 两条只读输入的来源都写死在这里，调用方无法替换：
 *
 * - `roles` 从 `projection.roles` 取（D1 契约决策，08 §9.2 / 09 §4）。页面壳不持有角色名，
 *   也没有参数可以塞进另一套，所以「前端硬编码 `RSP` / `RBP` / `RIP`」在类型上就无处可写；
 *   32 位题目（`ESP` / `EBP` / `EIP`）或自定义命名的题目因此不需要前端特判。
 * - `labels` 从公开包取。I/O 视图的可用性与渲染也读同一份 `challenge`
 *   （05 §2.6：题目声明 `syscalls` 或 `fds` 时出现），不再各判一套。
 *
 * 这里是纯函数，不依赖 DOM 与 lit：页面壳调用它，测试也能用同一段代码断言。
 */
import type { Label, Projection, PublicChallenge, Roles } from '@pwn2block/shared';
import type { ProjectionDiff } from './diff';

export interface ViewContext {
  readonly projection: Projection;
  readonly previous?: Projection;
  readonly archBits: number;
  /** 公开包（`GET /api/challenges/:id`）：速查表与可用性判定都读它，**不含任何私有内容**。 */
  readonly challenge: PublicChallenge;
  /** 一律等于 `projection.roles`。 */
  readonly roles: Roles;
  /** 一律等于 `challenge.labels ?? []`。 */
  readonly labels: readonly Label[];
  readonly diff: ProjectionDiff;
}

/** 构造上下文时**不接受**派生字段：`roles` 来自投影，`labels` 来自公开包。 */
export type ViewContextInput = Omit<ViewContext, 'roles' | 'labels'>;

export function createViewContext(input: ViewContextInput): ViewContext {
  return {
    ...input,
    roles: input.projection.roles,
    labels: input.challenge.labels ?? [],
  };
}
