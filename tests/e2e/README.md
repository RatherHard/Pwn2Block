# 节点画布浏览器回归

当前用例以显式连接图及 [数据连接结构交互方案](../../docs/07-数据连接结构交互方案.md) 为基准。运行真实后端和生产构建，不 mock API。此前 UI 方案的列表、分组序列与“手填/接线”断言已替换为显式图行为。

## 运行

在一个终端构建并启动后端，使用仓库公开的假 flag：

```powershell
pnpm build
node --env-file=.env.example --import tsx packages/server/src/index.ts
```

另一个终端运行：

```powershell
$env:PWN2BLOCK_E2E='1'
pnpm e2e
```

`PWN2BLOCK_BASE_URL` 可覆盖地址；`PWN2BLOCK_E2E_OUTPUT_DIR` 可指定截图、失败 trace 和 JSON 报告目录。默认产物保存在 `.tmp/playwright` 与 `.tmp/playwright.json`，不提交 Git。每个用例释放自己创建的会话；应使用独立测试服务，勿与真实学习会话共用。

## 覆盖

| 文件 | 内容 |
|---|---|
| `canvas-library-menu.spec.ts` | 分级返回、每项常驻预览、方法分页、侧栏宽度、无方括号、右键撤销/重做、键盘与边缘定位 |
| `canvas-logic.spec.ts` | 五种标量、唯一开始、点阵、真实拖动吸附/远离/提交、间距、右侧关系、内部吸附、转换、跨图拖动取消 |
| `canvas-data-insertion.spec.ts` | 尾段拔出、整段插入及让位预览、关系框不可拖、嵌套断连退出、25%/100%/300% 吸附阈值、Alt 单取、撤销与保存重载 |
| `canvas-interaction.spec.ts` | 新增与编辑、撤销、自由移动、空白框选、无重叠落位 |
| `canvas-ui-reconstruction.spec.ts` | 新规则下的包络端口、循环附着/解除和跨包络引用（保留文件名，旧 UI 规则已移除） |
| `closed-loop.spec.ts` | 全局定义 → 派生 payload → 循环内公开方法 → 真实判题 → 刷新恢复 |
| `frontend-details.spec.ts` | 类型错误阻止执行并定位、损坏存档保留、键盘与视图标签 |
| `desktop-smoke.spec.ts` | 六种窗口尺寸的布局可达性、键盘微调及刷新恢复 |

窗口覆盖：1280×720、1440×900、1920×1080、2560×1080、900×1200、768×1024。外壳采用上下布局；真实指针测试先将画布滚入视口，不能直接向视口外的节点坐标发送鼠标操作。

公开方法仍只生成 block 动作。闭环用例验证真实提交与服务端的“没有达成目标”结论；题目判胜完整性另外由全部参考解法回放验证，不将手工调试步骤冒充画布生成的 payload。

## 数据连接交互实现验收

2026-10-31（Asia/Shanghai），Windows / Chromium / 生产构建与独立 Fastify 服务（8799 端口），使用 `.env.example` 假 flag。

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test`：148 个文件通过，2573 项通过，原有 5 项 TODO 保留。
- `PWN2BLOCK_E2E=1 pnpm e2e`：54 项全部通过，包括六种窗口尺寸。
- 出题 CLI `check --all` 与 `solve --all`：7 个题目包和 7 个参考解法全部通过。
- 证据：`.tmp/data-interaction-verified.json`；截图位于 `.tmp/data-interaction-verified/` 对应用例目录内的 `insertion-preview.png` 和 `envelope-tail-outside.png`。截图与构建产物不提交。

旧手势测试已同步 Space 平移、现有结果摘要位置和流程线图层；固定坐标夹具通过真实平移统一到世界原点，不修改应用初始居中行为。断开成员的旧测试夹具改为连通结构，另有独立纯逻辑测试验证拒绝多结构包络和显式整理。

### Standards

审查基准为实现前提交 `82f962e`。发现两项：无差别吞异常、语义文档未同步；另发现一处旧操作提示。现已仅捕获明确的布局错误、继续抛出未知异常，并更新文档及提示。复核未解决项：0。

### Spec

发现两项：流程包络内拖动误用数据拔出规则、邻近插入候选抢占准确端点。现已保留流程拖动范围，并限定直接命中关系框才优先插入；两项均增加回归测试。复核未解决项：0。

审查合计：Standards 2 项、Spec 2 项，均已修复；两个方向均无剩余阻断项。当前含结构错误的图不提供数据吸附候选，旧多结构包络需要显式整理；尚未覆盖非 Chromium 浏览器。

## 逻辑重构阶段验证（历史）

2026-10-30（Asia/Shanghai），Windows / Chromium / 真实 Fastify 后端。

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test`：140 个测试文件通过，2495 项通过，保留原有 5 项 TODO。
- `PWN2BLOCK_E2E=1 pnpm e2e`：24 项全部通过，覆盖上述六种窗口尺寸。
- 使用 `.env.example` 执行出题 CLI `check --all` 与 `solve --all`：7 个题目包校验与 7 个参考解法均通过。
- 审查回归另覆盖嵌套循环及次数依赖、16 层共享派生依赖与更新、转换入口一致性、解除包络保留引用、动态选项同步、导入竞态和统一附着校验。

详细行为与语义边界见 [实现与验收](../../docs/archive/canvas-logic-2026-10-30/节点功能逻辑重构-实现与验收.md)。

## 节点库与右键菜单验证

2026-10-30（Asia/Shanghai），Windows / Chromium，使用独立 8799 端口的真实后端与生产构建。

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test`：140 个测试文件，2495 项通过，原有 5 项 TODO 保留。
- `PWN2BLOCK_E2E=1 PWN2BLOCK_BASE_URL=http://127.0.0.1:8799 pnpm e2e`：27 项通过，包括六种窗口尺寸。
- 新增 3 项浏览器回归覆盖分类、分页、预览和菜单；截图与报告保存在 `.tmp/playwright/` 和 `.tmp/playwright.json`，不提交 Git。
- 题目包与求解器未改动，本轮未重跑 `challenge:check` / `challenge:solve`；上方结果属于之前阶段。
