import { readFileSync, readdirSync } from 'node:fs';
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
  flagEnvVarName,
  parseSolutionMarkdown,
  type PrivateChallenge,
  type SolutionDoc,
} from '@pwn2block/shared';

/**
 * **全部磁盘题目的**端到端集成（A 的 A03 日常集成）。
 *
 * `disk-challenge-end-to-end.test.ts` 只吃 `challenges/ret2win`，是 D1 的「首题换到 `challenges/`
 * 后正式计 G1」那份证据。这一份把它**推广到 `challenges/` 下的每一道题**，因为 08 §3 的 D6 要求
 * 「六题逐题回归」，而每加一道题就手抄一份测试必然漂移。这里是**表驱动**的：
 *
 * - 题目清单来自磁盘目录，新增题目自动进入覆盖，不需要改这个文件；
 * - payload 一律从该题的 `solution.md` 机器可读块读出，**不抄第二份**（抄一份就会漂移，
 *   而且一旦与服务端展开路径不一致，测试反而掩盖真实缺陷）；
 * - 每道题都断言四条不许退让的边界：flag 只经环境变量注入、调试实例只回状态不下发 flag、
 *   判胜路径下发哨兵 flag、隐藏区内容与 flag 真值不出现在任何响应里。
 *
 * 参考解法逐题跑的是**真实引擎 + 真实 HTTP + 真实 `presets/` 展开路径**，与判题实例同一条路。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const challengeRoot = join(repoRoot, 'challenges');
const presetDir = join(repoRoot, 'presets');

interface DiskChallenge {
  readonly id: string;
  readonly priv: PrivateChallenge;
  readonly solution: SolutionDoc;
}

/** 读取磁盘上全部可用题目包；任何一道读不出来就当场抛，别让测试跑在半截夹具上。 */
function readDiskChallenges(): readonly DiskChallenge[] {
  return readdirSync(challengeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const dir = join(challengeRoot, id);
      const priv = PrivateChallengeSchema.parse(
        JSON.parse(readFileSync(join(dir, 'private.json'), 'utf8')) as unknown,
      );
      const parsed = parseSolutionMarkdown(readFileSync(join(dir, 'solution.md'), 'utf8'));
      if (!parsed.ok) throw new Error(`challenges/${id}/solution.md 不可用：${parsed.message}`);
      return { id, priv, solution: parsed.doc };
    });
}

const DISK = readDiskChallenges();

/** 每道题的 flag 真值只从环境变量取（06 §6）：这里注入的是**测试哨兵值**，不是真 flag。 */
const ALL_FLAGS: Record<string, string> = Object.fromEntries(
  DISK.map((challenge) => [flagEnvVarName(challenge.id), TEST_FLAG_SENTINEL]),
);

type App = ReturnType<typeof buildApp>;
let app: App;

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

/** 隐藏区**内容**的字节串：它们只能经由程序执行获取，绝不该出现在响应里。 */
function hiddenHexes(priv: PrivateChallenge): readonly string[] {
  return priv.vmas
    .filter((vma) => vma.hidden)
    .flatMap((vma) => (vma.init ?? []).map((patch) => patch.hex));
}

async function createSession(challengeId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

beforeAll(async () => {
  expect(DISK.length, `challenges/ 下没有任何题目包：${challengeRoot}`).toBeGreaterThan(0);
  app = buildApp({ challengeDir: challengeRoot, presetDir, env: ALL_FLAGS });
  await app.ready();
});

afterAll(async () => {
  if (app !== undefined) await app.close();
});

describe('磁盘全部题目：列表与投影只含公开信息（04 §4）', () => {
  it('列表包含磁盘上的每一道题，且不含 flag 真值与隐藏区内容', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/challenges' });
    expect(response.statusCode).toBe(200);

    const list = ChallengeSummarySchema.array().parse(response.json());
    const ids = list.map((item) => item.id);
    for (const challenge of DISK) expect(ids, challenge.id).toContain(challenge.id);

    const body = jsonOf(list);
    expect(body).not.toContain(TEST_FLAG_SENTINEL);
    for (const challenge of DISK) {
      for (const hex of hiddenHexes(challenge.priv)) expect(body, `${challenge.id}:${hex}`).not.toContain(hex);
    }
  });

  it.each(DISK.map((challenge) => [challenge.id] as const))(
    '%s：roles 与寄存器顺序来自私有包，隐藏 VMA 只有布局',
    async (id) => {
      const challenge = DISK.find((item) => item.id === id);
      if (challenge === undefined) throw new Error(`题目 ${id} 不在磁盘清单里`);
      const sessionId = await createSession(id);
      const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
      expect(response.statusCode).toBe(200);

      const state = SessionStateResponseSchema.parse(response.json());
      const { projection } = state;

      // `roles` 是「固定的已知信息」：随投影下发，且与私有包声明逐字段一致（04 §4、09 §4）。
      expect(projection.roles).toEqual(challenge.priv.roles);
      expect(Object.keys(projection.roles).sort()).toEqual(['bp', 'ip', 'sp']);
      expect(projection.registers.map((item) => item.name)).toEqual([...challenge.priv.registers]);

      // 隐藏区只公开布局：地址、大小、权限、hidden，没有 hex。
      for (const vma of projection.vmas.filter((item) => item.hidden)) {
        expect(vma.hex).toBeUndefined();
        expect(vma.start).toMatch(/^0x[0-9a-f]+$/);
      }

      const body = jsonOf(state);
      expect(body).not.toContain(TEST_FLAG_SENTINEL);
      for (const hex of hiddenHexes(challenge.priv)) expect(body, `${id}:${hex}`).not.toContain(hex);
    },
  );
});

