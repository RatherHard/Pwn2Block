# 浏览器回归与证据

节点画布已经是默认且唯一的 payload 编辑器；本目录只保留画布时代的 E2E。历史 Blockly 记录见 git 历史与 `docs/archive/`，不再作为当前验收依据。

## 用例

| 文件 | project | 覆盖 |
|---|---|---|
| `canvas-interaction.spec.ts` | `chromium-desktop` | 节点画布交互回归（10 §2–§6）：侧栏属性编辑、画布只读值同步与撤销、节点库两级目录、顶部等宽返回按钮、高亮文字对比度、题目动作权限过滤、搜索恢复、常驻预览与拖入落点、节点拖动不跳变且不选中文字、点击—点击与拖拽两种接线、正交折线与箭头、输入端口替换与撤销、拖动端点改接、连线删除与撤销、空存档刷新仍为空且缺「开始」只提示 |
| `closed-loop.spec.ts` | `chromium-desktop` | 真实后端闭环：从空画布加节点、属性面板填字节、加 `step 3`、编译；先提交错误 payload 得到失败录像；改对后判胜并拿到 flag；刷新后从新存档恢复图并重新编译 |
| `frontend-details.spec.ts` | `chromium-desktop` | 编译错误「定位」选中节点；坏新存档不回退旧键、保留原文并可导出；画布 Delete / Ctrl+Z / 方向键；视图标签键盘切换 |
| `desktop-smoke.spec.ts` | `chromium-desktop-1280x720`、`-1440x900`、`-1920x1080`、`-2560x1080`、`-900x1200`、`-768x1024` | 六种尺寸下上下布局（画布在视图之下）、无横向越界、页面可纵向滚动、视图与画布最低高度、节点库/画布/属性面板可见、常驻预览与去括号、加节点、方向键移动、`f` 适应、刷新恢复；每档保存一张 viewport 截图 |

所有用例都要求 `PWN2BLOCK_E2E=1`，否则显式跳过。没有自动重试，也没有用跳过冒充通过。

选择器约定：面板区域用 role——`getByRole('complementary', { name: '节点库' })`、`getByRole('application', { name: '节点画布' })`、`aside.inspector`（属性）；节点用 `.node[data-node="<id>"]`，端口用 `.port-hit.in|.out[data-node][data-port]`，空画布提示用 `.empty-hint`。文档断言优先读面板的 `currentDocument()`，只有「看起来怎样」才查 DOM/SVG。

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

**同一个后端进程跑多轮会撞上会话上限。** 每个用例都会新建调试/判题会话，服务端默认同一来源最多 32 个存活会话（`packages/server/src/limits.ts`）。连跑几轮后前端会显示「同一来源的会话数已达上限」，此时用例失败与画布无关：重启后端再跑。完整套件应从干净后端开始运行。

## CI

`.github/workflows/ci.yml` 在构建后启动真实后端并跑完整 `pnpm e2e`，失败时上传 `.tmp/ci-e2e` 与服务端日志。

## 证据与历史记录

当前套件配置共 21 个用例，布局回归覆盖上表六种窗口尺寸。节点拖动用例在 65%、100%、150% 缩放下连续拖动，检查拖动过程中的真实 DOM 位移与松手前后位置连续性；不能仅凭最终文档坐标判断是否跳变。

每次运行应保存独立报告与截图，并注明环境、执行数、跳过项和失败原因。尚未覆盖的多选拖动、人工视觉、真实读屏和其他浏览器验收见 [05-未完成工作](../../docs/05-未完成工作.md)。

过去各轮结果与本地证据路径见 [浏览器回归记录](../../docs/archive/graph-interaction-2026-10-19/浏览器回归记录.md)，更早阶段见 [基础画布验收记录](../../docs/archive/graph-2026-10-19/浏览器验收记录.md)。历史报告不能替代当前运行；`.tmp` 中的文件不随仓库交付。
