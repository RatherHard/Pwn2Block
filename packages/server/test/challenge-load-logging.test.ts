import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asciiToBytes, bytesToHex } from '@pwn2block/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import {
  HIDDEN_KEY_HEX, TEST_ENV, TEST_FLAG_VALUE, makeChallengeDir,
  testPrivate, testPublic, writeChallenge,
} from './support';

const PRIVATE_MARKER = 'private-value-DO-NOT-LOG';
const PRIVATE_PATH = 'C:\\private\\flag.txt';
const WARNING = '题目加载失败，已停用；请运行 pnpm challenge:check --all 排查';
let root: string;
let app: FastifyInstance | undefined;
let output: string;

beforeEach(() => {
  root = makeChallengeDir();
  output = '';
  writeChallenge(root, 'ret2win', testPublic(), testPrivate());
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(root, { recursive: true, force: true });
});

function start(options: BuildAppOptions = {}): FastifyInstance {
  app = buildApp({
    challengeDir: root, env: TEST_ENV, serveStatic: false,
    ...options,
    // 真实 Fastify/Pino 序列化输出，不 mock log.warn，也不只检查回调是否被调用。
    logger: { level: 'warn', stream: { write: (chunk: string) => { output += chunk; } } },
  });
  return app;
}

function logs(): Record<string, unknown>[] {
  return output.trim() === '' ? [] : output.trim().split('\n').map((line) => JSON.parse(line));
}

function expectWarning(reason: string, challengeId: string | null = 'ret2win'): void {
  expect(logs()).toEqual([{
    level: 40, time: expect.any(Number), pid: process.pid, hostname: expect.any(String),
    event: 'challenge_load_failed', challengeId, reason, msg: WARNING,
  }]);
  // 同时检查整条实际输出，覆盖顶层字段、msg 和默认序列化器可能加入的内容。
  for (const secret of [
    TEST_FLAG_VALUE, HIDDEN_KEY_HEX, PRIVATE_MARKER, PRIVATE_PATH,
    root, JSON.stringify(root).slice(1, -1), 'private.json', 'public.json',
    'initRegisters', 'vmas', '"win"', '"files"', '"err"', '"stack"',
  ]) expect(output).not.toContain(secret);
}

async function expectUnavailable(server: FastifyInstance, id = 'ret2win'): Promise<void> {
  for (const request of [
    { method: 'GET' as const, url: `/api/challenges/${id}` },
    { method: 'POST' as const, url: '/api/sessions', payload: { challengeId: id } },
  ]) {
    const response = await server.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'challenge_unavailable', message: '题目未通过加载校验，暂时不可用',
    });
  }
}

