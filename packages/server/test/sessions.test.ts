import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_IDLE_MS } from '@pwn2block/shared';
import type { HistoryDepth } from '@pwn2block/shared';
import { makeFakeRuntime } from './support';
import { SessionStore } from '../src/sessions';
import type { SessionStoreOptions } from '../src/sessions';

/**
 * 会话存储（04 §1）：串行锁、空闲回收、两个实例槽位、id 不可枚举。
 * 时间一律注入假时钟，测试不依赖真实等待。
 */

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(options: SessionStoreOptions = {}): SessionStore {
  return new SessionStore(options);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('会话存储（04 §1）', () => {
  it('sessionId 是 128 位随机值，会话里调试 / 判题两个槽位与回退深度都在', () => {
    const store = makeStore();
    const session = store.create(makeFakeRuntime().runtime);

    expect(session.id).toMatch(/^[0-9a-f]{32}$/);
    expect(session.challengeId).toBe('ret2win');
    expect(session.debug.state().status).toBe('ready');
    expect(session.judge).toEqual({ kind: 'stateless-replay', submits: 0 });
    expect(session.history()).toEqual({ undo: 0, stepBack: 0 } satisfies HistoryDepth);
    expect(store.size()).toBe(1);
  });

  it('同一会话的请求排队执行，绝不并发', async () => {
    const store = makeStore();
    const session = store.create(makeFakeRuntime().runtime);
    const events: string[] = [];

    const first = store.run(session.id, async () => {
      events.push('第一个请求：开始');
      await delay(20);
      events.push('第一个请求：结束');
    });
    const second = store.run(session.id, () => {
      events.push('第二个请求：开始');
      events.push('第二个请求：结束');
    });

    await Promise.all([first, second]);
    expect(events).toEqual([
      '第一个请求：开始',
      '第一个请求：结束',
      '第二个请求：开始',
      '第二个请求：结束',
    ]);
  });

  it('任务抛错不会卡住后面的请求', async () => {
    const store = makeStore();
    const session = store.create(makeFakeRuntime().runtime);

    const boom = store.run(session.id, () => {
      throw new Error('模拟引擎崩溃');
    });
    const after = store.run(session.id, () => 'ok');

    await expect(boom).rejects.toThrow('模拟引擎崩溃');
    await expect(after).resolves.toEqual({ ok: true, value: 'ok' });
  });

  it('活跃请求会刷新空闲计时', async () => {
    const fake = clock();
    const store = makeStore({ now: fake.now, idleMs: 1000 });
    const session = store.create(makeFakeRuntime().runtime);

    fake.advance(900);
    await store.run(session.id, () => 'touch');
    fake.advance(900);
    expect(store.reap()).toEqual([]);

    fake.advance(1000);
    expect(store.reap()).toEqual([session.id]);
  });

  it('空闲超时回收后区分 session_expired 与 not_found', async () => {
    const fake = clock();
    const store = makeStore({ now: fake.now, idleMs: SESSION_IDLE_MS });
    const session = store.create(makeFakeRuntime().runtime);

    fake.advance(SESSION_IDLE_MS);
    expect(store.reap()).toEqual([session.id]);
    await expect(store.run(session.id, () => 'never')).resolves.toEqual({ ok: false, expired: true });
    expect(store.lookup(session.id)).toEqual({ ok: false, expired: true });
    expect(store.lookup('未知会话')).toEqual({ ok: false, expired: false });
  });

  it('回收是惰性的：清理前到达的请求照常服务，并刷新空闲计时', async () => {
    const fake = clock();
    const store = makeStore({ now: fake.now, idleMs: 1000 });
    const session = store.create(makeFakeRuntime().runtime);

    fake.advance(5000);
    await expect(store.run(session.id, () => 'ok')).resolves.toEqual({ ok: true, value: 'ok' });
    expect(store.reap()).toEqual([]);

    fake.advance(1000);
    expect(store.reap()).toEqual([session.id]);
  });

  it('定时清理按周期回收空闲会话', () => {
    let clockMs = 1_000_000;
    vi.useFakeTimers();
    const store = makeStore({ now: () => clockMs, idleMs: 1000, sweepIntervalMs: 500 });
    const session = store.create(makeFakeRuntime().runtime);
    store.startSweeper();

    clockMs += 600; // 还没到空闲上限
    vi.advanceTimersByTime(500);
    expect(store.size()).toBe(1);

    clockMs += 1000; // 已超过空闲上限
    vi.advanceTimersByTime(500);
    expect(store.size()).toBe(0);
    expect(store.lookup(session.id)).toEqual({ ok: false, expired: true });
    store.stopSweeper();
  });

  it('定时清理的 timer 调用了 unref()，不阻止进程退出', () => {
    const store = makeStore({ idleMs: 1000, sweepIntervalMs: 500 });
    const handle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);

    store.startSweeper();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(handle.unref).toHaveBeenCalledTimes(1);
    // 重复启动不该再挂一个 timer。
    store.startSweeper();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    store.stopSweeper();
  });

  it('主动删除与空闲回收的语义分开', () => {
    const store = makeStore();
    const session = store.create(makeFakeRuntime().runtime);

    expect(store.remove(session.id)).toBe('removed');
    expect(store.remove(session.id)).toBe('unknown');
    expect(store.size()).toBe(0);
  });

  it('提交次数记在判题槽位上，单调递增', () => {
    const store = makeStore();
    const session = store.create(makeFakeRuntime().runtime);

    expect(store.recordSubmit(session.id)).toBe(true);
    expect(store.recordSubmit(session.id)).toBe(true);
    const found = store.lookup(session.id);
    expect(found.ok && found.session.judge.submits).toBe(2);
    expect(store.recordSubmit('未知会话')).toBe(false);
  });

  it('已回收 id 的备忘有上限，不会无限增长', () => {
    const fake = clock();
    const store = makeStore({ now: fake.now, idleMs: 1, forgottenAfter: 2 });
    const ids = [0, 1, 2].map(() => store.create(makeFakeRuntime().runtime).id);
    const [first, , third] = ids;

    fake.advance(10);
    expect(store.reap()).toHaveLength(3);
    // 最旧的 id 已经被忘掉：报 not_found 而不是 session_expired。
    expect(store.lookup(first)).toEqual({ ok: false, expired: false });
    expect(store.lookup(third)).toEqual({ ok: false, expired: true });
  });

  it('id 冲突时重新生成，不会覆盖已有会话', () => {
    const sequence = ['a'.repeat(32), 'a'.repeat(32), 'b'.repeat(32)];
    let next = 0;
    const store = makeStore({ newId: () => sequence[next++] ?? 'c'.repeat(32) });

    expect(store.create(makeFakeRuntime().runtime).id).toBe('a'.repeat(32));
    // 第二个会话拿到重复 id，必须重新生成而不是覆盖前一个。
    expect(store.create(makeFakeRuntime().runtime).id).toBe('b'.repeat(32));
    expect(store.size()).toBe(2);
  });
});
