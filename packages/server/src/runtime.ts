import { createRuntime } from '@pwn2block/engine';

/**
 * 默认引擎装配工厂（08 §3 D1）。
 *
 * 引擎由 B/G 在 D1–D3 补齐；`createRuntime` 需要调用方把 `checkChallengePair()` 展开好的
 * 编码表一并传进来（题目 `encoding` 引用 preset 时引擎自己读不到文件）。这里**不吞异常、
 * 不造兜底引擎**：`buildApp` 捕获后返回 503 `challenge_unavailable`，绝不给客户端假成功。
 * 测试与后续交付通过 `BuildAppOptions.createRuntime` 注入实现。
 */
export const engineRuntimeFactory = createRuntime;
