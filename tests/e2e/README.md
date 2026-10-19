# 浏览器回归与证据

节点画布已经是默认且唯一的 payload 编辑器；本目录只保留画布时代的 E2E。历史 Blockly 记录见 git 历史与 `docs/archive/`，不再作为当前验收依据。

## 用例

| 文件 | project | 覆盖 |
|---|---|---|
| `closed-loop.spec.ts` | `chromium-desktop` | 真实后端闭环：工具箱加 `gets(buf)`、检查器填字节、加 `step 3`、编译；先提交错误 payload 得到失败录像；改对后判胜并拿到 flag；刷新后从新存档恢复图并重新编译 |
| `frontend-details.spec.ts` | `chromium-desktop` | 编译错误「定位」选中节点；坏新存档不回退旧键、保留原文并可导出；画布 Delete / Ctrl+Z / 方向键；视图标签键盘切换 |
| `desktop-smoke.spec.ts` | `chromium-desktop-1280x720`、`-1440x900`、`-1920x1080` | 三种尺寸下工具箱/画布/检查器可见、无横向越界、加节点、方向键移动、`f` 适应、刷新恢复；每档保存一张 viewport 截图 |

所有用例都要求 `PWN2BLOCK_E2E=1`，否则显式跳过。没有自动重试，也没有用跳过冒充通过。

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

## CI

`.github/workflows/ci.yml` 在构建后启动真实后端并跑完整 `pnpm e2e`，失败时上传 `.tmp/ci-e2e` 与服务端日志。Python 侧另用 `PWN2BLOCK_REQUIRE_PYTHON=1` 和预先拉取的 `python:3.12-alpine` 强制真实 Docker 隔离用例执行，缺镜像直接失败。

## 最近一次本地结果

2026-11-05，Windows + Playwright bundled Chromium + 生产构建 + 真实后端 `127.0.0.1:8787`：

- `pnpm e2e`：8/8 通过（closed-loop 1 + frontend-details 4 + 三尺寸 smoke 3），0 skipped，0 flaky。
- 截图复制为 `docs/evidence-graph-1280x720.png`、`docs/evidence-graph-1440x900.png`、`docs/evidence-graph-1920x1080.png`、`docs/evidence-graph-won.png`；其余运行产物在 `.tmp/`，已被 git 忽略。
- 人工视觉、真实读屏、Firefox/WebKit 与移动端仍不在自动验收范围内。
