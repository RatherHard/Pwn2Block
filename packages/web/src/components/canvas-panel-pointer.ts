import type { Point } from '../canvas/view-model';

/**
 * 指针事件的三个小工具：坐标换算、全局监听、`data-*` 上溯。
 *
 * 抽出来的理由：画布交互里到处要做这三件事，而它们与「拖动状态机」无关；放在交互类里
 * 会让那个状态机看起来比实际复杂。全局监听只在拖动期间挂，所以成对给 `listenDrag` /
 * `unlistenDrag`，调用方不会漏掉解绑。
 */

/**
 * 客户端坐标 → 画布坐标。
 *
 * 画布是一个滚动容器（`.stage`），表面（`.surface`）贴着它的左上角，所以「减去容器矩形、
 * 加回滚动量」就够了。jsdom 里矩形的各项都是 0，于是用例可以直接写画布坐标。
 */
export function toGraphPoint(stage: HTMLElement | null, event: MouseEvent): Point {
  if (stage === null) return { x: event.clientX, y: event.clientY };
  const rect = stage.getBoundingClientRect();
  return {
    x: Math.round(event.clientX - rect.left + stage.scrollLeft),
    y: Math.round(event.clientY - rect.top + stage.scrollTop),
  };
}

/** 拖动期间把移动/松手挂到 window：指针移出画布也不会丢掉手势。 */
export function listenDrag(move: (event: MouseEvent) => void, up: (event: MouseEvent) => void): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function unlistenDrag(move: (event: MouseEvent) => void, up: (event: MouseEvent) => void): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
}

export function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/** 按 `data-*` 属性向上找最近的元素；找不到返回 `null`（指针事件的常态，不抛）。 */
export function closestData(element: Element | null, attribute: string): HTMLElement | null {
  const found = element?.closest(`[${attribute}]`);
  return found instanceof HTMLElement ? found : null;
}
