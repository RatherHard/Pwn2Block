import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../src/api';
import { createSessionController, type CanvasPort, type SessionController } from '../src/viewmodel/controller';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { readSession, writeSession, type KeyValueStore, type StoredSession } from '../src/viewmodel/storage';
import { MESSAGE_EXITED, MESSAGE_FAILED } from '../src/viewmodel/toolbar';
import {
  FAKE_SESSION_ID,
  createFakeApi,
  createFakeTracker,
  makeArtifact,
  makeReplay,
  makeSubmitResponse,
  repeatedActions,
  type FakeApi,
  type FakeApiOptions,
  type FakeTracker,
} from './fake-api';
import type { CompiledAction } from '../src/compiler/types';
import { makeProjection } from './helpers';

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`等待超时：${label}`);
}

async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

interface Harness {
  readonly api: FakeApi;
  readonly tracker: FakeTracker;
  readonly controller: SessionController;
}

function actionsCalls(api: FakeApi): readonly { readonly actions?: readonly unknown[] }[] {
  return api.calls.filter((call) => call.method === 'actions');
}

function methods(api: FakeApi): readonly string[] {
  return api.calls.map((call) => call.method);
}

async function open(options: FakeApiOptions = {}): Promise<Harness> {
  const api = createFakeApi(options);
  const tracker = createFakeTracker();
  const controller = createSessionController({ api: api.client, tracker: tracker.tracker });
  controller.start();
  await until(() => controller.state.phase === 'ready', '会话就绪');
  return { api, tracker, controller };
}

/** 让假追踪器产出指定动作，并让控制器发布这份快照（真实路径是 compile 一次）。 */
function compileInto(tracker: FakeTracker, controller: SessionController, actions: readonly CompiledAction[]): void {
  tracker.setArtifact(makeArtifact(actions));
  controller.compile({ blocks: [] });
}

describe('会话控制器：首屏与选题（04 §1、§5）', () => {
  it('只有一道题时直接开局：列表 → 题目 → 会话，投影进页面状态', async () => {
    const api = createFakeApi();
    const tracker = createFakeTracker();
    const controller = createSessionController({ api: api.client, tracker: tracker.tracker });

    controller.start();
    expect(controller.state.phase).toBe('loading');
    await until(() => controller.state.phase === 'ready', '会话就绪');

    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(controller.state.challenges).toHaveLength(1);
    expect(controller.state.challenge?.id).toBe('ret2win');
    expect(controller.state.sessionId).toBe(FAKE_SESSION_ID);
    expect(controller.state.page?.mode).toBe('debug');
    expect(controller.state.page?.projection.registers.length).toBeGreaterThan(0);
    expect(controller.state.cursor).toBe(0);
    expect(controller.state.notice).toBeUndefined();
    expect(controller.state.sessionExpired).toBe(false);
  });

  it('多道题先停在选题界面，选哪道就开哪道', async () => {
    const api = createFakeApi({
      challenges: [
        { id: 'a', title: '题目 A' },
        { id: 'b', title: '题目 B' },
      ],
    });
    const controller = createSessionController({ api: api.client, tracker: createFakeTracker().tracker });
    controller.start();
    await until(() => controller.state.phase === 'choosing', '进入选题');
    expect(methods(api)).toEqual(['listChallenges']);

    controller.choose('b');
    await until(() => controller.state.phase === 'ready', '会话就绪');
    expect(controller.state.challengeId).toBe('b');
    expect(api.calls.find((call) => call.method === 'createSession')?.challengeId).toBe('b');
  });

  it('列表为空时给出可重试的提示', async () => {
    const api = createFakeApi({ challenges: [] });
    const controller = createSessionController({ api: api.client, tracker: createFakeTracker().tracker });
    controller.start();
    await until(() => controller.state.phase === 'unavailable', '列表为空');
    expect(controller.state.notice?.action).toBe('retry');
    expect(controller.state.notice?.text).toContain('没有可用题目');
  });
});

describe('会话控制器：串行请求（04 §1）', () => {
  it('连点两次单步：同一时刻只有一个请求在飞，动作在开始时才算', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [
      { type: 'ret' },
      { type: 'push', value: '0x1' },
    ]);

    let release!: () => void;
    api.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    controller.run({ kind: 'step' });
    controller.run({ kind: 'step' });

    await until(() => controller.state.busy, '第一个请求在飞');
    expect(controller.state.queued).toBe(1);
    expect(actionsCalls(api)).toHaveLength(1);

    release();
    await until(() => actionsCalls(api).length === 2, '第二个请求发出');
    expect(actionsCalls(api)[0]?.actions).toEqual([{ type: 'ret' }]);
    // 关键：第二次点按提交的是**第二个**动作，不是第一个的副本。
    expect(actionsCalls(api)[1]?.actions).toEqual([{ type: 'push', value: '0x1' }]);
    await until(() => !controller.state.busy, '队列排空');
    expect(controller.state.cursor).toBe(2);
    expect(controller.state.queued).toBe(0);
  });
});

