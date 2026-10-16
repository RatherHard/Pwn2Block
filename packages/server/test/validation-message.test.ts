import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, MAX_BODY_BYTES, TEST_FLAG_SENTINEL } from '@pwn2block/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import {
  HIDDEN_KEY_HEX,
  TEST_ENV,
  TEST_FLAG_VALUE,
  expectApiError,
  makeChallengeDir,
  makeFakeRuntime,
  testPrivate,
  testPublic,
  writeChallenge,
} from './support';

/**
 * 校验失败文案的中文收口（04 §6 的 D5–D6 项、08 §8「D4 / 日终」的风险与遗留）。
 *
 * D4 遗留的两条口径：
 * - `text/plain` 走 Fastify 内置解析器 → Schema 校验失败的 400，而不是 415。**这条保持**
 *   （415 只在真正没有解析器时生效，如 `application/xml`），用例第 6 条把它钉住。
 * - 校验失败文案带**校验器英文原文**（`Invalid input: …`）→ 本文件就是收口的回归。
 *
 * 断言口径（不用模糊正则）：
 * - `code` 恒为 `invalid_request`、HTTP 恒为 400（「错误码决定状态码」不破例，09 §8 第 2 条）；
 * - message 以「请求体不合法：」开头、含中文原因、可诊断到字段路径；
 * - 逐条列出**不允许出现**的校验器措辞（英文原文 / 正则源码 / 内部标识）；
 * - 把声明过的字段路径从文案里摘掉后，剩下的部分**不允许出现任何 ASCII 字母**——
 *   这是「文案全中文」的可判定形式，而不是「看起来像中文」。
 * - 拒绝文案不回显提交的**值**：`flag` 真值、隐藏内容哨兵、甚至客户端自定义的键名。
 */

const CHALLENGE_ID = testPublic().id;

/** 校验器与运行时的英文措辞：一条都不许出现在对外文案里。 */
const VALIDATOR_WORDING: readonly string[] = [
  'Invalid input',
  'Invalid option',
  'Invalid discriminator',
  'Invalid string',
  'Invalid enum',
  'Unrecognized key',
  'Too big',
  'Too small',
  'must match',
  'expected',
  'received',
  'ZodError',
  'FST_ERR',
  'node_modules',
  'at Object.',
  'packages/server',
  'dist/',
];

let app: FastifyInstance;
let challengeDir = '';
let sessionId = '';

beforeAll(async () => {
  challengeDir = makeChallengeDir();
  writeChallenge(challengeDir, CHALLENGE_ID, testPublic(), testPrivate());
  const fake = makeFakeRuntime();
  app = buildApp({ challengeDir, env: TEST_ENV, createRuntime: () => fake.runtime });
  await app.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: CHALLENGE_ID },
  });
  expect(created.statusCode).toBe(200);
  sessionId = (created.json() as { sessionId: string }).sessionId;
});

afterAll(async () => {
  await app.close();
  rmSync(challengeDir, { recursive: true, force: true });
});

function messageOf(response: LightMyRequestResponse): string {
  return ApiErrorSchema.parse(response.json()).message;
}

/** 摘掉字段路径后不该再有 ASCII 字母：`expected` / `received` 这类词就藏不住了。 */
function expectAllChinese(message: string, path?: string): void {
  const withoutPath = path === undefined ? message : message.replace(path, '');
  expect(withoutPath).not.toMatch(/[A-Za-z]/u);
}

/**
 * 一条校验失败响应的完整断言：状态码 + 错误码 + 中文形态 + 无校验器措辞 + 可选字段路径。
 * 返回文案本身，供调用方追加具体断言（例如「要出现『缺少必填字段』」）。
 */
function expectChineseInvalidRequest(
  response: LightMyRequestResponse,
  path?: string,
): string {
  expectApiError(response, 'invalid_request');
  expect(response.statusCode).toBe(400);

  const message = messageOf(response);
  expect(Object.keys(ApiErrorSchema.parse(response.json())).sort()).toEqual(['code', 'message']);
  expect(message.startsWith('请求体不合法：')).toBe(true);
  // 原因必须是中文（前缀之后的正文里至少有一个汉字）。
  expect(message.slice('请求体不合法：'.length)).toMatch(/[\u4e00-\u9fff]/u);
  for (const needle of VALIDATOR_WORDING) expect(message).not.toContain(needle);
  expectAllChinese(message, path);
  if (path !== undefined) expect(message).toContain(path);

  return message;
}

