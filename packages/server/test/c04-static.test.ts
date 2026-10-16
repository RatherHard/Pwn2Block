import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import { defaultStaticRoot, isDeniedStaticPath } from '../src/static';
import {
  TEST_ENV,
  expectApiError,
  makeChallengeDir,
  makeFakeRuntime,
  testPrivate,
  testPublic,
  writeChallenge,
} from './support';

/**
 * 静态托管与发布边界（07 §7、08 §5 S06）。
 *
 * 全部是**真实 HTTP 用例**：`app.inject` 打真实路由 + 真实 `@fastify/static`，产物目录用临时目录
 * 现场构造（不依赖 `pnpm build` 的 `packages/web/dist`，CI 里可重复）。临时目录的布局刻意模拟
 * 仓库结构：`base/web-dist/` 是静态根（= `packages/web/dist`），`base/outside/` 是根之外的仓库内容
 * （= `challenges/`、`packages/`、`docs/`），两边都放哨兵值，任何响应里出现哨兵即视为泄露。
 */

const CHALLENGE_ID = testPublic().id;

/** 产物侧哨兵：断言「取到的确实是产物」。 */
const INDEX_MARKER = 'PWN2BLOCK-C04-INDEX';
const JS_MARKER = 'PWN2BLOCK-C04-APP-JS';
const CSS_MARKER = 'PWN2BLOCK-C04-STYLE-CSS';
const JSON_MARKER = 'PWN2BLOCK-C04-DATA-JSON';

/** 私密侧哨兵：只存在于静态根之外、点文件、黑名单文件或影子文件里，任何响应都不得出现。 */
const PRIVATE_MARKER = 'PWN2BLOCK-C04-PRIVATE-OUTSIDE';
const DOTENV_MARKER = 'PWN2BLOCK-C04-DOTENV-OUTSIDE';
const SOURCE_MARKER = 'PWN2BLOCK-C04-SOURCE-OUTSIDE';
const SOLUTION_MARKER = 'PWN2BLOCK-C04-SOLUTION-OUTSIDE';
const DOCS_MARKER = 'PWN2BLOCK-C04-DOCS-OUTSIDE';
const CHALLENGE_PRIVATE_MARKER = 'PWN2BLOCK-C04-CHALLENGE-PRIVATE';
const DIST_DOTENV_MARKER = 'PWN2BLOCK-C04-DOTENV-IN-DIST';
const DIST_PRIVATE_MARKER = 'PWN2BLOCK-C04-PRIVATE-IN-DIST';
const DIST_SOLUTION_MARKER = 'PWN2BLOCK-C04-SOLUTION-IN-DIST';
const SHADOW_MARKER = 'PWN2BLOCK-C04-API-SHADOW';
const LISTED_CHILD_MARKER = 'PWN2BLOCK-C04-LISTED-CHILD';
const LEAK_MARKER = 'PWN2BLOCK-C04-LEAK-OUTSIDE';

const SECRET_MARKERS: readonly string[] = [
  PRIVATE_MARKER,
  DOTENV_MARKER,
  SOURCE_MARKER,
  SOLUTION_MARKER,
  DOCS_MARKER,
  CHALLENGE_PRIVATE_MARKER,
  DIST_DOTENV_MARKER,
  DIST_PRIVATE_MARKER,
  DIST_SOLUTION_MARKER,
  SHADOW_MARKER,
  LISTED_CHILD_MARKER,
  LEAK_MARKER,
];

/** 目录列表会列出的子文件名：目录请求的响应里不得出现它们。 */
const LISTED_NAMES: readonly string[] = [
  'app.js',
  'style.css',
  'data.json',
  'nested.txt',
  'deep.txt',
];

let base = '';
let dist = '';
let outside = '';
let challengeDir = '';

