import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../src/api';
import { MESSAGE_NOT_RUNNING, MESSAGE_RUNNING } from '../src/viewmodel/toolbar';
import {
  actionsCalls,
  compileInto,
  deferred,
  flush,
  holdFirstChunk,
  open,
  respondToChunks,
  until,
} from './controller-harness';
import { repeatedActions } from './fake-api';
import { makeProjection } from './helpers';

describe('会话控制器：运行与分块（04 §5、05 §3）', () => {
  it('运行按 512 分块提交完整序列；再运行一次仍从 reset 开始，不退化成 run', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));

    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 600 && !controller.state.running, '两块跑完');
    expect(actionsCalls(api).map((call) => call.actions?.length)).toEqual([1, 512, 88]);

    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 6 && !controller.state.running, '第二轮跑完');
    expect(actionsCalls(api).slice(3).map((call) => call.actions?.length)).toEqual([1, 512, 88]);
    expect(actionsCalls(api)[3]?.actions).toEqual([{ type: 'reset' }]);
    expect(controller.state.cursor).toBe(600);
  });

  it('513 个动作跨两片（512 + 1）：单批上限就是 MAX_ACTIONS_PER_REQUEST', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(513));

    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 513 && !controller.state.running, '两片跑完');
    const calls = actionsCalls(api);
    expect(calls.map((call) => call.actions?.length)).toEqual([1, 512, 1]);
    // 全程串行：reset 在前，分片按序跟上（数组顺序就是发出顺序）。
    expect(calls[0]?.actions).toEqual([{ type: 'reset' }]);
    expect(calls[1]?.actions?.[0]).toEqual({ type: 'ret' });
  });

  it('某片被拒绝时不再发后续片（服务端的停止语义跨片保持）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    respondToChunks(api, (actions) => ({
      results: actions.map((action, index) =>
        index === 0
          ? { ok: false, action: action.type, error: { code: 'invalid_ip', message: '第一条就越界了' } }
          : { ok: true, action: action.type },
      ),
      executed: 0,
      projection: makeProjection({ status: 'failed' }),
      history: { undo: 0, stepBack: 0 },
    }));

    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 2 && !controller.state.running, '第一片结束');
    await flush();
    expect(actionsCalls(api)).toHaveLength(2);
    expect(controller.state.results[0]?.ok).toBe(false);
  });

  it('某片实际生效数少于提交数时也停止（executed 口径）', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    respondToChunks(api, (actions) => ({
      results: actions.map((action) => ({ ok: true, action: action.type })),
      executed: actions.length - 1,
      projection: makeProjection(),
      history: { undo: 0, stepBack: 0 },
    }));

    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 2 && !controller.state.running, '第一片结束');
    await flush();
    expect(actionsCalls(api)).toHaveLength(2);
    expect(controller.state.cursor).toBe(512);
  });
});

