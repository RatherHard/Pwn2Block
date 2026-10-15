import {
  checkChallengePair,
  parsePublicPackage,
  presetNameOf,
  type ChallengeDefinition,
  type ChallengeIssue,
  type EncodingItem,
} from '@pwn2block/shared';
import {
  listChallengeIds,
  readChallengeFiles,
  type ChallengeFileOptions,
  type ChallengeFiles,
} from './challenge-files';
import { loadPreset } from './presets';
import { repoRoot } from './paths';

/**
 * 题目包校验（03 §2.2）：读 public/private + 默认编码表 → `checkChallengePair`（shared 的唯一实现）。
 *
 * 为什么 preset 要在这里读：`shared` 不做文件 IO，只接受「preset 内容」。
 * 本地校验与线上加载共用 `checkChallengePair`，所以「本地过了线上挂」不会成为常态。
 */

export interface CheckOptions extends ChallengeFileOptions {
  /** `presets/` 所在根，默认与 `root` 相同。 */
  readonly presetRoot?: string;
}

export type DefinitionResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly definition: ChallengeDefinition;
      /** 题目包原文，供 `solve` / `asm` 复用，避免重复读盘。 */
      readonly files: ChallengeFiles;
    }
  | { readonly ok: false; readonly id: string; readonly issues: readonly ChallengeIssue[] };

export interface ChallengeReport {
  readonly id: string;
  readonly ok: boolean;
  readonly issues: readonly ChallengeIssue[];
}

function issue(path: string, message: string): ChallengeIssue {
  return { path, message };
}

/** 解析并校验一道题；成功时给出 `ChallengeDefinition`（含展开后的编码表与查询视图）。 */
export function loadChallengeDefinition(id: string, options: CheckOptions = {}): DefinitionResult {
  const root = options.root ?? repoRoot();
  const filesResult = readChallengeFiles(id, { root, env: options.env });
  if (!filesResult.ok) return { ok: false, id, issues: filesResult.issues };

  const { files } = filesResult;
  const presetIssues: ChallengeIssue[] = [];
  let presetItems: readonly EncodingItem[] | undefined;

  const pubResult = parsePublicPackage(files.publicRaw);
  if (pubResult.ok) {
    const presetName = presetNameOf(pubResult.pub);
    if (presetName) {
      const preset = loadPreset(presetName, options.presetRoot ?? root);
      if (preset.ok) {
        presetItems = preset.items;
      } else {
        presetIssues.push(issue(`presets/${presetName}.json`, preset.message));
      }
    }
  }

  const checked = checkChallengePair(files.publicRaw, files.privateRaw, {
    presetItems,
    flagValue: files.flagValue,
  });

  const issues = [...presetIssues, ...(checked.ok ? [] : checked.issues)];
  if (!checked.ok || issues.length > 0) return { ok: false, id, issues };
  return { ok: true, id, definition: checked.definition, files };
}

/** 校验一道题，返回 `{id, ok, issues}`。 */
export function checkChallenge(id: string, options: CheckOptions = {}): ChallengeReport {
  const result = loadChallengeDefinition(id, options);
  return result.ok ? { id, ok: true, issues: [] } : { id, ok: false, issues: result.issues };
}

/** 遍历 `challenges/` 下全部题目；没有题目时返回空数组（CI 在出题前也要绿）。 */
export function checkAllChallenges(options: CheckOptions = {}): ChallengeReport[] {
  const root = options.root ?? repoRoot();
  return listChallengeIds(root).map((id) => checkChallenge(id, options));
}
