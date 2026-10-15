import { describe, it } from 'vitest';

/**
 * S02 · 判题边界 — owner F（B/C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S02 · F，B/C 配合 判题边界：调试 satisfied 不发 flag、不记录通过；submit 从初态回放，不能借用手工调试状态，
 *     且不修改调试实例。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 8 条：调试实例的投影里永远没有 `flag` 字段，哪怕当前状态已满足成功条件。
 *   第 9 条：调试实例里满足成功条件只回“已满足”，不下发 flag、不记录通过。
 *   08 §5 另加的提交隔离：判题实例从初态回放，不能借用调试实例里的手工状态，且不修改调试实例。
 *
 * 契约依据（04 §1、§1.1、§5.1）：调试实例没有 `won`；提交是纯函数 `reset → 回放 → 判定`，`fail` 优先；
 * 判题实例没有回退，提交不限次数、不压调试实例快照。
 *
 * D1 状态：**未验收**（骨架）。以下条件全部是 `it.todo`，验收通过前一律不勾选（见本目录 README §0/§3）。
 * 验收关卡：G2 · D4。真实对象：真实 `POST /api/sessions/:id/submit` + 判题实例（B03 纯回放）+ 首题 ret2win。
 */
describe.skip('S02 判题边界 · 待真实服务端与判题实例（G2 · D4）', () => {
  it.todo('调试实例命中成功条件后 status 只变 satisfied，投影里没有 flag 字段（B/C）');
  it.todo('调试实例 satisfied 前后的投影字段集合完全一致，不新增任何“已通过”字段（C）');
  it.todo('调试实例 satisfied 不记录通过：后续 GET 会话与再提交都查不到通过标记（C）');
  it.todo('调试实例不存在 won 状态：任何动作都不会让调试实例进入 won（04 §1.1，B/C）');
  it.todo('手工调试（写字节/单步/回退）后再提交同一 payload，判题结果与全新会话逐字段一致（B/C）');
  it.todo('submit 的判题实例从题目初态重置后回放：录像首帧等于题目初态，而不是调试态（B）');
  it.todo('submit 前后调试实例投影逐字段相等（registers/vmas/status/steps/failures/error，C）');
  it.todo('submit 后调试实例 history 深度不变，undo 仍回退到提交前的手工请求（C）');
  it.todo('verdict 四态完整：仅 won 带 flag，failed/rejected/incomplete 都不带 flag（04 §5.1，C）');
  it.todo('命中 fail 时即使 win 也成立，仍判 failed（fail 优先，04 §5.1，B/C）');
  it.todo('提交次数不限：连续多次 submit 的结果互相独立，不因上一次判胜而改变（C）');
});
