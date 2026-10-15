import { z } from 'zod';

/**
 * 参数占位符：`$name`。
 * 单独成文件，避免 `challenge.ts`（积木模板）与 `actions.ts`（展开器）互相 import 成环。
 */
export const PLACEHOLDER_RE = /^\$[a-z][a-z0-9_]{0,15}$/;

export const PlaceholderSchema = z.string().regex(PLACEHOLDER_RE, '参数占位符形如 $name');

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}
