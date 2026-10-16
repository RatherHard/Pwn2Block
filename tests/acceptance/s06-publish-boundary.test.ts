import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp, defaultStaticRoot } from '@pwn2block/server';
import { API_ERROR_STATUS, ApiErrorSchema, TEST_FLAG_SENTINEL } from '@pwn2block/shared';
import type { ApiErrorCode } from '@pwn2block/shared';

/**
 * S06 · 发布边界 — owner F（A/C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S06 · F，A/C 配合 发布边界：检查构建产物和实际静态 HTTP 路径，不能取得 private.json、solution.md、
 *     环境文件或注入的 flag 哨兵值。」
 *
 * 07 §5 依据：08 §5 明确说明 S06 是**补充静态发布检查**（不在 07 §5 的十三条之内），
 * 对应 01 §6 第 1、2 条与 04 §6「`private.json` 只在服务端读取，不放进静态资源目录」、07 §7 的部署约定。
 *
 * 历史（D1–D3）：D1 只有骨架，本组是 `describe.skip` 下的 8 条 `it.todo`；D2 / F01-a 如实记录过当时的
 * 阻塞原因——服务端**还没有静态托管**（`packages/server/src/app.ts` 里 `static` / `dist` / `sendFile`
 * 零命中），「实际静态 HTTP 路径」无从探测，只能用 API 面顶替。**该阻塞已解除**：C04 在 `fa4af07`
 * 落地了静态托管（`packages/server/src/static.ts` + `app.ts` 的 `staticRoot` / `serveStatic` 选项，
 * D4 定稿见 04 §6 与 09 §4），`6484997` 在服务端侧补强了静态用例，`ee845a1` 把 CI 顺序改成
 * **先 build 再 test**。所以本轮（D4 / F03，原排期 D5）把 8 条 `it.todo` 全部换成**真实断言**：
 * 对象是**真实构建产物**（`packages/web/dist`，由真实 `pnpm build` 生成）与**真实静态 HTTP 路径**
 * （真实 `buildApp` + `app.inject`）。
 *
 * 本轮口径（写死，不留松动）：
 * - 静态根一律用 `defaultStaticRoot()`（= 仓库根的 `packages/web/dist`），**不指向临时目录伪造产物**：
 *   这一组的对象就是真产物。第 6 条正面断言这件事，并用「把静态根临时指向仓库根」的消融对照证明
 *   404 不是「文件不存在」的假阳性。
 * - 第 3 条从 `/index.html` 的正文里**解析**实际的 `assets/*` 引用再逐条取回，产物改名或哈希变化
 *   都不会让用例假绿。
 * - 第 5 条双向扫描：`@pwn2block/shared` 的 `TEST_FLAG_SENTINEL` 与 `process.env` 里每个非空的
 *   `FLAG_*` 真值，都不得出现在产物正文里。
 * - 跑这组之前必须先 `pnpm build`。CI 的步骤顺序是「构建前端产物」在「单元与集成测试」之前
 *   （`.github/workflows/ci.yml`），所以 **CI 里本组必须真实执行**；本地若 `packages/web/dist/index.html`
 *   缺席，整组 `describe.runIf` 跳过——**本地跳过请先 `pnpm build`，跳过不算通过**。
 * - 只用本文件内的**局部** helper，不 import `./support`：同目录的另一位 F 正在改它，避免相互踩踏。
 */

/** `app.inject` 响应里本文件用到的字段（不 import `fastify` 的类型：根 tsconfig 看不到那个包）。 */
interface ProbeResponse {
  readonly statusCode: number;
  readonly body: string;
  // 带 payload 的 `inject` 走另一条重载，headers 可能是 `OutgoingHttpHeaders`（值允许 number）
  readonly headers: Record<string, string | string[] | number | undefined>;
  json(): unknown;
}

type ServerApp = ReturnType<typeof buildApp>;

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHALLENGE_DIR = join(REPO_ROOT, 'challenges');
const PRESET_DIR = join(REPO_ROOT, 'presets');

/** 真实静态根与真实入口产物；`dist` 是 gitignore 的构建输出，只有跑过 `pnpm build` 才存在。 */
const DIST_ROOT = defaultStaticRoot();
const DIST_INDEX = join(DIST_ROOT, 'index.html');
const HAS_DIST = existsSync(DIST_INDEX);

/**
 * 应用环境表固定为空：本组只验静态面，不读宿主 `process.env`，
 * 免得结果随开发者本机注入的 flag 变化（flag 相关的那条另走 `process.env` 的真实扫描）。
 */
