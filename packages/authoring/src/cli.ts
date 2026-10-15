import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { flagEnvVarName, type ChallengeIssue } from '@pwn2block/shared';
import { assembleProgram, type AsmListingEntry } from './asm';
import { checkAllChallenges, checkChallenge, loadChallengeDefinition, type CheckOptions } from './check';
import { CHALLENGE_FILE_NAMES, listChallengeIds } from './challenge-files';
import { createChallenge } from './new-challenge';
import { repoRoot } from './paths';
import { applyInitPatches } from './private-init';
import { solveAllChallenges, solveChallenge, type ReplayFn, type SolveOptions } from './solve';

/**
 * 出题 CLI（06 §2）：`new / asm / check / solve`。
 *
 * 退出码约定（CI 依赖它）：
 * - `0` 通过；`--all` 且 `challenges/` 为空也算通过（出题前 CI 也要绿）；
 * - `1` 校验失败 / 回放失败 / 引擎不可用——**绝不假装通过**；
 * - `2` 用法错误（未知子命令、缺 id）。
 *
 * `main` 的输入都走 `options` 注入（仓库根、环境变量、回放实现），
 * 这样单测可以用 `test/fixtures` 当仓库根、用 fake replay 覆盖 D1 逻辑。
 */

export const USAGE = `用法：pnpm challenge:<command> [<id>|--all] [选项]

  new <id>      从模板生成 challenges/<id>/ 的四个文件（public.json / private.json /
                program.asm / solution.md）；已存在时拒绝覆盖，加 --force 覆盖
  asm <id>      编译 program.asm，把 hex 写回 private.json 里对应 VMA 的 init
                （内容没变时不写盘；汇编错误一律非零退出，不写半成品字节）
  check <id>    校验 public.json / private.json：Schema、VMA 布局、编码表、谓词、
                跨包引用、flag 缺失
  check --all   校验 challenges/ 下全部题目；目录为空时提示并返回 0
  solve <id>    把 solution.md 里的 payload 当成一次提交回放，断言 verdict 等于 expectedVerdict
  solve --all   对 challenges/ 下全部题目执行 solve；目录为空时提示并返回 0

选项：
  --all         遍历 challenges/ 下全部题目（check / solve）
  --force       允许 new 覆盖已存在的题目文件
  -h, --help    打印本用法

环境变量：
  FLAG_<ID大写>  flag 真值，例如 ret2win → FLAG_RET2WIN。缺失时该题拒绝加载（06 §6），
                因此 asm / check / solve 都要求先导出它。
`;

export interface CliOptions {
  /** 仓库根，默认 `repoRoot()`。 */
  readonly root?: string;
  /** `presets/` 根，默认与 `root` 相同。 */
  readonly presetRoot?: string;
  /** 环境变量表，默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 回放实现，默认走引擎（D3 接通）。 */
  readonly replay?: ReplayFn;
}

const SUBCOMMANDS = ['new', 'asm', 'check', 'solve'] as const;

function out(text: string): void {
  process.stdout.write(text);
}

function err(text: string): void {
  process.stderr.write(text);
}

/** 题目包在 CLI 输出里的路径前缀，让每行都能直接定位到文件。 */
function challengeLabel(id: string): string {
  return `challenges/${id}`;
}

function printIssues(id: string, issues: readonly ChallengeIssue[]): void {
  for (const item of issues) {
    out(`${challengeLabel(id)}/${item.path}: ${item.message}\n`);
  }
}

function checkOptions(options: CliOptions): CheckOptions {
  return { root: options.root, presetRoot: options.presetRoot, env: options.env };
}

function solveOptions(options: CliOptions): SolveOptions {
  return { ...checkOptions(options), replay: options.replay };
}

function runCheckAll(options: CliOptions): number {
  const reports = checkAllChallenges(options);
  if (reports.length === 0) {
    out('challenges/ 下还没有题目包，跳过。\n');
    return 0;
  }
  let failed = 0;
  for (const report of reports) {
    if (report.ok) {
      out(`${challengeLabel(report.id)}: ok\n`);
      continue;
    }
    failed += 1;
    printIssues(report.id, report.issues);
  }
  out(`校验完成：共 ${reports.length} 道，${failed} 道有问题。\n`);
  return failed === 0 ? 0 : 1;
}

function runCheck(target: string | undefined, options: CliOptions): number {
  if (!target) {
    err(`用法：pnpm challenge:check <id>|--all\n\n${USAGE}`);
    return 2;
  }
  const report = checkChallenge(target, checkOptions(options));
  if (report.ok) {
    out(`${challengeLabel(report.id)}: ok\n`);
    return 0;
  }
  printIssues(report.id, report.issues);
  return 1;
}

function reportSolve(report: Awaited<ReturnType<typeof solveChallenge>>): boolean {
  if (report.ok) {
    out(
      `${challengeLabel(report.id)}: 回放通过（期望 ${report.expectedVerdict ?? 'won'}，实际 ${report.actualVerdict ?? 'won'}）\n`,
    );
    return true;
  }
  printIssues(report.id, report.issues);
  if (report.message) out(`${challengeLabel(report.id)}: ${report.message}\n`);
  return false;
}

