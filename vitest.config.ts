import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 内部包直接以 TS 源码互相引用，测试通过别名解析，不依赖构建产物。 */
const src = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pwn2block/shared': src('shared'),
      '@pwn2block/engine': src('engine'),
      '@pwn2block/server': src('server'),
      '@pwn2block/authoring': src('authoring'),
    },
  },
  test: {
    environment: 'node',
    /**
     * 超时按「真实负载」给，不要用 vitest 默认的 5000ms。
     *
     * 本仓库的契约测试走真实 HTTP（`app.inject`）与真实引擎：单是 C03 的抽样穷举就要发
     * 1000+ 次请求、S06 要真的去读构建产物、roles/rate-limit/app 各自要建真实 app。
     * 单跑时每条 0.5–1s，但 vitest 默认按文件并行，机器一忙（CI runner 更慢）就会超过
     * 5s，于是报 `Error: Test timed out in 5000ms` —— 那是**负载**问题，不是产品缺陷，
     * 却会让 CI 间歇性变红、把真正的失败淹没在噪声里（D4 用三份并发全量复现：8 条超时）。
     * 给足余量后语义不变：真挂死的用例照样失败，只是晚一点；CI 自身的 job 超时仍是上限。
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'tests/acceptance/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/engine/src/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