const APP_ENV: Readonly<Record<string, string | undefined>> = {};

// ---------------------------------------------------------------------------
// 局部 helper
// ---------------------------------------------------------------------------

async function withRealApp(
  run: (app: ServerApp) => Promise<void>,
  options: { readonly staticRoot?: string } = {},
): Promise<void> {
  const app = buildApp({
    challengeDir: CHALLENGE_DIR,
    presetDir: PRESET_DIR,
    env: APP_ENV,
    staticRoot: options.staticRoot ?? DIST_ROOT,
  });
  try {
    await app.ready();
    await run(app);
  } finally {
    await app.close();
  }
}

function contentTypeOf(response: ProbeResponse): string {
  const value = response.headers['content-type'];
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? '' : String(value);
}

/**
 * 响应正文不得夹带内部信息（04 §6）：内部堆栈、源码路径、私有包文件名、仓库绝对路径。
 * `extra` 用来加本题特有的哨兵真值与私有包字段名。
 */
function expectNoInternalLeak(response: ProbeResponse, extra: readonly string[] = []): void {
  for (const needle of ['private.json', 'node_modules', 'at Object.', '.ts:', 'ZodError', REPO_ROOT]) {
    expect(response.body, `正文不该包含「${needle}」`).not.toContain(needle);
  }
  for (const needle of extra) {
    if (needle === '') continue;
    expect(response.body, `正文不该包含「${needle}」`).not.toContain(needle);
  }
  // 盘符路径的两种形态（`F:\...` / `F:/...`；`http://` 这种前面是字母的冒号不会被误判）
  expect(response.body).not.toContain(':\\');
  expect(response.body).not.toMatch(/(?:^|[^\w])[A-Za-z]:\//u);
  // `at fn (file:line:col)` 这类栈帧标记
  expect(response.body).not.toMatch(/at\s+\S+\s+\(/u);
}

/** 断言错误响应：HTTP 状态、`ApiErrorSchema` 形状、错误码、正文无内部信息（04 §6）。 */
function expectApiError(
  response: ProbeResponse,
  code: ApiErrorCode,
  extra: readonly string[] = [],
): void {
  expect(response.statusCode).toBe(API_ERROR_STATUS[code]);
  const parsed = ApiErrorSchema.safeParse(response.json());
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.code).toBe(code);
    // 错误对象只有 `code` 与 `message`：没有私有包字段，也没有 `path` / `detail` / `stack`。
    expect(Object.keys(parsed.data).sort()).toEqual(['code', 'message']);
  }
  expectNoInternalLeak(response, extra);
}

/** 断言「这个路径既不给内容，也不是 200」：统一 404 + `ApiError` 形状。 */
function expectBlocked(response: ProbeResponse, extra: readonly string[] = []): void {
  expectApiError(response, 'not_found', extra);
  expect(contentTypeOf(response)).not.toContain('text/html');
  expect(response.body).not.toContain('<html');
}

function messageOf(response: ProbeResponse): string {
  return ApiErrorSchema.parse(response.json()).message;
}

interface DistFile {
  /** 相对静态根的 POSIX 风格路径。 */
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 递归列出产物目录里的**全部**文件（按路径排序）。
 * 扫描范围就是磁盘上的全量文件，所以将来产物里出现 `.map` / `.css` / 额外 chunk，都会自动进入断言。
 */
function listDistFiles(root: string = DIST_ROOT): DistFile[] {
  const files: DistFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      files.push({
        relativePath: relative(root, absolute).split(sep).join('/'),
        content: readFileSync(absolute, 'utf8'),
      });
    }
  };
  walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** 从 `index.html` 正文里解析出真实的 `assets/*` 引用（JS 与 CSS 一视同仁）。 */
function parseIndexAssets(html: string): string[] {
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((match) => match[1]);
  return references.filter((reference) => reference.startsWith('/assets/'));
}

/** 产物里的一个相对路径 → 可注入的 URL。 */
function urlOf(relativePath: string): string {
  return `/${relativePath.replace(/\\/gu, '/')}`;
}

/** 仓库根的这些文件真实存在，才能说「取不到」是边界挡住而不是文件不存在。 */
const REPO_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'pnpm-lock.yaml',
  'vitest.config.ts',
  'CLAUDE.md',
  '.env.example',
  'presets/x86ish.json',
  'challenges/ret2win/public.json',
  'challenges/ret2win/private.json',
  'docs/README.md',
];

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/**
 * 本地 `packages/web/dist` 缺席时整组跳过（CI 先 build 再 test，所以 CI 里必然执行）。
 * 跳过是**如实记录**，不是通过：报告里必须贴有 `dist` 时的 executed / skipped 计数。
 */
