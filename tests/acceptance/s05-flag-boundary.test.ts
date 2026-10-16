import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ApiErrorSchema,
  ChallengeSummarySchema,
  CreateSessionResponseSchema,
  EncodingItemSchema,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  TEST_FLAG_SENTINEL,
  asciiToBytes,
  bytesToHex,
  checkChallengePair,
  containsBytes,
  containsBytesIgnoringAsciiCase,
  flagEnvNameOf,
  hexToBytes,
} from '@pwn2block/shared';
import type { ChallengeIssue } from '@pwn2block/shared';
import { expectApiError, expectNoInternalLeak, makeChallengeRoot, removeChallengeRoot } from './support';
import type { TempChallengeRoot } from './support';

/**
 * S05 · flag 边界 — owner F（C/E 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S05 · F，C/E 配合 flag 边界：缺失环境变量，或虚拟文件/隐藏 VMA 内容包含注入的 flag 真值时拒绝加载；
 *     使用测试哨兵值，不把真实 flag 写进仓库。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 7 条：虚拟文件或隐藏 VMA 的内容包含 flag 真值时，该题拒绝加载。
 *
 * 契约依据（06 §6、07 §7、04 §5/§6、09 §8）：`flag` 字段写 `env:FLAG_<ID 大写>`，真值由环境变量注入，
 * 缺失就拒绝加载该题；泄露检查要覆盖 ASCII 大小写变体；只用 `TEST_FLAG_SENTINEL` 这类哨兵值，真值绝不进仓库。
 *
 * **状态（D3 / F01-b）：8 条真实用例通过，1 条如实保留 `todo`**（该条在文件末尾，理由见其注释）。
 * 8 条里 7 条对应 08 §5 的两类拒绝（缺环境变量 / 内容含注入真值，含大小写变体）与「不把真值写进仓库」，
 * 另 1 条是「未注入副本正常加载」的消融对照（用来证明拒绝确实由注入造成）。
 * 真实对象：真实 `@pwn2block/server` 的 `buildApp` + `inject`（真实 HTTP 路径与请求 Schema）
 * 加真实加载链路（`loadChallengeDir` → shared 的 `checkChallengePair` / `validateFlagNotLeaked`）
 * 加真实首题 `challenges/ret2win` + 真实 `presets/x86ish.json`；「注入哨兵」的变体是真实首题包的副本，
 * 只往内容里塞哨兵字节，别的字段一个不改（消融对照见下）。
 *
 * 已删除的过时阻塞理由（D2 / F01-a 那段）：原文写「真实首题未落盘：`challenges/` 目录本批不存在
 * （E02 未交付）」——**这条理由是错的**。HEAD 上 `challenges/ret2win` 早已落盘（`33bde9a`），
 * 而且第 7 条的泄露检查从来就不依赖真实首题：它依赖的是**真实加载链路**，用真实题目包的副本注入哨兵即可。
 * 现在按实测重写：
 * - 「缺环境变量」与「正对照」用**真实首题本身**（不复制、不改造）；
 * - 「虚拟文件 / 隐藏 VMA 含哨兵」用真实首题副本 + 注入，并配一条**未注入副本正常加载**的消融对照
 *   （证明拒绝确实由注入的哨兵造成，而不是副本本身有别的毛病），再用 shared 的 `checkChallengePair`
 *   把**拒绝原因**逐条对齐（issue 的 path 与 message 精确断言）；
 * - 仍为 `todo` 的 1 条是「加载失败的服务端告警/日志」：当前实现没有任何加载失败日志出口，
 *   `BuildAppOptions.logger` 只收布尔值、`issuesFor()` 不在 `@pwn2block/server` 的导出面里，
 *   黑盒验收无法观察，见文件末尾。
 */

type App = ReturnType<typeof buildApp>;

