# 08 开发记录

这份文档只记录里程碑、当前风险和下一步，不再保存逐日聊天记录。详细行为以代码、测试和 [09-契约冻结](09-契约冻结.md) 为准。

## 已完成的主链路

- shared 类型、Schema 与 VM 基础状态已落地。
- engine 支持确定性执行、COW 内存、动作回退和录像帧。
- authoring CLI 支持题目创建、汇编、校验和参考解法。
- server 提供题目列表、会话、动作执行、提交判题、投影和静态托管。
- web 已接入真实 API、Blockly 编译、程序/输出区、视图滚动、提示、刷新恢复、判题回放和 flag 展示。
- 真实题目和集成/E2E 测试覆盖主闭环：加载题目 → 编辑 payload → 调试 → 提交 → 回放 → 返回调试。

## 当前验收基线

每次集成至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm challenge:check <id>
pnpm challenge:solve <id>
```

涉及页面时再运行 `pnpm build`，涉及浏览器行为时运行 `pnpm e2e`。改动题目后，所有题目的 `check` 和 `solve` 都要重跑。

## 仍需关注的风险

- 引擎的边界条件、隐藏内容不泄露、客户端伪造状态、回放隔离和拒绝动作不变更投影，都是发布前阻塞项。
- `private.json`、环境变量和题目加载失败路径要持续做静态检查与日志核对。
- 真实浏览器验收应覆盖 Chromium 的桌面尺寸、键盘焦点、刷新恢复、四类判题结果和历史回放；原型截图不能替代真实 API 验收。
- 发现契约变化时，先更新 shared 和 [09](09-契约冻结.md)，再同步 server、web、测试和本目录。

## 工作拆分

| 方向 | 主要目录 | 交付证据 |
|---|---|---|
| 契约 | `packages/shared`, `docs/09` | 类型检查、消费者清单 |
| 引擎 | `packages/engine` | 精确状态测试、覆盖率 |
| 服务端 | `packages/server` | API/安全/生命周期测试 |
| 前端 | `packages/web` | typecheck、build、真实浏览器验收 |
| 出题 | `packages/authoring`, `challenges` | check、solve、题目回归 |
| 验收 | `tests/acceptance`, `tests/e2e` | 闭环、边界和回归证据 |

每个任务保持独立写入边界；契约改动由 shared 先收口，消费者一次性跟进。不要把“原型通过”当成“生产验收通过”。
