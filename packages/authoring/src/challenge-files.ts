import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChallengeIdSchema, flagEnvVarName, type ChallengeIssue } from '@pwn2block/shared';
import { challengeDir, challengesDir, repoRoot } from './paths';

/**
 * 题目包文件定位与读取（03 §1、06 §1）：`challenges/<id>/` 下的四个文件。
 *
 * - `public.json`（题目公开面）、`private.json`（判题真值）**必须存在**；
 * - `program.asm`（伪汇编源）、`solution.md`（参考解法）按需读取，供 `asm` / `solve` 用；
 * - flag 真值只从环境变量取：`process.env[FLAG_<ID大写>]`，取不到就是 `undefined`，
 *   交给 `checkChallengePair` 报「缺失即拒绝加载」，工具绝不往文件里写 flag（06 §6）。
 *
 * 这里只做「读 + 解析 JSON + 参考解法编码检查」，不判断题目语义；语义交给 shared。
 */

export const CHALLENGE_FILE_NAMES = {
  public: 'public.json',
  private: 'private.json',
  asm: 'program.asm',
  solution: 'solution.md',
} as const;

export interface ChallengeFiles {
  readonly id: string;
  readonly dir: string;
  readonly publicText: string;
  readonly privateText: string;
  readonly publicRaw: unknown;
  readonly privateRaw: unknown;
  /** `program.asm` 原文；文件不存在时为 `undefined`。 */
  readonly programAsm?: string;
  /** `solution.md` 原文；文件不存在时为 `undefined`。 */
  readonly solutionMarkdown?: string;
  /** 环境变量注入的 flag 真值；缺失时为 `undefined`。 */
  readonly flagValue?: string;
}

export type ChallengeFilesResult =
  | { readonly ok: true; readonly files: ChallengeFiles }
  | { readonly ok: false; readonly id: string; readonly issues: readonly ChallengeIssue[] };

export interface ChallengeFileOptions {
  /** 仓库根，默认 `repoRoot()`。测试传夹具目录。 */
  readonly root?: string;
  /** 环境变量表，默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
}

function issue(path: string, message: string): ChallengeIssue {
  return { path, message };
}

/** 列出 `challenges/` 下有 `public.json` + `private.json` 的题目 id，按字典序。 */
export function listChallengeIds(root: string = repoRoot()): string[] {
  const dir = challengesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter(
      (name) =>
        existsSync(join(dir, name, CHALLENGE_FILE_NAMES.public)) &&
        existsSync(join(dir, name, CHALLENGE_FILE_NAMES.private)),
    )
    .sort();
}

/** 读取一个可选文本文件；不存在或读取失败时返回 `undefined`，由调用方按需报错。 */
function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

type ReadSolutionResult =
  | { readonly ok: true; readonly text: string | undefined }
  | { readonly ok: false; readonly message: string };

/** 检查完整参考解法的字节与行尾，不猜测合法 UTF-8 文本是否已经乱码。 */
function readSolutionText(path: string): ReadSolutionResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { ok: true, text: undefined };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `读取失败：${detail}` };
  }

  // Buffer 的宽松解码会把非法字节替换掉；逐字节往返比对才能发现原始输入损坏。
  // 仓库只规定 LF，未禁止 UTF-8 BOM；保留 BOM，避免误判或偷偷改写文件。
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { ok: false, message: '不是合法 UTF-8：存在非法或截断的字节序列，请从原始文件恢复并保存为 UTF-8' };
  }
  if (text.includes('\uFFFD')) {
    return { ok: false, message: '包含替换字符 U+FFFD：文本可能已在转码时损坏，请核对原文后修复' };
  }
  if (text.includes('\r')) {
    return { ok: false, message: '行尾必须使用 LF：检测到 CRLF 或单独 CR，请转换为 LF 后重试' };
  }
  return { ok: true, text };
}

/** 读取 flag 真值：题目 id → 环境变量名（`validate.ts` 的 `flagEnvVarName`）。 */
export function readFlagValue(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[flagEnvVarName(id)];
  return value === undefined || value === '' ? undefined : value;
}

/** 定位并读取 `challenges/<id>/` 的四个文件。 */
export function readChallengeFiles(
  id: string,
  options: ChallengeFileOptions = {},
): ChallengeFilesResult {
  const root = options.root ?? repoRoot();
  const issues: ChallengeIssue[] = [];

  const idParsed = ChallengeIdSchema.safeParse(id);
  if (!idParsed.success) {
    return { ok: false, id, issues: [issue('<id>', idParsed.error.issues[0]?.message ?? '题目 id 不合法')] };
  }

  const dir = challengeDir(id, root);
  if (!existsSync(dir)) {
    return { ok: false, id, issues: [issue(CHALLENGE_FILE_NAMES.public, `题目包不存在：${dir}`)] };
  }

  const publicResult = readJson(dir, CHALLENGE_FILE_NAMES.public);
  const privateResult = readJson(dir, CHALLENGE_FILE_NAMES.private);
  if (!publicResult.ok) issues.push(issue(CHALLENGE_FILE_NAMES.public, publicResult.message));
  if (!privateResult.ok) issues.push(issue(CHALLENGE_FILE_NAMES.private, privateResult.message));
  if (!publicResult.ok || !privateResult.ok) return { ok: false, id, issues };

  const solutionResult = readSolutionText(join(dir, CHALLENGE_FILE_NAMES.solution));
  if (!solutionResult.ok) {
    return { ok: false, id, issues: [issue(CHALLENGE_FILE_NAMES.solution, solutionResult.message)] };
  }

  return {
    ok: true,
    files: {
      id,
      dir,
      publicText: publicResult.text,
      privateText: privateResult.text,
      publicRaw: publicResult.value,
      privateRaw: privateResult.value,
      programAsm: readOptionalText(join(dir, CHALLENGE_FILE_NAMES.asm)),
      solutionMarkdown: solutionResult.text,
      flagValue: readFlagValue(id, options.env ?? process.env),
    },
  };
}

type ReadJsonResult =
  | { readonly ok: true; readonly text: string; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** 读文本 + 解析 JSON；两类失败都给中文原因，交给 CLI 打 `path: message`。 */
function readJson(dir: string, name: string): ReadJsonResult {
  const path = join(dir, name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `读取失败：${detail}` };
  }

  try {
    return { ok: true, text, value: JSON.parse(text) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `不是合法 JSON：${detail}` };
  }
}
