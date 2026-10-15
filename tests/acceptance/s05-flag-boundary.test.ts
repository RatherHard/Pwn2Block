import { describe, it } from 'vitest';

/**
 * S05 · flag 边界 — owner F（C/E 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S05 · F，C/E 配合 flag 边界：缺失环境变量，或虚拟文件/隐藏 VMA 内容包含注入的 flag 真值时拒绝加载；
 *     使用测试哨兵值，不把真实 flag 写进仓库。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 7 条：虚拟文件或隐藏 VMA 的内容包含 flag 真值时，该题拒绝加载。
 *
 * 契约依据（06 §6、07 §7、04 §6）：`flag` 字段写 `env:FLAG_<ID 大写>`，真值由环境变量注入，缺失就拒绝加载；
 * 泄露检查要覆盖大小写变体；只用 `TEST_FLAG_SENTINEL` 这类哨兵值，真值绝不进仓库。
 *
 * D1 状态：**未验收**（骨架）。以下条件全部是 `it.todo`，验收通过前一律不勾选（见本目录 README §0/§3）。
 * 验收关卡：G2 · D4。真实对象：真实服务端题目加载 + 首题 `challenges/ret2win` + 环境变量注入与缺失两种路径。
 * 说明：shared 层已有该语义的单测（`packages/shared/test/challenge.test.ts` 的「flag 真值泄露检查」），
 * 但**服务端加载路径**仍是未验收状态。
 */
describe.skip('S05 flag 边界 · 待真实题目加载（G2 · D4）', () => {
  it.todo('缺失 FLAG_<ID> 环境变量：该题拒绝加载，服务仍能启动并给出可诊断的告警（C）');
  it.todo('缺失环境变量的题目不出现在 /api/challenges 列表，创建会话回 challenge_unavailable（C）');
  it.todo('虚拟文件内容包含注入的哨兵真值时拒绝加载该题（C/E）');
  it.todo('隐藏 VMA 内容包含注入的哨兵真值时拒绝加载该题（C/E）');
  it.todo('哨兵真值的大小写变体同样被拒绝（hex.ts containsBytesIgnoringAsciiCase，C/E）');
  it.todo('拒绝加载时错误响应与日志不含私有包字段、文件路径或内部堆栈（04 §6，C）');
  it.todo('哨兵值只用 TEST_FLAG_SENTINEL：仓库里不存在真实 flag 真值（F/E）');
  it.todo('challenges/** 的 flag 字段只写 env:FLAG_<ID>，.env.example 只有变量名与占位说明（E/A）');
  it.todo('加载失败不把“命中了哪段内容/哪个地址”这类细节回给客户端（C）');
});