describe('会话控制器：门禁与产物过期（05 §3）', () => {
  it('积木改动后试运行与提交都被拒，重新编译后恢复', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);
    controller.noteEdit();
    expect(controller.state.artifact.stale).toBe(true);

    controller.run({ kind: 'trial-run' });
    controller.run({ kind: 'submit' });
    expect(controller.state.notice?.text).toBe(MESSAGE_STALE);
    await flush();
    expect(actionsCalls(api)).toHaveLength(0);
    expect(api.calls.some((call) => call.method === 'submit')).toBe(false);

    compileInto(tracker, controller, [{ type: 'ret' }]);
    expect(controller.state.artifact.stale).toBe(false);
    controller.run({ kind: 'submit' });
    await until(() => controller.state.verdict !== undefined, '提交完成');
    expect(controller.state.notice).toBeUndefined();
  });

  it('「运行 N 步」的非法步数只出提示，不发请求', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);
    controller.run({ kind: 'run-n', count: 0 });
    await flush();
    expect(actionsCalls(api)).toHaveLength(0);
    expect(controller.state.notice?.text).toContain('运行步数');

    controller.run({ kind: 'run-n', count: 5 });
    await until(() => actionsCalls(api).length === 1, '合法步数发出');
    expect(actionsCalls(api)[0]?.actions).toEqual([{ type: 'step', count: 5 }]);
  });
});

describe('会话控制器：门禁在任务真正开始时复查（D5 ①，G2 Phase 2 的连点竞态）', () => {
  /**
   * 复现：同一 tick 连点两次「单步」。第一次响应把实例推到 `failed`（判负是终止态，04 §1.1），
   * 第二次点按在**点击时**求值仍然放行（那一刻实例还是 ready），于是多发出一个请求——
   * 它会被服务端以 `not_executable` 拒绝，白记一次 `failures`。
   *
   * 门禁必须在**任务真正开始时**用同一张表复查：连点两次只发 1 个 actions 请求。
   */
  it('连点两次「单步」：第一次响应已判负，第二次不再发请求', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);

    let responses = 0;
    api.setActionsResponse((actions) => {
      responses += 1;
      return {
        results: actions.map((action) => ({ ok: true, action: action.type })),
        executed: actions.length,
        // 只有第一次响应把实例推到判负；第二次若还发得出去，用的就是这份新投影。
        projection:
          responses === 1
            ? makeProjection({
                status: 'failed',
                steps: 1,
                error: { code: 'invalid_ip', message: '指令指针落在未映射的地址' },
                lastStop: { reason: 'exception' },
              })
            : makeProjection(),
        history: { undo: 1, stepBack: 64 },
      };
    });

    controller.run({ kind: 'step' });
    controller.run({ kind: 'step' });
    // 两个任务一串行跑完为止（每个任务只跨几次微任务，60 次足够稳定）。
    await flush(60);

    // 关键断言：只发出 1 个请求（修复前是 2）。
    expect(actionsCalls(api)).toHaveLength(1);
    expect(actionsCalls(api)[0]?.actions).toEqual([{ type: 'ret' }]);
    // 第二次按序停在原地：游标没被推进，也没有白记失败。
    expect(controller.state.cursor).toBe(1);
    expect(controller.state.page?.projection.failures).toBe(0);
    // 与点击时一致的禁用原因（05 §6：必须写出原因，不能只置灰）。
    expect(controller.state.notice?.text).toBe(MESSAGE_FAILED);
  });

  it('合法排队不受影响：前一次响应仍是可执行状态时，第二次照发（不是把 busy 当门禁）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);
    controller.run({ kind: 'step' });
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 2, '两个请求按序生效');
    expect(actionsCalls(api)).toHaveLength(2);
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([
      [{ type: 'ret' }],
      [{ type: 'ret' }],
    ]);
    expect(controller.state.notice).toBeUndefined();
  });
});

describe('会话控制器：回退（04 §3、05 §6）', () => {
  it('单步压入快照，撤销恢复到上一步的位置', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }, { type: 'ret' }]);
    // 服务端报告的可用回退深度：撤销 / 后退一步的按钮门禁看它（05 §6）。
    api.setHistory({ undo: 3, stepBack: 8 });

    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1, '第一步');
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 2, '第二步');

    controller.run({ kind: 'undo' });
    await until(() => controller.state.cursor === 1, '撤销一次');
    controller.run({ kind: 'undo' });
    await until(() => controller.state.cursor === 0, '撤销两次');

    // 撤销到底后再撤销：快照栈空了，停在 0 而不是变成负数。
    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 5, '第三次撤销也发出');
    expect(controller.state.cursor).toBe(0);

    controller.run({ kind: 'reset' });
    await until(() => actionsCalls(api).length === 6, '重置');
    expect(controller.state.cursor).toBe(0);
    expect(actionsCalls(api)[5]?.actions).toEqual([{ type: 'reset' }]);
  });
});