describe('会话控制器：运行与终止', () => {
  it('先发 [reset]，再按 512 分片发完整序列，末尾不补 run', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');

    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 600 && !controller.state.running, '运行结束');
    const calls = actionsCalls(api).map((call) => call.actions ?? []);
    expect(calls.slice(-3).map((actions) => actions.length)).toEqual([1, 512, 88]);
    expect(calls.at(-3)).toEqual([{ type: 'reset' }]);
    // 完整序列，不是从游标 1 开始。
    expect(calls.slice(-2).flat()).toEqual(repeatedActions(600));
    expect(controller.state.cursor).toBe(600);
  });

  it('空程序发 [reset] + [run]', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, []);

    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 2 && !controller.state.running, '运行结束');
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([[{ type: 'reset' }], [{ type: 'run' }]]);
    expect(controller.state.cursor).toBe(0);
  });

  it('running 先置位，结束后复位', async () => {
    const { tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);

    controller.run({ kind: 'run-all' });
    // 同步置位：run() 返回时还没有任何请求发出。
    expect(controller.state.running).toBe(true);
    await until(() => !controller.state.running, '运行结束');
    expect(controller.state.cursor).toBe(2);
    expect(controller.state.aborted).toBeUndefined();
    await until(() => !controller.state.busy, '队列排空');
  });

  it('终止后不再发下一片，已发那片的响应照常应用', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const chunk = await holdFirstChunk(api, controller);

    controller.run({ kind: 'abort' });
    // 终止只置本轮的取消标志：在途那片还没回来，running 仍为 true。
    expect(controller.state.running).toBe(true);
    chunk.release();
    await until(() => !controller.state.running, '本轮结束');
    await flush();
    expect(actionsCalls(api)).toHaveLength(2);
    expect(controller.state.cursor).toBe(512);
    expect(controller.state.aborted).toEqual({ executed: 512, total: 600 });
    expect(controller.state.running).toBe(false);
  });

  it('reset 在途时终止：reset 照常应用，一片都不发', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');

    const reset = deferred();
    api.gate(reset.promise);
    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 2, 'reset 发出');
    api.gate(undefined);
    controller.run({ kind: 'abort' });
    reset.release();
    await until(() => !controller.state.running, '本轮结束');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([[{ type: 'ret' }], [{ type: 'reset' }]]);
    expect(controller.state.cursor).toBe(0);
    expect(controller.state.aborted).toEqual({ executed: 0, total: 600 });
  });

  it('连点运行只跑一轮', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);

    controller.run({ kind: 'run-all' });
    controller.run({ kind: 'run-all' });
    expect(controller.state.notice?.text).toBe(MESSAGE_RUNNING);
    expect(controller.state.queued).toBe(1);
    await until(() => !controller.state.running && !controller.state.busy, '运行结束');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([
      [{ type: 'reset' }],
      [{ type: 'ret' }, { type: 'ret' }],
    ]);
  });

  it('单步在途时点两次运行：排在单步之后，只跑一轮', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'ret' }]);
    const step = deferred();
    api.gate(step.promise);
    controller.run({ kind: 'step' });
    await until(() => actionsCalls(api).length === 1, '单步发出');
    api.gate(undefined);

    // busy / queued 不是门禁：第一次运行可以排在单步后面；running 同步置位挡住第二次。
    controller.run({ kind: 'run-all' });
    controller.run({ kind: 'run-all' });
    expect(controller.state.running).toBe(true);
    expect(controller.state.queued).toBe(1);
    step.release();
    await until(() => !controller.state.running && !controller.state.busy, '运行结束');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([
      [{ type: 'ret' }],
      [{ type: 'reset' }],
      [{ type: 'ret' }, { type: 'ret' }],
    ]);
    expect(controller.state.cursor).toBe(2);
  });

  it('排队中的运行在开始时被门禁拦下：running 照样复位', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }]);
    const step = deferred();
    api.gate(step.promise);
    api.failNext(new ApiClientError('session_expired', '会话不存在或已被回收', { status: 404, sessionExpired: true }));
    controller.run({ kind: 'step' });
    controller.run({ kind: 'run-all' });
    expect(controller.state.running).toBe(true);
    await until(() => actionsCalls(api).length === 1, '单步发出');
    api.gate(undefined);
    step.release();
    await until(() => !controller.state.running && !controller.state.busy, '队列排空');
    await flush();
    expect(controller.state.sessionExpired).toBe(true);
    expect(actionsCalls(api)).toHaveLength(1);
  });

  it('中途失败复位 running', async () => {
    const { api, tracker, controller } = await open();
    // 1100 = 512 + 512 + 76：第二片失败后，第三片绝不能再发。
    compileInto(tracker, controller, repeatedActions(1100));
    const chunk = await holdFirstChunk(api, controller);
    api.failNext(new ApiClientError('internal', '连接不上服务端', { network: true }));
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    await flush();
    expect(actionsCalls(api)).toHaveLength(3);
    expect(controller.state.cursor).toBe(512);
    expect(controller.state.notice?.action).toBe('retry');
    expect(controller.state.aborted).toBeUndefined();

    // 「终止」随 running 一起失效：不在运行中就只给出原因、不发请求。
    controller.run({ kind: 'abort' });
    expect(controller.state.notice?.text).toBe(MESSAGE_NOT_RUNNING);
    await flush();
    expect(actionsCalls(api)).toHaveLength(3);
  });

  it('终止标志不跨轮', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const chunk = await holdFirstChunk(api, controller);
    controller.run({ kind: 'abort' });
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '第一轮结束');
    expect(controller.state.aborted).toEqual({ executed: 512, total: 600 });

    controller.run({ kind: 'run-all' });
    expect(controller.state.aborted).toBeUndefined();
    await until(() => !controller.state.running && !controller.state.busy, '第二轮结束');
    expect(actionsCalls(api).slice(2).map((call) => call.actions?.length)).toEqual([1, 512, 88]);
    expect(controller.state.cursor).toBe(600);
    expect(controller.state.aborted).toBeUndefined();
  });

  it('其他命令开始执行时清掉终止记录', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const chunk = await holdFirstChunk(api, controller);
    controller.run({ kind: 'abort' });
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    expect(controller.state.aborted).toBeDefined();

    controller.run({ kind: 'step' });
    await until(() => actionsCalls(api).length === 3 && !controller.state.busy, '单步结束');
    expect(controller.state.aborted).toBeUndefined();
    expect(controller.state.cursor).toBe(513);
  });

  it('abort 不进串行队列、不发请求', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const idle = api.calls.length;
    controller.run({ kind: 'abort' });
    expect(controller.state.notice?.text).toBe(MESSAGE_NOT_RUNNING);
    expect(controller.state.queued).toBe(0);
    await flush();
    expect(api.calls.length).toBe(idle);

    const chunk = await holdFirstChunk(api, controller);
    const before = api.calls.length;
    controller.run({ kind: 'abort' });
    expect(controller.state.queued).toBe(0);
    expect(api.calls.length).toBe(before);
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    await flush();
    // 终止本身一个请求都没加：只有 [reset] 与已在途的第一片。
    expect(api.calls.length).toBe(before);
    expect(actionsCalls(api).map((call) => call.actions?.length)).toEqual([1, 512]);
    expect(controller.state.cursor).toBe(512);
    expect(controller.state.aborted).toEqual({ executed: 512, total: 600 });
  });

  it('运行排在在途单步之后时终止：放行单步后一个 reset 都不发', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, [{ type: 'ret' }, { type: 'push', value: '0x1' }, { type: 'ret' }]);
    const step = deferred();
    api.gate(step.promise);
    controller.run({ kind: 'step' });
    await until(() => actionsCalls(api).length === 1, '单步发出');
    api.gate(undefined);
    controller.run({ kind: 'run-all' });
    controller.run({ kind: 'abort' });
    expect(controller.state.queued).toBe(1);

    step.release();
    await until(() => !controller.state.running && !controller.state.busy, '队列排空');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions)).toEqual([[{ type: 'ret' }]]);
    // 本轮还没开始就被终止：记下的是开始那一刻的游标（单步之后的 1）。
    expect(controller.state.aborted).toEqual({ executed: 1, total: 3 });
    expect(controller.state.cursor).toBe(1);
  });
});

