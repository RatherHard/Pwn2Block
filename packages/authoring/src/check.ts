import {
  bytesToHex,
  checkChallengePair,
  flagEnvVarName,
  hexToBytes,
  parseHex,
  parsePrivatePackage,
  parsePublicPackage,
  presetNameOf,
  type ChallengeDefinition,
  type ChallengeIssue,
  type ChallengeVma,
  type EncodingItem,
  type PrivateChallenge,
  type PublicChallenge,
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
 * 再补三条 shared 看不到的检查：
 *
 * 1. `public.json` 的 `id` 必须等于题目目录名（服务端按目录名加载，不一致的包上线即不可用）；
 * 2. `private.json` 的 `flag` 必须是 `env:FLAG_<ID大写>`（真值不进 git，06 §6）；
 * 3. `program.asm` 汇编出来的字节必须等于 `private.json` 里的 `init`。
 *
 * 为什么 preset 要在这里读：`shared` 不做文件 IO，只接受「preset 内容」。
 * 本地校验与线上加载共用 `checkChallengePair`，所以「本地过了线上挂」不会成为常态；
 * 上面 1 / 2 两条正是补上「出题侧漏、服务端有」与「加载器不能拦、出题闸门必须拦」的两处缺口。
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

/**
 * 出题闸门 1（03 §1）：`public.json` 的 `id` 必须等于题目目录名。
 *
 * 服务端 `loadChallengeDir` 按目录名加载并核对 `pub.id`（`server/src/challenges.ts`），
 * 只有出题侧漏了这条：目录名与包内 id 不一致的包能通过 `challenge:check`，
 * 上线后按目录名开局直接 503 `challenge_unavailable`。
 */
function idGateIssues(id: string, pub: PublicChallenge): ChallengeIssue[] {
  const declaredId = pub.id;
  if (declaredId === id) return [];
  return [
    issue(
      'id',
      `公开包 id「${declaredId}」与目录名「${id}」不一致：` +
        `服务端按目录名加载题目，这种包一上线就不可用` +
        `（把 public.json 的 id 改成「${id}」，或把目录改名）`,
    ),
  ];
}

/**
 * 出题闸门 2（CLAUDE.md「绝对不能进 git」、06 §6）：`private.json` 的 `flag` 必须写成
 * `env:FLAG_<ID大写>`，真值只在部署时由同名环境变量注入。
 *
 * 为什么只装在出题 CLI：`shared` 的 `checkChallengePair` 同时是**加载器**，
 * 合成测试包（`packages/server/test/**`、`tests/**`）用字面 flag 是合法的，不能在加载器里拦。
 * 出题侧读取的题目包一定会进 git，字面 flag 等于把真值交出去，所以闸门只装在出题这条路上。
 *
 * 错误文案不回显字面值：它可能就是真 flag，写进 CI 日志等于二次泄露。
 */
function flagGateIssues(id: string, priv: PrivateChallenge): ChallengeIssue[] {
  const envVar = flagEnvVarName(id);
  const expected = `env:${envVar}`;
  const declared = priv.flag;
  if (declared === expected) return [];

  if (!declared.startsWith('env:')) {
    return [
      issue(
        'flag',
        `flag 不得写明文常量：题目包必须写成「${expected}」，` +
          `真值只在部署时由环境变量 ${envVar} 注入，绝不能进 git（06 §6）`,
      ),
    ];
  }
  return [
    issue(
      'flag',
      `flag 的环境变量名与题目 id「${id}」不匹配：应写成「${expected}」` +
        `（题目 id 的大写形态，非字母数字字符换成下划线），实际写成「${declared}」（06 §6）`,
    ),
  ];
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

  // 出题闸门：只看「公开包 id」与「私有包 flag」两个声明字段，所以先算、并进同一份问题清单。
  // 这样即使 `checkChallengePair` 还报了别的问题（例如 flag 大小写不符），闸门问题也会一起列出来；
  // 合成测试包里用字面 flag 是加载器的合法输入，闸门只装在出题这条路上。
  const privResult = parsePrivatePackage(files.privateRaw);
  const gateIssues: ChallengeIssue[] = [
    ...(pubResult.ok ? idGateIssues(id, pubResult.pub) : []),
    ...(privResult.ok ? flagGateIssues(id, privResult.priv) : []),
  ];

  const checked = checkChallengePair(files.publicRaw, files.privateRaw, {
    presetItems,
    flagValue: files.flagValue,
  });

  const issues = [...gateIssues, ...presetIssues, ...(checked.ok ? [] : checked.issues)];
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
