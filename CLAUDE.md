# Pwn2Block

Pwn2Block 是面向 CTF 初学者的内存可视化 Pwn 实验室：学习者用 Blockly 拼装 payload，由后端权威 VM 执行，再观察栈、寄存器、指令和 I/O 的变化。

## 先记住四条边界

1. **后端权威**：完整 VM 状态、私有题目包和 flag 只在服务端；浏览器只发送受限动作，接收公开投影。
2. **隐藏内容不下发**：隐藏 VMA、虚拟文件的内容不得出现在响应、错误文案或副作用中，只能通过程序执行获得；固定的布局信息可以公开。
3. **客户端不可信**：服务端不接受客户端提交的状态、快照或成功标记，判定只能由服务端完成。
4. **题目包是数据**：DSL 只组合封闭的内置原语，不允许回调、脚本或 `eval`。

前端混淆、禁用右键和 DevTools 检测不属于安全措施。

## 结构

```text
packages/shared/     类型与 Schema，跨层单一事实来源
packages/engine/     纯函数 VM 与 COW 内存，不依赖 HTTP
packages/server/     Fastify、会话、REST、题目加载、静态托管
packages/web/        Vite + Lit + Blockly 单页应用
packages/authoring/  asm / check / solve / new 出题 CLI
challenges/          题目包
presets/             默认编码表
```

依赖只能向左，尤其是 `engine` 不得 import `server`。

## 会话模型

一个会话包含两个实例：调试实例允许反复试验、回退和观察，满足条件时只提示“已满足”；提交判题时，服务端把 payload 在初始状态重新回放，判胜后才下发 flag。详见 [04-会话与API](docs/04-会话与API.md)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动服务端与前端 |
| `pnpm test` | 运行全部测试 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint 检查 |
| `pnpm build` | 构建前端 |
| `pnpm challenge:check <id>` | 校验题目包 |
| `pnpm challenge:solve <id>` | 执行参考解法 |

改动 API、引擎语义或题目包格式时，同步更新 `docs/02`、`docs/03`、`docs/04` 及相关测试。

## Git 约定

- `main` 保持可运行；配置 remote 后使用 `feat/`、`fix/`、`docs/`、`refactor/`、`challenge/` 分支。
- 一个提交只做一件可回滚的事，提交信息格式为 `<type>: <中文描述>`。
- 只暂存本任务文件，提交前运行相关检查和 `git diff --cached --check`。
- 不提交 `.env`、凭证、构建产物、`node_modules`、覆盖率报告或缓存。
- `private.json` 是题目包的一部分，应提交；其中的 flag 只保存 `env:FLAG_<ID>` 引用，真值由环境变量注入。
- 不使用 `git push --force`、`reset --hard`、`clean -f`、`branch -D` 或 `--no-verify`。

## 开发规则

- 中文界面、注释和文档；地址、寄存器、指令和 API 标识保留技术名称。
- 优先不可变数据和显式错误处理；所有系统边界都校验输入。
- 不留下 `console.log` 或调试代码。
- 引擎测试要断言精确状态；完整 MVP 要求引擎覆盖率至少 80%，安全测试清单见 [07-工程约定](docs/07-工程约定.md)。
- 文档是设计事实来源；改了语义就同步更新文档。
