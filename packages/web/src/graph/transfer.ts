import { parseGraphDocument } from '@pwn2block/shared';
import type { GraphDocument } from '@pwn2block/shared';
import { withDocument, type EditResult, type GraphEditorState } from './editor';

/**
 * 图的导出与导入（06 §3；07 §P2/P3）。
 *
 * 导入是**先校验再替换**：JSON 解析、Schema 校验、语义校验全部通过才换文档，失败时原图
 * 一个字都不动，并把问题列成一句可展示的话。导出只写当前文档，不带编译产物、预览或撤销
 * 历史——那些都是本地的临时结果，不能从存档恢复成有效产物。
 */

export interface ImportFailure {
  readonly ok: false;
  readonly message: string;
  readonly issues: readonly string[];
}

export type ImportOutcome = EditResult | ImportFailure;

export function exportDocument(document: GraphDocument): string {
  return JSON.stringify(document, null, 2);
}

export function importDocument(state: GraphEditorState, text: string): ImportOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: '不是合法的 JSON 文件', issues: [] };
  }
  const parsed = parseGraphDocument(raw);
  if (!parsed.ok) {
    return { ok: false, message: `图格式不对，已保留原图：${parsed.message}`, issues: [parsed.message] };
  }
  return { ok: true, state: withDocument(state, parsed.document) };
}