describe('D6 题目加载告警（真实日志流）', () => {
  it('有效加载没有 warn，列表、详情、真实引擎建会话均正常', async () => {
    const server = start();
    expect((await server.inject('/api/challenges')).json()).toEqual([
      { id: 'ret2win', title: testPublic().title },
    ]);
    expect((await server.inject('/api/challenges/ret2win')).json()).toEqual(testPublic());
    expect((await server.inject({
      method: 'POST', url: '/api/sessions', payload: { challengeId: 'ret2win' },
    })).statusCode).toBe(200);
    expect(logs()).toEqual([]);
  });

  it.each([undefined, ''])('缺失/空 flag=%s：启动一条 warn，后续请求不重复告警', async (flag) => {
    const server = start({ env: { FLAG_RET2WIN: flag } });
    // 在 ready / 首个请求前已收到真正序列化的启动告警。
    expectWarning('flag_missing');
    expect((await server.inject('/api/challenges')).json()).toEqual([]);
    await expectUnavailable(server);
    expect((await server.inject('/api/challenges/unknown')).statusCode).toBe(404);
    expectWarning('flag_missing');
  });

  it.each(['public', 'private'])('%s 文件缺失和非法 JSON 有不同原因码', async (kind) => {
    const file = join(root, 'ret2win', `${kind}.json`);
    rmSync(file);
    let server = start();
    expectWarning(`${kind}_read_failed`);
    await expectUnavailable(server);
    await server.close();
    writeFileSync(file, `{ "${TEST_FLAG_VALUE}": "${PRIVATE_PATH}"`, 'utf8');
    output = '';
    server = start();
    expectWarning(`${kind}_json_invalid`);
    await expectUnavailable(server);
  });

  it.each<[string, unknown, unknown]>([
    ['public_schema_invalid', { ...testPublic(), title: { [PRIVATE_MARKER]: PRIVATE_PATH } }, testPrivate()],
    ['private_schema_invalid', testPublic(), { ...testPrivate(), [TEST_FLAG_VALUE]: PRIVATE_MARKER }],
    ['preset_unavailable', { ...testPublic(), encoding: { preset: 'missing-preset' } }, testPrivate()],
    ['package_validation_failed', testPublic(), {
      ...testPrivate(), files: { [PRIVATE_MARKER]: { hex: bytesToHex(asciiToBytes(TEST_FLAG_VALUE)) } },
    }],
  ])('%s：固定原因码，原始值和 issue 路径不进入日志', async (reason, pub, priv) => {
    writeChallenge(root, 'ret2win', pub, priv);
    const server = start({ presetDir: join(root, 'missing-presets') });
    await expectUnavailable(server);
    expectWarning(reason);
  });

  it('目录名与声明 id 不同：只记录目录 id，一次告警，两个 id 都不可用', async () => {
    writeChallenge(root, 'ret2win', testPublic({ id: 'other-id' }), testPrivate());
    const server = start();
    await expectUnavailable(server);
    await expectUnavailable(server, 'other-id');
    expectWarning('id_mismatch');
  });

  it('非法目录名不能把私有字符串带进日志', async () => {
    writeChallenge(root, TEST_FLAG_VALUE, testPublic(), testPrivate());
    const server = start();
    await server.ready();
    expectWarning('id_mismatch', null);
  });

  it('失败不影响其他题加载，健康探针仍然可用', async () => {
    writeChallenge(root, 'broken', testPublic({ id: 'broken' }), testPrivate());
    writeFileSync(join(root, 'broken', 'private.json'), PRIVATE_MARKER);
    const server = start();
    expect((await server.inject('/api/challenges')).json()).toEqual([
      { id: 'ret2win', title: testPublic().title },
    ]);
    expect((await server.inject('/api/health')).statusCode).toBe(200);
    await expectUnavailable(server, 'broken');
    expectWarning('private_json_invalid', 'broken');
  });

  it('题目根目录不存在仍为空列表，不伪造某题加载失败', async () => {
    const server = start({ challengeDir: join(root, 'absent') });
    expect((await server.inject('/api/challenges')).json()).toEqual([]);
    expect(logs()).toEqual([]);
  });
});

describe('pseudocode.c：并入公开包下发', () => {
  const pseudocodePath = (): string => join(root, 'ret2win', 'pseudocode.c');

  it('文件存在时规范化后随详情下发（去 BOM、CRLF 转 LF、去末尾空白）', async () => {
    writeFileSync(pseudocodePath(), '\uFEFFvoid vuln() {\r\n  char buf[8];\r\n}\r\n\r\n', 'utf8');
    const server = start();
    expect((await server.inject('/api/challenges/ret2win')).json()).toEqual({
      ...testPublic(), pseudocode: 'void vuln() {\n  char buf[8];\n}',
    });
    expect(logs()).toEqual([]);
  });

  it.each([
    ['含 flag 真值', `puts("${TEST_FLAG_VALUE.toUpperCase()}");`],
    ['含 flag 占位符', 'char *flag = "env:FLAG_RET2WIN";'],
    ['只有空白', '  \n\n'],
  ])('%s：拒绝加载，内容不进日志', async (_name, text) => {
    writeFileSync(pseudocodePath(), text, 'utf8');
    const server = start();
    await expectUnavailable(server);
    expectWarning('package_validation_failed');
    expect(output).not.toContain(TEST_FLAG_VALUE.toUpperCase());
  });

  it('public.json 里直接写 pseudocode 字段：拒绝加载，伪代码只能来自文件', async () => {
    writeChallenge(root, 'ret2win', { ...testPublic(), pseudocode: 'int main();' }, testPrivate());
    const server = start();
    await expectUnavailable(server);
    expectWarning('package_validation_failed');
  });

  it('文件存在却读不了：固定原因码 pseudocode_read_failed', async () => {
    mkdirSync(pseudocodePath());
    const server = start();
    await expectUnavailable(server);
    expectWarning('pseudocode_read_failed');
  });
});
