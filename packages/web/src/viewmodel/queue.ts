/**
 * 串行请求队列（04 §1、05 §6）。纯逻辑：不碰 DOM、不看时间，node 环境可测。
 *
 * 为什么需要它：04 §1 要求「同一会话同一时刻只处理一个请求」。界面上的按钮是异步的，
 * 用户连点「单步」会同时发出多个请求，服务端虽然有每会话锁，但到达顺序不保证，
 * 结果就是后到的响应覆盖先到的——学习者在程序区看到的当前执行位置会跳。
 * 所以**前端先串起来**：同时只有一个请求在飞，其余按点击顺序排队，任何一个响应到达后
 * 下一个才出发。
 *
 * 关键约定：`push` 接受的是**任务函数**而不是已经算好的结果。动作（提交哪些 action）
 * 必须在任务真正开始执行时才根据最新状态计算，否则连点两次「单步」会把同一个动作提交两遍。
 */
export interface SerialQueueOptions {
  /** 队列状态变化时回调（界面据此显示「请求中 / 排队中」）。 */
  readonly onChange?: () => void;
}

export interface SerialQueue {
  /** 是否有请求正在飞：同一时刻最多一个（04 §1）。 */
  readonly inFlight: boolean;
  /** 已排队但还没开始的任务数（不含正在飞的那个）。 */
  readonly queued: number;
  /**
   * 排队一个任务。返回值是该任务自己的 Promise（成功/失败都是它自己的结果，不会被前一个任务的
   * 失败连坐）。任务抛错不会卡住队列：后续任务照常按序执行。
   */
  push<T>(task: () => Promise<T>): Promise<T>;
  /** 排空队列；测试用来等全部任务结束。 */
  drain(): Promise<void>;
}

export function createSerialQueue(options: SerialQueueOptions = {}): SerialQueue {
  /** 队列尾：一个**永不拒绝**的 Promise，只表示「前面的任务都结束了」。 */
  let tail: Promise<void> = Promise.resolve();
  let inFlight = false;
  let queued = 0;
  const notify = options.onChange;

  return {
    get inFlight(): boolean {
      return inFlight;
    },

    get queued(): number {
      return queued;
    },

    push<T>(task: () => Promise<T>): Promise<T> {
      queued += 1;
      notify?.();

      const run = tail.then(async (): Promise<T> => {
        queued -= 1;
        inFlight = true;
        notify?.();
        try {
          return await task();
        } finally {
          inFlight = false;
          notify?.();
        }
      });

      // 两条链分开：`tail` 吞掉结果与异常，只用于排序；`run` 把真实结果交给调用方。
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    drain(): Promise<void> {
      return tail;
    },
  };
}
