import { randomBytes } from 'node:crypto';
import { SESSION_IDLE_MS } from '@pwn2block/shared';
import type { DebugInstance, EngineRuntime, HistoryDepth } from '@pwn2block/shared';

/**
 * 进程内会话存储（04 §1、§6）。MVP 不做持久化，服务重启后会话丢失。
 *
 * 三条硬约束：
 * - `sessionId` 是 128 位随机值，持有即凭证（bearer capability），不可枚举。
 * - **每会话串行锁**：同一会话的请求排队执行，绝不并发（04 §1）。
 * - 空闲 `SESSION_IDLE_MS` 回收，定时清理的 timer 必须 `unref()`，不阻止进程退出。
 *
 * 一个会话含两个实例槽位：`debug`（草稿纸，`actions` 作用于它）与 `judge`（判题）。
 * D1 的判题是 `runtime.replaySubmit` 的一次性纯回放（04 §5.1），没有常驻句柄；
 * `judge` 槽位先只记提交次数，B03 接入后在这里换成实例句柄，调用方不需要改。
 */

/** 判题实例槽位。 */
export interface JudgeSlot {
  readonly kind: 'stateless-replay';
  /** 该会话已提交的次数，单调递增，不随回退减少。 */
  readonly submits: number;
}

export interface Session {
  readonly id: string;
  readonly challengeId: string;
  readonly runtime: EngineRuntime;
  /** 调试实例：草稿纸。 */
  readonly debug: DebugInstance;
  /** 判题实例槽位。 */
  readonly judge: JudgeSlot;
  /** 回退深度现取自调试实例，避免在会话里存一份会过期的副本（04 §3）。 */
  readonly history: () => HistoryDepth;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface SessionStoreOptions {
  /** 空闲多久算过期，默认 30 分钟（`SESSION_IDLE_MS`）。 */
  readonly idleMs?: number;
  /** 定时清理周期，默认空闲时间的一半。 */
  readonly sweepIntervalMs?: number;
  /** 取当前时间的函数，测试注入假时钟。 */
  readonly now?: () => number;
  /** 生成会话 id，测试注入确定性 id。 */
  readonly newId?: () => string;
  /** 记住多少个已回收的 id，用来把 `not_found` 与 `session_expired` 区分开。 */
  readonly forgottenAfter?: number;
}

export type SessionLookup =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly expired: boolean };

export type SessionRun<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly expired: boolean };

export type SessionRemoval = 'removed' | 'expired' | 'unknown';

/** 定时清理周期：空闲时间的一半，保证回收在 1.5×idle 内发生。 */
export const DEFAULT_SWEEP_INTERVAL_MS = SESSION_IDLE_MS / 2;

const DEFAULT_FORGOTTEN_AFTER = 1024;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly forgotten = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly idleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly forgottenAfter: number;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(16).toString('hex'));
    this.forgottenAfter = options.forgottenAfter ?? DEFAULT_FORGOTTEN_AFTER;
  }

  /** 建会话：两个实例槽位一次建好，返回不可变记录。 */
  create(runtime: EngineRuntime): Session {
    const at = this.now();
    const debug = runtime.createDebugInstance();
    const session: Session = {
      id: this.freshId(),
      challengeId: runtime.challengeId,
      runtime,
      debug,
      judge: { kind: 'stateless-replay', submits: 0 },
      history: () => debug.historyDepth(),
      createdAt: at,
      lastActiveAt: at,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** 只读查找，不刷新活跃时间、不加锁；用于 DELETE 这类不读状态的路径。 */
  lookup(id: string): SessionLookup {
    const session = this.sessions.get(id);
    if (session !== undefined) return { ok: true, session };
    return { ok: false, expired: this.forgotten.has(id) };
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * 在会话锁里执行任务：同一会话的请求排队，先到先执行（04 §1）。
   * 任务抛错会原样传给调用方，但**不会卡住后续请求**。
   */
  async run<T>(id: string, task: (session: Session) => T | Promise<T>): Promise<SessionRun<T>> {
    const idle = this.lookup(id);
    if (!idle.ok) return { ok: false, expired: idle.expired };

    const previous = this.tails.get(id) ?? Promise.resolve();
    const execute = async (): Promise<SessionRun<T>> => {
      const found = this.sessions.get(id);
      if (found === undefined) return { ok: false, expired: this.forgotten.has(id) };
      const value = await task(this.touch(found));
      return { ok: true, value };
    };
    const chained = previous.then(execute, execute);
    const tail = chained.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return chained;
  }

  /** 记一次提交（判题槽位的计数器），会话不存在时返回 false。 */
  recordSubmit(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    const next: Session = {
      ...session,
      judge: { ...session.judge, submits: session.judge.submits + 1 },
    };
    this.sessions.set(id, next);
    return true;
  }

  /** 主动结束会话（DELETE）。与空闲回收区分开，重复删除报 `unknown` 而不是 `expired`。 */
  remove(id: string): SessionRemoval {
    if (this.sessions.delete(id)) return 'removed';
    return this.forgotten.has(id) ? 'expired' : 'unknown';
  }

  /** 回收空闲会话，返回被回收的 id。定时清理与测试都走这里。 */
  reap(at: number = this.now()): string[] {
    const reaped: string[] = [];
    for (const [id, session] of this.sessions) {
      if (at - session.lastActiveAt < this.idleMs) continue;
      this.sessions.delete(id);
      this.remember(id);
      reaped.push(id);
    }
    return reaped;
  }

  startSweeper(): void {
    if (this.sweeper !== undefined) return;
    const timer = setInterval(() => {
      this.reap();
    }, this.sweepIntervalMs);
    // 不阻止进程退出：测试与服务重启时不该有悬挂的 timer。
    timer.unref();
    this.sweeper = timer;
  }

  stopSweeper(): void {
    if (this.sweeper === undefined) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private touch(session: Session): Session {
    const next: Session = { ...session, lastActiveAt: this.now() };
    this.sessions.set(session.id, next);
    return next;
  }

  private freshId(): string {
    let id = this.newId();
    while (this.sessions.has(id)) id = this.newId();
    this.forgotten.delete(id);
    return id;
  }

  private remember(id: string): void {
    this.forgotten.add(id);
    while (this.forgotten.size > this.forgottenAfter) {
      const oldest = this.forgotten.values().next().value;
      if (oldest === undefined) return;
      this.forgotten.delete(oldest);
    }
  }
}