describe('会话控制器：试运行与分块（04 §5、05 §3）', () => {
  it('试运行按 512 分块提交剩余动作，序列用完退化成 run', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));

    controller.run({ kind: 'trial-run' });
    await until(() => controller.state.cursor === 600, '两块跑完');
    const calls = actionsCalls(api);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.actions).toHaveLength(512);
    expect(calls[1]?.actions).toHaveLength(88);

    controller.run({ kind: 'trial-run' });
    await until(() => actionsCalls(api).length === 3, '退化成 run');
    expect(actionsCalls(api)[2]?.actions).toEqual([{ type: 'run' }]);
    expect(controller.state.cursor).toBe(600);
  });

  it('513 个动作跨两片（512 + 1）：单批上限就是 MAX_ACTIONS_PER_REQUEST', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(513));

    controller.run({ kind: 'trial-run' });
    await until(() => controller.state.cursor === 513, '两片跑完');
    const calls = actionsCalls(api);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.actions).toHaveLength(512);
    expect(calls[1]?.actions).toHaveLength(1);
    // 全程串行：第二片在第一片之后才发出（数组顺序就是发出顺序）。
    expect(calls[0]?.actions?.[0]).toEqual({ type: 'ret' });
  });

  it('某片被拒绝时不再发后续片（服务端的停止语义跨片保持）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    api.setActionsResponse((actions) => ({
      results: actions.map((action, index) =>
        index === 0 ? { ok: false, action: action.type, error: { code: 'invalid_ip', message: '第一条就越界了' } } : { ok: true, action: action.type },
      ),
      executed: 0,
      projection: makeProjection({ status: 'failed' }),
      history: { undo: 0, stepBack: 0 },
    }));

    controller.run({ kind: 'trial-run' });
    await until(() => actionsCalls(api).length === 1, '第一片发出');
    await until(() => !controller.state.busy, '第一片结束');
    expect(actionsCalls(api)).toHaveLength(1);
    expect(controller.state.results[0]?.ok).toBe(false);
  });

  it('某片实际生效数少于提交数时也停止（executed 口径）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    api.setActionsResponse((actions) => ({
      results: actions.map((action) => ({ ok: true, action: action.type })),
      executed: actions.length - 1,
      projection: makeProjection(),
      history: { undo: 0, stepBack: 0 },
    }));

    controller.run({ kind: 'trial-run' });
    await until(() => actionsCalls(api).length === 1, '第一片发出');
    await until(() => !controller.state.busy, '第一片结束');
    expect(actionsCalls(api)).toHaveLength(1);
    expect(controller.state.cursor).toBe(512);
  });

  it('序列没用完时只提交剩下的动作（不会重复执行已跑过的部分）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }, { type: 'ret' }]);

    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1, '先单步一次');
    controller.run({ kind: 'trial-run' });
    await until(() => controller.state.cursor === 3, '试运行剩余两个');
    expect(actionsCalls(api)[1]?.actions).toEqual([{ type: 'ret' }, { type: 'ret' }]);
  });
});

