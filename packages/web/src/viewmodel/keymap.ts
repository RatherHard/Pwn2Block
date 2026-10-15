/**
 * 快捷键映射（05 §2.1）：`Ctrl+↑ / Ctrl+↓` 在视图之间切换。
 *
 * 纯函数、只读事件形状，node 环境可测；组件把它接到 `keydown` 上。
 * 输入框里按 `Ctrl+↑/↓` 是「按词移动光标」，不抢。
 */
export interface KeyLikeEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly target?: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  } | null;
}

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

export function isEditableTarget(event: KeyLikeEvent): boolean {
  const target = event.target;
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase() ?? '';
  return EDITABLE_TAGS.includes(tag);
}

/** 返回 -1（`Ctrl+↑`）、+1（`Ctrl+↓`）或 0（不是我们的快捷键）。 */
export function viewScrollDelta(event: KeyLikeEvent): -1 | 0 | 1 {
  if (!event.ctrlKey || event.metaKey === true || event.altKey === true) return 0;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return 0;
  if (isEditableTarget(event)) return 0;
  return event.key === 'ArrowUp' ? -1 : 1;
}
