import { parseCanvasSave } from '../canvas/save';

/**
 * 旧存档的判定与上报（需求 §8：读到旧工作流存档要**说明**，不迁移、不改写）。
 *
 * `loadCanvas` 把所有读不出来的情况都归成 `corrupt`，只带一句消息；要区分「旧档」与
 * 「文件坏了」，得按存档格式再解析一次。这里就是那一次：原文能解析、且结论是 `legacy`，
 * 才发 `p2b-canvas-legacy`，其余情况保持沉默（坏 JSON 由面板的提示负责）。
 */

/** `p2b-canvas-legacy` 的 detail：旧存档的解析结论与原文。 */
export interface CanvasLegacyDetail {
  readonly legacy: {
    readonly reason: string;
    readonly message: string;
    readonly raw: string;
  };
}

/** 解析存档原文；JSON 本身坏了就没有「旧档」可言。 */
function parseJsonText(raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/** 判定这份原文是不是旧档；是就返回要发出去的 detail，不是返回 `undefined`。 */
export function legacyDetailOf(raw: string, challengeId: string | undefined): CanvasLegacyDetail | undefined {
  const parsed = parseJsonText(raw);
  if (!parsed.ok) return undefined;
  const result = parseCanvasSave(parsed.value, challengeId);
  if (result.ok || result.reason !== 'legacy') return undefined;
  return { legacy: { reason: result.reason, message: result.message, raw } };
}
