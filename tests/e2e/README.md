# D7 浏览器回归与证据

本目录验收只交付回归。2026-10-16 在 `F:/Pwn2Block-wt/d7-browser`、分支 `test/d7-browser`、基线 `8a40600491281454f132d92d96c87e3caca9f233` 上执行。未修改产品包、依赖、锁文件或 `docs/08`。

## 环境与覆盖范围

- Windows / PowerShell，Node `v24.20.0`，pnpm `11.25.0`，Playwright `1.64.0`。
- 浏览器通道：**Playwright bundled Chromium headless shell**，版本 `156.0.8078.4`；未设置系统 Chrome / Edge channel。
- 真实 Fastify 后端、真实题包、`pnpm build` 的生产静态文件，同源地址 `http://127.0.0.1:8797`。六个 flag 环境变量均为明确的假测试值。
- 原 `closed-loop.spec.ts` 10 项保持原样，在 `chromium-desktop` 的 1600×1000 自建 context 执行。
- 新 `desktop-smoke.spec.ts` 分别在 1280×720、1440×900、1920×1080 执行，使用 Playwright page fixture，避免自建 context 覆盖 project 尺寸。
- 每个尺寸检查生产入口 / 六题列表、真实会话、题面键盘折叠、等宽双栏与横向溢出、八个工具栏按钮可达、视图菜单键盘开关、真实鼠标连接开始和普通单步积木、编译、单步与回退、incomplete 判题、键盘时间线、回到调试的状态隔离、刷新接回旧会话和画布。
- 检查页面异常与 console.error；测试结束删除会话并检查返回值。仅对画布边框允许 1 CSS px 舍入容差，按钮仍要求完整进入可视区域。
- 每个尺寸保存 7 张原 viewport 截图；浏览器版本、viewport、CDP 进程 PID 写入 JSON 报告的 `browser-environment` attachment。

## 可重复运行

以下均从 worktree 根执行。服务和测试各用一个 PowerShell 终端。每轮更换证据目录，避免 Playwright 清理前轮输出。

