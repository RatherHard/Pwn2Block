/** 视图行只在直接承载它的槽位内滚动，避免隐藏在下方的视图把整个管理器拉走。 */
export function scrollRowInSlot(view: HTMLElement, row: Element | null): void {
  const slot = view.parentElement;
  if (slot === null || row === null || typeof slot.scrollTo !== 'function') return;
  const bounds = slot.getBoundingClientRect();
  const target = row.getBoundingClientRect();
  const delta = target.top < bounds.top
    ? target.top - bounds.top
    : target.bottom > bounds.bottom ? target.bottom - bounds.bottom : 0;
  if (delta !== 0) slot.scrollTo({ top: slot.scrollTop + delta });
}
