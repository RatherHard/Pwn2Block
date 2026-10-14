# Pwn2Block

内存可视化的 Pwn 概念实验室：学习者用积木拼装 payload，交给**后端权威 VM** 执行，再观察栈、寄存器和指令的变化。面向 CTF 新生赛教学。

一个会话两个实例：**调试实例**是草稿纸，边试边看反馈，满足成功条件也只回"已满足"，不发 flag；**判题实例**在提交时重置到初始状态回放 payload，判胜才下发 flag。见 [docs/04](docs/04-会话与API.md) §1。

需求文档在 `docs/`，从 [docs/README.md](docs/README.md) 进入。**文档是设计的事实来源**，动手前先读相关章节；改了语义就同步改文档。

## 不可妥协的四条

来自 [docs/01](docs/01-产品与范围.md) §6。任何改动都不许破坏它们：

1. **后端权威**：完整 VM 状态、私有题目包和 flag 只存在于后端。浏览器只发送受限动作，只接收公开投影。
2. **隐藏即不下发**：隐藏 VMA 和虚拟文件的**内容**不以任何形式出现在响应里，包括字段、错误文案和副作用差异，只能经由程序执行获取。布局（地址、大小、权限）公开：**固定的东西都是已知的**，只藏运行时未知量。
3. **客户端不可信**：服务端不接受客户端提交的状态、快照或成功标志。是否通过只由服务端判定。
4. **出题 DSL 是数据，不是脚本**：题目包里没有回调和 eval，只能组合封闭的内置原语。

前端混淆、禁用右键、检测 DevTools 都不算安全措施，不要写。

## 技术栈与结构

全栈 TypeScript，Fastify 单进程同时承担引擎、API 和静态托管。完整决策表见 [docs/07](docs/07-工程约定.md) §1。

```
packages/shared/     类型与 Schema，单一事实来源
packages/engine/     VM 引擎，纯函数 + COW 内存，不依赖 HTTP
packages/server/     Fastify：会话、题目加载、REST、静态托管
packages/web/        Vite + Lit + Blockly 单页应用
packages/authoring/  出题 CLI：asm、check、solve、new
challenges/          题目包
presets/             默认编码表
```

依赖方向只能向左。**`engine` 不许 import `server`**，否则引擎没法单独测。

## Git 仓库管理规范

### 分支

- `main` 是唯一长期分支，始终保持可运行。
- **当前仓库还没有 remote**，只有 `main`。在推上远端、协作者进场之前，骨架阶段直接提交到 `main` 可以接受。下面的分支与 PR 规范从**配置 remote 那一刻**开始生效。
- 之后不再直接提交到 `main`，而是从 `main` 切分支：
  - `feat/<简述>`、`fix/<简述>`、`docs/<简述>`、`refactor/<简述>`
  - 出题分支用 `challenge/<题目id>`
- 一个分支一件事。出题分支只碰 `challenges/<id>/`。
- 推送新分支带 `-u`：`git push -u origin <branch>`。

### 提交信息

```
<type>: <description>

<body，可选，说明为什么而不是做了什么>
```

- type 取 `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`。
- 描述用中文，一行说清改了什么。
- 正文解释动机和取舍，不复述 diff。
- 不加 AI 署名（全局已关闭）。

### 提交粒度

- 一个提交一件可独立回滚的事。
- **及时提交**：一件事做完、检查通过就提交，不必等人催，也不要把多件事攒成一个大提交。文档改动同样适用。
- **类型是契约，不留半截状态**：改 `packages/shared` 的类型时，同一个提交里把 `server` 和 `web` 一起改完。
- 改引擎语义或 API 形状时，同步更新 `docs/02` / `03` / `04`。
- 暂存具体文件，不用 `git add .`，避免捎带无关改动。

### PR

- 创建前跑完 CI 要求的检查，解决冲突，与 `main` 同步。
- 标题 70 字以内，细节写在描述里。
- 描述包含：改了什么、为什么、怎么验证的、已知未做的部分。
- 出题 PR 额外写明考点和预期解法。
- 用 `gh pr create` 创建。

### 绝对不能进 git

- **flag 真值**。题目包的 `flag` 字段写 `"env:FLAG_<ID>大写"`，真值在部署时由环境变量注入，服务端启动时缺失就拒绝加载该题。详见 [docs/06](docs/06-出题指南.md) §6。
- `.env` 及任何凭证、私钥。`.gitignore` 已排除 `.env` 与 `.env.*`，但保留 `.env.example`。
- 构建产物、`node_modules/`、覆盖率报告、本地缓存。

`challenges/<id>/private.json` **要**进 git：它是题目的一部分，不是密钥。隐藏内容和虚拟文件写在里面没问题，因为仓库的读者是出题人，不是正在做题的学习者。

### 危险操作

默认只用非破坏性命令。以下操作需要先征得同意：

- `git push --force`（及 `--force-with-lease`）
- `git reset --hard`
- `git clean -f`
- `git branch -D`
- `git rebase` 已推送的提交
- 改写已推送的提交信息

`git commit --amend` 只用于自己**尚未推送**的提交。不要用 `--no-verify` 跳过钩子；钩子失败就去修根因。

### 行尾

仓库里统一用 LF。Windows 上 `git add` 会提示 LF 将被替换为 CRLF，这是工作区的正常行为。建议加 `.gitattributes` 固定文本文件为 LF，避免不同机器之间产生整文件 diff。

## 开发

按 [docs/07](docs/07-工程约定.md) §3 的顺序推进：`shared` → `engine` → `authoring` → 第一道题 → `server` → `web` → 剩余题目。第 3 步做完出题协作者就能并行进场。

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 起本地全栈 |
| `pnpm test` | 单元 + 集成测试 |
| `pnpm typecheck` | 类型检查 |
| `pnpm challenge:check <id>` | 校验题目包 |
| `pnpm challenge:solve <id>` | 跑参考解法，断言判胜 |

### CI 必须通过

typecheck、lint、单元测试、集成测试，以及**全部题目的 `challenge:solve`**。改动已有题目后必须重跑：改一个字节就可能让参考解法失效。

### 测试要求

- `engine` 是安全边界，覆盖率 80%+ 不打折。
- 引擎确定、不读时间、不用随机数，所以要断言精确的内存与寄存器值，**不要写模糊断言**。
- [docs/07](docs/07-工程约定.md) §5 的安全测试清单每条都要有对应测试。

## 写代码时

- 中文界面，中文注释与文档。
- 小文件优先：200–400 行常见，800 行上限。函数 50 行以内。
- 不可变数据：返回新对象，不原地修改。
- 错误显式处理，不静默吞掉。
- 系统边界一律校验输入：题目包用 Schema，API 用 Schema，客户端提交的一切都不可信。
- 不留 `console.log` 和调试语句。