async function runSolveAll(options: CliOptions): Promise<number> {
  const reports = await solveAllChallenges(options);
  if (reports.length === 0) {
    out('challenges/ 下还没有题目包，跳过。\n');
    return 0;
  }
  let failed = 0;
  for (const report of reports) {
    if (!reportSolve(report)) failed += 1;
  }
  out(`参考解法回放完成：共 ${reports.length} 道，${failed} 道未通过。\n`);
  return failed === 0 ? 0 : 1;
}

async function runSolve(target: string | undefined, options: CliOptions): Promise<number> {
  if (!target) {
    err(`用法：pnpm challenge:solve <id>|--all\n\n${USAGE}`);
    return 2;
  }
  const report = await solveChallenge(target, solveOptions(options));
  return reportSolve(report) ? 0 : 1;
}

function runNew(target: string | undefined, force: boolean, options: CliOptions): number {
  if (!target) {
    err(`用法：pnpm challenge:new <id>\n\n${USAGE}`);
    return 2;
  }
  const result = createChallenge(target, { root: options.root, force });
  if (!result.ok) {
    err(`${challengeLabel(result.id)}: ${result.message}\n`);
    return 1;
  }
  out(`${challengeLabel(result.id)}: 已生成 ${result.written.length} 个文件（${result.dir}）\n`);
  out(`提示：运行前导出 flag 环境变量 ${flagEnvVarName(result.id)}=<本地哨兵值>（06 §6）。\n`);
  return 0;
}

/** 打印汇编器给的地址清单：直接拿去填 `labels` 和 `solution.md`（06 §2.2）。 */
function printListing(listing: readonly AsmListingEntry[]): void {
  if (listing.length === 0) return;
  out('地址清单：\n');
  for (const entry of listing) {
    out(`  ${entry.label.padEnd(16)} ${entry.addr.padEnd(12)} ${entry.vma}\n`);
  }
}

function runAsm(target: string | undefined, options: CliOptions): number {
  if (!target) {
    err(`用法：pnpm challenge:asm <id>\n\n${USAGE}`);
    return 2;
  }

  // 走 check 的同一入口：题目包本身不合法时绝不往 private.json 里写字节。
  // 唯一例外是「init 是否已经同步」这条自检——asm 存在的意义就是把它修好。
  const loaded = loadChallengeDefinition(target, { ...checkOptions(options), skipAsmSyncCheck: true });
  if (!loaded.ok) {
    printIssues(target, loaded.issues);
    return 1;
  }

  const files = loaded.files;
  if (files.programAsm === undefined) {
    out(`${challengeLabel(target)}/${CHALLENGE_FILE_NAMES.asm}: 缺少伪汇编源文件\n`);
    return 1;
  }

  const result = assembleProgram(files.programAsm, loaded.definition.priv.vmas, {
    lookup: loaded.definition.lookup,
    registers: loaded.definition.priv.registers,
  });
  if (!result.ok) {
    err(`${challengeLabel(target)}/${CHALLENGE_FILE_NAMES.asm}: ${result.message}\n`);
    return 1;
  }

  printListing(result.listing);

  const applied = applyInitPatches(files.privateText, result.segments);
  if (!applied.ok) {
    err(`${challengeLabel(target)}/${CHALLENGE_FILE_NAMES.private}: ${applied.message}\n`);
    return 1;
  }

  const summary = result.segments
    .map((segment) => `${segment.vmaId} 段 ${segment.patches.reduce((sum, patch) => sum + patch.hex.length / 2, 0)} 字节`)
    .join('，');
  if (!applied.changed) {
    out(`${challengeLabel(target)}: ${summary}，与 private.json 一致，未写盘\n`);
    return 0;
  }

  writeFileSync(join(files.dir, CHALLENGE_FILE_NAMES.private), applied.text, 'utf8');
  out(`${challengeLabel(target)}: 已写回 ${CHALLENGE_FILE_NAMES.private}（${summary}）\n`);
  return 0;
}

/** CLI 入口：返回进程退出码。`cli.ts` 的顶层把返回值赋给 `process.exitCode`。 */
export async function main(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    out(USAGE);
    return 0;
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(command)) {
    err(`未知子命令：${command}\n\n${USAGE}`);
    return 2;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    out(USAGE);
    return 0;
  }

  const all = rest.includes('--all');
  const force = rest.includes('--force');
  const target = rest.find((item) => !item.startsWith('-'));

  if (command === 'check') return all ? runCheckAll(options) : runCheck(target, options);
  if (command === 'solve') return all ? await runSolveAll(options) : await runSolve(target, options);
  if (command === 'new') return runNew(target, force, options);
  return runAsm(target, options);
}

export { repoRoot, listChallengeIds };

/**
 * 只在被当成入口执行时跑 CLI（`pnpm challenge:*` → `tsx .../cli.ts`）。
 * 单测会 import 本模块拿 `main`，那时 `argv[1]` 是 vitest 的入口，这里必须跳过，
 * 否则会污染测试进程的退出码。
 */
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