describe('交付物 1 · 校验失败文案中文化（04 §6）', () => {
  it('非法请求体（JSON 语法错）走固定的中文文案，不夹带解析器原文', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expectApiError(response, 'invalid_request');
    expect(response.statusCode).toBe(400);
    expect(messageOf(response)).toBe('请求体不是合法 JSON');
    for (const needle of ['FST_ERR', 'Unexpected token', 'SyntaxError', 'JSON.parse', 'position']) {
      expect(response.body).not.toContain(needle);
    }
  });

  it('空请求体与 `null` / 数组 / 数字：400 + 中文文案，说清是「为空」还是「结构不对」', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expectApiError(empty, 'invalid_request');
    expect(empty.statusCode).toBe(400);
    // 空 body 是解析期的 400，与「不是合法 JSON」不是同一回事。
    expect(messageOf(empty)).toBe('请求体不能为空');

    for (const payload of ['null', '[]', '5']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(expectChineseInvalidRequest(response)).toContain('类型不正确，应为对象');
    }
  });

  it('缺必填字段：报「缺少必填字段」并带字段路径（不是把类型错的措辞套上去）', async () => {
    const missingChallenge = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(expectChineseInvalidRequest(missingChallenge, 'challengeId')).toContain('缺少必填字段');

    const missingActions = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: {},
    });
    expect(expectChineseInvalidRequest(missingActions, 'actions')).toContain('缺少必填字段');

    // 嵌套缺失：`actions[0]` 存在但没有动作类型。
    const missingType = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{}] },
    });
    expect(expectChineseInvalidRequest(missingType, 'actions.0.type')).toContain('缺少必填字段');
  });

  it('类型错：字段路径 + 中文类型名，且不含校验器的 expected/received 措辞', async () => {
    const wrongType = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'step', count: '十' }] },
    });
    expect(expectChineseInvalidRequest(wrongType, 'actions.0.count')).toContain('类型不正确，应为数字');

    const wrongChallenge = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { challengeId: 5 },
    });
    expect(expectChineseInvalidRequest(wrongChallenge, 'challengeId')).toContain(
      '类型不正确，应为字符串',
    );

    const wrongActions = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: { type: 'step' } },
    });
    expect(expectChineseInvalidRequest(wrongActions, 'actions')).toContain('类型不正确，应为数组');
  });

  it('多余字段：strictObject 拒绝，但不回显多余字段的键名', async () => {
    const extraTop = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { challengeId: CHALLENGE_ID, flag: TEST_FLAG_SENTINEL, won: true, snapshot: {} },
    });
    expect(expectChineseInvalidRequest(extraTop)).toContain('包含不允许的字段');
    // 键名也是客户端提交的内容：既不回显键，也不回显值。
    for (const needle of ['flag', 'won', 'snapshot', TEST_FLAG_SENTINEL, 'Unrecognized']) {
      expect(extraTop.body).not.toContain(needle);
    }

    const extraAction = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'step', junk: 1 }] },
    });
    expect(expectChineseInvalidRequest(extraAction, 'actions.0')).toContain('包含不允许的字段');
    expect(extraAction.body).not.toContain('junk');

    const extraSubmit = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/submit`,
      payload: { actions: [{ type: 'step' }], verdict: 'won' },
    });
    expect(expectChineseInvalidRequest(extraSubmit)).toContain('包含不允许的字段');
    expect(extraSubmit.body).not.toContain('verdict');
  });

  it('请求体超上限：413 归一成 400 invalid_request，文案是中文且不带阈值数字', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'step' }], junk: 'x'.repeat(MAX_BODY_BYTES + 1024) },
    });

    expectApiError(response, 'invalid_request');
    expect(response.statusCode).toBe(400);
    expect(messageOf(response)).toBe('请求体超过大小上限');
    for (const needle of ['413', String(MAX_BODY_BYTES), 'FST_ERR_CTP_BODY_TOO_LARGE', 'payload']) {
      expect(response.body).not.toContain(needle);
    }
  });

  it('`text/plain` 仍是 Schema 校验失败的 400，不是 415（D4 口径保持）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(400);
    expect(expectChineseInvalidRequest(response)).toContain('类型不正确，应为对象');

    // 对照：真正没有解析器的类型才走 415 分支（`application/xml`）。
    const xml = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/xml' },
      payload: '<session/>',
    });
    expectApiError(xml, 'invalid_request');
    expect(messageOf(xml)).toBe('请求体必须是 application/json');
  });

  it('不合法的动作类型：discriminatedUnion 的失败也中文化，且不回显提交的 type 值', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: TEST_FLAG_SENTINEL }] },
    });

    expect(expectChineseInvalidRequest(response, 'actions.0.type')).toContain('不符合允许的结构');
    expect(response.body).not.toContain(TEST_FLAG_SENTINEL);
    expect(response.body).not.toContain('discriminator');
  });

  it('空动作数组与越界数值：中文上下限文案，且只报契约里的数字', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [] },
    });
    expect(expectChineseInvalidRequest(empty, 'actions')).toContain('数量低于下限');

    const tooBig = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/submit`,
      payload: { actions: Array.from({ length: 4097 }, () => ({ type: 'step' })) },
    });
    expect(expectChineseInvalidRequest(tooBig, 'actions')).toContain('数量超出上限');

    const lowCount = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/actions`,
      payload: { actions: [{ type: 'step', count: 0 }] },
    });
    expect(expectChineseInvalidRequest(lowCount, 'actions.0.count')).toContain('数值低于下限');
  });

  it('拒绝文案不回显任何提交值：flag 真值、隐藏内容、自定义键名都不出现', async () => {
    const secretLike = [
      TEST_FLAG_VALUE,
      TEST_FLAG_SENTINEL,
      HIDDEN_KEY_HEX,
      'pwn2block-probe-sentinel',
    ];

    const payloads: readonly Record<string, unknown>[] = [
      { challengeId: TEST_FLAG_SENTINEL },
      { challengeId: CHALLENGE_ID, flag: TEST_FLAG_VALUE },
      { challengeId: CHALLENGE_ID, [TEST_FLAG_SENTINEL]: 1 },
      { actions: [{ type: TEST_FLAG_SENTINEL }] },
      { actions: [{ type: 'step', count: TEST_FLAG_VALUE }] },
      { actions: [{ type: 'block', id: 'gets', args: { data: HIDDEN_KEY_HEX, junk: [] } }] },
      // 客户端自定义的键名会进校验器的 issue path：`validation.ts` 把非结构段折成 `?`。
      { actions: [{ type: 'block', id: 'gets', args: { [TEST_FLAG_SENTINEL]: [] } }] },
    ];

    for (const payload of payloads) {
      for (const url of [`/api/sessions/${sessionId}/actions`, `/api/sessions/${sessionId}/submit`]) {
        const response = await app.inject({ method: 'POST', url, payload });
        expectApiError(response, 'invalid_request');
        for (const needle of secretLike) expect(response.body).not.toContain(needle);
      }
    }
  });
});
