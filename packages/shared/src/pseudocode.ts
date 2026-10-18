import { MAX_PSEUDOCODE_CHARS } from './limits';
import type { ChallengeIssue } from './validate';

/**
 * 题目伪代码（`challenges/<id>/pseudocode.c`）。
 *
 * 伪代码描述的是固定的程序逻辑，属于公开面，随公开包下发、在前端「伪代码」标签页只读展示。
 * 它单独成文件而不是写进 `public.json`：C 代码塞进 JSON 字符串要转义每个引号和换行，没法维护。
 * shared 不做文件 IO，读文件交给服务端加载器与出题 CLI，这里只做规范化、并入和校验，两边共用。
 */

export const PSEUDOCODE_FILE_NAME = 'pseudocode.c';

const FLAG_PLACEHOLDER_RE = /env:\s*FLAG_/i;

function issue(message: string): ChallengeIssue {
  return { path: PSEUDOCODE_FILE_NAME, message };
}

/** 去掉 UTF-8 BOM、CRLF/CR 统一为 LF、去掉末尾空白：在哪台机器上保存的文件都下发同一份文本。 */
export function normalizePseudocode(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
}

export type MergePseudocodeResult =
  | { readonly ok: true; readonly raw: unknown }
  | { readonly ok: false; readonly issues: readonly ChallengeIssue[] };

/**
 * 把 `pseudocode.c` 原文并入公开包原始对象，再交给 Schema 解析。
 *
 * - `public.json` 里直接写 `pseudocode` 一律拒绝：来源只有一个，避免两处内容不一致；
 * - 文件不存在（`text` 为 `undefined`）时原样返回，前端也就不显示伪代码标签页；
 * - 空文件与超长文件给出中文原因，而不是 Schema 的通用报错。
 */
export function mergePseudocode(publicRaw: unknown, text: string | undefined): MergePseudocodeResult {
  const isObject = typeof publicRaw === 'object' && publicRaw !== null && !Array.isArray(publicRaw);
  if (isObject && 'pseudocode' in publicRaw) {
    return {
      ok: false,
      issues: [{ path: 'pseudocode', message: `伪代码写在 ${PSEUDOCODE_FILE_NAME}，public.json 里不要写 pseudocode 字段` }],
    };
  }
  if (text === undefined || !isObject) return { ok: true, raw: publicRaw };

  const pseudocode = normalizePseudocode(text);
  if (pseudocode === '') {
    return { ok: false, issues: [issue('伪代码文件为空：这道题不需要伪代码就删掉这个文件')] };
  }
  if (pseudocode.length > MAX_PSEUDOCODE_CHARS) {
    return {
      ok: false,
      issues: [issue(`伪代码有 ${pseudocode.length} 个字符，超过 ${MAX_PSEUDOCODE_CHARS} 的上限`)],
    };
  }
  return { ok: true, raw: { ...publicRaw, pseudocode } };
}

/**
 * 伪代码随公开包整份下发，不能出现 flag 占位符或 flag 真值（大小写变体也算）。
 * 文案不回显命中的内容：它可能就是真 flag。
 */
export function validatePseudocodeNoFlag(
  pseudocode: string | undefined,
  flagValue: string | undefined,
): ChallengeIssue[] {
  if (pseudocode === undefined) return [];
  const issues: ChallengeIssue[] = [];
  if (FLAG_PLACEHOLDER_RE.test(pseudocode)) {
    issues.push(issue('伪代码里不能出现 flag 占位符 env:FLAG_…：它会原样下发给学习者'));
  }
  if (flagValue && pseudocode.toLowerCase().includes(flagValue.toLowerCase())) {
    issues.push(issue('伪代码包含 flag 真值，拒绝加载'));
  }
  return issues;
}
