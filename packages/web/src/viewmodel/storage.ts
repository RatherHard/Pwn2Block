/**
 * 本地保存（05 §3.1、09 §3.2）：**画布存档**与「刷新后接回会话」所需的会话记录。
 *
 * 三条硬约束：
 * 1. **存储位置与键名归 D**（`localStorage`，按题目 id 区分）；**序列化格式归 H**
 *    （`BlocklyBridge.save()`），这里只搬运不解释内容。
 * 2. 画布存档与会话记录分开存、分开读：05 §3.1 要求刷新后**先还原画布、再还原会话状态**。
 * 3. 丢失 / 损坏 / 被禁用 / 写不进去，都只是「便利消失」，绝不影响做题（同 `viewmodel/hints.ts`）。
 *
 * 会话记录里除了 `sessionId` 还带上 `cursor` / `results` / `actionsLength`：调试实例的**服务端**
 * 状态能靠 `GET /api/sessions/:id` 取回，但「程序区走到第几条动作」是纯前端的指针，
 * 服务端没有这个字段（04 §1.1）。不存它就会出现「服务端执行到第 3 条、程序区还停在开头」，
 * 下一次试运行会把已经执行过的动作再提交一遍。
 */
import type { ActionResultView } from '@pwn2block/shared';
import { isViewKind, type ViewKind } from './views';

export const STORAGE_VERSION = 1;

/** 当前视图标签的键名（设计 §3.1）：所有题目共用一个值，不按题目 id 区分。 */
export const VIEW_TAB_KEY = 'p2b:view-tab';

/** 会话记录的形状：读的时候逐字段校验，任何一项不像就整条丢弃（不猜）。 */
export interface StoredSession {
  readonly sessionId: string;
  readonly cursor: number;
  readonly results: readonly ActionResultView[];
  /** 存这条记录时产物有多少条动作：还原后对不上就不认这个 cursor（见 storage 头部注释）。 */
  readonly actionsLength: number;
}

/** 存取接口（与 `viewmodel/hints.ts` 同一形状；`removeItem` 可缺省）。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 画布存档的键名（05 §3.1：按题目 id 区分）。 */
export function canvasStorageKey(challengeId: string): string {
  return `pwn2block.canvas.v${STORAGE_VERSION}.${challengeId}`;
}

/** 会话记录的键名（同上）。 */
export function sessionStorageKey(challengeId: string): string {
  return `pwn2block.session.v${STORAGE_VERSION}.${challengeId}`;
}

/** 同一次打开始终保留一份缓存；存储禁用/写满时，换题仍不会丢失画布与进度。 */
export function cachedStore(persistent?: KeyValueStore): KeyValueStore {
  const cache = new Map<string, string | null>();
  return {
    getItem(key) {
      if (cache.has(key)) return cache.get(key) ?? null;
      try { return persistent?.getItem(key) ?? null; } catch { return null; }
    },
    setItem(key, value) {
      cache.set(key, value);
      try { persistent?.setItem(key, value); } catch { /* 本次打开仍可恢复。 */ }
    },
    removeItem(key) {
      cache.set(key, null);
      try {
        if (persistent?.removeItem) persistent.removeItem(key);
        else persistent?.setItem(key, '');
      } catch { /* 缓存的删除优先于无法更新的旧存档。 */ }
    },
  };
}

/**
 * 默认存储：没有 `localStorage`、或被浏览器策略拦下（隐私模式、iframe 沙箱）时返回 `undefined`。
 * 显式检测而不是 try 一下再说：调用方要能一眼看出「这台环境不保存」。
 */
