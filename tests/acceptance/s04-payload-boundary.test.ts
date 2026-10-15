import { describe, it } from 'vitest';

/**
 * S04 · payload 边界 — owner F（C/H 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S04 · F，C/H 配合 payload 边界：block 由服务端展开，不相信客户端提供的展开结果；读状态 payload 被
 *     rejected，而不是变成零。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 10 条：客户端提交的 `block` 展开结果被忽略，服务端自己展开。
 *   第 13 条：payload 里出现读状态积木时，提交被 `rejected`，不是静默当成零。
 *
 * 契约依据（03 §3、04 §2/§5.1、05 §4；01 §6 第 3、4 条）：`block` 只发 `{id, args}`，
 * 唯一展开入口是服务端 `expandBlock`；payload 必须自足，不允许含读取当前状态的构造（错误码 `reads_state`）；
 * 客户端编译上限（循环展开 256、表达式求值 4096 步）在服务端复核。
 *
 * D1 状态：**未验收**（骨架）。以下条件全部是 `it.todo`，验收通过前一律不勾选（见本目录 README §0/§3）。
 * 验收关卡：G2 · D4。真实对象：真实服务端展开路径 + H 编译器的真实编译产物 + 首题 ret2win。
 */
describe.skip('S04 payload 边界 · 待真实服务端与编译器产物（G2 · D4）', () => {
  it.todo('block 只接受 {id, args}：带 expand/actions/resolved 等字段的请求被 strictObject 拒绝（C）');
  it.todo('客户端提供的展开结果被忽略：展开以题目包 authorBlocks 为准（C）');
  it.todo('客户端给出的地址/字节与题目包不一致时，实际执行的是题目包展开的动作（C）');
  it.todo('未声明的积木 id 回 unknown_action，状态不变（C）');
  it.todo('积木缺参数、多参数、参数类型不符都回 invalid_arguments，状态不变（C）');
  it.todo('读状态构造（如按当前 RSP 求偏移）在 payload 里被判 rejected，错误码 reads_state（H/C）');
  it.todo('reads_state 不是静默当零：results 里该动作 ok=false 并带错误信息，executed 停在它之前（C）');
  it.todo('同一读状态构造在调试实例与判题实例里按同一契约被拒绝（04 §2/§5.1，B/C）');
  it.todo('客户端编译上限（循环展开 256、表达式 4096 步）在服务端复核，超限被拒绝（05 §4，C/H）');
  it.todo('submit 请求体动作数超 MAX_SUBMIT_ACTIONS 被拒绝，动作 Schema 同样是 strictObject（04 §6，C）');
});
