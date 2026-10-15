import { DEFAULT_PORT } from '@pwn2block/shared';
import { buildApp } from './app';

/**
 * 服务端开发入口：Fastify 单进程同时承担引擎、API 与静态托管（07 §7）。
 * 端口可用 `PORT` 覆盖，默认 8787；前端 dev server 通过 `/api` 代理过来。
 */
const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const app = buildApp({ logger: true });

try {
  await app.listen({ port, host: '127.0.0.1' });
  app.log.info(`Pwn2Block server listening on http://127.0.0.1:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
