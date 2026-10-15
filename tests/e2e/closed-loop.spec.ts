import { test } from '@playwright/test';

/**
 * 01 §3 八步闭环 E2E 骨架 — owner F · 关卡 **G3 · D5**。
 *
 * **D1 只搭骨架，D5 才做真实验收。** 真实验收的前置条件：
 *   1. 真实后端在跑（`pnpm dev` 或 `pnpm start`，04 §6 默认端口 8787）；
 *   2. 真实首题 `challenges/ret2win` 已就位、`FLAG_RET2WIN` 已注入；
 *   3. 已安装浏览器：`pnpm exec playwright install chromium`；
 *   4. 环境变量 `PWN2BLOCK_E2E=1`（可选 `PWN2BLOCK_BASE_URL` 覆盖地址）。
 * 不满足第 4 条时整组跳过——`pnpm e2e` 在默认环境下应当是 0 个用例执行、全部 skipped。
 *
 * 本文件里每个用例体都会**显式失败**（`throw`）：D5 之前如果有人打开开关跑它，拿到的是红色失败清单，
 * 而不是假绿。实现时按注释里的断言清单补真实操作，**不要改成空体或占位断言**。
 *
 * 步骤出处：`docs/01-产品与范围.md` §3（1–6 调试段，7–8 判题段）；
 * 附加断言出处：`docs/08` §3 D5 行 / G3「调试不发 flag，正式提交成功才发」。
 */

const E2E_ENABLED = process.env.PWN2BLOCK_E2E === '1';
const E2E_SKIP_REASON =
  'D5 才做真实验收：需要 PWN2BLOCK_E2E=1、正在运行的真实后端与真实首题 ret2win，以及已安装的 Playwright 浏览器';

/** 未实现时统一抛出，保证不会假通过。 */
function pending(step: string, checklist: readonly string[]): never {
  throw new Error(`D5 待实现：${step}。需要的断言：\n- ${checklist.join('\n- ')}`);
}

// 闭环是一条串行的会话：一个后端、一份会话状态。
test.describe.configure({ mode: 'serial' });

test.describe('01 §3 八步闭环 · 真实后端 + 真实首题（G3 · D5）', () => {
  test.skip(!E2E_ENABLED, E2E_SKIP_REASON);

  test('第 1 步：打开题目页，阅读题面', () => {
    pending('打开题目页并阅读题面', [
      "page.goto('/') 返回中文题目列表（GET /api/challenges 至少含 ret2win）",
      '进入 ret2win 题目页后题面标题与 briefing 文本可见（GET /api/challenges/ret2win）',
      '页面无 console error（页面级错误会掩盖真实缺陷）',
    ]);
  });

  test('第 2 步：创建会话，拿到调试实例的公开投影', () => {
    pending('创建服务端会话', [
      'POST /api/sessions {challengeId:"ret2win"} 返回 sessionId 与完整投影',
      '投影 status=ready、vmas 含 text/stack 布局、disasm 非空',
      '投影里没有任何 flag / win / fail / 虚拟文件内容字段（S01 的端到端复核）',
    ]);
  });

  test('第 3 步：观察栈视图、寄存器视图和指令视图，找到 buffer / saved RBP / return address', () => {
    pending('观察三视图', [
      '栈视图显示 buf(0x7fffff00) / saved rbp(0x7fffff10) / ret addr(0x7fffff18) 的语义标注',
      '寄存器视图显示 RSP=0x7fffff00、RBP=0x7fffff10、RIP=0x400000',
      '指令视图显示 text 段反汇编（leave / ret / syscall 序列）',
    ]);
  });

  test('第 4 步：手工写字节、单步、运行 N 步、后退一步，算出偏移', () => {
    pending('手工试（不进 payload）', [
      '工具栏动作写入 16 字节填充后栈视图对应地址高亮变化',
      'step 一次后 steps 与 IP 按 04 §4 的投影契约前进',
      'run N 步在 limit 处停下，lastStop.reason=limit',
      'step_back 一次后寄存器与内存回到上一条指令之前',
      '整个调试过程中页面不出现 flag（G3 附加断言）',
    ]);
  });

  test('第 5 步：在积木窗口里拼出 payload（填充 + 地址），试运行看效果', () => {
    pending('拼 payload 并试运行', [
      '积木窗口按 03 §3 的 authorBlocks 渲染 gets(buf) 积木',
      '放入 payload 后编译出 fill + 小端地址，编译器不报错',
      '试运行触发的请求 action 序列与编译器产物一致',
    ]);
  });

  test('第 6 步：失败时阅读错误解释、揭示下一级提示；回退后改了再试', () => {
    pending('错误解释与提示', [
      '故意写错地址时页面给出中文错误解释（04 §4 的 error.code/message/note）',
      '提示按 failures 门槛逐级解锁（03 §1 hints.unlockAfterFailures）',
      '回退（undo/step_back/reset）后按钮状态与 history 深度一致（05 §6）',
    ]);
  });

  test('第 7 步：点“提交判题”，判题实例重置到初始状态并回放 payload', () => {
    pending('提交判题', [
      'POST /api/sessions/:id/submit 用编译产物动作序列回放',
      '录像首帧等于题目初态，而不是调试实例当前状态（S02 的端到端复核）',
      '提交前后调试实例的页面状态逐字段不变',
    ]);
  });

  test('第 8 步：判胜显示 flag；否则看录像定位问题，回到调试模式继续；提交不限次数', () => {
    pending('判胜与回放', [
      '参考解法提交后 verdict=won 且页面显示 flag',
      '错误 payload 提交后 verdict=incomplete/rejected/failed，页面给出对应中文结论',
      '录像可拖动查看逐动作 diff，并能回到调试模式继续（04 §5.1）',
      '连续多次提交互不影响，提交次数不限',
    ]);
  });

  test('附加断言（G3）：调试实例全程不出现 flag，只有 submit won 才下发', () => {
    pending('调试/判题 flag 边界', [
      '调试实例所有响应（创建/动作/GET/录像）的 JSON 里都没有 flag 字段',
      '调试实例命中成功条件时只提示“已满足”，不发 flag、不记录通过',
      '仅 submit 返回 verdict=won 的那次响应带 flag，且值等于注入的环境变量真值',
    ]);
  });
});