const REAL_CHALLENGE_DIR = fileURLToPath(new URL('../../challenges', import.meta.url));
const REAL_PRESET_DIR = fileURLToPath(new URL('../../presets', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 真实首题的目录名 / id / flag 环境变量名。 */
const REAL_ID = 'ret2win';
const FLAG_ENV_NAME = 'FLAG_RET2WIN';

/** 文档化的测试哨兵真值：`docs/06` §6 与 `.env.example` 用的就是它。 */
const SENTINEL_BYTES = asciiToBytes(TEST_FLAG_SENTINEL);
const SENTINEL_HEX = bytesToHex(SENTINEL_BYTES);
/** 同一真值的 ASCII 大写变体：逐字节精确匹配不到，只有忽略大小写的检查能抓到。 */
const SENTINEL_UPPER_HEX = bytesToHex(asciiToBytes(TEST_FLAG_SENTINEL.toUpperCase()));

/** 注入哨兵（正对照与泄露变体都用它）；`NO_FLAG_ENV` 显式不注入，避免读到宿主环境的真值。 */
const SENTINEL_ENV: Readonly<Record<string, string | undefined>> = { [FLAG_ENV_NAME]: TEST_FLAG_SENTINEL };
const NO_FLAG_ENV: Readonly<Record<string, string | undefined>> = {};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** 真实首题的原始包数据：注入变体只在这个基础上加内容，别的字段原样透传。 */
const REAL_PUBLIC_RAW = readJson(join(REAL_CHALLENGE_DIR, REAL_ID, 'public.json')) as Record<string, unknown>;
const REAL_PRIVATE_RAW = readJson(join(REAL_CHALLENGE_DIR, REAL_ID, 'private.json')) as Record<string, unknown>;
const PRESET_ITEMS = EncodingItemSchema.array().parse(readJson(join(REAL_PRESET_DIR, 'x86ish.json')));

interface RawPackage {
  readonly pub: Record<string, unknown>;
  readonly priv: Record<string, unknown>;
}

/** 真实首题副本，未注入任何东西。 */
function plainCopy(): RawPackage {
  return { pub: { ...REAL_PUBLIC_RAW }, priv: { ...REAL_PRIVATE_RAW } };
}

/**
 * 真实首题副本 + 虚拟文件内容里的哨兵真值。
 * `fds` 里补一条同名的 file 声明，好让「文件存在」本身是合法的，唯一的毛病就是内容含真值。
 */
function fileLeakCopy(): RawPackage {
  return {
    pub: {
      ...REAL_PUBLIC_RAW,
      fds: [{ fd: 3, name: 'secret.txt', kind: 'file', size: SENTINEL_BYTES.length }],
    },
    priv: { ...REAL_PRIVATE_RAW, files: { '3': { hex: SENTINEL_HEX } } },
  };
}

/** 真实首题副本 + 隐藏 VMA 内容里的哨兵真值（`hex` 可以是大小写变体）。 */
function hiddenVmaLeakCopy(hex: string): RawPackage {
  return {
    pub: { ...REAL_PUBLIC_RAW },
    priv: {
      ...REAL_PRIVATE_RAW,
      vmas: [
        ...(REAL_PRIVATE_RAW.vmas as unknown[]),
        {
          id: 'secret',
          kind: 'custom',
          label: '秘密区',
          start: '0x600000',
          size: '0x1000',
          perm: 'rw',
          hidden: true,
          init: [{ at: '0x600000', hex }],
        },
      ],
    },
  };
}

/** 加载校验的**原因**：与 `loadChallengeDir` 走的是同一个 shared 入口。 */
function loadIssues(pkg: RawPackage): readonly ChallengeIssue[] {
  const checked = checkChallengePair(pkg.pub, pkg.priv, {
    presetItems: PRESET_ITEMS,
    flagValue: TEST_FLAG_SENTINEL,
  });
  expect(checked.ok).toBe(false);
  return checked.ok ? [] : checked.issues;
}

async function makeApp(
  challengeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<App> {
  const app = buildApp({ challengeDir, presetDir: REAL_PRESET_DIR, env });
  await app.ready();
  return app;
}

/** 临时题目根 + 真实服务端：用完必关必删（不落进仓库的 `challenges/`）。 */
async function withTempChallenge(
  pkg: RawPackage,
  env: Readonly<Record<string, string | undefined>>,
  run: (app: App, root: TempChallengeRoot) => Promise<void>,
): Promise<void> {
  const root = makeChallengeRoot({ [REAL_ID]: pkg });
  const app = await makeApp(root.challengeDir, env);
  try {
    await run(app, root);
  } finally {
    await app.close();
    removeChallengeRoot(root);
  }
}

/** `GET /api/challenges`：已加载题目的 id 列表。 */
async function listedIds(app: App): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: '/api/challenges' });
  expect(response.statusCode).toBe(200);
  return ChallengeSummarySchema.array().parse(response.json()).map((item) => item.id);
}

function getChallenge(app: App, id: string) {
  return app.inject({ method: 'GET', url: `/api/challenges/${id}` });
}

