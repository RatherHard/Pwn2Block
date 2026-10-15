import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSolutionMarkdown,
  ret2winSolutionActions,
  type ChallengeDefinition,
} from '@pwn2block/shared';
import { defaultReplay, solveAllChallenges, solveChallenge } from '../src/solve';
import { FIXTURES, OK_ROOT, SENTINEL, fakeReplay, failingReplay, makeRet2winRepo, makeTempRepo } from './helpers';

const ret2winOptions = { root: FIXTURES, env: { FLAG_RET2WIN: SENTINEL } };

function solutionMarkdownOf(root: string): string {
  return readFileSync(join(root, 'challenges', 'ret2win', 'solution.md'), 'utf8');
}

describe('solve：解析与断言', () => {
  it('夹具里的参考解法与 shared 的 ret2win 参考动作一致', () => {
    const parsed = parseSolutionMarkdown(solutionMarkdownOf(FIXTURES));
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.actions).toEqual([...ret2winSolutionActions]);
    expect(parsed.doc.expectedVerdict).toBe('won');
  });

  it('verdict 等于 expectedVerdict 时通过', async () => {
    const report = await solveChallenge('ret2win', {
      ...ret2winOptions,
      replay: fakeReplay('won'),
    });
    expect(report).toEqual({
      id: 'ret2win',
      ok: true,
      expectedVerdict: 'won',
      actualVerdict: 'won',
      issues: [],
    });
  });

  it('verdict 与期望不符时失败并说明差异', async () => {
    const report = await solveChallenge('ret2win', {
      ...ret2winOptions,
      replay: fakeReplay('failed'),
    });
    expect(report.ok).toBe(false);
    expect(report.actualVerdict).toBe('failed');
    expect(report.message).toContain('期望 won');
    expect(report.message).toContain('实际 failed');
  });

  it('expectedVerdict: failed 的反例解法同样被尊重', async () => {
    const root = makeRet2winRepo({
      solutionMarkdown: solutionMarkdownOf(FIXTURES).replace(
        '"expectedVerdict": "won"',
        '"expectedVerdict": "failed"',
      ),
    });
    const expectFailed = await solveChallenge('ret2win', {
      root,
      env: { FLAG_RET2WIN: SENTINEL },
      replay: fakeReplay('failed'),
    });
    expect(expectFailed.ok).toBe(true);
    expect(expectFailed.expectedVerdict).toBe('failed');

    const mismatch = await solveChallenge('ret2win', {
      root,
      env: { FLAG_RET2WIN: SENTINEL },
      replay: fakeReplay('won'),
    });
    expect(mismatch.ok).toBe(false);
  });

  it('回放函数报错时把原因带出来', async () => {
    const report = await solveChallenge('ret2win', {
      ...ret2winOptions,
      replay: failingReplay('引擎还没接好'),
    });
    expect(report.ok).toBe(false);
    expect(report.message).toBe('引擎还没接好');
  });

  it('回放函数抛异常时也算失败，不静默通过', async () => {
    const report = await solveChallenge('ret2win', {
      ...ret2winOptions,
      replay: () => {
        throw new Error('boom');
      },
    });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('boom');
  });
});

describe('solve：解法文件与题目包问题', () => {
  it('solution.md 缺少 json 代码块时报解析错误', async () => {
    const root = makeRet2winRepo({ solutionMarkdown: '# 只有正文，没有机器可读块\n' });
    const report = await solveChallenge('ret2win', {
      root,
      env: { FLAG_RET2WIN: SENTINEL },
      replay: fakeReplay('won'),
    });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('json');
    expect(report.issues[0]?.path).toBe('solution.md');
  });

  it('solution.md 完全缺失时报缺文件', async () => {
    const root = makeRet2winRepo({ omitSolution: true });
    const report = await solveChallenge('ret2win', {
      root,
      env: { FLAG_RET2WIN: SENTINEL },
      replay: fakeReplay('won'),
    });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.path).toBe('solution.md');
  });

  it('题目包本身不合法时直接报题目包问题，不跑回放', async () => {
    let called = false;
    const report = await solveChallenge('ret2win', {
      root: FIXTURES,
      env: {},
      replay: () => {
        called = true;
        return { ok: true, verdict: 'won' };
      },
    });
    expect(report.ok).toBe(false);
    expect(called).toBe(false);
    expect(report.issues.map((item) => item.path)).toContain('flag');
  });

  it('--all 在没有题目包时返回空数组', async () => {
    expect(await solveAllChallenges({ root: makeTempRepo({}), env: {} })).toEqual([]);
  });

  it('--all 遍历全部题目', async () => {
    const reports = await solveAllChallenges({
      root: OK_ROOT,
      env: { FLAG_OKWIN: SENTINEL },
      replay: fakeReplay('won'),
    });
    expect(reports.map((report) => report.id)).toEqual(['okwin']);
    expect(reports.every((report) => report.ok)).toBe(true);
  });
});

describe('solve：默认回放', () => {
  it('引擎未就绪时默认回放明确失败，不做假 verdict', () => {
    const definition = {
      pub: { id: 'fake' },
      priv: { flag: 'literal' },
    } as unknown as ChallengeDefinition;
    const result = defaultReplay(definition, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('引擎');
  });

  it('不注入回放时走引擎：报告必须自洽，D1 不伪造 verdict', async () => {
    const report = await solveChallenge('ret2win', ret2winOptions);
    expect(report.expectedVerdict).toBe('won');
    if (!report.ok) {
      // 引擎给出什么就是什么：失败必须带原因，不允许无理由的“通过”。
      expect(Boolean(report.message) || report.issues.length > 0).toBe(true);
    }
  });
});
