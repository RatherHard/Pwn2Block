import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  ChallengeSummarySchema,
  CreateSessionResponseSchema,
  PrivateChallengeSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  parseSolutionMarkdown,
  type PrivateChallenge,
  type SolutionDoc,
} from '@pwn2block/shared';

/**
 * 磁盘首题的端到端集成（A 的 A03 日常集成）。
 *
 * 和 `ret2win-end-to-end.test.ts` 的区别：那一份把题目包写进临时目录、只验证引擎与 HTTP 的接线；
 * 这一份**直接吃仓库里 `challenges/ret2win/` 的真实产物**——真实的 `public.json` / `private.json` /
 * `solution.md`、真实的 `presets/x86ish.json` 展开路径。它才是 D1 记录的
 * 「首题换到 `challenges/` 后即可正式计 G1」那一步的证据。
 *
 * 三条不许退让的边界：
 * 1. flag 真值只从环境变量注入（这里注入**测试哨兵值**，不是真 flag），缺失即拒绝加载该题；
 * 2. 参考解法从 `solution.md` 的机器可读块读出，不在这份测试里另抄一份 payload——抄一份就会漂移，
 *    而且抄出来的那份一旦与服务端的展开路径不一致，测试反而会掩盖真实缺陷；
 * 3. 判胜路径必须真的往下发哨兵 flag，且**只有**判胜路径下发得出来。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const challengeRoot = join(repoRoot, 'challenges');
const challengeDir = join(challengeRoot, 'ret2win');
const presetDir = join(repoRoot, 'presets');

const privatePath = join(challengeDir, 'private.json');
const solutionPath = join(challengeDir, 'solution.md');

/** 缺失就拒绝加载：`challenges/ret2win/private.json` 里 `flag` 写的是 `env:FLAG_RET2WIN`（06 §6）。 */
const FLAG_ENV_VAR = 'FLAG_RET2WIN';
const env: Record<string, string> = { [FLAG_ENV_VAR]: TEST_FLAG_SENTINEL };

type App = ReturnType<typeof buildApp>;
let app: App;

/** 磁盘上的私有包；投影里的 `roles` 必须与它一致（角色是公开的固定信息，见 04 §4、09 §4）。 */
function privateOfDisk(): PrivateChallenge {
  return PrivateChallengeSchema.parse(JSON.parse(readFileSync(privatePath, 'utf8')) as unknown);
}

/** 磁盘上的参考解法；不可用就直接抛，别让测试跑在半截夹具上。 */
function solutionOfDisk(): SolutionDoc {
  const parsed = parseSolutionMarkdown(readFileSync(solutionPath, 'utf8'));
  if (!parsed.ok) throw new Error(`challenges/ret2win/solution.md 不可用：${parsed.message}`);
  return parsed.doc;
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

beforeAll(async () => {
  expect(
    existsSync(privatePath) && existsSync(solutionPath),
    `仓库里没有可用的 challenges/ret2win 题目包（E02 的交付物）：${challengeDir}`,
  ).toBe(true);

  app = buildApp({ challengeDir: challengeRoot, presetDir, env });
  await app.ready();
});

afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function createSession(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: 'ret2win' },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

describe('磁盘首题 challenges/ret2win（真实服务端 + 真实引擎）', () => {
  it('真实服务端能加载磁盘题目包，列表只含公开信息', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/challenges' });
    expect(response.statusCode).toBe(200);

    const list = ChallengeSummarySchema.array().parse(response.json());
    expect(list.map((item) => item.id)).toContain('ret2win');

    // 列表里不该出现 flag 真值，也不该出现隐藏区的内容。
    const body = jsonOf(list);
    expect(body).not.toContain(TEST_FLAG_SENTINEL);
    for (const vma of privateOfDisk().vmas.filter((item) => item.hidden)) {
      for (const patch of vma.init ?? []) expect(body).not.toContain(patch.hex);
    }
  });

  it('投影带私有包声明的 roles，隐藏 VMA 只有布局没有内容', async () => {
    const sessionId = await createSession();
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    expect(response.statusCode).toBe(200);

    const state = SessionStateResponseSchema.parse(response.json());
    const { projection } = state;
    const priv = privateOfDisk();

    // roles 是「固定的已知信息」：随投影下发，且与私有包声明逐字段一致。
    expect(projection.roles).toEqual(priv.roles);
    expect(Object.keys(projection.roles).sort()).toEqual(['bp', 'ip', 'sp']);

    // 全部寄存器按题目包声明顺序给出。
    expect(projection.registers.map((item) => item.name)).toEqual([...priv.registers]);

    // 隐藏区只公开布局：地址、大小、权限、hidden，没有 hex。
    for (const vma of projection.vmas.filter((item) => item.hidden)) {
      expect(vma.hex).toBeUndefined();
      expect(vma.start).toMatch(/^0x[0-9a-f]+$/);
    }

    // 响应正文不含 flag 真值与任何隐藏区**内容**（布局本身是公开的）。
    const body = jsonOf(state);
    expect(body).not.toContain(TEST_FLAG_SENTINEL);
  });

  it('调试实例用磁盘 solution.md 的 payload 走到 satisfied，且不下发 flag', async () => {
    const sessionId = await createSession();
    const doc = solutionOfDisk();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: doc.actions },
    });
    expect(response.statusCode).toBe(200);

    const body = ActionsResponseSchema.parse(response.json());
    expect(body.projection.status).toBe('satisfied');
    // 调试实例满足成功条件也只是提示：没有 flag 字段，也没有真值。
    expect(Object.keys(body)).not.toContain('flag');
    expect(jsonOf(body)).not.toContain(TEST_FLAG_SENTINEL);
  });

  it('提交磁盘 solution.md 的 payload 判胜、下发哨兵 flag，录像初态同样带 roles', async () => {
    const sessionId = await createSession();
    const doc = solutionOfDisk();
    expect(doc.expectedVerdict).toBe('won');

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/submit`,
      payload: { actions: doc.actions },
    });
    expect(response.statusCode).toBe(200);

    const body = SubmitResponseSchema.parse(response.json());
    expect(body.verdict).toBe('won');
    expect(body.flag).toBe(TEST_FLAG_SENTINEL);

    // 录像只含公开投影，且初态与每一帧都不带 flag 真值。
    expect(body.replay.initial.roles).toEqual(privateOfDisk().roles);
    expect(jsonOf(body.replay)).not.toContain(TEST_FLAG_SENTINEL);
  });
});
