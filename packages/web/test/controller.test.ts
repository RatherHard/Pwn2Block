import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../src/api';
import { createSessionController, type SessionController } from '../src/viewmodel/controller';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { MESSAGE_EXITED } from '../src/viewmodel/toolbar';
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

describe('会话控制器：已退出即终止态（04 §1.1/§5、09 §8 第 10 条）', () => {
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
    expect(controller.state.artifact.artifact).toBeUndefined();
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
