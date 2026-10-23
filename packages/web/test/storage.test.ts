// @vitest-environment jsdom
/**
 * 本地保存的单测（05 §3.1、09 §3.2，D5 批次 2）。
 *
 * 这一层是「刷新后还能接着上次」的全部依据，所以坏数据必须**整条丢弃**而不是猜着修补：
 * 一个乱套的 cursor 会让下一次试运行把已经执行过的动作再提交一遍。
 */
import { describe, expect, it } from 'vitest';
import {
  cachedStore,
  clearSession,
  defaultStore,
  readSession,
  sessionStorageKey,
  STORAGE_VERSION,
  writeSession,
  type KeyValueStore,
  type StoredSession,
} from '../src/viewmodel/storage';

/** 内存替身：顺带记录写入，方便断言键名。 */
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

const SESSION_ID = 'a'.repeat(32);

function validSession(): StoredSession {
  return {
    sessionId: SESSION_ID,
    cursor: 2,
    results: [
      { ok: true, action: 'step' },
      { ok: false, action: 'ret', error: { code: 'invalid_ip', message: '指令指针越界' } },
    ],
    actionsLength: 3,
  };
}

describe('本地保存：键名与版本（05 §3.1）', () => {
  it('键名按题目 id 与版本号区分', () => {
    expect(sessionStorageKey('ret2win')).toBe(`pwn2block.session.v${STORAGE_VERSION}.ret2win`);
    expect(sessionStorageKey('a')).not.toBe(sessionStorageKey('b'));
  });

  it('没有存储（node / 隐私模式）时读写都安全退化', () => {
    expect(readSession(undefined, 'ret2win')).toBeUndefined();
    expect(writeSession(undefined, 'ret2win', validSession())).toBe(false);
    expect(clearSession(undefined, 'ret2win')).toBe(false);
  });

  it('写入抛错（配额满）时返回 false，不抛出', () => {
    const full: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(writeSession(full, 'ret2win', validSession())).toBe(false);
    expect(clearSession(full, 'ret2win')).toBe(false);
  });
});

describe('本地保存：会话记录（04 §1.1、05 §3.1）', () => {
  it('完整记录可以往返', () => {
    const store = memoryStore();
    expect(writeSession(store, 'ret2win', validSession())).toBe(true);
    expect(readSession(store, 'ret2win')).toEqual(validSession());
  });

  it('缺字段 / 类型不对 / 会话 id 太短一律丢弃', () => {
    const store = memoryStore();
    const key = sessionStorageKey('ret2win');
    const bad: readonly Record<string, unknown>[] = [
      { cursor: 0, results: [], actionsLength: 0 }, // 没有 sessionId
      { sessionId: 'short', cursor: 0, results: [], actionsLength: 0 }, // 比 shared 的 min(16) 短
      { sessionId: SESSION_ID, cursor: -1, results: [], actionsLength: 0 },
      { sessionId: SESSION_ID, cursor: 1.5, results: [], actionsLength: 0 },
      { sessionId: SESSION_ID, cursor: 0, results: [], actionsLength: -1 },
      { sessionId: SESSION_ID, cursor: 0, results: [{ ok: 'yes', action: 'step' }], actionsLength: 0 },
      { sessionId: SESSION_ID, cursor: 0, results: {}, actionsLength: 0 },
    ];
    for (const value of bad) {
      store.setItem(key, JSON.stringify(value));
      expect(readSession(store, 'ret2win')).toBeUndefined();
    }
    // 多一个未知字段不影响读取（旧版本写的记录不会被新版本当成脏数据）。
    store.setItem(key, JSON.stringify({ ...validSession(), 备注: '手改过' }));
    expect(readSession(store, 'ret2win')?.sessionId).toBe(SESSION_ID);
  });

  it('坏 JSON 与空串当「没有记录」', () => {
    const store = memoryStore();
    const key = sessionStorageKey('ret2win');
    store.setItem(key, 'not json');
    expect(readSession(store, 'ret2win')).toBeUndefined();
    store.setItem(key, '');
    expect(readSession(store, 'ret2win')).toBeUndefined();
  });

  it('清除后读不到', () => {
    const store = memoryStore();
    writeSession(store, 'ret2win', validSession());
    expect(clearSession(store, 'ret2win')).toBe(true);
    expect(readSession(store, 'ret2win')).toBeUndefined();
  });

  it('没有 `removeItem` 的实现退化成写空串，读回来仍然是「没有」', () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    writeSession(store, 'ret2win', validSession());
    expect(clearSession(store, 'ret2win')).toBe(true);
    expect(readSession(store, 'ret2win')).toBeUndefined();
  });

  it('`defaultStore()` 在 jsdom 里拿到真存储，写进去读得回来', () => {
    const store = defaultStore();
    expect(store).toBeDefined();
    if (store === undefined) return;
    expect(writeSession(store, 'probe', validSession())).toBe(true);
    expect(readSession(store, 'probe')?.sessionId).toBe(SESSION_ID);
    clearSession(store, 'probe');
  });
});


describe('cached storage during challenge switching', () => {
  it('reads existing saves and persists new writes and removals', () => {
    const persistent = memoryStore();
    persistent.setItem('saved', 'old');
    const store = cachedStore(persistent);
    expect(store.getItem('saved')).toBe('old');
    store.setItem('saved', 'new');
    expect(store.getItem('saved')).toBe('new');
    expect(persistent.getItem('saved')).toBe('new');
    store.removeItem?.('saved');
    expect(store.getItem('saved')).toBeNull();
    expect(persistent.getItem('saved')).toBeNull();
  });

  it('keeps progress and tombstones when persistent writes fail', () => {
    const persistent: KeyValueStore = {
      getItem: () => 'stale',
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const store = cachedStore(persistent);
    store.setItem('saved', 'current');
    expect(store.getItem('saved')).toBe('current');
    store.removeItem?.('saved');
    expect(store.getItem('saved')).toBeNull();
    expect(persistent.getItem('saved')).toBe('stale');
  });

  it('works without browser storage, including blocked reads', () => {
    for (const persistent of [undefined, {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    }]) {
      const store = cachedStore(persistent);
      expect(store.getItem('saved')).toBeNull();
      store.setItem('saved', 'current');
      expect(store.getItem('saved')).toBe('current');
      store.removeItem?.('saved');
      expect(store.getItem('saved')).toBeNull();
    }
  });
});
