import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_FLAG_SENTINEL, type Verdict } from '@pwn2block/shared';
import { vi } from 'vitest';
import { repoRoot } from '../src/paths';
import type { ReplayFn, ReplayResult } from '../src/solve';

/**
 * 测试夹具工具（E01）。
 *
 * 夹具题目包放在 `packages/authoring/test/fixtures/`，**不放 `challenges/`**——
 * 否则 CI 的 `challenge:check --all` 会把测试夹具当成真题目扫到。
 */

/** 真实仓库根：`presets/x86ish.json` 从这里读。 */
export const REPO_ROOT = repoRoot();

const HERE = dirname(fileURLToPath(import.meta.url));

/** 夹具仓库根：底下有 `challenges/` 与 `presets/`，可以直接当 `root` 用。 */
export const FIXTURES = join(HERE, 'fixtures');

/** 只含一个全绿题目的夹具根，用于 `--all` 的通过用例。 */
export const OK_ROOT = join(FIXTURES, 'ok');

/** 本地哨兵 flag，绝不等于任何真实 flag（08 §5 S05）。 */
export const SENTINEL = TEST_FLAG_SENTINEL;

/** 造一个临时「仓库根」：键为相对路径，值为文件内容。 */
export function makeTempRepo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'pwn2block-authoring-'));
  for (const [relative, text] of Object.entries(files)) {
    writeFile(join(root, relative), text);
  }
  return root;
}

/** 把 ret2win 夹具复制到临时仓库，可替换 / 删除 `solution.md`。 */
export function makeRet2winRepo(options: {
  readonly solutionMarkdown?: string;
  readonly omitSolution?: boolean;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pwn2block-ret2win-'));
  const target = join(root, 'challenges', 'ret2win');
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(FIXTURES, 'challenges', 'ret2win'), target, { recursive: true });

  const solutionPath = join(target, 'solution.md');
  if (options.omitSolution) {
    rmSync(solutionPath);
  } else if (options.solutionMarkdown !== undefined) {
    writeFileSync(solutionPath, options.solutionMarkdown, 'utf8');
  }
  return root;
}

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** 假的回放实现：只回一个固定 verdict，用来单测 D1 的「解析 + 断言」逻辑。 */
export function fakeReplay(verdict: Verdict): ReplayFn {
  return (): ReplayResult => ({ ok: true, verdict });
}

/** 假的回放实现：模拟引擎不可用。 */
export function failingReplay(message: string): ReplayFn {
  return (): ReplayResult => ({ ok: false, message });
}

export interface CapturedStdio {
  stdoutText(): string;
  stderrText(): string;
  restore(): void;
}

/** 截获 `process.stdout/stderr.write`，用于断言 CLI 输出。 */
export function captureStdio(): CapturedStdio {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    }) as never);
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }) as never);

  return {
    stdoutText: () => outChunks.join(''),
    stderrText: () => errChunks.join(''),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}
