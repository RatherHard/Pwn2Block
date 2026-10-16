# Pwn2Block

Pwn2Block 是面向 CTF 新生赛的内存可视化实验室：学习者用积木拼装 payload，交给**后端权威 VM**执行，观察栈、寄存器和指令变化。

一个会话包含两个实例：**调试实例**用于试验，只回“已满足”不发 flag；提交时由**判题实例**从初态回放 payload，判胜后才下发 flag。见 [docs/01-基本架构](docs/01-基本架构.md) §3–4。

设计事实来源是 `docs/`，从 [docs/README.md](docs/README.md) 进入。动手前先读相关章节，改动语义时同步更新文档。

## 不可妥协的四条

来自 [docs/01-基本架构](docs/01-基本架构.md) §4。任何改动都必须遵守：

1. **后端权威**：完整 VM 状态、私有题目包和 flag 只存在于后端。浏览器只发送受限动作，只接收公开投影。
2. **隐藏即不下发**：隐藏 VMA 和虚拟文件的**内容**不得出现在响应、错误文案或副作用差异中，只能经程序执行获取；地址、大小、权限等固定布局可以公开。
3. **客户端不可信**：服务端不接受客户端提交的状态、快照或成功标志。是否通过只由服务端判定。
4. **出题 DSL 是数据，不是脚本**：题目包里没有回调和 eval，只能组合封闭的内置原语。

前端混淆、禁用右键和 DevTools 检测不属于安全措施。

## 技术栈与结构

全栈 TypeScript；Fastify 单进程承担引擎、API 和静态托管。架构摘要见 [docs/01-基本架构](docs/01-基本架构.md)；历史工程决策见 [MVP 归档](docs/archive/mvp-2026-10-16/07-工程约定.md)。

```
packages/shared/     类型与 Schema，单一事实来源
packages/engine/     VM 引擎，纯函数 + COW 内存，不依赖 HTTP
packages/server/     Fastify：会话、题目加载、REST、静态托管
packages/web/        Vite + Lit + Blockly 单页应用
packages/authoring/  出题 CLI：asm、check、solve、new
challenges/          题目包
presets/             默认编码表
```

依赖方向只能向左；**`engine` 不得 import `server`**，以便独立测试。

## Git 仓库管理规范

### 分支

- `main` 是唯一长期分支，始终保持可运行。
- 当前没有 remote，只有 `main`；配置 remote 前，骨架阶段可直接提交 `main`。配置 remote 后，以下分支与 PR 规范生效。
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
- **及时提交是任务完成的一部分**：独立交付物通过检查后立即创建本地提交，再汇报完成；代码、文档、原型、截图和并行安排都适用。用户要求暂不提交时遵从该要求。
- **类型是契约**：改 `packages/shared` 的类型时，同一提交内完成 `server` 和 `web` 的适配。
- 改引擎语义或 API 形状时，同步更新 `docs/01-基本架构.md`、`docs/02-已实现需求.md` 和相关测试；历史契约细节见 `docs/archive/mvp-2026-10-16/`。
- 暂存具体文件，不用 `git add .`，避免捎带无关改动。

### 提交前后检查

- 提交前检查 `git status --short` 和 diff，只暂存本任务的文件或改动块。
- 运行与改动匹配的验证，并执行 `git diff --cached --check`；失败时先修复，不能跳过。
- 长任务按可独立验证、可回滚的阶段及时提交。
- 提交后核对记录和 `git status --short`，汇报提交号、验证结果与剩余未提交内容；有阻塞要说明原因。
- 本地提交与推送远端分别处理；及时提交的要求不代表自动获得推送、合并或发布的授权。

### PR

- 创建前跑完 CI 要求的检查，解决冲突，与 `main` 同步。
- 标题 70 字以内，细节写在描述里。
- 描述包含：改了什么、为什么、怎么验证的、已知未做的部分。
- 出题 PR 额外写明考点和预期解法。
- 用 `gh pr create` 创建。

### 绝对不能进 git

- **flag 真值**。题目包只写 `"env:FLAG_<ID大写>"`，真值由部署环境注入；缺失时服务端拒绝加载题目。详见 [MVP 归档中的出题指南](docs/archive/mvp-2026-10-16/06-出题指南.md) §6。
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

按 [MVP 归档中的工程约定](docs/archive/mvp-2026-10-16/07-工程约定.md) §3 的顺序推进：`shared` → `engine` → `authoring` → 第一道题 → `server` → `web` → 剩余题目。第 3 步做完出题协作者就能并行进场。

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

MVP 已于 2026-10-16 按项目决策完成。历史 D7 记录中的 T01–T06 专项黑盒测试、CI 门禁和扩展组合属于后续收尾工作，当前状态与清单见 [docs/05-未完成工作](docs/05-未完成工作.md)；正式比赛或非隔离使用前仍应补齐这些验证。

- `engine` 是安全边界，覆盖率 80%+ 不打折。
- 引擎确定、不读时间、不用随机数，所以要断言精确的内存与寄存器值，**不要写模糊断言**。
- 安全测试清单和历史证据见 `docs/archive/mvp-2026-10-16/07-工程约定.md`、`08-Agent并行开发日程.md`；新增安全边界必须同时增加对应测试。

## 写代码时

- 中文界面，中文注释与文档。
- 小文件优先：200–400 行常见，800 行上限。函数 50 行以内。
- 不可变数据：返回新对象，不原地修改。
- 错误显式处理，不静默吞掉。
- 系统边界一律校验输入：题目包用 Schema，API 用 Schema，客户端提交的一切都不可信。
- 不留 `console.log` 和调试语句。
