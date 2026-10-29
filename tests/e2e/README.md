# 节点画布浏览器回归

当前用例以 `docs/节点功能逻辑重构.md` 为基准。运行真实后端和生产构建，不 mock API。此前 UI 方案的列表、分组序列、分页与“手填/接线”断言已替换为显式图行为。

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
| `canvas-logic.spec.ts` | 五种标量、唯一开始、点阵、真实拖动吸附/远离/提交、间距、右侧关系、内部吸附、转换、跨图拖动取消 |
| `canvas-interaction.spec.ts` | 新增与编辑、撤销、自由移动、空白框选、无重叠落位 |
| `canvas-ui-reconstruction.spec.ts` | 新规则下的包络端口、循环附着/解除和跨包络引用（保留文件名，旧 UI 规则已移除） |
| `closed-loop.spec.ts` | 全局定义 → 派生 payload → 循环内公开方法 → 真实判题 → 刷新恢复 |
| `frontend-details.spec.ts` | 类型错误阻止执行并定位、损坏存档保留、键盘与视图标签 |
| `desktop-smoke.spec.ts` | 六种窗口尺寸的布局可达性、键盘微调及刷新恢复 |

窗口覆盖：1280×720、1440×900、1920×1080、2560×1080、900×1200、768×1024。外壳采用上下布局；真实指针测试先将画布滚入视口，不能直接向视口外的节点坐标发送鼠标操作。

公开方法仍只生成 block 动作。闭环用例验证真实提交与服务端的“没有达成目标”结论；题目判胜完整性另外由全部参考解法回放验证，不将手工调试步骤冒充画布生成的 payload。

## 本轮验证

2026-10-30（Asia/Shanghai），Windows / Chromium / 真实 Fastify 后端。

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test`：140 个测试文件通过，2495 项通过，保留原有 5 项 TODO。
- `PWN2BLOCK_E2E=1 pnpm e2e`：24 项全部通过，覆盖上述六种窗口尺寸。
- 使用 `.env.example` 执行出题 CLI `check --all` 与 `solve --all`：7 个题目包校验与 7 个参考解法均通过。
- 审查回归另覆盖嵌套循环及次数依赖、16 层共享派生依赖与更新、转换入口一致性、解除包络保留引用、动态选项同步、导入竞态和统一附着校验。

详细行为与语义边界见 [实现与验收](../../docs/节点功能逻辑重构-实现与验收.md)。
