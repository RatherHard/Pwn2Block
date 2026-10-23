import type { canvas } from '@pwn2block/shared';
import { saveCanvas } from '../canvas/save';
import type { CanvasStore } from '../canvas/save';

/**
 * 存档节流（需求 §8「编辑 400ms 后写一次，卸载时立刻写」）。
 *
 * 只做两件事：把频繁的文档变化合成一次写入；卸载时补写最后一次。写失败（没有存储、
 * 配额满）不打断做题——`saveCanvas` 的返回值只表示「有没有落盘」，界面另有提示渠道。
 */
const SAVE_DEBOUNCE_MS = 400;

/** 存档时要读的三样东西：都可能在两次调用之间变化，所以用函数而不是值。 */
export interface AutosaveSource {
  store(): CanvasStore | undefined;
  challengeId(): string | undefined;
  document(): canvas.CanvasDocument | undefined;
}

export class CanvasAutosave {
  private timer: number | undefined;

  constructor(private readonly source: AutosaveSource) {}

  /** 排一次写入：同一批变化只写一次。 */
  schedule(): void {
    this.cancel();
    if (typeof window === 'undefined') return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立刻写；没有题目或没有文档时什么都不做（加载失败不该写半份文档）。 */
  flush(): void {
    this.cancel();
    const challengeId = this.source.challengeId();
    const document = this.source.document();
    if (challengeId === undefined || document === undefined) return;
    saveCanvas(this.source.store(), challengeId, document);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
