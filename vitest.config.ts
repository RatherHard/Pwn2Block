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
