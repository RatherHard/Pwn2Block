import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * 真实后端 + 生产构建验收：先 pnpm build / pnpm start，再设 PWN2BLOCK_E2E=1。
 * 默认仍保留显式开关；不配置替身 webServer、不 mock API。
 * 首次运行可执行 pnpm exec playwright install chromium 安装已有配置所需浏览器。
 * chromium-desktop 保留原闭环；其余 project 只跑指定尺寸的桌面冒烟。
 * PWN2BLOCK_BASE_URL 可覆盖地址，否则使用 PWN2BLOCK_PORT（默认 8787）。
 * PWN2BLOCK_E2E_OUTPUT_DIR 可为每轮证据选独立目录（相对仓库根或绝对路径）；
 * 截图/trace 写入该目录，JSON 报告写到同名 .json 文件，避免复跑覆盖前轮证据。
 * 命令与本次实测结果见同目录 README.md。
 */
const evidenceDir = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  process.env.PWN2BLOCK_E2E_OUTPUT_DIR ?? '.tmp/playwright',
);

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
  outputDir: evidenceDir,
  reporter: [['list'], ['json', { outputFile: `${evidenceDir}.json` }]],
  use: {
    baseURL: process.env.PWN2BLOCK_BASE_URL ?? `http://127.0.0.1:${process.env.PWN2BLOCK_PORT ?? '8787'}`,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      testIgnore: '**/desktop-smoke.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    ...[
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1080 },
      { width: 900, height: 1200 },
      { width: 768, height: 1024 },
    ].map(viewport => ({
      name: `chromium-desktop-${viewport.width}x${viewport.height}`,
      testMatch: '**/desktop-smoke.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport },
    })),
  ],
});