describe('会话控制器：终止态（failed / 已退出）（04 §1.1/§5、09 §8 第 10 条）', () => {
  /** 600 个动作 = 512 + 88：退出落在第一片末尾时，就是「退出恰好落在分片边界」。 */
  async function exitAtChunkBoundary(
    projection: ReturnType<typeof makeProjection>,
  ): Promise<Harness & { readonly firstChunkCalls: () => number }> {
    const harness = await open();
    compileInto(harness.tracker, harness.controller, repeatedActions(600));
    harness.api.setActionsResponse((actions) => ({
      // 该片每个动作都成功、executed 等于提交数：只看得见 status 的判据会认为还可以继续。
      results: actions.map((action) => ({ ok: true, action: action.type })),
      executed: actions.length,
      projection,
      history: { undo: 1, stepBack: 64 },
    }));
    harness.controller.run({ kind: 'trial-run' });
    await until(() => actionsCalls(harness.api).length === 1, '第一片发出');
    await until(() => !harness.controller.state.busy, '第一片结束');
    await flush();
    return { ...harness, firstChunkCalls: () => actionsCalls(harness.api).length };
  }

  it('退出落在 512 分片边界：不再发第二片，也不产生任何拒绝', async () => {
    const { api, controller, firstChunkCalls } = await exitAtChunkBoundary(
      // 判胜那一刻程序已经退出：status 仍是 satisfied，终止事实只在 lastStop 上。
      makeProjection({ status: 'satisfied', steps: 512, lastStop: { reason: 'exit', addr: '0x400003' } }),
    );

    expect(firstChunkCalls()).toBe(1);
    expect(actionsCalls(api)[0]?.actions).toHaveLength(512);
    expect(controller.state.cursor).toBe(512);
    // 没有多发片 ⇒ 没有 not_executable 的拒绝、failures 也没有被白记一次。
    expect(controller.state.results).toHaveLength(512);
    expect(controller.state.results.every((result) => result.ok)).toBe(true);
    expect(controller.state.page?.projection.failures).toBe(0);
  });

  it('status 为 exited（没有 lastStop）时停止行为不回归', async () => {
    const { api, controller, firstChunkCalls } = await exitAtChunkBoundary(
      makeProjection({ status: 'exited', steps: 512 }),
    );
    expect(firstChunkCalls()).toBe(1);
    expect(actionsCalls(api)).toHaveLength(1);
    expect(controller.state.cursor).toBe(512);
  });

  it('satisfied 但停因是 step（未退出）时继续发后续分片', async () => {
    const { controller } = await exitAtChunkBoundary(
      makeProjection({ status: 'satisfied', steps: 512, lastStop: { reason: 'step', addr: '0x400002' } }),
    );
    // satisfied 本身不限制动作（04 §1.1）：第二片照发，游标走完 600。
    await until(() => controller.state.cursor === 600, '两片跑完');
    expect(controller.state.cursor).toBe(600);
  });

  it('已退出后执行类命令被门禁拦住，回退类与「提交判题」仍放行（05 §6）', async () => {
    const { api, controller } = await exitAtChunkBoundary(
      makeProjection({ status: 'satisfied', steps: 512, lastStop: { reason: 'exit' } }),
    );

    controller.run({ kind: 'step' });
    controller.run({ kind: 'run-n', count: 3 });
    await flush();
    expect(controller.state.notice?.text).toBe(MESSAGE_EXITED);
    expect(actionsCalls(api)).toHaveLength(1);

    // 回退类不受影响：reset 照发。
    controller.run({ kind: 'reset' });
    await until(() => actionsCalls(api).length === 2, '重置发出');
    expect(actionsCalls(api)[1]?.actions).toEqual([{ type: 'reset' }]);

    // 「提交判题」不受影响：提交走判题实例，与调试实例是否退出无关。
    controller.run({ kind: 'submit' });
    await until(() => controller.state.verdict !== undefined, '提交完成');
    expect(api.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
  });

  it('判负（status=failed）同样是终止态：分片不再多发，执行类被拦住且原因说「判负」', async () => {
    const { api, controller } = await exitAtChunkBoundary(
      makeProjection({
        status: 'failed',
        steps: 512,
        error: { code: 'memory_fault', message: '访问了未映射的地址' },
        lastStop: { reason: 'exception', addr: '0x400001' },
      }),
    );
    // 判负也是终止态：跨分片停止条件同样生效（这条来路以前完全没有门禁）。
    expect(actionsCalls(api)).toHaveLength(1);
    expect(controller.state.cursor).toBe(512);

    controller.run({ kind: 'step' });
    controller.run({ kind: 'trial-run' });
    controller.run({ kind: 'run-n', count: 5 });
    await flush();
    // 文案与「已退出」分开：判负未必是 exit 造成的（04 §1.1）。
    expect(controller.state.notice?.text).toBe(MESSAGE_FAILED);
    expect(actionsCalls(api)).toHaveLength(1);

    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 2, '撤销发出');
    expect(actionsCalls(api)[1]?.actions).toEqual([{ type: 'undo' }]);

    controller.run({ kind: 'submit' });
    await until(() => controller.state.verdict !== undefined, '提交完成');
    expect(api.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
  });
});

describe('会话控制器：限流与旧会话释放（04 §5/§6）', () => {
  it('时间窗口型 429 把 Retry-After 的秒数说出来，点「重试」真的重发同一条命令', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);

    api.failNext(new ApiClientError('rate_limited', '请求过于频繁', { status: 429, retryAfterSeconds: 7 }));
    controller.run({ kind: 'step' });
    await until(() => controller.state.notice?.action === 'retry', '限流提示');
    expect(controller.state.notice?.text).toContain('服务端要求 7 秒后再试');
    expect(controller.state.cursor).toBe(0);
    expect(controller.state.sessionExpired).toBe(false);

    controller.retry();
    await until(() => controller.state.cursor === 1, '重试生效');
    expect(actionsCalls(api)).toHaveLength(2);
    expect(actionsCalls(api)[1]?.actions).toEqual([{ type: 'ret' }]);
    expect(controller.state.notice).toBeUndefined();
  });

  it('会话容量型 429（没有 Retry-After）只提示稍后重试，不编造等待时间', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);

    api.failNext(new ApiClientError('rate_limited', '本机存活会话数已达上限', { status: 429 }));
    controller.run({ kind: 'step' });
    await until(() => controller.state.notice?.action === 'retry', '限流提示');
    expect(controller.state.notice?.text).toContain('本机存活会话数已达上限');
    expect(controller.state.notice?.text).not.toContain('秒后再试');
  });

  async function twoChallenges(): Promise<Harness> {
    const api = createFakeApi({
      challenges: [
        { id: 'a', title: '题 A' },
        { id: 'b', title: '题 B' },
      ],
    });
    const tracker = createFakeTracker();
    const controller = createSessionController({ api: api.client, tracker: tracker.tracker });
    controller.start();
    await until(() => controller.state.phase === 'choosing', '进入选题');
    controller.choose('a');
    await until(() => controller.state.phase === 'ready', '第一题就绪');
    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    return { api, tracker, controller };
  }

  it('换题与重新开始都先 DELETE 旧会话，再建新会话（存活配额不泄漏）', async () => {
    const { api, controller } = await twoChallenges();

    controller.choose('b');
    await until(() => controller.state.challengeId === 'b' && controller.state.phase === 'ready', '第二题就绪');
    expect(methods(api).slice(3)).toEqual(['endSession', 'getChallenge', 'createSession']);
    expect(api.calls[3]?.sessionId).toBe(FAKE_SESSION_ID);

    controller.restart();
    await until(
      () => controller.state.challengeId === 'b' && controller.state.phase === 'ready',
      '重新开始就绪',
    );
    expect(methods(api).slice(6)).toEqual(['endSession', 'getChallenge', 'createSession']);
    expect(api.calls.filter((call) => call.method === 'endSession')).toHaveLength(2);
    expect(api.calls.filter((call) => call.method === 'createSession')).toHaveLength(3);
  });

  it('旧会话已经不存在（DELETE 404）时新会话照常建立，不误报会话失效', async () => {
    const { api, controller } = await twoChallenges();
    // 下一个请求就是那次清理：会话可能已被空闲回收（04 §1），或网络抖动。
    api.failNext(
      new ApiClientError('session_expired', '会话不存在', { status: 404, sessionExpired: true }),
    );

    controller.choose('b');
    await until(() => controller.state.challengeId === 'b' && controller.state.phase === 'ready', '第二题就绪');
    expect(controller.state.notice).toBeUndefined();
    expect(controller.state.sessionExpired).toBe(false);
    expect(api.calls.filter((call) => call.method === 'createSession')).toHaveLength(2);
  });
});

