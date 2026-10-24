# 浏览器回归与证据

节点画布已经是默认且唯一的 payload 编辑器；本目录只保留**新版画布**（`pwn2block-canvas-panel`）的 E2E。
旧画布（`pwn2block-graph-panel` / `pwn2block-graph-canvas` / 节点库 / Blockly 侧栏）及其交互用例已随
阶段三的清理一并删除，历史记录见 git 历史与 `docs/archive/`，不再作为当前验收依据。

## 用例

| 文件 | project | 覆盖 |
|---|---|---|
| `canvas-interaction.spec.ts` | `chromium-desktop` | 新版画布交互：工具箱七个分类十八种节点、点一项在空位加节点、点选节点后检查器显示 id、侧栏改名同步到画布行并撤销、双击「值」行就地编辑（Enter 提交 / Esc 取消）、拖动节点只改坐标并 Ctrl+Z 撤回、从输入端口拉线接到提供者节点、Delete 删节点可撤销、空白处框选 |
| `closed-loop.spec.ts` | `chromium-desktop` | 真实后端闭环：首屏只有开始节点、方法节点选 `gets(buf)` 后才长出参数端口、整数值接到 `bytes` 参数上编译失败并在输出区点「定位积木」高亮、装入合法 payload 后编译成功且动作数进状态栏、提交判题拿到服务端结论、刷新后从 `pwn2block.canvas.v2.*` 恢复并重新编译 |
| `frontend-details.spec.ts` | `chromium-desktop` | 方法节点未选方法时编译失败的定位；新档损坏时不回退旧档、原文与旧键原样保留、提示条提供导出；画布 Delete / Ctrl+Z / 方向键；视图标签键盘切换 |
| `desktop-smoke.spec.ts` | `chromium-desktop-1280x720`、`-1440x900`、`-1920x1080`、`-2560x1080`、`-900x1200`、`-768x1024` | 六种尺寸下上下布局（画布在视图之下）、无横向越界、页面可纵向滚动、工具箱/画布/检查器可见、加节点、方向键精确 +8px、刷新从 v2 存档恢复；每档保存一张 viewport 截图 |

所有用例都要求 `PWN2BLOCK_E2E=1`，否则显式跳过。没有自动重试，也没有用跳过冒充通过。

选择器约定集中在 `helpers.ts`：面板是 `pwn2block-canvas-panel`，工具箱与检查器用
`getByRole('complementary', { name: '工具箱' | '检查器' })`，工具箱条目是 `.tool[data-kind]`
（本题方法是 `.tool-block[data-block]`，搜索框 `.library-query`，分类页 `.library-tab`；分页或搜索
筛掉的条目只是带 `hidden`，仍在 DOM 里），画布是 `.stage`；节点用
`.node-box[data-node="<id>"]`（关系方框是 `.relation-box`；`selectNode` 点的是 `.title`，因为已选中
节点上单击可编辑行会直接开编辑框），端口用 `.port[data-node][data-port]`，
行用 `.row[data-node][data-row]`，就地编辑的输入框用 `.row-input`，顶栏计数用
`.status-error` / `.status-warn` / `.status-unconnected` / `.status-revision`。
文档断言优先读面板公开属性 `document`（`helpers.readDocument()` 会在 Node 侧按形状复核一遍），
只有「看起来怎样」才查 DOM。

## 运行

先构建并启动真实后端（测试 flag 是公开哨兵值，不是真 flag）：

```powershell
pnpm build
$env:FLAG_RET2WIN='flag{e2e-graph}'
$env:PORT='8787'
pnpm start
```

另开一个终端：

```powershell
$env:PWN2BLOCK_E2E='1'
$env:PWN2BLOCK_BASE_URL='http://127.0.0.1:8787'
$env:PWN2BLOCK_E2E_OUTPUT_DIR='.tmp/e2e'
pnpm e2e
```

只跑某个 spec 或某个尺寸时加 `--project=...` 与文件路径；输出目录每轮换一个，避免 Playwright 清理上一轮现场。

**同一个后端进程跑多轮会撞上会话上限。** 每个用例都会新建调试/判题会话，服务端默认同一来源最多 32 个存活会话（`packages/server/src/limits.ts`）。一个用例在不同题目/刷新之间还会再建会话，所以**一轮从干净后端开始也只能跑到大半套**：撞上后前端显示「同一来源的会话数已达上限」，此时失败与画布无关。推荐分两批跑，批间重启后端：

```
# 批一：画布交互、闭环、细节（11 例）
pnpm exec playwright test --config tests/e2e/playwright.config.ts \
  tests/e2e/canvas-interaction.spec.ts tests/e2e/closed-loop.spec.ts tests/e2e/frontend-details.spec.ts \
  --project=chromium-desktop

# 重启后端后，批二：六个视口的桌面冒烟（6 例）
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/desktop-smoke.spec.ts
```

两批合计 17 例，就是 `pnpm e2e` 的全集；CI 用干净后端一次跑，若撞上限就先重启再跑剩余项目。

## CI

`.github/workflows/ci.yml` 在构建后启动真实后端并跑完整 `pnpm e2e`，失败时上传 `.tmp/ci-e2e` 与服务端日志。

## 已知缺口

- 画布只产出 `{ type: 'block' }`，不产出 `step` / `run`，所以 `ret2win` 这类「写内存再单步执行到 `ret`」
  的题**暂时无法从界面拿到判胜与 flag**；`closed-loop` 因此断言服务端给出的
  「payload 跑完了，但没有达成目标」，判胜分支等缺口补上后放回。
- 尚未覆盖的多选拖动、人工视觉、真实读屏和其他浏览器验收见 [05-未完成工作](../../docs/05-未完成工作.md)。

当前套件配置共 17 个用例（`canvas-interaction` 6、`closed-loop` 1、`frontend-details` 4、`desktop-smoke` 1×6 个尺寸）。

每次运行应保存独立报告与截图，并注明环境、执行数、跳过项和失败原因。

过去各轮结果与本地证据路径见 [浏览器回归记录](../../docs/archive/graph-interaction-2026-10-19/浏览器回归记录.md)，更早阶段见 [基础画布验收记录](../../docs/archive/graph-2026-10-19/浏览器验收记录.md)。历史报告不能替代当前运行；`.tmp` 中的文件不随仓库交付。
