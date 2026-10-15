import {
  bytesToHex,
  checkChallengePair,
  hexToBytes,
  parseHex,
  parsePublicPackage,
  presetNameOf,
  type ChallengeDefinition,
  type ChallengeIssue,
  type ChallengeVma,
  type EncodingItem,
} from '@pwn2block/shared';
import { assembleProgram } from './asm';
import {
  CHALLENGE_FILE_NAMES,
  listChallengeIds,
  readChallengeFiles,
  type ChallengeFileOptions,
  type ChallengeFiles,
} from './challenge-files';
import { loadPreset } from './presets';
import { repoRoot } from './paths';

/**
 * 题目包校验（03 §2.2）：读 public/private + 默认编码表 → `checkChallengePair`（shared 的唯一实现），
 * 再补一条 shared 看不到的检查：`program.asm` 汇编出来的字节必须等于 `private.json` 里的 `init`。
 *
 * 为什么 preset 要在这里读：`shared` 不做文件 IO，只接受「preset 内容」。
 * 本地校验与线上加载共用 `checkChallengePair`，所以「本地过了线上挂」不会成为常态。
 *
 * 为什么还要查 asm 与 init 是否同步：Schema / 布局 / 编码表全对，也不能证明那份 `init` 是新的。
 * 出题过程中程序改一行、忘了重跑 `challenge:asm`，`check` 会全绿而参考解法已经失效
 * （06 §5：改一个字节就可能让参考解法失效）。汇编器是唯一实现，这里复用它，不另写编码逻辑。
 */

export interface CheckOptions extends ChallengeFileOptions {
  /** `presets/` 所在根，默认与 `root` 相同。 */
  readonly presetRoot?: string;
  /**
   * 跳过「`program.asm` ↔ `private.json` 的 `init` 是否同步」这条自检。
   *
   * 只有 `challenge:asm` 会打开它：那个命令存在的意义正是把陈旧的 `init` 修好，
   * 若在这里先判它不一致，汇编器就永远修不了它。其它调用方（check / solve / 服务端）都不要跳过。
   */
  readonly skipAsmSyncCheck?: boolean;
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

/** 报错里回显的字节串，太长就截断，别把整段 hex 打进终端。 */
function shortHex(hex: string): string {
  if (hex === '') return '（空）';
  return hex.length > 32 ? `${hex.slice(0, 32)}…` : hex;
}

/**
 * 从 `private.json` 的 `init` 还原出某个 VMA 前 `length` 字节的实际内容。
 * `init` 里有超出这个范围的字节（相对 program.asm 是多余的）时返回 `undefined`。
 */
function initImageHex(vma: ChallengeVma, length: number): string | undefined {
  const start = parseHex(vma.start);
  const bytes = new Uint8Array(length);
  for (const patch of vma.init ?? []) {
    const base = Number(parseHex(patch.at) - start);
    const patchBytes = hexToBytes(patch.hex);
    for (let index = 0; index < patchBytes.length; index += 1) {
      const offset = base + index;
      if (offset < 0 || offset >= length) return undefined;
      bytes[offset] = patchBytes[index];
    }
  }
  return bytesToHex(bytes);
}

/**
 * `program.asm` ↔ `private.json` 一致性检查。
 * `program.asm` 不存在（老包或刻意手写 hex）时跳过，行为与以前一致。
 */
function asmSyncIssues(
  id: string,
  definition: ChallengeDefinition,
  programAsm: string,
): ChallengeIssue[] {
  const assembled = assembleProgram(programAsm, definition.priv.vmas, {
    lookup: definition.lookup,
    registers: definition.priv.registers,
  });
  if (!assembled.ok) {
    return [issue(CHALLENGE_FILE_NAMES.asm, `伪汇编编译失败：${assembled.message}`)];
  }

  const issues: ChallengeIssue[] = [];
  for (const segment of assembled.segments) {
    const vma = definition.priv.vmas.find((item) => item.id === segment.vmaId);
    if (!vma) continue;
    const expected = segment.patches.map((patch) => patch.hex).join('');
    const actual = initImageHex(vma, expected.length / 2);
    if (actual === expected) continue;
    issues.push(
      issue(
        CHALLENGE_FILE_NAMES.private,
        `「${segment.vmaId}」段的 init 与 program.asm 的汇编结果不一致` +
          `（private.json 里是 ${actual === undefined ? '比程序多出的字节' : shortHex(actual)}，` +
          `汇编得到 ${shortHex(expected)}）：跑 pnpm challenge:asm ${id} 重新生成`,
      ),
    );
  }
  return issues;
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

  if (files.programAsm !== undefined && options.skipAsmSyncCheck !== true) {
    const asmIssues = asmSyncIssues(id, checked.definition, files.programAsm);
    if (asmIssues.length > 0) return { ok: false, id, issues: asmIssues };
  }

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