describe('会话控制器：会话失效与网络错误（05 §6）', () => {
  it('会话失效：提示重新开始、门禁全关，restart 后拿到新会话', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);

    api.failNext(new ApiClientError('session_expired', '会话不存在或已被回收', { status: 404, sessionExpired: true }));
    controller.run({ kind: 'step' });
    await until(() => controller.state.sessionExpired, '标记会话失效');
    expect(controller.state.notice?.action).toBe('restart');
    expect(controller.state.notice?.text).toContain('会话已失效');
    expect(actionsCalls(api)).toHaveLength(1);

    // 失效之后任何调试动作都不再发请求。
    controller.run({ kind: 'step' });
    controller.run({ kind: 'submit' });
    await flush();
    expect(actionsCalls(api)).toHaveLength(1);
    expect(api.calls.some((call) => call.method === 'submit')).toBe(false);
    expect(controller.state.notice?.text).toContain('重新开始');

    controller.restart();
    await until(() => controller.state.phase === 'ready' && controller.state.sessionId !== undefined, '新会话就绪');
    expect(controller.state.sessionExpired).toBe(false);
    expect(controller.state.notice).toBeUndefined();
    // D5 批次 2 起「重新开始」只换会话、不抹用户的程序：画布（与它的产物）都留下——
    // 本地存档按题目保存，抹掉画布下一次刷新也会被装回来，清产物只会让程序区与画布不一致。
    expect(controller.state.artifact.artifact?.actions).toEqual([{ type: 'ret' }]);
    expect(controller.state.cursor).toBe(0);
    expect(api.calls.filter((call) => call.method === 'createSession')).toHaveLength(2);
  });

  it('网络错误：给「重试」，重试成功后提示消失', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);

    api.failNext(new ApiClientError('internal', '连接不上服务端', { network: true }));
    controller.run({ kind: 'step' });
    await until(() => controller.state.notice?.action === 'retry', '网络错误提示');
    expect(controller.state.notice?.text).toContain('网络错误');
    expect(controller.state.sessionExpired).toBe(false);

    controller.retry();
    await until(() => actionsCalls(api).length === 2, '重试发出');
    await until(() => controller.state.notice === undefined, '提示消失');
    expect(controller.state.cursor).toBe(1);
  });
});

describe('会话控制器：提交与「回到调试」（05 §6）', () => {
  const rejected = makeSubmitResponse('rejected', {
    executed: 1,
    results: [
      { ok: true, action: 'ret' },
      { ok: false, action: 'ret', error: { code: 'invalid_ip', message: '指令指针越界' } },
    ],
    replay: makeReplay([
      { kind: 'action', label: 'ret' },
      { kind: 'action', label: 'ret', status: 'failed', error: { code: 'invalid_ip', message: '指令指针越界' } },
    ]),
  });

  async function submitted(): Promise<Harness & { readonly debugProjection: unknown }> {
    const harness = await open({ submit: rejected });
    const { api, tracker, controller } = harness;
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1, '先调试一步');
    const debugProjection = controller.state.page?.projection;

    controller.run({ kind: 'submit' });
    await until(() => controller.state.verdict !== undefined, '提交完成');
    expect(api.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
    return { ...harness, debugProjection };
  }

  it('提交发送整个 payload（不受程序区当前位置影响），并切到判题结果模式', async () => {
    const { api, controller } = await submitted();
    expect(api.calls.find((call) => call.method === 'submit')?.actions).toEqual([{ type: 'ret' }, { type: 'ret' }]);
    expect(controller.state.page?.mode).toBe('verdict');
    // 失败那一帧默认选中（09 §3.4：带 error 的 action 帧）。
    expect(controller.state.verdict?.position).toBe(2);
    expect(controller.state.verdict?.origins).toHaveLength(2);
  });

  it('判题结果模式下调试按钮禁用但提交保持可用（提交不限次数）', async () => {
    const { api, controller } = await submitted();
    controller.run({ kind: 'step' });
    await flush();
    expect(actionsCalls(api)).toHaveLength(1);
    expect(controller.state.notice?.text).toContain('回到调试');

    controller.run({ kind: 'submit' });
    await until(() => api.calls.filter((call) => call.method === 'submit').length === 2, '可以再提交一次');
  });

  it('判题录像只是判题模式的数据源：拖时间线不碰调试实例的投影（05 §5/§6）', async () => {
    const { controller, debugProjection } = await submitted();
    // 提交不改动调试实例，切到判题结果也不许用录像覆盖它——恢复路径的地基。
    expect(controller.state.page?.mode).toBe('verdict');
    expect(controller.state.page?.projection).toBe(debugProjection);

    controller.selectPosition(1);
    controller.selectPosition(0);
    expect(controller.state.verdict?.position).toBe(0);
    expect(controller.state.page?.projection).toBe(debugProjection);
  });

  it('「回到调试」恢复提交前的调试状态，视图显隐保持不变', async () => {
    const { controller, debugProjection } = await submitted();
    const before = controller.state;
    const cursor = before.cursor;
    const history = before.history;
    const results = before.results;
    const views = before.page?.views;

    controller.selectPosition(0);
    expect(controller.state.verdict?.position).toBe(0);
    controller.backToDebug();

    expect(controller.state.page?.mode).toBe('debug');
    expect(controller.state.page?.projection).toBe(debugProjection);
    expect(controller.state.cursor).toBe(cursor);
    expect(controller.state.history).toEqual(history);
    expect(controller.state.results).toBe(results);
    expect(controller.state.page?.views).toBe(views);
    // 判题结论与位置留着：再切回判题模式还是刚才看的那一帧。
    expect(controller.state.verdict?.position).toBe(0);
  });
});

