import { createRuntime } from '@pwn2block/engine';
import {
  parseSolutionMarkdown,
  type Action,
  type ChallengeDefinition,
  type ChallengeIssue,
  type Verdict,
} from '@pwn2block/shared';
import { CHALLENGE_FILE_NAMES, listChallengeIds } from './challenge-files';
import { loadChallengeDefinition, type CheckOptions } from './check';
import { repoRoot } from './paths';

/**
 * 参考解法回放（06 §2）：把 `solution.md` 里的 payload **当成一次提交**从初态执行，断言 verdict。
 *
 * 回放本身依赖引擎（`createRuntime`，B01/B03 在 D3 交付），所以这里把回放做成**可注入的**：
 * - 默认实现走真引擎；
 * - 引擎还不可用时返回 `{ok:false}` 并带上原因，CLI 据此**非零退出**——绝不假装通过；
 * - 单测注入 fake replay，只测「解析 + 断言 + 报告」这段 D1 逻辑。
 */

export type ReplayResult =
  | { readonly ok: true; readonly verdict: Verdict }
  | { readonly ok: false; readonly message: string };

export type ReplayFn = (
  definition: ChallengeDefinition,
  actions: readonly Action[],
) => ReplayResult | Promise<ReplayResult>;

export interface SolveReport {
  readonly id: string;
  readonly ok: boolean;
  readonly expectedVerdict?: Verdict;
  readonly actualVerdict?: Verdict;
  readonly message?: string;
  readonly issues: readonly ChallengeIssue[];
}

export interface SolveOptions extends CheckOptions {
  /** 回放实现，默认走引擎。单测注入 fake。 */
  readonly replay?: ReplayFn;
}

/**
 * 默认回放：真引擎的纯提交回放（B03）。引擎未就绪时明确失败，不返回假 verdict。
 *
 * 必须把 `definition.lookup` 交给引擎：题目的 `encoding` 写成 `{preset, add, remove}` 时，
 * 引擎不做文件 IO，自己展开不了那张表（03 §1、shared 的 `RuntimeOptions`）。
 */
export function defaultReplay(
  definition: ChallengeDefinition,
  actions: readonly Action[],
): ReplayResult {
  try {
    const runtime = createRuntime(definition.pub, definition.priv, { lookup: definition.lookup });
    const outcome = runtime.replaySubmit(actions);
    return { ok: true, verdict: outcome.verdict };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `引擎回放不可用（createRuntime，B01/B03，D3 接通）：${detail}` };
  }
}

function issue(path: string, message: string): ChallengeIssue {
  return { path, message };
}

/** 回放一道题的参考解法，断言 `verdict === expectedVerdict`（默认 `won`）。 */
export async function solveChallenge(id: string, options: SolveOptions = {}): Promise<SolveReport> {
  const loaded = loadChallengeDefinition(id, options);
  if (!loaded.ok) return { id, ok: false, issues: loaded.issues };

  const markdown = loaded.files.solutionMarkdown;
  if (markdown === undefined) {
    return {
      id,
      ok: false,
      message: '缺少参考解法文件',
      issues: [issue(CHALLENGE_FILE_NAMES.solution, `题目${id}没有 ${CHALLENGE_FILE_NAMES.solution}`)],
    };
  }

  const parsed = parseSolutionMarkdown(markdown);
  if (!parsed.ok) {
    return {
      id,
      ok: false,
      message: parsed.message,
      issues: [issue(CHALLENGE_FILE_NAMES.solution, parsed.message)],
    };
  }

  const { doc } = parsed;
  const replay = options.replay ?? defaultReplay;
  let outcome: ReplayResult;
  try {
    outcome = await replay(loaded.definition, doc.actions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id, ok: false, expectedVerdict: doc.expectedVerdict, message: `回放抛出异常：${detail}`, issues: [] };
  }

  if (!outcome.ok) {
    return { id, ok: false, expectedVerdict: doc.expectedVerdict, message: outcome.message, issues: [] };
  }

  if (outcome.verdict !== doc.expectedVerdict) {
    return {
      id,
      ok: false,
      expectedVerdict: doc.expectedVerdict,
      actualVerdict: outcome.verdict,
      message: `回放结果与期望不符：期望 ${doc.expectedVerdict}，实际 ${outcome.verdict}`,
      issues: [],
    };
  }

  return { id, ok: true, expectedVerdict: doc.expectedVerdict, actualVerdict: outcome.verdict, issues: [] };
}

/** 遍历 `challenges/` 下全部题目；没有题目时返回空数组（CI 在出题前也要绿）。 */
export async function solveAllChallenges(options: SolveOptions = {}): Promise<SolveReport[]> {
  const root = options.root ?? repoRoot();
  const ids = listChallengeIds(root);
  const reports: SolveReport[] = [];
  for (const id of ids) {
    reports.push(await solveChallenge(id, options));
  }
  return reports;
}
