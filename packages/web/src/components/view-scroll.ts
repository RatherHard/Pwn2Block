/**
 * 视图行只在直接承载它的标签主体区内滚动，不拉动整页。
 * 主体区或视图自身隐藏（非当前标签）时几何尺寸为 0，此时滚动没有意义，直接返回；
 * 切回标签时由视图自己补做一次跟随。
 */
export function scrollRowInBody(view: HTMLElement, row: Element | null): void {
  const body = view.parentElement;
  if (body === null || row === null || typeof body.scrollTo !== 'function') return;
  if (body.hidden || view.hidden) return;
  const bounds = body.getBoundingClientRect();
  const target = row.getBoundingClientRect();
  const delta = target.top < bounds.top
    ? target.top - bounds.top
    : target.bottom > bounds.bottom ? target.bottom - bounds.bottom : 0;
  if (delta !== 0) body.scrollTo({ top: body.scrollTop + delta });
}
