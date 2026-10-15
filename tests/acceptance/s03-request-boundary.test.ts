import { describe, it } from 'vitest';

/**
 * S03 · 请求边界 — owner F（C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S03 · F，C 配合 请求边界：伪造快照/成功标记、未知动作、未允许的动作被拒绝；拒绝不修改状态，
 *     回退动作按契约仍可用。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 11 条：伪造判胜结果或提交快照的请求被拒绝。
 *   第 12 条：不在 `allowedActions` 里的动作被拒绝。
 *
 * 契约依据（04 §2、§3、§6；01 §6 第 3 条）：请求体一律 `strictObject`，多余字段被拒；被拒绝的动作不修改状态、
 * 不压快照；`failures` 单调递增，不随回退减少；回退类动作（`undo`/`step_back`/`reset`）始终可用。
 *
 * D1 状态：**未验收**（骨架）。以下条件全部是 `it.todo`，验收通过前一律不勾选（见本目录 README §0/§3）。
 * 验收关卡：G2 · D4。真实对象：真实 Fastify 实例（`buildApp` + `inject`）与真实请求 Schema。
 * 说明：shared 层已有动作 Schema 单测（`packages/shared/test/actions.test.ts`），那**不等于**本项验收。
 */
describe.skip('S03 请求边界 · 待真实 REST 路径（G2 · D4）', () => {
  it.todo('请求体带客户端伪造的判胜结果（verdict/ok/won 之类字段）被 strictObject 拒绝（C）');
  it.todo('请求体带伪造快照或状态（snapshot/state/clientState 之类字段）被拒绝，服务端不接受客户端状态（C）');
  it.todo('请求体带伪造成功标记（succeeded/win/flag 之类字段）被拒绝（C）');
  it.todo('未知动作名被拒绝（unknown_action），且不进 allowedActions 判断之外的分支（C）');
  it.todo('不在 allowedActions 里的执行类动作被拒绝（action_not_allowed），状态不变（C）');
  it.todo('任何拒绝都不修改状态：投影逐字段与请求前相等，且不压快照（history 不变，C）');
  it.todo('拒绝使 failures 单调 +1，且回退后不减少（04 §3，C）');
  it.todo('回退动作不受 allowedActions 约束：undo/step_back/reset 始终可用（04 §2，C）');
  it.todo('历史为空时回退被拒绝并回 empty_history，而不是静默成功（04 §3，C）');
  it.todo('failed / exited 状态下执行类动作被拒（not_executable），回退类仍可用（04 §1.1，C）');
  it.todo('请求体超体积、动作数超 MAX_ACTIONS_PER_REQUEST 被拒绝（04 §6，C）');
  it.todo('拒绝响应的错误体不含内部堆栈、文件路径或私有包字段（04 §6，C）');
});
