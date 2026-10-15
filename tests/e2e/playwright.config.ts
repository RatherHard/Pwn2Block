import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * 主路径 E2E 配置（01 §3 八步闭环）— owner F · 关卡 **G3 · D5**。
 *
 * 定位：D1 只搭骨架，**D5 才做真实验收**。
 * - 用例默认整组跳过，只有 `PWN2BLOCK_E2E=1` **且真实后端已经在跑**、并已加载真实首题 `ret2win` 时才执行。
 * - 配置里**故意不配 `webServer`**：验收要求服务确实在跑（真实后端 + 真实首题），而不是由 Playwright 起一个替身。
 *   验收人先 `pnpm dev` 或 `pnpm start`，再运行本配置。
 * - Playwright 浏览器二进制本轮**不下载**；D5 首次运行前执行 `pnpm exec playwright install chromium`。
 * - 后端地址：`PWN2BLOCK_BASE_URL`（默认 `http://127.0.0.1:<PWN2BLOCK_PORT 或 8787>`，与 04 §6 的 `DEFAULT_PORT` 一致）。
 *
 * 产物目录用 `.tmp/playwright`：`.tmp/` 已被 `.gitignore` 排除，不会污染 A 的集成提交。
 * （根 `.gitignore` 尚未包含 `test-results/` 与 `playwright-report/`；如后续改用默认目录，需要 A 一并加上。）
 */
export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 一个后端、一份会话状态：串行执行，工作进程数固定为 1。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: fileURLToPath(new URL('../../.tmp/playwright', import.meta.url)),
  reporter: [['list']],
  use: {
    baseURL: process.env.PWN2BLOCK_BASE_URL ?? `http://127.0.0.1:${process.env.PWN2BLOCK_PORT ?? '8787'}`,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }],
});