describe.runIf(HAS_DIST)('S06 发布边界 · 真实构建产物与真实静态 HTTP（G3 · D4）', () => {
  it('构建产物目录里不存在 private.json / solution.md / .env* 等私密文件（A/F）', () => {
    const files = listDistFiles();
    // 空目录会让下面的循环假绿：先钉死「确实扫到了真产物」。
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.relativePath === 'index.html')).toBe(true);

    for (const file of files) {
      const name = basename(file.relativePath).toLowerCase();
      expect(name, file.relativePath).not.toBe('private.json');
      expect(name, file.relativePath).not.toBe('solution.md');
      expect(name.startsWith('.env'), file.relativePath).toBe(false);
    }

    // 正对照：黑名单里的文件名在仓库里**确实**存在，所以上面的断言不是「碰巧没有这种文件」。
    expect(existsSync(join(CHALLENGE_DIR, 'ret2win', 'private.json'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, '.env.example'))).toBe(true);
  });

  it('逐条探测静态路径：private.json、challenges/<id>/private.json、solution.md、.env、.env.example、packages/**、docs/** 全部 404（C/F）', async () => {
    const probes: readonly string[] = [
      '/private.json',
      '/solution.md',
      '/.env',
      '/.env.example',
      '/.env.local',
      '/challenges/ret2win/private.json',
      '/challenges/endian/private.json',
      '/challenges/ret2win/solution.md',
      '/packages/server/src/app.ts',
      '/packages/server/src/static.ts',
      '/packages/web/package.json',
      '/packages/web/vite.config.ts',
      '/docs/README.md',
      '/docs/01-基本架构.md',
      '/CLAUDE.md',
    ];

    // 探测目标必须真实存在，否则「404」可能只是文件不存在（假阳性）。
    for (const target of [
      'challenges/ret2win/private.json',
      'challenges/ret2win/solution.md',
      'challenges/endian/private.json',
      'packages/server/src/static.ts',
      'docs/01-基本架构.md',
      '.env.example',
      'CLAUDE.md',
    ]) {
      expect(existsSync(join(REPO_ROOT, target)), target).toBe(true);
    }

    await withRealApp(async (app) => {
      for (const url of probes) {
        expectBlocked(await app.inject({ method: 'GET', url }), [TEST_FLAG_SENTINEL, 'env:FLAG_']);
      }
    });
  });

  it('公开资源可达：/ 与 /index.html 及打包后的 JS/CSS 正常返回（确认探测不是全 404 的假阳性，C/F）', async () => {
    const html = readFileSync(DIST_INDEX, 'utf8');

    await withRealApp(async (app) => {
      // `/` 与 `/index.html` 都由静态根的 `index` 命中，正文逐字节等于磁盘上的产物。
      for (const url of ['/', '/index.html']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        expect(contentTypeOf(response), url).toContain('text/html');
        expect(response.body, url).toBe(html);
      }

      // 从**产物正文**里解析实际引用，再逐条取回：产物改名或哈希变化都不会让用例假绿。
      const assets = parseIndexAssets(html);
      expect(assets.length).toBeGreaterThan(0);
      expect(assets.some((asset) => asset.endsWith('.js'))).toBe(true);

      for (const asset of assets) {
        const response = await app.inject({ method: 'GET', url: asset });
        expect(response.statusCode, asset).toBe(200);
        expect(response.body, asset).toBe(readFileSync(join(DIST_ROOT, asset.slice(1)), 'utf8'));
        if (asset.endsWith('.css')) {
          expect(contentTypeOf(response), asset).toContain('text/css');
        } else {
          expect(contentTypeOf(response), asset).toMatch(/javascript|ecmascript/u);
        }
      }

      // 产物目录里的每个文件都可达（不止 index 引用的那几个）：将来出现额外 chunk / CSS 也一并覆盖。
      // 说明：本轮 `pnpm build` 只产出 `index.html` 与 `assets/index-*.js`——`packages/web` 里没有
      // 任何 `.css` 源（Lit 的样式内联在 JS 里），所以「打包后的 CSS」今天没有实测对象；
      // 一旦产物里出现 `.css`，上面的循环会按 `text/css` 取回它。
      for (const file of listDistFiles()) {
        if (file.relativePath === 'index.html') continue;
        const response = await app.inject({ method: 'GET', url: urlOf(file.relativePath) });
        expect(response.statusCode, file.relativePath).toBe(200);
      }
    });
  });

  it('目录穿越与编码变体（%2e%2e%2f、..%2f、双斜杠、大写、反斜杠）不能绕过静态根（C）', async () => {
    const probes: readonly string[] = [
      '/../challenges/ret2win/private.json',
      '/../CLAUDE.md',
      '/..%2fchallenges%2fret2win%2fprivate.json',
      '/%2e%2e%2fchallenges%2fret2win%2fprivate.json',
      '/%2E%2E%2Fchallenges%2Fret2win%2Fprivate.json',
      '/%2e%2e/%2e%2e/challenges/ret2win/private.json',
      '/assets/../../challenges/ret2win/private.json',
      '/assets/%2e%2e/%2e%2e/challenges/ret2win/private.json',
      '/assets/..%2f..%2fchallenges%2fret2win%2fprivate.json',
      '//challenges/ret2win/private.json',
      '/./challenges/ret2win/private.json',
      // 大写：Windows 的文件系统大小写不敏感，但静态根之外的路径照样跨不出去。
      '/CHALLENGES/ret2win/private.json',
      '/PACKAGES/server/src/app.ts',
      '/DOCS/README.md',
      String.raw`/..\challenges\ret2win\private.json`,
      String.raw`/%2e%2e%5cchallenges%5cret2win%5cprivate.json`,
      String.raw`/assets\..\..\challenges\ret2win\private.json`,
      '/etc/passwd',
      '/C:/Windows/win.ini',
    ];

    // 穿越的目标文件真实存在，且同一次运行里 `/index.html` 是 200（见上一条）——所以这些 404 是边界，
    // 不是「整站都 404」。
    expect(existsSync(join(CHALLENGE_DIR, 'ret2win', 'private.json'))).toBe(true);

    await withRealApp(async (app) => {
      for (const url of probes) {
        expectBlocked(await app.inject({ method: 'GET', url }), ['env:FLAG_', '"flag"', '"vmas"']);
      }
    });
  });

  it('构建产物（含 sourcemap 与打包后的 JS）里不出现注入的 flag 哨兵值（C/F）', () => {
    const files = listDistFiles();
    expect(files.length).toBeGreaterThan(0);

    // 正对照：扫描器确实读到了产物正文，否则「没扫到」可能只是「没读到文件」。
    const index = files.find((file) => file.relativePath === 'index.html');
    expect(index).toBeDefined();
    expect(index?.content).toContain('<html');
    expect(files.some((file) => file.content.includes('pwn2block-app'))).toBe(true);

    // 注入的哨兵真值：文档化的 `TEST_FLAG_SENTINEL` + 宿主 / CI 注入的每个非空 `FLAG_*` 值。
    // 说明：扫描的范围是产物目录的全部文件；本轮构建没有 `.map`（`vite.config.ts` 没开 `sourcemap`），
    // 一旦开启，`sourcesContent` 里的源码同样会落进这份断言。
    const injected = new Map<string, string>([['TEST_FLAG_SENTINEL', TEST_FLAG_SENTINEL]]);
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith('FLAG_')) continue;
      if (value === undefined || value === '') continue;
      injected.set(name, value);
    }
    expect(injected.size).toBeGreaterThan(0);

    for (const [name, value] of injected) {
      for (const file of files) {
        expect(file.content, `${file.relativePath} 不应含 ${name} 的注入值`).not.toContain(value);
      }
    }
  });

  it('静态托管根目录只包含 web 构建产物，服务端不以任何路径暴露仓库根（C/A）', async () => {
    // 默认静态根就是仓库根的 `packages/web/dist`，不是别的目录。
    expect(resolve(DIST_ROOT)).toBe(resolve(REPO_ROOT, 'packages', 'web', 'dist'));

    // 产物根只应出现 web 产物：仓库的目录 / 私密文件名一个都不许出现在这里。
    const topLevel = readdirSync(DIST_ROOT, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    expect(topLevel).toContain('index.html');
    const forbidden = [
      'challenges',
      'packages',
      'docs',
      'presets',
      'node_modules',
      '.git',
      'private.json',
      'solution.md',
      '.env',
      '.env.example',
    ];
    expect(topLevel.filter((name) => forbidden.includes(name))).toEqual([]);

    for (const target of REPO_FILES) {
      expect(existsSync(join(REPO_ROOT, target)), target).toBe(true);
    }

    await withRealApp(async (app) => {
      for (const target of REPO_FILES) {
        expectBlocked(await app.inject({ method: 'GET', url: `/${target}` }), [
          TEST_FLAG_SENTINEL,
          'env:FLAG_',
        ]);
      }
    });

    // 消融对照：把静态根**临时**指向仓库根时，同一个文件确实可取到。
    // 这条证明上面的 404 来自「静态根被限死在 `packages/web/dist`」，而不是文件不存在或静态没挂上。
    await withRealApp(
      async (app) => {
        const leaked = await app.inject({ method: 'GET', url: '/challenges/ret2win/public.json' });
        expect(leaked.statusCode).toBe(200);
        expect(leaked.body).toBe(readFileSync(join(REPO_ROOT, 'challenges/ret2win/public.json'), 'utf8'));
      },
      { staticRoot: REPO_ROOT },
    );
  });

  it('静态目录不做目录浏览，未知路径不返回仓库文件清单（C）', async () => {
    // 目录请求与未知路径：既不 200，也不回文件清单。
    const probes: readonly string[] = [
      '/assets/',
      '/assets',
      '/challenges/',
      '/challenges',
      '/docs/',
      '/packages/',
      '/presets/',
      '/node_modules/',
      '/.git/',
      '/no-such-dir/',
      '/assets/no-such-chunk.js',
    ];

    const distNames = listDistFiles().map((file) => basename(file.relativePath));
    const repoNames = ['CLAUDE.md', 'pnpm-lock.yaml', 'tsconfig.base.json', 'x86ish.json', 'ret2win'];

    await withRealApp(async (app) => {
      for (const url of probes) {
        const response = await app.inject({ method: 'GET', url });
        expectBlocked(response);
        // 产物自己的文件名（含 `index.html` 与打包后的 JS）都不许出现在响应里——那是目录列表的特征。
        for (const name of distNames) expect(response.body, `${url} 不该列出 ${name}`).not.toContain(name);
        for (const name of repoNames) expect(response.body, `${url} 不该列出 ${name}`).not.toContain(name);
      }

      // 反面对照：`/`（有 index）仍是 200，说明上面的 404 是「不做浏览」而不是「静态全挂」。
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);

      // 未知路径的文案固定，不回显请求路径（01 §6：不泄露服务端目录结构）。
      const unknown = await app.inject({ method: 'GET', url: '/no-such-dir/' });
      expect(messageOf(unknown)).toBe('资源不存在');
      expect(unknown.body).not.toContain('no-such-dir');
    });
  });

  it('错误响应不含内部堆栈、文件路径或私有包字段（04 §6，C）', async () => {
    // 私有包字段名（`challenge.ts` 的 `PrivateChallengeSchema`）与 flag 引用形态，任何错误正文都不得出现。
    const forbidden: readonly string[] = [
      TEST_FLAG_SENTINEL,
      'env:FLAG_',
      '"flag"',
      '"vmas"',
      '"files"',
      '"win"',
      '"fail"',
      'privatePkg',
    ];

    await withRealApp(async (app) => {
      // 静态未命中
      const staticMiss = await app.inject({ method: 'GET', url: '/assets/no-such-chunk.js' });
      expectApiError(staticMiss, 'not_found', forbidden);
      expect(messageOf(staticMiss)).toBe('资源不存在');

      // API 未命中（`/api` 面）
      const apiMiss = await app.inject({ method: 'GET', url: '/api/no-such-endpoint' });
      expectApiError(apiMiss, 'not_found', forbidden);
      expect(messageOf(apiMiss)).toBe('接口不存在');

      // 穿越被静态层拒绝（403）对外统一成 404，且不区分「不存在」与「被拒绝」
      const traversal = await app.inject({ method: 'GET', url: '/../CLAUDE.md' });
      expectApiError(traversal, 'not_found', forbidden);
      expect(messageOf(traversal)).toBe('资源不存在');

      // 请求体不是合法 JSON
      const badJson = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: '{ not json',
      });
      expectApiError(badJson, 'invalid_request', forbidden);
      expect(messageOf(badJson)).toBe('请求体不是合法 JSON');

      // 请求体类型不支持（`application/xml` 没有注册解析器；`text/plain` 有 Fastify 的内置解析器，
      // 会走 Schema 校验那条路，不在本条断言范围里）
      const badType = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/xml' },
        payload: '<session/>',
      });
      expectApiError(badType, 'invalid_request', forbidden);
      expect(messageOf(badType)).toBe('请求体必须是 application/json');

      // 校验失败（Schema 层）同样只回字段路径与原因，不含服务端信息
      const invalidBody = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expectApiError(invalidBody, 'invalid_request', forbidden);
    });
  });
});
