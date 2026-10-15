import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * 前端构建配置。
 * - `root` 指到 `packages/web`，这样从仓库根执行 `vite --config packages/web/vite.config.ts` 也对。
 * - 开发时 `/api` 代理到服务端（默认 8787），前端不直接碰引擎。
 */
export default defineConfig({
  root: webRoot,
  resolve: {
    alias: {
      '@pwn2block/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
