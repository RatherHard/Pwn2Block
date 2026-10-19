# Pwn2Block

面向 CTF 新生赛的内存可视化 Pwn 实验室。学习者用节点画布拼装 payload，交给后端权威 VM 执行，观察栈、寄存器、指令和 I/O 的变化，在过程中理解栈帧、缓冲区溢出和返回地址劫持。

它不是浏览器里的 Linux 或 x86 模拟器，只实现教学所需的受控指令、内存区域（VMA）、syscall 和判题能力。

## 怎么玩

1. 选一道题，阅读题面和公开内存布局。
2. 在调试实例里单步、运行、后退、撤销，观察状态变化。
3. 在节点画布上用字节、地址、运算、分支/循环和题目动作拼装 payload，改动后在浏览器内自动编译。
4. 提交判题：服务端从初始状态回放 payload，判胜后下发 flag。

调试实例里的「已满足」只表示当前试验状态满足条件，不发 flag；只有判题实例的回放结果算数。

## 题目

| 顺序 | id | 标题 |
|---|---|---|
| 1 | `endian` | 认识内存与小端序 |
| 2 | `pushpop` | 栈顶两个字 |
| 3 | `callret` | call 与 ret 的栈 |
| 4 | `stackframe` | 栈帧 |
| 5 | `localvar` | 局部变量覆盖 |
| 6 | `ret2win` | 回到胜利 |
| 7 | `ret2rop` | 把 gadget 串成链 |

## 快速开始

需要 Node >= 22 和 pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm build
node --env-file=.env.example --import tsx packages/server/src/index.ts
```

浏览器打开 `http://127.0.0.1:8787`。`.env.example` 只含公开的测试 flag，可以直接用来本地体验。

几点说明：

- `pnpm start` 不会读取 `.env` 或 `.env.example`，flag 需要通过进程环境或 `--env-file` 注入。
- 每道题的 flag 变量名是 `FLAG_<ID大写>`，例如 `FLAG_RET2WIN`。缺失或为空时该题拒绝加载。
- 端口用 `PORT` 覆盖，默认 8787；监听地址固定为 `127.0.0.1`。
- 会话只存在服务端内存里，重启后丢失。
- Python 节点默认不可用；要在部署环境启用隔离求值，按 [09-Python 求值部署与诊断](docs/09-Python求值部署与诊断.md) 配置 `PWN2BLOCK_PYTHON_BACKEND=docker` 并准备镜像。普通 `process` 后端只用于开发，不算隔离。

开发时用 `pnpm dev` 同时起 server 和 Vite（5173 端口，`/api` 代理到后端），同样需要先在环境中设置 `FLAG_*`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 起本地全栈（热更新） |
| `pnpm build` | 构建前端到 `packages/web/dist` |
| `pnpm start` | 单进程启动服务，同时托管 API 和前端 |
| `pnpm test` | 单元 + 集成测试 |
| `pnpm test:coverage` | 带覆盖率的测试 |
| `pnpm typecheck` | 类型检查 |
| `pnpm lint` | ESLint，零警告 |
| `pnpm e2e` | Playwright 端到端测试，见 [tests/e2e](tests/e2e/README.md) |
| `pnpm challenge:new <id>` | 从模板生成题目包 |
| `pnpm challenge:asm <id>` | 编译 `program.asm`，把字节写回 `private.json` |
| `pnpm challenge:check <id>\|--all` | 校验题目包 |
| `pnpm challenge:solve <id>\|--all` | 跑参考解法，断言判胜 |

`asm`、`check`、`solve` 都要求先在环境中设置对应的 `FLAG_*`。

## 安全边界

1. **后端权威**：完整 VM 状态、私有题目包和 flag 只在后端，浏览器只发送受限动作、只接收公开投影。
2. **隐藏即不下发**：隐藏内存和虚拟文件的内容不出现在响应、错误文案或副作用里，只能经程序执行获取。
3. **客户端不可信**：服务端不接受客户端提交的状态、快照或成功标志。
4. **出题 DSL 是数据**：题目包里没有回调和 eval，只能组合内置原语。

前端混淆、禁用右键这类手段不算安全措施。

## 项目结构

```text
packages/shared/     前后端共享的类型与 Schema
packages/engine/     VM 引擎：纯函数 + COW 内存，不依赖 HTTP
packages/server/     Fastify：题目加载、会话、REST、静态托管
packages/web/        Vite + Lit 单页应用：节点画布、状态视图与回放
packages/authoring/  出题 CLI：new、asm、check、solve
challenges/          题目包（public.json 对外，private.json 只在服务端）
presets/             默认编码表
```

依赖只能从下往上：`shared` ← `engine` ← `server`，`engine` 不得 import `server`。

## 文档

从 [文档目录](docs/README.md) 或 [00-开发入口](docs/00-开发入口.md) 进入：01、02 说明当前架构与能力，05 维护工程待办，已完成的计划和验收记录统一归档。

- [基本架构](docs/01-基本架构.md) / [当前已实现能力](docs/02-已实现需求.md)
- [未实现需求](docs/03-未实现需求.md) / [待办与验收债务](docs/05-未完成工作.md)
- [Python 求值部署与诊断](docs/09-Python求值部署与诊断.md)
- [历史归档](docs/archive/README.md)：MVP、旧前端设计、节点画布基础与交互布局阶段的需求、计划和验收记录

贡献约定（分支、提交、测试要求）见 [CLAUDE.md](CLAUDE.md)。flag 真值、`.env` 和凭证不得进 git。

## 许可证

[GPL-3.0](LICENSE)
