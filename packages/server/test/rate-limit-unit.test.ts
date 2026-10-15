import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT, SlidingWindowLimiter, resolveRateLimit } from '../src/limits';
import { SessionStore } from '../src/sessions';
import { makeFakeRuntime } from './support';

/**
 * 限流器的单元面（04 §6）：滑动窗口、默认值、会话存活计数。
 * HTTP 面在 `rate-limit.test.ts`；这里不碰网络，时间用假时钟精确推进。
 */

function makeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('SlidingWindowLimiter（04 §6 按 IP 限流）', () => {
  it('窗口内放行到上限；被拒不记录（不自我续期）；窗口推进后恢复', () => {
    const clock = makeClock();
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 }, clock.now, 8);

    expect(limiter.hit('ip')).toEqual({ allowed: true });
    expect(limiter.hit('ip')).toEqual({ allowed: true });
    // 第 3 次拒绝：`Retry-After` 指向最早一次命中过期的那一刻（t0 + 1000 - now）。
    expect(limiter.hit('ip')).toEqual({ allowed: false, retryAfterMs: 1000 });
    // 连续被拒不会把窗口往后推：再过 500ms 时剩余等待仍在倒数。
    clock.advance(500);
    expect(limiter.hit('ip')).toEqual({ allowed: false, retryAfterMs: 500 });
    clock.advance(499);
    expect(limiter.hit('ip')).toEqual({ allowed: false, retryAfterMs: 1 });
    clock.advance(1);
    expect(limiter.hit('ip')).toEqual({ allowed: true });
  });

  it('不同 key 互不影响（就是每 IP 的隔离）', () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 }, () => 0, 8);

    expect(limiter.hit('ip-a')).toEqual({ allowed: true });
    expect(limiter.hit('ip-a').allowed).toBe(false);
    expect(limiter.hit('ip-b').allowed).toBe(true);
  });

  it('跟踪的 key 数有上限：超出后淘汰最久未访问的，内存不无限增长', () => {
    const clock = makeClock();
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000 }, clock.now, 2);

    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('c').allowed).toBe(true); // 挤掉最久未访问的 'a'
    // 'a' 的计数已被淘汰，所以它不再被判为超限（代价：大量伪造源 IP 可以挤掉别人的计数）。
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('clear() 清空计数（app.close() 走的就是它）', () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 }, () => 0, 8);

    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(false);
    limiter.clear();
    expect(limiter.hit('ip').allowed).toBe(true);
  });
});

describe('resolveRateLimit（默认值必须在，且不能静默失效）', () => {
  it('缺省配置就是开着的：连打默认次数会被拒，而不是无限放行', () => {
    // 不写死 600：断言的是「默认值确实生效」，默认值本身由 limits.ts 的注释给出依据。
    const limiter = new SlidingWindowLimiter(DEFAULT_RATE_LIMIT.request, () => 0, 4);
    for (let i = 0; i < DEFAULT_RATE_LIMIT.request.limit; i += 1) {
      expect(limiter.hit('ip').allowed).toBe(true);
    }
    expect(limiter.hit('ip').allowed).toBe(false);

    expect(DEFAULT_RATE_LIMIT.submit.limit).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT.sessions.perIp).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT.sessions.global).toBeGreaterThan(0);
  });

  it('不传选项时等于默认值；部分覆盖只改指定字段', () => {
    expect(resolveRateLimit()).toEqual(DEFAULT_RATE_LIMIT);

    const config = resolveRateLimit({
      request: { limit: 5 },
      sessions: { perIp: 1 },
      now: () => 42,
    });
    expect(config.request).toEqual({ limit: 5, windowMs: DEFAULT_RATE_LIMIT.request.windowMs });
    expect(config.submit).toEqual(DEFAULT_RATE_LIMIT.submit);
    expect(config.sessions).toEqual({ perIp: 1, global: DEFAULT_RATE_LIMIT.sessions.global });
    expect(config.now()).toBe(42);
    expect(config.maxTrackedKeys).toBe(DEFAULT_RATE_LIMIT.maxTrackedKeys);
  });

  it('非法值立刻抛错，不静默退化成不限流（NaN 会让所有比较为假）', () => {
    for (const bad of [
      { request: { limit: 0 } },
      { request: { limit: Number.NaN } },
      { request: { windowMs: -1 } },
      { submit: { limit: 1.5 } },
      { sessions: { perIp: 0 } },
      { sessions: { global: Number.POSITIVE_INFINITY } },
      { maxTrackedKeys: 0 },
    ]) {
      expect(() => resolveRateLimit(bad)).toThrow(/限流配置/);
    }
  });
});

describe('SessionStore 的存活会话计数（04 §6 每 IP / 全局上限的口径）', () => {
  it('countByOwner 只数存活会话；DELETE 与空闲回收都释放', () => {
    const clock = makeClock();
    const store = new SessionStore({ now: clock.now, idleMs: 1000 });
    const runtime = makeFakeRuntime().runtime;

    const first = store.create(runtime, 'ip-a');
    store.create(runtime, 'ip-a');
    store.create(runtime, 'ip-b');
    expect(store.countByOwner('ip-a')).toBe(2);
    expect(store.countByOwner('ip-b')).toBe(1);
    expect(store.countByOwner('ip-c')).toBe(0);

    expect(store.remove(first.id)).toBe('removed');
    expect(store.countByOwner('ip-a')).toBe(1);

    clock.advance(1000);
    expect(store.reap()).toHaveLength(2);
    expect(store.countByOwner('ip-a')).toBe(0);
    expect(store.countByOwner('ip-b')).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('clear() 把计数与配额一起归零（app.close() 走的就是它）', () => {
    const store = new SessionStore();
    const runtime = makeFakeRuntime().runtime;

    store.create(runtime, 'ip-a');
    store.create(runtime, 'ip-a');
    expect(store.countByOwner('ip-a')).toBe(2);

    store.clear();
    expect(store.size()).toBe(0);
    expect(store.countByOwner('ip-a')).toBe(0);
    // 归零之后还能重新建：配额没有残留。
    store.create(runtime, 'ip-a');
    expect(store.countByOwner('ip-a')).toBe(1);
  });

  it('ownerKey 默认为空串，`create(runtime)` 的单参用法保持可用', () => {
    const store = new SessionStore();
    store.create(makeFakeRuntime().runtime);
    expect(store.countByOwner('')).toBe(1);
    expect(store.countByOwner('ip-a')).toBe(0);
  });
});