describe('会话控制器：本地保存与「刷新后接回会话」（D5 批次 2，05 §3.1）', () => {
  /** 内存存储：控制器只认注入进来的 store，不传就等于这台环境不保存。 */
  function memoryStore(): KeyValueStore & { readonly data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }

  const RESUMED = { ok: true, action: 'step' } as const;

  function storedRecord(cursor: number, actionsLength: number): StoredSession {
    return {
      sessionId: FAKE_SESSION_ID,
      cursor,
      results: [RESUMED],
      actionsLength,
    };
  }

  async function openWith(
    store: KeyValueStore,
    canvas?: CanvasPort,
  ): Promise<Harness & { readonly store: KeyValueStore }> {
    const api = createFakeApi();
    const tracker = createFakeTracker();
    const controller = createSessionController({ api: api.client, tracker: tracker.tracker, store, canvas });
    controller.start();
    await until(() => controller.state.phase === 'ready', '会话就绪');
    return { api, tracker, controller, store };
  }

  it('有本地记录时接回旧会话（GET /api/sessions/:id），不再新建', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(0, 0));

    const { api, controller } = await openWith(store);
    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'sessionState']);
    expect(api.calls.find((call) => call.method === 'sessionState')?.sessionId).toBe(FAKE_SESSION_ID);
    expect(controller.state.sessionId).toBe(FAKE_SESSION_ID);
    // 刷新时接不上旧会话（404）不是「会话失效」那种错误，不该吓用户。
    expect(controller.state.sessionExpired).toBe(false);
    expect(controller.state.notice).toBeUndefined();
  });

  it('程序区指针按「动作条数对得上」取舍：对得上就接着走', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(2, 3));

    const { tracker, controller } = await openWith(store);
    // 还没编译出产物：先不套（套上去就是猜）。
    expect(controller.state.cursor).toBe(0);
    compileInto(tracker, controller, repeatedActions(3));
    expect(controller.state.cursor).toBe(2);
    expect(controller.state.results).toEqual([RESUMED]);
    expect(controller.state.notice).toBeUndefined();
    // 记录也被刷新成当前状态，下一次刷新接着走。
    expect(readSession(store, 'ret2win')).toEqual(storedRecord(2, 3));
  });

  it('动作条数对不上（画布被改过 / 存档没恢复）就不套旧指针，并说明原因', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(4, 5));

    const { tracker, controller } = await openWith(store);
    compileInto(tracker, controller, repeatedActions(2));
    expect(controller.state.cursor).toBe(0);
    expect(controller.state.results).toEqual([]);
    expect(controller.state.notice?.text).toContain('对不上');
  });

  it('旧会话已被回收（404）：清掉记录、安静新建，并说明「本地程序还在」', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(3, 3));

    const api = createFakeApi();
    // 用画布端口把「第一相位 → 第二相位」之间卡出一个确定的时刻：假 API 的 `failNext`
    // 是「下一个请求失败」，不这样做就会打在 `listChallenges` 上。
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = createFakeTracker();
    const controller = createSessionController({
      api: api.client,
      tracker: tracker.tracker,
      store,
      canvas: {
        restore: async () => {
          await gate;
          return undefined;
        },
      },
    });
    controller.start();
    // `open()` 会**先同步**发布 `phase: 'opening'`，所以等它等于没等；`challenge` 只在
    // `getChallenge` 回来之后才有，用它当「第一相位到了」的信号。
    await until(() => controller.state.challenge !== undefined, '第一相位（画布阶段）');
    api.failNext(new ApiClientError('session_expired', '会话不存在', { status: 404, sessionExpired: true }));
    release?.();
    await until(() => controller.state.phase === 'ready', '新会话就绪');

    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'sessionState', 'createSession']);
    expect(controller.state.notice?.text).toContain('本地保存的程序还在');
    expect(controller.state.sessionExpired).toBe(false);
    // 记录被换成新会话（旧 id 不能留，否则每次刷新都要白撞一次 404）。
    expect(readSession(store, 'ret2win')).toEqual({
      sessionId: FAKE_SESSION_ID,
      cursor: 0,
      results: [],
      actionsLength: 0,
    });
  });

  it('接回会话时的网络错误照原样报出来，不偷偷新建一个会话', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(0, 0));

    const api = createFakeApi();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createSessionController({
      api: api.client,
      tracker: createFakeTracker().tracker,
      store,
      canvas: {
        restore: async () => {
          await gate;
          return undefined;
        },
      },
    });
    controller.start();
    await until(() => controller.state.challenge !== undefined, '第一相位（画布阶段）');
    api.failNext(new ApiClientError('internal', '连接不上服务端', { network: true }));
    release?.();
    await until(() => controller.state.notice?.tone === 'error', '网络错误提示');
    expect(controller.state.notice?.text).toContain('网络错误');
    expect(controller.state.notice?.action).toBe('retry');
    expect(methods(api)).not.toContain('createSession');
    // 记录留着：网络恢复后刷新还能接着接回这个会话。
    expect(readSession(store, 'ret2win')?.sessionId).toBe(FAKE_SESSION_ID);
  });

  it('先还原画布、再接回会话：端口在会话请求之前被调用（05 §3.1 的硬顺序）', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(0, 0));

    let atRestore: readonly string[] = [];
    const api = createFakeApi();
    const canvas: CanvasPort = {
      restore: async () => {
        atRestore = methods(api);
        return undefined;
      },
    };
    const controller = createSessionController({
      api: api.client,
      tracker: createFakeTracker().tracker,
      store,
      canvas,
    });
    controller.start();
    await until(() => controller.state.phase === 'ready', '会话就绪');

    // 端口被调用时，会话请求（sessionState）必须还没发出去。
    expect(atRestore).toEqual(['listChallenges', 'getChallenge']);
    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'sessionState']);
  });

  it('画布存档装不回去只提示，会话照常恢复', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(0, 0));

    const api = createFakeApi();
    const controller = createSessionController({
      api: api.client,
      tracker: createFakeTracker().tracker,
      store,
      canvas: { restore: async () => '本地保存的程序恢复失败（画布保持原样）：坏存档' },
    });
    controller.start();
    await until(() => controller.state.phase === 'ready', '会话就绪');
    expect(controller.state.notice?.text).toContain('恢复失败');
    expect(controller.state.sessionId).toBe(FAKE_SESSION_ID);

    // 端口抛错也一样：转成提示，不让它掀掉整条打开流程。
    const api2 = createFakeApi();
    const controller2 = createSessionController({
      api: api2.client,
      tracker: createFakeTracker().tracker,
      store,
      canvas: {
        restore: async () => {
          throw new Error('画布没挂上');
        },
      },
    });
    controller2.start();
    await until(() => controller2.state.phase === 'ready', '会话就绪');
    expect(controller2.state.notice?.text).toContain('画布没挂上');
  });

  it('程序区每走一步就把位置落盘（刷新后接着走，不重发已执行过的动作）', async () => {
    const store = memoryStore();
    const { api, tracker, controller } = await openWith(store);
    compileInto(tracker, controller, repeatedActions(2));
    expect(readSession(store, 'ret2win')?.actionsLength).toBe(2);
    expect(readSession(store, 'ret2win')?.cursor).toBe(0);

    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1, '走一步');
    await until(() => readSession(store, 'ret2win')?.cursor === 1, '位置落盘');
    expect(readSession(store, 'ret2win')?.results).toHaveLength(1);
    expect(readSession(store, 'ret2win')?.sessionId).toBe(FAKE_SESSION_ID);
    expect(api.calls.filter((call) => call.method === 'actions')).toHaveLength(1);
  });

  it('「重新开始」丢掉会话记录（新实例不能配旧指针），画布存档不动', async () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', storedRecord(3, 3));
    const { api, controller } = await openWith(store);
    expect(api.calls.filter((call) => call.method === 'sessionState')).toHaveLength(1);

    controller.restart();
    await until(() => controller.state.phase === 'ready', '新会话就绪');
    // 没有记录可读 ⇒ 不会去 GET 旧会话，直接新建（记录里的旧指针也不该被套上）。
    expect(api.calls.filter((call) => call.method === 'sessionState')).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === 'createSession')).toHaveLength(1);
    expect(controller.state.cursor).toBe(0);
    expect(readSession(store, 'ret2win')?.cursor).toBe(0);
  });
});