安装、构建（本轮确实执行）：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
```

服务终端（本轮使用的环境和命令）：

```powershell
$env:PORT='8797'
$env:FLAG_RET2WIN='flag{d7-browser-test-only}'
$env:FLAG_ENDIAN='flag{d7-browser-test-only}'
$env:FLAG_PUSHPOP='flag{d7-browser-test-only}'
$env:FLAG_CALLRET='flag{d7-browser-test-only}'
$env:FLAG_STACKFRAME='flag{d7-browser-test-only}'
$env:FLAG_LOCALVAR='flag{d7-browser-test-only}'
pnpm start
```

测试终端（必须与服务使用相同假测试 flag）：

```powershell
$env:PWN2BLOCK_E2E='1'
$env:PWN2BLOCK_BASE_URL='http://127.0.0.1:8797'
$env:FLAG_RET2WIN='flag{d7-browser-test-only}'
$env:PWN2BLOCK_E2E_OUTPUT_DIR='.tmp/d7-full'
pnpm e2e
```

稳定性复跑的真实命令（每尺寸 2 次，无重试）：

```powershell
$env:PWN2BLOCK_E2E_OUTPUT_DIR='.tmp/d7-repeat'
pnpm.cmd e2e --project=chromium-desktop-1280x720 --project=chromium-desktop-1440x900 --project=chromium-desktop-1920x1080 --repeat-each=2
```

本轮全量与稳定性命令的输出另通过 `2>&1 | Tee-Object -FilePath .tmp/d7-full.log` / `.tmp/d7-repeat.log` 保存，再以 `exit $LASTEXITCODE` 返回真实退出码。Windows PowerShell 将原生命令 stderr 包装为 `NativeCommandError` 的日志头，不代表测试退出失败；以退出码和 JSON 的 stats 为准。

质量检查的真实命令：

```powershell
pnpm typecheck
pnpm lint
```

## 实测结果与失败历史

| 执行 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 成功，锁文件无需变更，272 包复用缓存 | 0 | 本次终端记录 |
| `pnpm build` | 成功；存在既有 bundle 大于 500 kB 提醒 | 0 | `packages/web/dist` 为忽略的构建产物 |
| `pnpm exec playwright install chromium` | 成功，所需浏览器可用 | 0 | 版本见 browser-environment |
| 修改前原 `pnpm e2e` | 10 passed，27.2s，0 skipped | 0 | 本次终端记录；原配置只有 list reporter |
| 首轮 `pnpm typecheck` | 新测试误用 `regs`，应为 `registers`；已修正 | 1 | 本次终端记录 |
| 首轮三 project 冒烟 | 3 failed，0 skipped；原因及修正见下文 | 1 | `.tmp/d7-first-smoke.json`、`.tmp/d7-first-smoke/` |
| 修正后同一三 project 命令 | 3 passed，19.5s，0 skipped | 0 | `.tmp/d7-smoke-r2.json`、`.tmp/d7-smoke-r2/` |
| 最终全量 `pnpm e2e` | **13 passed，45.5s，0 skipped，0 flaky** | 0 | `.tmp/d7-full.json`、`.tmp/d7-full.log` |
| 三 project `--repeat-each=2` | **6 passed，39.4s，0 skipped，0 flaky** | 0 | `.tmp/d7-repeat.json`、`.tmp/d7-repeat.log` |
| 修正后 `pnpm typecheck` / `pnpm lint` | 均通过 | 0 / 0 | 本次终端记录 |

首轮三 project 命令与稳定性命令相同，但使用 `pnpm e2e`，不带 `--repeat-each=2`；第二轮使用输出目录 `.tmp/d7-smoke-r2`。所有实际浏览器验收运行均设置 `PWN2BLOCK_E2E=1`，没有通过删除、跳过失败测试或自动重试取得通过。

首轮失败是测试断言问题：

1. 会话 DELETE 实际契约返回 HTTP 200 / `{ ok: true }`，测试初稿误写成 204，导致三个尺寸都在清理阶段失败。已检查真实服务实现并修正；清理使用 soft assertion，仍使测试失败但不遮住主流程异常。
2. 1280×720 画布 `toBeInViewport({ ratio: 1 })` 实测交集比例 `0.9967041015625`，不足 1 CSS px 的边框裁切使初稿提前失败。改为只给画布 1 CSS px 容差；没有放宽按钮可达断言。
3. 原始失败截图、error-context、trace.zip 保留在 `.tmp/d7-first-smoke/`；第一轮原 JSON 从当时相对 config 目录生成的位置归档，后续配置改用绝对路径避免歧义。

## 截图与结构化证据

所有路径均相对于 `F:/Pwn2Block-wt/d7-browser`。截图、日志与 JSON 为忽略的运行产物，不提交 git。

最终全量截图目录模板：

```text
.tmp/d7-full/desktop-smoke-桌面冒烟：布局、键盘、积木、调试、回放与刷新-chromium-desktop-<尺寸>/
```

`<尺寸>` 分别为 `1280x720`、`1440x900`、`1920x1080`。每个目录有：

1. `01-challenge-list.png`
2. `02-briefing-expanded.png`
3. `03-desktop-layout.png`
4. `04-compiled-program.png`
5. `05-verdict-replay.png`
6. `06-debug-output.png`
7. `07-restored.png`

最终全量 **21 张**、额外稳定性复跑 **42 张**（不计 attachment 副本）。已读取 PNG 文件头核对每张宽高与 project 一致。`.tmp/d7-evidence-summary.json` 汇总各轮 stats、浏览器环境、PID、截图路径、实际宽高和 SHA-256；原 Playwright JSON 保留每个测试的结果与 attachment。

## 进程收尾与验收边界

- 本轮服务监听 PID **15364**，tsx 启动器 PID **19036**。结束时先核对 PID 15364 的命令行属于该 worktree，再执行 `Stop-Process -Id 15364`。启动器随服务退出，8797 已无监听。
- CDP 记录的 15 个浏览器主 PID、合计 60 个浏览器相关进程 PID 已全部退出，未按进程名批量终止。清理证据：`.tmp/d7-process-cleanup.json`（2026-10-16 18:22:51 +08:00）。未停止其他端口或工作区服务；检查时 8787 本身无监听。
- 本次范围内未发现阻塞浏览器冒烟的产品缺陷。
- 本轮实际执行项 **0 skipped**。未设置 `PWN2BLOCK_E2E=1` 时保留原有显式 opt-in 跳过约定；本轮未运行关闭开关的验收。
- 截图只作为运行留证；未完成人工视觉 / 像素对比、真实屏幕阅读器、Firefox、WebKit、系统 Edge / Chrome、触屏或移动设备验收。
- 三尺寸执行的是桌面冒烟；原八步完整闭环仍只在 1600×1000 执行，不宣称八步闭环在全部尺寸重跑。
- 没有执行题库独立最终 check/solve 子任务；主集成已报告该子任务遭自动安全审查拦截，**G4 缺口保留**。没有代跑 T01–T06，也不据浏览器结果宣告完整 MVP 或安全测试全部通过。
- 主集成的 112 文件、1617 passed + 5 todo、覆盖率等是主集成提供的独立结果，不计为本 worktree 的执行证据。`docs/08`、`docs/12`、`docs/13` 由主集成更新。

## Standards P2 审查收口（2026-10-16）

在 `d4b9729` 上仅修改 `desktop-smoke.spec.ts` 与本文件，补强两项断言：

- 刷新前记录 `canvasBlocks` 的 `id / cls / parentId / childClasses`，按 id 排序，排除 geometry；明确验证 `start → action_step → math_number` 三块连接及字段 `1`，刷新后完整比较同一份结构与字段。随后真实点击「编译」，核对程序区恰有一行、类型 `step`、参数文案 `执行 1 条指令`，对应 `{ type: 'step', count: 1 }`。不新增判题，不通过生产 API 注入画布。
- `reachable` 对启用按钮追加 `click({ trial: true })`，检查无遮挡、稳定并可接收点击；disabled 按钮仍检查可见性，不强行点击。画布原有 1 CSS px 边框容差保持。

本轮复用此前已安装依赖和同一基线的生产构建，服务仍用本文件记录的六个假 flag，执行 `$env:PORT='8797'; pnpm start`。仅运行三尺寸 smoke，未重跑原有完整闭环，未运行题目 CLI。

真实测试命令（测试终端）：

```powershell
$env:PWN2BLOCK_E2E='1'
$env:PWN2BLOCK_BASE_URL='http://127.0.0.1:8797'
$env:FLAG_RET2WIN='flag{d7-browser-test-only}'
$env:PWN2BLOCK_E2E_OUTPUT_DIR='.tmp/d7-review-smoke-r2'
pnpm e2e --project=chromium-desktop-1280x720 --project=chromium-desktop-1440x900 --project=chromium-desktop-1920x1080
pnpm typecheck
pnpm lint
```

| 本轮执行 | 真实结果 | 证据 |
| --- | --- | --- |
| 首轮三尺寸 smoke，输出 `.tmp/d7-review-smoke` | 3 failed / 20.6s，0 skipped，exit 1 | `.tmp/d7-review-smoke.json`、同名 `.log` 与目录内截图 / trace |
| 修正后三尺寸 smoke，输出 `.tmp/d7-review-smoke-r2` | **3 passed / 20.8s，0 skipped，0 flaky，exit 0** | `.tmp/d7-review-smoke-r2.json`、同名 `.log` |
| 首轮 `pnpm typecheck` | 新增 `Locator.evaluate` 少一个泛型参数，exit 2；已补齐类型参数 | `.tmp/d7-review-typecheck.log` |
| 修正后 `pnpm typecheck` | 通过，exit 0 | `.tmp/d7-review-typecheck-r2.log` |
| `pnpm lint` | 通过，exit 0 | `.tmp/d7-review-lint.log` |

首轮 smoke 失败原因是新增测试误把画布计为两块，漏算了 `math_number` 参数影子块；已在失败后及时报告，并修正为三块、增加参数块父子连接断言。没有删除或跳过失败测试，失败证据保留。随后 typecheck 的修正只补全泛型类型参数，不改变已通过 smoke 的运行行为。

浏览器仍为 Playwright bundled Chromium headless shell `156.0.8078.4`。成功截图 **21 张**，目录模板为 `.tmp/d7-review-smoke-r2/desktop-smoke-桌面冒烟：布局、键盘、积木、调试、回放与刷新-chromium-desktop-<尺寸>/`，文件名沿用上述七张截图；`07-restored.png` 现在包含刷新后重新编译的程序区。截图与 JSON / 日志均保留在本 worktree，不提交 git。

本轮监听 PID **12216**、启动器 PID **19376**。已核验服务命令行属于本 worktree 后按具体 PID 停止；8797 无监听，启动器及报告记录的浏览器进程均已退出。清理记录：`.tmp/d7-review-process-cleanup.json`，时间 2026-10-16 19:19:41 +08:00。未停止其他工作区服务。

主线另报告 `PWN2BLOCK_E2E=0`、输出 `.tmp/d7-opt-out` 的 `pnpm e2e` 为 **13 skipped / 0 executed**，只证明开关行为，不计为通过；该结果来自主线在 `c99124f` 后追加的验证，不是本 worktree 新执行。主线 `docs/08/12/13` 仍由集成方维护。
