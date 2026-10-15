/**
 * 服务端限流与并发会话上限（04 §6「必须的防护」）。
 *
 * 为什么数字放在服务端而不是 `packages/shared`：限流是**部署策略**，不是跨包契约。
 * 引擎与前端都不需要知道阈值，调阈值也不该动契约；每次 `buildApp()` 各取一份配置，
 * 测试按需收紧或放宽，互不影响（不做全局单例）。
 */

/** 一个滑动窗口：`windowMs` 毫秒内最多放行 `limit` 次。 */
export interface WindowLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/** 存活会话数上限（04 §6）：全局与每 IP 各一个。 */
export interface SessionLimits {
  /** 同一客户端 IP 的存活会话数上限。 */
  readonly perIp: number;
  /** 全进程存活会话数上限。 */
  readonly global: number;
}

export interface RateLimitOptions {
  /** 普通 API 请求的每 IP 限流。 */
  readonly request?: Partial<WindowLimit>;
  /** 提交接口的每 IP 限流：独立桶，不占普通请求的配额（04 §6）。 */
  readonly submit?: Partial<WindowLimit>;
  /** 存活会话数上限。 */
  readonly sessions?: Partial<SessionLimits>;
  /** 取当前时间的函数，测试注入假时钟；默认 `Date.now`。 */
  readonly now?: () => number;
  /** 最多跟踪多少个客户端 IP，超出后淘汰最久未访问的（见 `SlidingWindowLimiter`）。 */
  readonly maxTrackedKeys?: number;
}

export interface RateLimitConfig {
  readonly request: WindowLimit;
  readonly submit: WindowLimit;
  readonly sessions: SessionLimits;
  readonly now: () => number;
  readonly maxTrackedKeys: number;
}

/**
 * 默认值。04 §6 要求这些防护**缺省就是开着的**，所以默认不是「关闭」，只是足够宽松。
 *
 * 量级依据：
 * - **会话内存**：一份会话含两个实例，外加指令层环形缓冲（04 §3：单条快照 4–8KB、N=64，
 *   即 256–512KB），乐观按单会话 ≤1MB 估。全局 128 → 最坏约 128MB 常驻，单进程可承受；
 *   每 IP 32 → 单一来源最坏约 32MB。
 * - **每 IP 32 而非更小**：交付期的契约测试在**同一个 `buildApp()`** 里连续创建会话
 *   （`c03-real-engine.test.ts` 单文件最多约 20 个存活会话），默认值不能把既有用例打红。
 *   它拦的是「一个来源无限堆会话」，不是正常使用。部署时按 `global × 单会话内存 ≤ 进程预算`
 *   收紧，并把更细的 IP 限制交给反向代理（07 §7）。
 * - **普通请求 600 次 / 60s（≈10 req/s）**：学习者交互是「点一下发一批动作」，峰值远低于此；
 *   它拦的是脚本化暴力扫描。静态资源不在此列（一次页面加载要取几十个文件），见 `app.ts`。
 * - **提交 60 次 / 60s**：`/submit` 每次都要从初态回放整份 payload（可能上千个动作，
 *   每个 `run` 上限一万条指令），代价比普通请求高一到两个数量级，所以是更紧的独立桶。
 *   注意 04 §1「提交次数不限」是**产品语义**（失败可以无限次再来）；这里的限流只是资源保护，
 *   限制的是单位时间内的提交速率，不改变总次数不限。
 * - **跟踪 2048 个 IP**：每个 IP 的窗口最多留 `limit` 个时间戳，最坏约
 *   2048×600×8B ≈ 10MB，有界。
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  request: { limit: 600, windowMs: 60_000 },
  submit: { limit: 60, windowMs: 60_000 },
  sessions: { perIp: 32, global: 128 },
  now: Date.now,
  maxTrackedKeys: 2048,
};

/**
 * 配置错误必须立刻炸掉，不能静默退化成「不限流」：
 * `limit` 为 `NaN` 时所有比较都为假，防护会被无声关掉。
 */
function positiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`限流配置 ${name} 必须是正整数，收到 ${String(value)}`);
  }
  return value;
}

function windowOf(name: string, limit: WindowLimit): WindowLimit {
  return {
    limit: positiveInt(`${name}.limit`, limit.limit),
    windowMs: positiveInt(`${name}.windowMs`, limit.windowMs),
  };
}

/** 合并默认值与调用方覆盖项；只覆盖显式给出的字段。 */
export function resolveRateLimit(options: RateLimitOptions = {}): RateLimitConfig {
  const sessions = { ...DEFAULT_RATE_LIMIT.sessions, ...options.sessions };
  return {
    request: windowOf('request', { ...DEFAULT_RATE_LIMIT.request, ...options.request }),
    submit: windowOf('submit', { ...DEFAULT_RATE_LIMIT.submit, ...options.submit }),
    sessions: {
      perIp: positiveInt('sessions.perIp', sessions.perIp),
      global: positiveInt('sessions.global', sessions.global),
    },
    now: options.now ?? DEFAULT_RATE_LIMIT.now,
    maxTrackedKeys: positiveInt(
      'maxTrackedKeys',
      options.maxTrackedKeys ?? DEFAULT_RATE_LIMIT.maxTrackedKeys,
    ),
  };
}

export type LimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * 滑动窗口计数（04 §6「按 IP 限流」）。
 *
 * - 精确滑动窗口：每个 key 只留窗口内的命中时间戳，判定是「窗口内已有 N 次」，
 *   而不是固定窗口那种「跨窗口边界可以打双倍」的近似。
 * - **被拒绝的请求不记录**：否则攻击者每打一次就把封锁线往后推，等于自我续期。
 * - 内存有界：判定时顺带丢弃过期时间戳；key 数超过 `maxTrackedKeys` 时先清理窗口已完全过期的
 *   key，再按最久未访问淘汰。代价是「用大量伪造源 IP 可以挤掉别人的计数」——
 *   与「Map 无限增长被撑爆」相比这是可接受的取舍，真正的每 IP 限制应由反向代理承担（07 §7）。
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly window: WindowLimit;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(window: WindowLimit, now: () => number, maxKeys: number) {
    this.window = window;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** 记一次访问并判定；`allowed: false` 时调用方不该继续处理请求。 */
  hit(key: string): LimitDecision {
    const at = this.now();
    const fresh = this.prune(key, at);
    if (fresh.length >= this.window.limit) {
      const oldest = fresh[0];
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.window.windowMs - at) };
    }

    fresh.push(at);
    // Map 保持插入序：重新 set 让这个 key 成为「最近访问」，淘汰时先丢最久未访问的。
    this.hits.delete(key);
    this.hits.set(key, fresh);
    this.evict(at);
    return { allowed: true };
  }

  /** 清空计数：`app.close()` 时调用，不留下跨实例的痕迹（04 §6）。 */
  clear(): void {
    this.hits.clear();
  }

  /** 丢弃过期时间戳，返回窗口内仍然有效的那一段。 */
  private prune(key: string, at: number): number[] {
    const seen = this.hits.get(key) ?? [];
    const from = at - this.window.windowMs;
    return seen.filter((stamp) => stamp > from);
  }

  private evict(at: number): void {
    if (this.hits.size <= this.maxKeys) return;
    const from = at - this.window.windowMs;
    for (const [key, stamps] of this.hits) {
      const last = stamps[stamps.length - 1];
      if (last === undefined || last <= from) this.hits.delete(key);
    }
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }
}