/** 按「相对路径 → 内容」铺文件，父目录自动创建。 */
function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'pwn2block-c04-'));
  dist = join(base, 'web-dist');
  outside = join(base, 'outside');

  writeTree(dist, {
    'index.html': `<!doctype html><html lang="zh"><title>Pwn2Block</title><div id="app">${INDEX_MARKER}</div></html>`,
    'assets/app.js': `export const marker = '${JS_MARKER}';\n`,
    'assets/style.css': `body::after { content: '${CSS_MARKER}'; }\n`,
    'assets/data.json': `{"marker":"${JSON_MARKER}"}\n`,
    // 子目录里的文件：用来证明目录请求不回文件清单。
    'assets/nested.txt': `${LISTED_CHILD_MARKER}\n`,
    'sub/deep.txt': `${LISTED_CHILD_MARKER}\n`,
    // 产物目录里**故意**放影子文件：`/api/**` 必须仍然命中 API，而不是这些文件。
    'api/health': `${SHADOW_MARKER}\n`,
    'api/nope': `${SHADOW_MARKER}\n`,
    // 同一路径既是目录（`/api/challenges` 可用其 index.html 顶替）又含同名文件（`/api/challenges/:id`）。
    'api/challenges/index.html': `<!doctype html><div>${SHADOW_MARKER}</div>\n`,
    [`api/challenges/${CHALLENGE_ID}`]: `${SHADOW_MARKER}\n`,
    'api/sessions/index.html': `<!doctype html><div>${SHADOW_MARKER}</div>\n`,
    // 即使被误拷进产物目录：点文件按不存在处理，黑名单文件名由 `allowedPath` 挡掉。
    '.env': `PWN2BLOCK_C04_DOTENV=${DIST_DOTENV_MARKER}\n`,
    'private.json': `{"flag":"${DIST_PRIVATE_MARKER}"}\n`,
    'solution.md': `# ${DIST_SOLUTION_MARKER}\n`,
  });

  writeTree(outside, {
    'private.json': `{"flag":"${PRIVATE_MARKER}"}\n`,
    '.env': `PWN2BLOCK_C04_DOTENV=${DOTENV_MARKER}\n`,
    'solution.md': `# ${SOLUTION_MARKER}\n`,
    'leak.txt': `${LEAK_MARKER}\n`,
    'packages/server/src/app.ts': `export const leak = '${SOURCE_MARKER}';\n`,
    'docs/01-产品与范围.md': `# ${DOCS_MARKER}\n`,
    [`challenges/${CHALLENGE_ID}/private.json`]: `{"flag":"${CHALLENGE_PRIVATE_MARKER}"}\n`,
  });

  challengeDir = makeChallengeDir();
  writeChallenge(challengeDir, CHALLENGE_ID, testPublic(), testPrivate());
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(challengeDir, { recursive: true, force: true });
});

function optionsWith(overrides: Partial<BuildAppOptions> = {}): BuildAppOptions {
  return { challengeDir, env: TEST_ENV, staticRoot: dist, ...overrides };
}