function createSession(app: App, id: string) {
  return app.inject({ method: 'POST', url: '/api/sessions', payload: { challengeId: id } });
}

describe('S05 flag 边界 · 真实题目加载路径（G2 · D4）', () => {
  it('缺失 FLAG_RET2WIN：真实首题不加载、不出现在列表里，请求它回 503 challenge_unavailable', async () => {
    const app = await makeApp(REAL_CHALLENGE_DIR, NO_FLAG_ENV);
    try {
      // 服务照常启动并可服务请求：不是「整个服务挂掉」。
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      // 加载失败的题目不出现在列表里（04 §5 / 08 §3 D1）。
      expect(await listedIds(app)).toEqual([]);

      // 请求它时回 503 challenge_unavailable，而不是假装不存在（404）。
      const detail = await getChallenge(app, REAL_ID);
      expectApiError(detail, 'challenge_unavailable');
      // 也不回显「缺哪个环境变量」这类诊断细节。
      expect(detail.body).not.toContain(FLAG_ENV_NAME);
      expect(detail.body).not.toContain('缺失');

      const session = await createSession(app, REAL_ID);
      expectApiError(session, 'challenge_unavailable');

      // 反面对照：磁盘上不存在的 id 仍然是 404，证明上面的 503 是「加载失败」而不是「一律 503」。
      expectApiError(await getChallenge(app, 'not-on-disk'), 'not_found');
      expectApiError(await createSession(app, 'not-on-disk'), 'not_found');
    } finally {
      await app.close();
    }
  });

  it('注入哨兵后同一真实首题正常加载：列表含 ret2win、建会话 200（缺 env 那条的正对照）', async () => {
    const app = await makeApp(REAL_CHALLENGE_DIR, SENTINEL_ENV);
    try {
      // 正对照必须成对：否则上面那条可能因为「题目根目录没配」而假绿。
      expect(await listedIds(app)).toEqual([REAL_ID]);

      const detail = await getChallenge(app, REAL_ID);
      expect(detail.statusCode).toBe(200);
      expect(PublicChallengeSchema.safeParse(detail.json()).success).toBe(true);
      // 公开包原样下发：没有私有包字段、没有 flag 字段、没有哨兵。
      expectNoInternalLeak(detail.body, [TEST_FLAG_SENTINEL]);
      expect(detail.body).not.toContain('"flag"');

      const session = await createSession(app, REAL_ID);
      expect(session.statusCode).toBe(200);
      const body = CreateSessionResponseSchema.parse(session.json());
      expect(body.sessionId).not.toBe('');
      expect(body.projection.status).toBe('ready');
      expect(session.body).not.toContain(TEST_FLAG_SENTINEL);
    } finally {
      await app.close();
    }
  });

  it('真实首题副本（未注入）在临时题目根下正常加载：下面三条泄露用例的消融对照', async () => {
    const pkg = plainCopy();
    // 副本本身必须干净通过校验，否则「注入后拒绝」证明不了任何事。
    const checked = checkChallengePair(pkg.pub, pkg.priv, {
      presetItems: PRESET_ITEMS,
      flagValue: TEST_FLAG_SENTINEL,
    });
    expect(checked.ok).toBe(true);
    expect(checked.ok ? [] : checked.issues).toEqual([]);

    await withTempChallenge(pkg, SENTINEL_ENV, async (app) => {
      expect(await listedIds(app)).toEqual([REAL_ID]);
      const session = await createSession(app, REAL_ID);
      expect(session.statusCode).toBe(200);
      expect(CreateSessionResponseSchema.parse(session.json()).projection.status).toBe('ready');
    });
  });

  it('虚拟文件内容包含注入的哨兵真值：拒绝加载该题（07 §5 第 7 条）', async () => {
    const pkg = fileLeakCopy();
    // 原因精确对齐：唯一的问题是「虚拟文件内容包含 flag 真值」，别的校验一个都没踩。
    expect(loadIssues(pkg)).toEqual([
      { path: 'files.3', message: '虚拟文件内容包含 flag 真值，拒绝加载' },
    ]);

    await withTempChallenge(pkg, SENTINEL_ENV, async (app) => {
      expect(await listedIds(app)).toEqual([]);
      expectApiError(await getChallenge(app, REAL_ID), 'challenge_unavailable');
      expectApiError(await createSession(app, REAL_ID), 'challenge_unavailable');
    });
  });

  it('隐藏 VMA 内容包含注入的哨兵真值：拒绝加载该题（07 §5 第 7 条）', async () => {
    const pkg = hiddenVmaLeakCopy(SENTINEL_HEX);
    expect(bodyOf(pkg, 'secret').hex).toBe(SENTINEL_HEX);
    expect(loadIssues(pkg)).toEqual([
      { path: 'vmas.secret', message: '隐藏 VMA 的内容包含 flag 真值，拒绝加载' },
    ]);

    await withTempChallenge(pkg, SENTINEL_ENV, async (app) => {
      expect(await listedIds(app)).toEqual([]);
      expectApiError(await getChallenge(app, REAL_ID), 'challenge_unavailable');
      expectApiError(await createSession(app, REAL_ID), 'challenge_unavailable');
    });
  });

  it('哨兵真值的大小写变体同样被拒绝（hex.ts containsBytesIgnoringAsciiCase）', async () => {
    // 先确认这确实是「大小写变体」：逐字节精确匹配不到，只有忽略 ASCII 大小写的检查能抓到。
    const upperBytes = hexToBytes(SENTINEL_UPPER_HEX);
    expect(SENTINEL_UPPER_HEX).not.toBe(SENTINEL_HEX);
    expect(containsBytes(upperBytes, SENTINEL_BYTES)).toBe(false);
    expect(containsBytesIgnoringAsciiCase(upperBytes, SENTINEL_BYTES)).toBe(true);

    const pkg = hiddenVmaLeakCopy(SENTINEL_UPPER_HEX);
    expect(loadIssues(pkg)).toEqual([
      { path: 'vmas.secret', message: '隐藏 VMA 的内容包含 flag 真值，拒绝加载' },
    ]);

    await withTempChallenge(pkg, SENTINEL_ENV, async (app) => {
      expect(await listedIds(app)).toEqual([]);
      expectApiError(await getChallenge(app, REAL_ID), 'challenge_unavailable');
      expectApiError(await createSession(app, REAL_ID), 'challenge_unavailable');
    });
  });

  it('challenges/** 的 flag 字段只写 env:FLAG_<ID 大写>，仓库里没有 flag 真值', async () => {
    const ids = readdirSync(REAL_CHALLENGE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // 空集合会让下面的循环假绿：先钉死「至少有一道题，且含真实首题」。
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain(REAL_ID);

    for (const id of ids) {
      const priv = PrivateChallengeSchema.parse(
        readJson(join(REAL_CHALLENGE_DIR, id, 'private.json')),
      );
      // 只允许 `env:FLAG_<ID 大写>` 引用：任何字面真值都会在这里变红。
      expect(priv.flag, id).toBe(`env:FLAG_${id.toUpperCase().replace(/-/g, '_')}`);
      expect(flagEnvNameOf(priv), id).toBe(priv.flag.slice('env:'.length));
      expect(priv.flag, id).not.toContain('{');

      // 题目数据里也不能躺着哨兵真值或 `flag{…}` 形态的字面量（可读文件断言，不做全仓 grep）。
      for (const hex of contentHexOf(priv)) {
        const bytes = hexToBytes(hex);
        expect(containsBytesIgnoringAsciiCase(bytes, SENTINEL_BYTES), `${id}:${hex}`).toBe(false);
        expect(containsBytesIgnoringAsciiCase(bytes, asciiToBytes('flag{')), `${id}:${hex}`).toBe(false);
      }
    }

    // `.env.example` 进 git：只允许变量名 + 文档化的测试哨兵值，真值一律不许出现。
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    const assignments = example
      .split('\n')
      .map((line) => /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => match[1].startsWith('FLAG_'));
    expect(assignments.length).toBeGreaterThan(0);
    for (const match of assignments) {
      expect(match[1]).toMatch(/^FLAG_[A-Z0-9_]+$/);
      expect(match[2]).toBe(TEST_FLAG_SENTINEL);
    }
    // 说明：这是**有界**的可读文件断言（`challenges/**` + `.env.example`）。
    // 「全仓任何角落都不存在真值」需要 CI 里的秘密扫描，超出黑盒验收范围，已随报告提交给 A。
  });

  it('拒绝加载时不下发细节：503 正文是固定文案，不含命中位置、文件路径或私有包内容', async () => {
    const detail = '题目未通过加载校验，暂时不可用';
    const pkg = fileLeakCopy();

    await withTempChallenge(pkg, SENTINEL_ENV, async (app, root) => {
      const forbidden = [
        TEST_FLAG_SENTINEL,
        SENTINEL_HEX,
        'secret.txt',
        'files.',
        'vmas.',
        '拒绝加载',
        'private.json',
        root.challengeDir,
        root.root,
        FLAG_ENV_NAME,
      ];
      for (const response of [await getChallenge(app, REAL_ID), await createSession(app, REAL_ID)]) {
        expectApiError(response, 'challenge_unavailable', forbidden);
        const parsed = ApiErrorSchema.parse(response.json());
        // 正文只有固定文案：错误对象恰好两个字段，message 逐字固定。
        expect(Object.keys(parsed).sort()).toEqual(['code', 'message']);
        expect(parsed.code).toBe('challenge_unavailable');
        expect(parsed.message).toBe(detail);
        expect(response.body).not.toContain('secret');
        expect(response.body).not.toMatch(/at\s+\S+\s+\(/);
      }
    });

    // 缺环境变量那条同样不透露细节。
    const missingEnvApp = await makeApp(REAL_CHALLENGE_DIR, NO_FLAG_ENV);
    try {
      for (const response of [
        await getChallenge(missingEnvApp, REAL_ID),
        await createSession(missingEnvApp, REAL_ID),
      ]) {
        expectApiError(response, 'challenge_unavailable', [FLAG_ENV_NAME, '缺失', 'env:']);
        expect(ApiErrorSchema.parse(response.json()).message).toBe(detail);
      }
    } finally {
      await missingEnvApp.close();
    }
  });

  // -------------------------------------------------------------------------
  // 以下 1 条按当前实现无法在黑盒层验证，如实保留 todo
  // -------------------------------------------------------------------------

  /**
   * 「加载失败要有可诊断的告警/日志」为什么现在还验证不了：
   *
   * 1. **实现里没有加载失败日志出口**：`loadChallengeDir` 只把失败原因放进内部的 `ChallengeStore.issuesFor()`，
   *    `buildApp()` 不打印任何加载失败信息（`app.ts` 里唯一的 `log.warn` 是「引擎装配失败」那条）。
   * 2. **黑盒也拿不到那个出口**：`packages/server/src/index.ts` 只导出 `buildApp`，
   *    `issuesFor()` 不出现在包导出面里（深路径导入过不了根 `tsconfig.json` 的 `paths`，
   *    也会越过验收测试「只用公开接口」的边界）；`BuildAppOptions.logger` 只收布尔值，
   *    没有注入 `stream` / 自定义 logger 的口子，所以测试无法截获日志。
   * 3. 契约口径本身也不唯一：06 §6 说「缺失时拒绝加载这道题并报错」，眼下这个「报错」由
   *    HTTP 503 + `challenge:check` CLI 的诊断文案承担（CLI 那侧已经有真实证据）。
   *    要不要在服务端启动时额外打一条告警，是产品/运维口径问题，不是 F 能单方面决定的。
   *
   * 所以这条**不写假断言**：需要 C 决定并实现「加载失败 → 一条可诊断的服务端告警（且不含私有字段、
   * 文件路径、内部堆栈）」，或者 A 明确「503 + CLI 诊断」就是 06 §6 的完整口径、把这条从 S05 移除。
   * 另外：上面「拒绝加载时不下发细节」那条已经把**响应侧**（04 §6 的一半）真实验完了，
   * 这里剩下的只有**日志侧**。
   */
  it.todo('加载失败的服务端告警/日志：可诊断且不含私有包字段、文件路径或内部堆栈（06 §6 / 04 §6，C/A）');
});

/** 私有包里所有「内容」字节：隐藏 VMA 的 init 补丁与虚拟文件内容。 */
function contentHexOf(priv: ReturnType<typeof PrivateChallengeSchema.parse>): string[] {
  const out: string[] = [];
  for (const vma of priv.vmas) {
    if (!vma.hidden) continue;
    for (const patch of vma.init ?? []) out.push(patch.hex);
  }
  for (const content of Object.values(priv.files ?? {})) out.push(content.hex);
  return out;
}

/** 取注入变体里那个隐藏 VMA 的 `init` 补丁（用来回读注入的字节）。 */
function bodyOf(pkg: RawPackage, id: string): { readonly hex: string } {
  const vmas = (pkg.priv.vmas ?? []) as readonly { readonly id: string; readonly init?: readonly { readonly hex: string }[] }[];
  const found = vmas.find((vma) => vma.id === id);
  expect(found).toBeDefined();
  return found?.init?.[0] ?? { hex: '' };
}
