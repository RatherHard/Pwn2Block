import { describe, expect, it } from 'vitest';
import { ApiClientError, createApiClient, isSessionExpired, type FetchLike } from '../src/api';
import { SAMPLE_PROJECTION_START } from '../src/fixtures/sample';

const SESSION_ID = 'a'.repeat(32);
const HISTORY = { undo: 1, stepBack: 2 };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl };
}

async function captureError(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiClientError) return error;
    throw error;
  }
  throw new Error('期望抛出 ApiClientError，但请求成功了');
}

describe('API 客户端（04 §5、05 §6）', () => {
  it('题目列表：响应过 Schema 校验', async () => {
    const { calls, fetchImpl } = stubFetch(() => json([{ id: 'ret2win', title: '回到胜利' }]));
    const client = createApiClient({ fetchImpl });
    const challenges = await client.listChallenges();
    expect(challenges).toEqual([{ id: 'ret2win', title: '回到胜利' }]);
    expect(calls[0]?.url).toBe('/api/challenges');
    expect(calls[0]?.method).toBe('GET');
  });

  it('baseUrl 拼接时去掉多余斜杠', async () => {
    const { calls, fetchImpl } = stubFetch(() => json([]));
    await createApiClient({ baseUrl: 'http://127.0.0.1:8787/', fetchImpl }).listChallenges();
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/api/challenges');
  });

  it('创建会话：请求体走 strictObject，响应含投影与回退深度', async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      json({ sessionId: SESSION_ID, projection: SAMPLE_PROJECTION_START, history: HISTORY }, 201),
    );
    const client = createApiClient({ fetchImpl });
    const session = await client.createSession('ret2win');
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.projection.status).toBe('ready');
    expect(session.history).toEqual(HISTORY);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ challengeId: 'ret2win' });
  });

  it('请求先自检：空动作数组不上网', async () => {
    const { calls, fetchImpl } = stubFetch(() => json({}));
    const client = createApiClient({ fetchImpl });
    const error = await captureError(client.actions(SESSION_ID, []));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('动作请求不合法');
    expect(calls).toHaveLength(0);
  });

  it('动作请求：返回结果、投影与回退深度', async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      json({
        results: [{ ok: true, action: 'step' }],
        executed: 1,
        projection: SAMPLE_PROJECTION_START,
        history: { undo: 0, stepBack: 4 },
      }),
    );
    const client = createApiClient({ fetchImpl });
    const response = await client.actions(SESSION_ID, [{ type: 'step', count: 2 }]);
    expect(response.executed).toBe(1);
    expect(response.history.stepBack).toBe(4);
    expect(calls[0]?.url).toBe(`/api/sessions/${SESSION_ID}/actions`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ actions: [{ type: 'step', count: 2 }] });
  });

  it('会话接口 404 视为会话失效，并给出可识别的标志', async () => {
    const { fetchImpl } = stubFetch(() => json({ code: 'session_expired', message: '会话不存在' }, 404));
    const client = createApiClient({ fetchImpl });
    const error = await captureError(client.sessionState(SESSION_ID));
    expect(error.code).toBe('session_expired');
    expect(error.sessionExpired).toBe(true);
    expect(isSessionExpired(error)).toBe(true);
    expect(error.message).toContain('会话已失效');
    expect(isSessionExpired(new Error('别的错'))).toBe(false);
  });

  it('非会话接口的 404 按 not_found 处理', async () => {
    const { fetchImpl } = stubFetch(() => json({ code: 'not_found', message: '题目不存在' }, 404));
    const error = await captureError(createApiClient({ fetchImpl }).getChallenge('ret2win'));
    expect(error.code).toBe('not_found');
    expect(error.sessionExpired).toBe(false);
  });

  it('服务端错误码原样带出（含限流）', async () => {
    const { fetchImpl } = stubFetch(() => json({ code: 'rate_limited', message: '提交过于频繁' }, 429));
    const error = await captureError(createApiClient({ fetchImpl }).submit(SESSION_ID, [{ type: 'run' }]));
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.message).toBe('提交过于频繁');
    // 会话容量型 429 不带 Retry-After（04 §6）：没有秒数就不编造。
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('时间窗口型 429 的 Retry-After 解析成秒数，日期形态与非法值一律不猜', async () => {
    const withHeader = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'rate_limited', message: '请求过于频繁' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        }),
    );
    const timed = await captureError(createApiClient({ fetchImpl: withHeader.fetchImpl }).listChallenges());
    expect(timed.code).toBe('rate_limited');
    expect(timed.retryAfterSeconds).toBe(7);

    const dateForm = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'rate_limited', message: '请求过于频繁' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        }),
    );
    expect(
      (await captureError(createApiClient({ fetchImpl: dateForm.fetchImpl }).listChallenges())).retryAfterSeconds,
    ).toBeUndefined();

    const zero = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'rate_limited', message: '请求过于频繁' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        }),
    );
    expect(
      (await captureError(createApiClient({ fetchImpl: zero.fetchImpl }).listChallenges())).retryAfterSeconds,
    ).toBeUndefined();
  });

  it('错误响应不是 JSON 时给出兜底文案，不泄露细节', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>500</html>', { status: 500 }));
    const error = await captureError(createApiClient({ fetchImpl }).listChallenges());
    expect(error.code).toBe('internal');
    expect(error.message).toBe('请求失败（HTTP 500）');
  });

  it('响应不符合契约时当场报错，不让脏数据进视图', async () => {
    const missing = { sessionId: SESSION_ID, history: HISTORY };
    const error = await captureError(
      createApiClient({ fetchImpl: stubFetch(() => json(missing)).fetchImpl }).createSession('ret2win'),
    );
    expect(error.code).toBe('internal');
    expect(error.message).toContain('响应不符合契约');

    const notJson = await captureError(
      createApiClient({ fetchImpl: stubFetch(() => new Response('不是 JSON', { status: 200 })).fetchImpl }).listChallenges(),
    );
    expect(notJson.message).toContain('不是合法 JSON');
  });

  it('提交判题：verdict 与 flag 走 Schema', async () => {
    const { fetchImpl } = stubFetch(() =>
      json({
        verdict: 'won',
        executed: 2,
        results: [{ ok: true, action: 'step' }],
        replay: { initial: SAMPLE_PROJECTION_START, frames: [] },
        flag: 'flag{local-test-sentinel}',
      }),
    );
    const response = await createApiClient({ fetchImpl }).submit(SESSION_ID, [{ type: 'run' }]);
    expect(response.verdict).toBe('won');
    expect(response.flag).toBe('flag{local-test-sentinel}');
  });

  it('网络失败包装成 network 错误', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const error = await captureError(createApiClient({ fetchImpl }).listChallenges());
    expect(error.network).toBe(true);
    expect(error.message).toContain('无法连接服务器');
  });

  it('结束会话接受 204 空响应', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
    await createApiClient({ fetchImpl }).endSession(SESSION_ID);
    expect(calls[0]?.method).toBe('DELETE');
  });
});