describe('磁盘全部题目：真实 HTTP 判题（G2）', () => {
  it.each(DISK.map((challenge) => [challenge.id] as const))(
    '%s：调试实例跑 solution.md 到 satisfied，只回状态不下发 flag',
    async (id) => {
      const challenge = DISK.find((item) => item.id === id);
      if (challenge === undefined) throw new Error(`题目 ${id} 不在磁盘清单里`);
      const sessionId = await createSession(id);

      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/actions`,
        payload: { actions: challenge.solution.actions },
      });
      expect(response.statusCode).toBe(200);

      const body = ActionsResponseSchema.parse(response.json());
      expect(body.projection.status, id).toBe('satisfied');
      // 调试实例满足成功条件也只是提示：没有 flag 字段，也没有真值（01 §6 第 3 条）。
      expect(Object.keys(body)).not.toContain('flag');
      expect(jsonOf(body)).not.toContain(TEST_FLAG_SENTINEL);
    },
  );

  it.each(DISK.map((challenge) => [challenge.id] as const))(
    '%s：judge 实例用同一 payload 判胜并下发哨兵 flag，录像只含公开投影',
    async (id) => {
      const challenge = DISK.find((item) => item.id === id);
      if (challenge === undefined) throw new Error(`题目 ${id} 不在磁盘清单里`);
      expect(challenge.solution.expectedVerdict, id).toBe('won');

      const sessionId = await createSession(id);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/submit`,
        payload: { actions: challenge.solution.actions },
      });
      expect(response.statusCode).toBe(200);

      const body = SubmitResponseSchema.parse(response.json());
      expect(body.verdict, id).toBe('won');
      expect(body.flag, id).toBe(TEST_FLAG_SENTINEL);

      // 录像初态同样带 roles，且整段录像不含 flag 真值（04 §5.1）。
      expect(body.replay.initial.roles).toEqual(challenge.priv.roles);
      expect(jsonOf(body.replay)).not.toContain(TEST_FLAG_SENTINEL);
    },
  );

  /**
   * 双实例隔离（G2 的另一个条件）：一个会话被推进到 `satisfied`，不能影响另一个会话的投影；
   * `submit` 必须从题目初态回放，不借用任何其他实例的状态。这里刻意跨两道题跑，验证隔离不是
   * 「同题两实例」的特例。
   */
  it('推进一个会话不改变另一个会话的投影，判题也不借用别人的状态', async () => {
    const [first, second] = DISK;
    if (first === undefined || second === undefined) throw new Error('至少需要两道题才能验隔离');

    const progressed = await createSession(first.id);
    const untouched = await createSession(second.id);

    const before = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${untouched}` })).json(),
    );

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${progressed}/actions`,
      payload: { actions: first.solution.actions },
    });

    const after = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${untouched}` })).json(),
    );
    // 未被触碰的会话：投影逐字段不变（用 JSON 比对，字段全在范围内）。
    expect(jsonOf(after.projection)).toBe(jsonOf(before.projection));

    // 它自己的判题仍从初态回放：拿另一道题的 payload 提交，必须判负而不是「借用」任何状态。
    const crossed = await app.inject({
      method: 'POST',
      url: `/api/sessions/${untouched}/submit`,
      payload: { actions: first.solution.actions },
    });
    expect(crossed.statusCode).toBe(200);
    const crossedBody = SubmitResponseSchema.parse(crossed.json());
    expect(crossedBody.verdict).not.toBe('won');
    expect(crossedBody.flag).toBeUndefined();

    // 而它自己的解法仍然判胜——证明上面的判负是「payload 不对」，不是会话坏了。
    const own = await app.inject({
      method: 'POST',
      url: `/api/sessions/${untouched}/submit`,
      payload: { actions: second.solution.actions },
    });
    const ownBody = SubmitResponseSchema.parse(own.json());
    expect(ownBody.verdict).toBe('won');
    expect(ownBody.flag).toBe(TEST_FLAG_SENTINEL);
  });
});

describe('磁盘全部题目：缺 flag 环境变量时逐题拒绝加载（06 §6）', () => {
  it('没有任何 FLAG_* 时列表为空，每题都回 challenge_unavailable', async () => {
    const bare = buildApp({ challengeDir: challengeRoot, presetDir, env: {} });
    await bare.ready();
    try {
      const list = await bare.inject({ method: 'GET', url: '/api/challenges' });
      expect(list.statusCode).toBe(200);
      expect(ChallengeSummarySchema.array().parse(list.json())).toEqual([]);

      // 只抽第一道题做接口级断言，逐题差异由 S05 的真实包用例覆盖。
      const id = DISK[0]?.id;
      if (id === undefined) throw new Error('磁盘清单为空');
      const created = await bare.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: id },
      });
      expect(created.statusCode).toBeGreaterThanOrEqual(400);
      expect(created.json()).toMatchObject({ code: 'challenge_unavailable' });
      expect(jsonOf(created.json())).not.toContain(TEST_FLAG_SENTINEL);
    } finally {
      await bare.close();
    }
  });
});
