# 核心安全验收

本目录通过真实引擎和服务端 `buildApp` / `app.inject` 验证公开 API 与安全边界。临时题目包与辅助函数见 [support.ts](support.ts)，部分用例还使用仓库内的真实题目和 preset。

## 运行

从仓库根目录执行：

```powershell
pnpm build
pnpm exec vitest run tests/acceptance
```

S06 检查真实 `packages/web/dist` 和静态 HTTP 路径。缺少构建入口时整组会跳过，因此需要先构建；跳过不能记为验收通过。记录结果时注明执行、跳过和 todo 数量。

## 覆盖范围

| 文件 | 检查内容 |
|---|---|
| [s01-hidden-boundary.test.ts](s01-hidden-boundary.test.ts) | 隐藏内容与公开投影边界 |
| [s02-verdict-boundary.test.ts](s02-verdict-boundary.test.ts) | 调试与独立判题边界 |
| [s03-request-boundary.test.ts](s03-request-boundary.test.ts) | 请求 Schema 与不可信输入 |
| [s04-payload-boundary.test.ts](s04-payload-boundary.test.ts) | payload、动作额度与失败回滚 |
| [s05-flag-boundary.test.ts](s05-flag-boundary.test.ts) | flag 发放及错误信息安全 |
| [s06-publish-boundary.test.ts](s06-publish-boundary.test.ts) | 真实构建产物与静态发布边界 |
| [api-lifecycle.test.ts](api-lifecycle.test.ts) | 会话生命周期与执行终态 |

## 待核验项与历史记录

当前源码保留 5 个 `it.todo`：S04 的 3 个 `reads_state` 契约问题、1 个无法从扁平动作序列验证前端编译上限的问题，以及 S05 的 1 个题目加载诊断与日志问题。它们代表尚未落实的验收断言，处理前需核验当前实现，不能仅凭历史描述判定功能缺失。

工程待办统一维护在 [05-未完成工作](../../docs/05-未完成工作.md)。原 D3/D4 交接、测试计数和 BG 问题记录保存在 [核心安全验收记录](../../docs/archive/mvp-2026-10-16/核心安全验收记录.md)，供追溯使用，不作为当前测试结果。
