import Fastify, { type FastifyInstance } from 'fastify';
import { ChallengeSummarySchema, MAX_BODY_BYTES, type ChallengeSummary } from '@pwn2block/shared';

export interface BuildAppOptions {
  /** 题目包目录，默认仓库根的 `challenges/`。 */
  readonly challengeDir?: string;
  readonly logger?: boolean;
}

/**
 * 服务端骨架（C01–C04 实现）。
 *
 * D1 只提供：请求体大小上限、健康检查、题目列表（当前为空）。
 * 会话、投影、actions / submit、静态托管由 C 在 D2–D6 补齐，见 docs/08 §4。
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/challenges', async (): Promise<ChallengeSummary[]> => {
    const list: ChallengeSummary[] = [];
    return list.map((item) => ChallengeSummarySchema.parse(item));
  });

  return app;
}
