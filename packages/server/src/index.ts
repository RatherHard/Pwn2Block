import { pathToFileURL } from 'node:url';
import { DEFAULT_PORT } from '@pwn2block/shared';
import { buildApp } from './app';
import type { BuildAppOptions } from './app';

export { buildApp };
export type { BuildAppOptions };

/**
 * 服务端开发入口：Fastify 单进程同时承担引擎、API 与静态托管（07 §7）。
 * 端口可用 `PORT` 覆盖，默认 8787；前端 dev server 通过 `/api` 代理过来。
 *
 * 只有**直接执行**这个文件时才监听端口：测试（或其它包）`import` 它不该顺带起一个服务。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const app = buildApp({ logger: true });

  try {
    await app.listen({ port, host: '127.0.0.1' });
    app.log.info(`Pwn2Block server listening on http://127.0.0.1:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