export function defaultStore(): KeyValueStore | undefined {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return undefined;
    // 真写一次：有些环境 `localStorage` 存在但写入必抛（配额 0）。
    const probe = `pwn2block.probe.v${STORAGE_VERSION}`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

function read(store: KeyValueStore | undefined, key: string): string | undefined {
  if (store === undefined) return undefined;
  try {
    return store.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(store: KeyValueStore | undefined, key: string, value: string): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    // 配额满 / 被禁写：本地保存失效，但做题必须继续。
    return false;
  }
}

function remove(store: KeyValueStore | undefined, key: string): boolean {
  if (store === undefined) return false;
  try {
    if (store.removeItem !== undefined) {
      store.removeItem(key);
      return true;
    }
    // 没有 `removeItem` 的实现退化成写空串：读取侧一律把空串当「没有」。
    store.setItem(key, '');
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读画布存档。`undefined` 表示「没有存档或存档不可用」——包含 JSON 坏掉、不是对象、
 * 以及空的 `{}`（`{}` 在 H 的桥上等价于清空画布，装回去只会把用户的程序抹掉，所以不认它）。
 */
export function readCanvas(
  store: KeyValueStore | undefined,
  challengeId: string,
): Record<string, unknown> | undefined {
  const raw = read(store, canvasStorageKey(challengeId));
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || Object.keys(parsed).length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 存画布存档；返回是否真的落盘（`false` 只表示本地保存不可用，调用方不该因此中断做题）。 */
export function writeCanvas(
  store: KeyValueStore | undefined,
  challengeId: string,
  state: Record<string, unknown>,
): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(state);
  } catch {
    // 序列化出来的东西不可 stringify（循环引用等）：宁可什么都不存，也不存半个。
    return false;
  }
  return write(store, canvasStorageKey(challengeId), raw);
}

export function clearCanvas(store: KeyValueStore | undefined, challengeId: string): boolean {
  return remove(store, canvasStorageKey(challengeId));
}

function isActionResult(value: unknown): value is ActionResultView {
  if (!isPlainObject(value)) return false;
  return typeof value['ok'] === 'boolean' && typeof value['action'] === 'string';
}

/** 读会话记录；任何一项不合契约就返回 `undefined`（不猜、不修补）。 */
export function readSession(
  store: KeyValueStore | undefined,
  challengeId: string,
): StoredSession | undefined {
  const raw = read(store, sessionStorageKey(challengeId));
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return undefined;
    const sessionId = parsed['sessionId'];
    const cursor = parsed['cursor'];
    const results = parsed['results'];
    const actionsLength = parsed['actionsLength'];
    // 服务端会话 id 至少 16 字符（shared 的 Schema），短的一律当脏数据。
    if (typeof sessionId !== 'string' || sessionId.length < 16) return undefined;
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) return undefined;
    if (typeof actionsLength !== 'number' || !Number.isInteger(actionsLength) || actionsLength < 0) {
      return undefined;
    }
    if (!Array.isArray(results) || !results.every(isActionResult)) return undefined;
    return { sessionId, cursor, results, actionsLength };
  } catch {
    return undefined;
  }
}

export function writeSession(
  store: KeyValueStore | undefined,
  challengeId: string,
  session: StoredSession,
): boolean {
  try {
    return write(store, sessionStorageKey(challengeId), JSON.stringify(session));
  } catch {
    return false;
  }
}

export function clearSession(store: KeyValueStore | undefined, challengeId: string): boolean {
  return remove(store, sessionStorageKey(challengeId));
}

/**
 * 读上次的视图标签。读失败（存储被禁、`getItem` 抛错）或读到非法值时回退到栈：
 * 记住标签只是便利功能，不该让一份坏数据挡住开局。
 */
export function readViewTab(store: KeyValueStore | undefined): ViewKind {
  const raw = read(store, VIEW_TAB_KEY);
  return isViewKind(raw) ? raw : 'stack';
}

/** 记下当前视图标签。写失败不提示（`write` 已吞掉异常）：丢的只是下次开局的默认标签。 */
export function writeViewTab(store: KeyValueStore | undefined, kind: ViewKind): void {
  write(store, VIEW_TAB_KEY, kind);
}
