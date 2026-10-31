# 节点画布浏览器回归

当前用例以显式连接图及 [已实现需求](../../docs/02-已实现需求.md) 为基准。运行真实后端和生产构建，不 mock API。此前 UI 方案的列表、分组序列与“手填/接线”断言已替换为显式图行为。

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
| `canvas-envelope-lifecycle.spec.ts` | 空包络保留与整段拖回、附件拖出解除和恢复、转换连接限制、嵌套预览间距、附着循环从双方属性栏或拖拽建立次数引用 |
| `canvas-interaction.spec.ts` | 新增与编辑、撤销、自由移动、空白框选、无重叠落位 |
| `canvas-ui-reconstruction.spec.ts` | 新规则下的包络端口、循环附着/解除和跨包络引用（保留文件名，旧 UI 规则已移除） |
| `closed-loop.spec.ts` | 全局定义 → 派生 payload → 循环内公开方法 → 真实判题 → 刷新恢复 |
| `frontend-details.spec.ts` | 类型错误阻止执行并定位、损坏存档保留、键盘与视图标签 |
| `desktop-smoke.spec.ts` | 六种窗口尺寸的布局可达性、键盘微调及刷新恢复 |

窗口覆盖：1280×720、1440×900、1920×1080、2560×1080、900×1200、768×1024。外壳采用上下布局；真实指针测试先将画布滚入视口，不能直接向视口外的节点坐标发送鼠标操作。

公开方法仍只生成 block 动作。闭环用例验证真实提交与服务端的“没有达成目标”结论；题目判胜完整性另外由全部参考解法回放验证，不将手工调试步骤冒充画布生成的 payload。

## 阶段验收记录

已完成阶段的测试与审查结果移至 [画布交互验收归档](../../docs/archive/canvas-interaction-2026-10-31/验收记录.md)。记录对应当时提交，不能替代后续改动的验证；本地证据路径不保证随仓库可用。
