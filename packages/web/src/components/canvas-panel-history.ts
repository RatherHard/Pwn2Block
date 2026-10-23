import type { canvas } from '@pwn2block/shared';

/**
 * 撤销/重做栈（需求 §10 任务第 11 条：100 步）。
 *
 * 一份快照 = 一次文档变化；不做增量补丁，因为编辑命令本身返回的就是新文档（不可变数据），
 * 存引用即可。粒度由调用方决定：一次拖动 = 一条命令 = 一次快照，拖十像素不会堆十条历史。
 */

/** 历史深度：需求给的上限。 */
export const HISTORY_LIMIT = 100;

export class CanvasHistory {
  private past: canvas.CanvasDocument[] = [];
  private future: canvas.CanvasDocument[] = [];

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 记一条新状态：清空重做栈，超出上限时丢最旧的一条。 */
  push(document: canvas.CanvasDocument): void {
    this.past.push(document);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** 撤销：返回上一条快照，当前状态进重做栈；没有可撤销的返回 `undefined`。 */
  undo(current: canvas.CanvasDocument | undefined): canvas.CanvasDocument | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return undefined;
    if (current !== undefined) {
      this.future.push(current);
      if (this.future.length > HISTORY_LIMIT) this.future.shift();
    }
    return previous;
  }

  redos(current: canvas.CanvasDocument | undefined): canvas.CanvasDocument | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    if (current !== undefined) {
      this.past.push(current);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    return next;
  }

  /** 换文档（导入、放弃旧档）时清空：旧历史对新文档没有意义。 */
  reset(): void {
    this.past = [];
    this.future = [];
  }
}
