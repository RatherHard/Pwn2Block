import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChallengeSummarySchema,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  checkChallengePair,
  flagEnvNameOf,
  presetNameOf,
} from '@pwn2block/shared';
import type {
  ChallengeDefinition,
  ChallengeIssue,
  ChallengeSummary,
  EncodingItem,
  PrivateChallenge,
} from '@pwn2block/shared';

/**
 * 题目加载（03 §1、04 §5）。
 *
 * - 校验只有一份实现：shared 的 `checkChallengePair`，加载与 `challenge:check` 共用。
 * - **加载失败的题目不出现在列表里**（08 §3 D1）；它的 id 记下来，请求它时回 503
 *   `challenge_unavailable`，而不是假装不存在。
 * - `private.json` 只在这里被读，内容永不进入任何 HTTP 响应（01 §6 第 1 条）。
 */

export interface LoadedChallenge {
  readonly definition: ChallengeDefinition;
  readonly summary: ChallengeSummary;
}

export interface ChallengeStore {
  /** 只含加载成功的题目，按目录名排序。 */
  list(): readonly ChallengeSummary[];
  get(id: string): LoadedChallenge | undefined;
  /** 磁盘上有这个 id，但没通过校验 / 缺 flag 环境变量。 */
  isUnavailable(id: string): boolean;
  /** 加载失败原因：只给日志与出题人，**绝不下发**。 */
  issuesFor(id: string): readonly ChallengeIssue[];
}

export interface ChallengeLoadOptions {
  /** 环境变量表（flag 真值从 `env:FLAG_X` 指定的变量读）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `presets/` 目录，默认取题目目录的兄弟目录。 */
  readonly presetDir?: string;
  /** 预设名 → 编码表内容，测试可直接注入，省掉文件系统。 */
  readonly readPreset?: (name: string) => readonly EncodingItem[] | undefined;
}

/** 仓库根下的默认题目目录。 */
export function defaultChallengeDir(): string {
  return fileURLToPath(new URL('../../../challenges', import.meta.url));
}

/**
 * 解析私有包里的 flag：常量直接用，`env:FLAG_X` 从环境变量取（06 §6）。
 * 变量名解析复用 shared 的 `flagEnvNameOf`，服务端不再复刻正则。
 */
export function resolveFlag(
  priv: PrivateChallenge,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const envName = flagEnvNameOf(priv);
  if (envName !== undefined) return env[envName];
  // 不是合法的 `env:` 引用就是字面常量；`env:` 前缀写坏了当缺失处理，绝不把原文当假 flag 下发。
  return priv.flag.startsWith('env:') ? undefined : priv.flag;
}

/**
 * 扫描题目目录并逐个校验。目录不存在等价于「还没有题目」——返回空列表是正确行为。
 */
export function loadChallengeDir(dir: string, options: ChallengeLoadOptions): ChallengeStore {
  const loaded = new Map<string, LoadedChallenge>();
  const issues = new Map<string, readonly ChallengeIssue[]>();

  for (const dirName of listChallengeDirs(dir)) {
    const result = loadOne(dir, dirName, options);
    if (result.ok) {
      loaded.set(dirName, result.loaded);
      continue;
    }
    issues.set(dirName, result.issues);
    // 目录名与公开包 id 不一致时，两个 id 都要报「不可用」，否则会退化成 not_found。
    if (result.id !== dirName) issues.set(result.id, result.issues);
  }

  return {
    list: () => [...loaded.values()].map((item) => item.summary),
    get: (id) => loaded.get(id),
    isUnavailable: (id) => issues.has(id),
    issuesFor: (id) => issues.get(id) ?? [],
  };
}

type LoadResult =
  | { readonly ok: true; readonly loaded: LoadedChallenge }
  | { readonly ok: false; readonly id: string; readonly issues: readonly ChallengeIssue[] };

function issue(path: string, message: string): ChallengeIssue {
  return { path, message };
}

function listChallengeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readJson(file: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch {
    // 读不到或不是合法 JSON：对加载来说都是「这个题目不可用」，原因在调用方按目录汇报。
    return { ok: false };
  }
}

function loadOne(dir: string, dirName: string, options: ChallengeLoadOptions): LoadResult {
  const pubRaw = readJson(join(dir, dirName, 'public.json'));
  if (!pubRaw.ok) {
    return { ok: false, id: dirName, issues: [issue('public.json', `题目 ${dirName} 缺少 public.json 或不是合法 JSON`)] };
  }
  const privRaw = readJson(join(dir, dirName, 'private.json'));
  if (!privRaw.ok) {
    return {
      ok: false,
      id: dirName,
      issues: [issue('private.json', `题目 ${dirName} 缺少 private.json 或不是合法 JSON`)],
    };
  }

  const pubLight = PublicChallengeSchema.safeParse(pubRaw.value);
  const declaredId: string = pubLight.success ? pubLight.data.id : dirName;
  if (pubLight.success && pubLight.data.id !== dirName) {
    return {
      ok: false,
      id: declaredId,
      issues: [issue('id', `公开包 id「${declaredId}」与目录名「${dirName}」不一致`)],
    };
  }

  const checked = checkChallengePair(pubRaw.value, privRaw.value, {
    presetItems: pubLight.success ? readPresetItems(options, presetNameOf(pubLight.data)) : undefined,
    flagValue: flagValueOf(privRaw.value, options.env),
  });
  if (!checked.ok) return { ok: false, id: declaredId, issues: checked.issues };

  return {
    ok: true,
    loaded: {
      definition: checked.definition,
      summary: ChallengeSummarySchema.parse({
        id: checked.definition.pub.id,
        title: checked.definition.pub.title,
      }),
    },
  };
}

function flagValueOf(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const parsed = PrivateChallengeSchema.safeParse(raw);
  return parsed.success ? resolveFlag(parsed.data, env) : undefined;
}

function readPresetItems(
  options: ChallengeLoadOptions,
  name: string | undefined,
): readonly EncodingItem[] | undefined {
  if (name === undefined) return undefined;
  if (options.readPreset !== undefined) return options.readPreset(name);
  if (options.presetDir === undefined) return undefined;
  const file = readJson(join(options.presetDir, `${name}.json`));
  if (!file.ok || !looksLikeEncodingItems(file.value)) return undefined;
  return file.value;
}

/** 轻量结构检查：预设文件来自仓库数据，坏数据由 `expandEncoding` 报成 issue 而不是崩溃。 */
function looksLikeEncodingItems(value: unknown): value is readonly EncodingItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'opcode' in item &&
        'op' in item &&
        Array.isArray((item as { readonly operands?: unknown }).operands),
    )
  );
}