/** 三个可区分的动作：撤销后再单步，能看出提交的是哪一条。 */
const DISTINCT = [
  { type: 'ret' },
  { type: 'push', value: '0x1' },
  { type: 'push', value: '0x2' },
] as const;

describe('会话控制器：运行之后的撤销（服务端每个请求一层 undo，04 §3）', () => {
  it('单步 → 运行（reset + 一片）→ 撤销：游标回到 reset 之后，再单步提交第一条', async () => {
    const { api, tracker, controller } = await open({ history: { undo: 5, stepBack: 0 } });
    compileInto(tracker, controller, DISTINCT);
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');
    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 3 && !controller.state.running, '运行结束');

    // 服务端撤掉的是最后那一片：实例回到 reset 之后的初态。
    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 4 && !controller.state.busy, '撤销一次');
    expect(controller.state.cursor).toBe(0);
    controller.run({ kind: 'step' });
    await until(() => actionsCalls(api).length === 5 && !controller.state.busy, '再单步');
    expect(actionsCalls(api)[4]?.actions).toEqual([{ type: 'ret' }]);
  });

  it('两次撤销回到运行前：游标历史层数等于运行实际生效的请求数', async () => {
    const { api, tracker, controller } = await open({ history: { undo: 5, stepBack: 0 } });
    compileInto(tracker, controller, DISTINCT);
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');
    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 3 && !controller.state.running, '运行结束');

    controller.run({ kind: 'undo' });
    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 5 && !controller.state.busy, '撤销两次');
    // 第二次撤掉的是 reset：回到单步之后，下一条是第二个动作。
    expect(controller.state.cursor).toBe(1);
    controller.run({ kind: 'step' });
    await until(() => actionsCalls(api).length === 6 && !controller.state.busy, '再单步');
    expect(actionsCalls(api)[5]?.actions).toEqual([{ type: 'push', value: '0x1' }]);
  });

  it('多片运行逐片撤销：600 = reset + 512 + 88，三次撤销依次回到 512、0、1', async () => {
    const { api, tracker, controller } = await open({ history: { undo: 5, stepBack: 0 } });
    compileInto(tracker, controller, repeatedActions(600));
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');
    controller.run({ kind: 'run-all' });
    await until(() => controller.state.cursor === 600 && !controller.state.running, '运行结束');

    const cursors: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      controller.run({ kind: 'undo' });
      await until(() => actionsCalls(api).length === 5 + index && !controller.state.busy, `撤销 ${index + 1}`);
      cursors.push(controller.state.cursor);
    }
    expect(cursors).toEqual([512, 0, 1]);
  });

  it('抛错的分片不留游标历史：撤销跳过它，直接回到上一片之前', async () => {
    const { api, tracker, controller } = await open({ history: { undo: 5, stepBack: 0 } });
    compileInto(tracker, controller, repeatedActions(1100));
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');
    const chunk = await holdFirstChunk(api, controller);
    api.failNext(new ApiClientError('internal', '连接不上服务端', { network: true }));
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    expect(controller.state.cursor).toBe(512);

    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 5 && !controller.state.busy, '撤销一次');
    expect(controller.state.cursor).toBe(0);
    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 6 && !controller.state.busy, '撤销两次');
    expect(controller.state.cursor).toBe(1);
  });

  it('一条都没生效的分片（executed 0）不留游标历史：服务端也没压 undo 层', async () => {
    const { api, tracker, controller } = await open({ history: { undo: 5, stepBack: 0 } });
    compileInto(tracker, controller, DISTINCT);
    controller.run({ kind: 'step' });
    await until(() => controller.state.cursor === 1 && !controller.state.busy, '先单步一次');
    respondToChunks(api, (actions) => ({
      results: [{ ok: false, action: actions[0]?.type ?? 'ret', error: { code: 'invalid_ip', message: '越界' } }],
      executed: 0,
      projection: makeProjection(),
      history: { undo: 5, stepBack: 0 },
    }));
    controller.run({ kind: 'run-all' });
    await until(() => actionsCalls(api).length === 3 && !controller.state.running, '运行结束');

    controller.run({ kind: 'undo' });
    await until(() => actionsCalls(api).length === 4 && !controller.state.busy, '撤销一次');
    // 唯一的服务端 undo 层属于 reset：撤销回到运行前的游标 1。
    expect(controller.state.cursor).toBe(1);
  });
});

describe('会话控制器：运行途中改动积木', () => {
  it('改动积木（产物过期）后不再发下一片，也不记「已终止」', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const chunk = await holdFirstChunk(api, controller);
    controller.noteEdit();
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions?.length)).toEqual([1, 512]);
    expect(controller.state.running).toBe(false);
    expect(controller.state.aborted).toBeUndefined();
  });

  it('自动重编译换了产物后不再发旧产物的分片', async () => {
    const { api, tracker, controller } = await open();
    compileInto(tracker, controller, repeatedActions(600));
    const chunk = await holdFirstChunk(api, controller);
    compileInto(tracker, controller, repeatedActions(700));
    chunk.release();
    await until(() => !controller.state.running && !controller.state.busy, '本轮结束');
    await flush();
    expect(actionsCalls(api).map((call) => call.actions?.length)).toEqual([1, 512]);
    expect(controller.state.running).toBe(false);
    expect(controller.state.aborted).toBeUndefined();
  });
});