describe('会话控制器：启动路径的失败出口（A 的巡检缺陷，04 §6、05 §6）', () => {
  /**
   * 这三条路径原来都不接 `handleFailure`，异常直接穿透到 `enqueue` 的 catch，
   * 界面显示「界面内部错误」并**永远停在启动页**（每 IP 会话配额打满时必然踩到：
   * `sessions.perIp = 32`，超了就是 429 `rate_limited`）。
   */
  const RATE_LIMITED = new ApiClientError('rate_limited', '同一来源的会话数已达上限', {
    status: 429,
    retryAfterSeconds: 11,
  });
  const OFFLINE = new ApiClientError('internal', '连接不上服务端', { network: true });

  it('建会话被限流：限流文案 + 等 N 秒 + 「重试」出口，相位不再是启动页', async () => {
    const api = createFakeApi();
    // 只给 `createSession` 下毒：`failNext` 是「下一个请求失败」，直接设在 `start()` 前
    // 会打在 `listChallenges` 上，用例就名不副实了。
    const originalCreate = api.client.createSession;
    api.client.createSession = (challengeId) => {
      api.failNext(RATE_LIMITED);
      return originalCreate(challengeId);
    };
    const controller = createSessionController({ api: api.client, tracker: createFakeTracker().tracker });
    controller.start();
    await until(() => controller.state.notice?.action === 'retry', '限流提示');

    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(controller.state.notice?.tone).toBe('error');
    expect(controller.state.notice?.text).toContain('请求过于频繁');
    expect(controller.state.notice?.text).toContain('11 秒');
    // 不能停在 `loading`（首屏「正在读取题目列表」）或 `opening`（「正在创建会话」）。
    expect(controller.state.phase).not.toBe('loading');
    expect(controller.state.phase).not.toBe('opening');
  });

  it('建会话遇网络错误：网络文案 + 「重试」，相位不再是启动页', async () => {
    const api = createFakeApi();
    const originalCreate = api.client.createSession;
    let attempts = 0;
    api.client.createSession = (challengeId) => {
      attempts += 1;
      if (attempts === 1) api.failNext(OFFLINE); // 只毒第一次，重试才能成功。
      return originalCreate(challengeId);
    };
    const controller = createSessionController({ api: api.client, tracker: createFakeTracker().tracker });
    controller.start();
    await until(() => controller.state.notice?.action === 'retry', '网络提示');

    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'createSession']);
    expect(controller.state.notice?.text).toContain('网络错误');
    expect(controller.state.phase).not.toBe('loading');
    expect(controller.state.phase).not.toBe('opening');
    // 重试真的重跑「打开这道题」这个意图（不是从头读列表）。
    controller.retry();
    await until(() => controller.state.phase === 'ready', '重试后会话就绪');
    expect(controller.state.notice).toBeUndefined();
    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'createSession', 'getChallenge', 'createSession']);
  });

  it('题目列表加载失败：网络文案 + 「重试」，重试重跑 list 意图', async () => {
    const api = createFakeApi();
    api.failNext(OFFLINE);
    const controller = createSessionController({ api: api.client, tracker: createFakeTracker().tracker });
    controller.start();
    await until(() => controller.state.notice?.action === 'retry', '网络提示');

    expect(controller.state.notice?.text).toContain('网络错误');
    expect(controller.state.phase).not.toBe('loading');
    expect(methods(api)).toEqual(['listChallenges']);

    controller.retry();
    await until(() => controller.state.phase === 'ready', '重试后开局');
    expect(methods(api)).toEqual(['listChallenges', 'listChallenges', 'getChallenge', 'createSession']);
    expect(controller.state.notice).toBeUndefined();
  });

  it('接回会话后新建也失败（404 之后紧跟 429）：仍然只是提示 + 重试，不穿透', async () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    writeSession(store, 'ret2win', {
      sessionId: FAKE_SESSION_ID,
      cursor: 0,
      results: [],
      actionsLength: 0,
    });

    const api = createFakeApi();
    // 每个包装只给**它自己那一次**请求下毒，因此不依赖请求之间的时序。
    const originalSessionState = api.client.sessionState;
    api.client.sessionState = (sessionId) => {
      api.failNext(new ApiClientError('session_expired', '会话不存在', { status: 404, sessionExpired: true }));
      return originalSessionState(sessionId);
    };
    const originalCreate = api.client.createSession;
    api.client.createSession = (challengeId) => {
      api.failNext(RATE_LIMITED);
      return originalCreate(challengeId);
    };

    const controller = createSessionController({
      api: api.client,
      tracker: createFakeTracker().tracker,
      store,
    });
    controller.start();
    await until(() => controller.state.notice?.action === 'retry', '限流提示');

    expect(methods(api)).toEqual(['listChallenges', 'getChallenge', 'sessionState', 'createSession']);
    expect(controller.state.notice?.text).toContain('请求过于频繁');
    expect(controller.state.phase).not.toBe('loading');
    expect(controller.state.phase).not.toBe('opening');
  });
});

describe('会话控制器：视图状态（05 §2.1）', () => {
  it('显隐、排序与滚动都经过控制器写进 PageState', async () => {
    const { controller } = await open();
    const before = controller.state.page?.views;
    controller.setViewShown('memory', false);
    expect(controller.state.page?.views).not.toBe(before);
    expect(controller.state.page?.views.shown).not.toContain('memory');

    controller.moveView('registers', -1);
    const moved = controller.state.page?.views;
    controller.moveView('registers', 0);
    expect(controller.state.page?.views).toBe(moved);

    controller.scrollViews(1);
    expect(controller.state.page?.views.offset).toBe(1);
    controller.scrollViews(-1);
    expect(controller.state.page?.views.offset).toBe(0);
  });
});
