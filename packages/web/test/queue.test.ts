import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '../src/viewmodel/queue';

/** 让微任务队列跑空：队列本身只用 Promise 链，没有定时器。 */
async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** 等到条件成立：串行队列的推进要跨好几层 Promise 链，按次数 flush 容易数错。 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`等待超时：${label}`);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('串行请求队列（04 §1）', () => {
  it('同一时刻只有一个任务在飞，按加入顺序执行', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;

    const make = (name: string, gate: Promise<void>) => async (): Promise<string> => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(`开始:${name}`);
      await gate;
      order.push(`结束:${name}`);
      running -= 1;
      return name;
    };

    const first = deferred();
    const second = deferred();
    const a = queue.push(make('a', first.promise));
    const b = queue.push(make('b', second.promise));
    const c = queue.push(make('c', Promise.resolve()));

    await flush();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['开始:a']);
    expect(queue.inFlight).toBe(true);
    expect(queue.queued).toBe(2);

    first.resolve();
    await until(() => order.includes('开始:b'), '第二个任务开始');
    expect(order).toEqual(['开始:a', '结束:a', '开始:b']);
    expect(maxRunning).toBe(1);

    second.resolve();
    await until(() => order.includes('结束:c'), '第三个任务结束');
    expect(order).toEqual(['开始:a', '结束:a', '开始:b', '结束:b', '开始:c', '结束:c']);
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    await expect(c).resolves.toBe('c');
    expect(queue.inFlight).toBe(false);
    expect(queue.queued).toBe(0);
  });

  it('一个任务失败不会卡住后面的任务', async () => {
    const queue = createSerialQueue();
    const done: string[] = [];
    const failed = queue.push(async () => {
      throw new Error('第一个任务失败');
    });
    const second = queue.push(async () => {
      done.push('第二个');
      return 2;
    });

    await expect(failed).rejects.toThrow('第一个任务失败');
    await expect(second).resolves.toBe(2);
    expect(done).toEqual(['第二个']);
  });

  it('onChange 报告飞行与排队状态', async () => {
    const snapshots: string[] = [];
    const queue = createSerialQueue({
      onChange: () => snapshots.push(`${queue.inFlight}/${queue.queued}`),
    });
    const gate = deferred();
    void queue.push(async () => {
      await gate.promise;
    });
    expect(snapshots.at(0)).toBe('false/1');
    await flush();
    expect(snapshots).toContain('true/0');
    gate.resolve();
    await queue.drain();
    expect(snapshots.at(-1)).toBe('false/0');
  });
});