async function withApp(
  options: BuildAppOptions,
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = buildApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

/** 任何响应正文都不该出现的私密内容与内部细节（04 §6、01 §6）。 */
function expectNoSecret(response: LightMyRequestResponse): void {
  for (const marker of SECRET_MARKERS) expect(response.body).not.toContain(marker);
  expect(response.body).not.toContain('at Object.');
  expect(response.body).not.toContain('node_modules');
  expect(response.body).not.toContain('<html');
}

/** 断言「这个路径既不给内容，也不是 200」：统一 404 + ApiError 形状。 */
function expectBlocked(response: LightMyRequestResponse): void {
  expectApiError(response, 'not_found');
  expectNoSecret(response);
}

describe('静态产物可达（07 §7）', () => {
  it('`/` 与 `/index.html` 由 index 命中，返回真实 HTML 产物', async () => {
    await withApp(optionsWith(), async (app) => {
      for (const url of ['/', '/index.html']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain(INDEX_MARKER);
      }
    });
  });

  it('打包出来的 JS / CSS / JSON 按真实 content-type 返回', async () => {
    await withApp(optionsWith(), async (app) => {
      const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toMatch(/javascript|ecmascript/);
      expect(script.body).toContain(JS_MARKER);

      const style = await app.inject({ method: 'GET', url: '/assets/style.css' });
      expect(style.statusCode).toBe(200);
      expect(style.headers['content-type']).toContain('text/css');
      expect(style.body).toContain(CSS_MARKER);

      const data = await app.inject({ method: 'GET', url: '/assets/data.json' });
      expect(data.statusCode).toBe(200);
      expect(data.headers['content-type']).toContain('application/json');
      expect(data.body).toContain(JSON_MARKER);
    });
  });

  it('带查询串的产物请求照样可达（页面缓存击穿用的 `?v=` 不影响路径解析）', async () => {
    await withApp(optionsWith(), async (app) => {
      const response = await app.inject({ method: 'GET', url: '/assets/app.js?v=20261015' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(JS_MARKER);

      const root = await app.inject({ method: 'GET', url: '/?from=test' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain(INDEX_MARKER);
    });
  });
});

describe('`/api/**` 优先于静态（04 §5）', () => {
  it('产物目录里存在同名 `api/**` 文件时，API 路由仍然优先', async () => {
    const fake = makeFakeRuntime();
    await withApp(optionsWith({ createRuntime: () => fake.runtime }), async (app) => {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });
      expectNoSecret(health);

      const list = await app.inject({ method: 'GET', url: '/api/challenges' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([{ id: CHALLENGE_ID, title: testPublic().title }]);
      expectNoSecret(list);

      const detail = await app.inject({ method: 'GET', url: `/api/challenges/${CHALLENGE_ID}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(testPublic());
      expectNoSecret(detail);

      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { challengeId: CHALLENGE_ID },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().sessionId).toMatch(/^[0-9a-f]{32}$/);
      expectNoSecret(created);
    });
  });

  it('未匹配的 `/api/**` 是 ApiError 404，不回静态文件、也不回 HTML', async () => {
    await withApp(optionsWith(), async (app) => {
      const probes: readonly { method: 'GET' | 'POST'; url: string }[] = [
        { method: 'GET', url: '/api/nope' },
        { method: 'POST', url: '/api/nope' },
        { method: 'GET', url: '/api' },
        { method: 'GET', url: `/api/sessions/${'f'.repeat(32)}/nope` },
      ];

      for (const probe of probes) {
        // 客户端声明要 HTML 也不改变结论：这个前端没有客户端路由，不存在回退。
        const response = await app.inject({ ...probe, headers: { accept: 'text/html' } });
        expectBlocked(response);
      }
    });
  });
});

describe('发布边界：静态根之外与敏感路径（08 §5 S06）', () => {
  it('`private.json`、`.env`、`solution.md` 即使出现在静态根里也取不到', async () => {
    await withApp(optionsWith(), async (app) => {
      for (const url of [
        '/private.json',
        '/.env',
        '/solution.md',
        '/assets/../private.json',
        '/%70rivate.json',
      ]) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }
    });
  });

  it('仓库目录（`packages/**`、`docs/**`、`challenges/**`）全部 404', async () => {
    await withApp(optionsWith(), async (app) => {
      for (const url of [
        '/packages/server/src/app.ts',
        '/packages/web/package.json',
        '/docs/01-产品与范围.md',
        '/docs/README.md',
        `/challenges/${CHALLENGE_ID}/private.json`,
        '/.env.example',
      ]) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }
    });
  });

  it('穿越与编码变体（`../`、`..%2f`、`%2e%2e%2f`、大写、反斜杠、双斜杠）都跨不出静态根', async () => {
    await withApp(optionsWith(), async (app) => {
      const probes = [
        '/../outside/private.json',
        '/../outside/leak.txt',
        '/../outside/.env',
        '/..%2foutside/private.json',
        '/%2e%2e%2foutside%2fprivate.json',
        '/%2E%2E%2Foutside%2Fprivate.json',
        '/%2e%2e/%2e%2e/outside/private.json',
        '/assets/../../outside/private.json',
        '/assets/%2e%2e/%2e%2e/outside/.env',
        '//outside/private.json',
        '/./outside/private.json',
        String.raw`/..\outside\private.json`,
        String.raw`/%2e%2e%5coutside%5cprivate.json`,
      ];

      for (const url of probes) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }
    });
  });

  it('绝对路径探测拿不到静态根外的文件', async () => {
    await withApp(optionsWith(), async (app) => {
      const absoluteOutside = '/' + join(outside, 'private.json').replace(/\\/gu, '/');
      for (const url of ['/etc/passwd', '/C:/Windows/win.ini', absoluteOutside]) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }
    });
  });

  it('目录请求不做浏览：不回文件清单，也不回 200', async () => {
    await withApp(optionsWith(), async (app) => {
      for (const url of ['/assets/', '/assets', '/sub/', '/sub', '/assets/app.js/']) {
        const response = await app.inject({ method: 'GET', url });
        expectBlocked(response);
        for (const name of LISTED_NAMES) expect(response.body).not.toContain(name);
      }
    });
  });

  it('正对照：同一个哨兵文件落在静态根内时确实可取到（证明上面的 404 是边界挡住，不是文件读不到）', async () => {
    // 故意把静态根指向 `base`（也就是 `outside/` 的父目录）：`/outside/leak.txt` 这时是可服务的。
    // 没有这条，`/outside/...` 的 404 可能只是「文件不存在」的假阳性。
    await withApp(optionsWith({ staticRoot: base }), async (app) => {
      const reachable = await app.inject({ method: 'GET', url: '/outside/leak.txt' });
      expect(reachable.statusCode).toBe(200);
      expect(reachable.body).toContain(LEAK_MARKER);

      // 同一次运行里，黑名单与点文件仍然取不到——它们是独立于静态根的一层。
      expectBlocked(await app.inject({ method: 'GET', url: '/outside/private.json' }));
      expectBlocked(await app.inject({ method: 'GET', url: '/outside/.env' }));
      expectBlocked(await app.inject({ method: 'GET', url: '/outside/solution.md' }));
    });
  });
});

describe('静态根不可用与开关（C04）', () => {
  it('静态根不存在时不崩：静态路径 404，`/api/**` 照常（D5 之前 dist 可能还没构建）', async () => {
    const fake = makeFakeRuntime();
    const missing = join(base, '还没构建的产物目录');
    await withApp(
      optionsWith({ staticRoot: missing, createRuntime: () => fake.runtime }),
      async (app) => {
        for (const url of ['/', '/index.html', '/assets/app.js']) {
          expectBlocked(await app.inject({ method: 'GET', url }));
        }

        const health = await app.inject({ method: 'GET', url: '/api/health' });
        expect(health.statusCode).toBe(200);
        expect(health.json()).toEqual({ ok: true });

        const list = await app.inject({ method: 'GET', url: '/api/challenges' });
        expect(list.statusCode).toBe(200);
        expect(list.json()).toHaveLength(1);

        const created = await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: CHALLENGE_ID },
        });
        expect(created.statusCode).toBe(200);
      },
    );
  });

  it('静态根指向一个文件（部署配错）时不注册静态托管，也不把服务带崩', async () => {
    await withApp(optionsWith({ staticRoot: join(outside, 'private.json') }), async (app) => {
      expectBlocked(await app.inject({ method: 'GET', url: '/' }));
      expectBlocked(await app.inject({ method: 'GET', url: '/private.json' }));

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    });
  });

  it('`serveStatic: false` 时只有 API 面', async () => {
    await withApp(optionsWith({ serveStatic: false }), async (app) => {
      expectBlocked(await app.inject({ method: 'GET', url: '/' }));
      expectBlocked(await app.inject({ method: 'GET', url: '/assets/app.js' }));

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    });
  });

  it('默认静态根就是仓库的 `packages/web/dist`，不是仓库根（不传 `staticRoot` 时）', async () => {
    // 静态根的默认值是「发布边界」的一半：默认值一旦变成仓库根，整条 S06 立刻失效。
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    expect(defaultStaticRoot().replace(/\\/gu, '/').endsWith('/packages/web/dist')).toBe(true);

    // 行为证据：下面这些文件确实在仓库根，但不在静态根里，所以取不到。
    // 若默认根被改成仓库根（最危险的回归），前两条会立刻变成 200。
    for (const relative of ['CLAUDE.md', 'package.json', 'docs/README.md']) {
      expect(existsSync(join(repoRoot, relative))).toBe(true);
    }

    await withApp(optionsWith({ staticRoot: undefined }), async (app) => {
      for (const url of [
        '/CLAUDE.md',
        '/package.json',
        '/docs/README.md',
        `/challenges/${CHALLENGE_ID}/private.json`,
      ]) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }

      // 静态面被挡住不影响 API 面。
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    });
  });

  it('发布黑名单按最后一段判定，大小写不敏感且不误伤正常产物', () => {
    expect(isDeniedStaticPath('/private.json')).toBe(true);
    expect(isDeniedStaticPath('/challenges/ret2win/Private.JSON')).toBe(true);
    expect(isDeniedStaticPath('/solution.md')).toBe(true);
    expect(isDeniedStaticPath('/assets/private.json.js')).toBe(false);
    expect(isDeniedStaticPath('/assets/app.js')).toBe(false);
    expect(isDeniedStaticPath('/')).toBe(false);
  });
});

describe('限流口径不变（04 §6）', () => {
  it('静态请求与 `/api/health` 不占 API 配额', async () => {
    await withApp(
      optionsWith({ rateLimit: { request: { limit: 1, windowMs: 60_000 } } }),
      async (app) => {
        for (const url of ['/', '/index.html', '/assets/app.js', '/assets/data.json']) {
          const staticResponse = await app.inject({ method: 'GET', url });
          expect(staticResponse.statusCode).toBe(200);
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const health = await app.inject({ method: 'GET', url: '/api/health' });
          expect(health.statusCode).toBe(200);
        }

        const first = await app.inject({ method: 'GET', url: '/api/challenges' });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({ method: 'GET', url: '/api/challenges' });
        expectApiError(second, 'rate_limited');
        expect(second.headers['retry-after']).toBeDefined();
      },
    );
  });
});

/**
 * 真实构建产物用例：`packages/web/dist` 被 gitignore，只有跑过 `pnpm build` 才存在。
 * 缺席时整组跳过，不把「没构建」当成失败，也不让 CI 依赖本地产物。
 */
const realDist = defaultStaticRoot();
const realAssets = join(realDist, 'assets');
const realEntry = existsSync(realAssets)
  ? readdirSync(realAssets).find((name) => name.endsWith('.js'))
  : undefined;

describe.skipIf(realEntry === undefined)('真实构建产物（`pnpm build` 之后）', () => {
  it('真实 `/` 与打包出来的 JS 都能取到（确认托管对真产物也成立）', async () => {
    await withApp(optionsWith({ staticRoot: undefined }), async (app) => {
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.body).toContain('<html');

      const script = await app.inject({ method: 'GET', url: `/assets/${realEntry ?? ''}` });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toMatch(/javascript|ecmascript/);
    });
  });

  it('真实产物 + 真实仓库路径：私密文件与穿越变体仍然全部 404', async () => {
    await withApp(optionsWith({ staticRoot: undefined }), async (app) => {
      for (const url of [
        '/private.json',
        '/.env',
        '/.env.example',
        '/solution.md',
        '/packages/server/src/app.ts',
        '/challenges/ret2win/private.json',
        '/docs/01-产品与范围.md',
        '/../challenges/ret2win/private.json',
        '/%2e%2e%2fchallenges%2fret2win%2fprivate.json',
        '/assets/../../challenges/ret2win/private.json',
      ]) {
        expectBlocked(await app.inject({ method: 'GET', url }));
      }
    });
  });
});
