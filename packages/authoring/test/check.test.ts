import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ret2winPrivate, ret2winPublic } from '@pwn2block/shared';
import { checkAllChallenges, checkChallenge, loadChallengeDefinition } from '../src/check';
import { readChallengeFiles } from '../src/challenge-files';
import { clearPresetCache } from '../src/presets';
import { FIXTURES, OK_ROOT, REPO_ROOT, SENTINEL, makeTempRepo, writeFile } from './helpers';

/** 读夹具题目包的原文；`okwin` 在全绿夹具根下。 */
function fixtureText(id: string, name: string): string {
  const dir =
    id === 'okwin' ? join(OK_ROOT, 'challenges', 'okwin') : join(FIXTURES, 'challenges', id);
  return readFileSync(join(dir, name), 'utf8');
}

const ret2winEnv = { FLAG_RET2WIN: SENTINEL };

describe('check：正例', () => {
  it('夹具题目包与 shared 的 ret2win 样例逐字一致', () => {
    expect(JSON.parse(fixtureText('ret2win', 'public.json'))).toEqual(ret2winPublic);
    expect(JSON.parse(fixtureText('ret2win', 'private.json'))).toEqual(ret2winPrivate);
  });

  it('ret2win 通过校验并给出定义', () => {
    clearPresetCache();
    const loaded = loadChallengeDefinition('ret2win', { root: FIXTURES, env: ret2winEnv });
    expect(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.issues)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.definition.pub.id).toBe('ret2win');
    expect(loaded.definition.encoding).toHaveLength(4);
    expect(loaded.definition.flagRef).toEqual({
      kind: 'env',
      envVar: 'FLAG_RET2WIN',
      resolved: SENTINEL,
    });
    expect(loaded.files.programAsm).toBeDefined();
    expect(loaded.files.solutionMarkdown).toBeDefined();
  });

  it('check <id> 返回 {id, ok, issues}', () => {
    const report = checkChallenge('ret2win', { root: FIXTURES, env: ret2winEnv });
    expect(report).toEqual({ id: 'ret2win', ok: true, issues: [] });
  });

  it('--all 在没有题目包时返回空数组（CI 在出题前也要绿）', () => {
    const empty = makeTempRepo({});
    expect(checkAllChallenges({ root: empty })).toEqual([]);
  });

  it('--all 遍历 challenges/ 下的全部题目', () => {
    const reports = checkAllChallenges({ root: OK_ROOT, env: { FLAG_OKWIN: SENTINEL } });
    expect(reports.map((report) => report.id)).toEqual(['okwin']);
    expect(reports.every((report) => report.ok)).toBe(true);
  });
});

describe('check：反例', () => {
  it('flag 环境变量缺失时拒绝加载', () => {
    const report = checkChallenge('ret2win', { root: FIXTURES, env: {} });
    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.path)).toContain('flag');
    expect(report.issues.some((item) => item.message.includes('FLAG_RET2WIN'))).toBe(true);
  });

  it('坏 preset 与未对齐的 VMA 都会被逐条报出来', () => {
    const report = checkChallenge('broken', { root: FIXTURES, env: { FLAG_BROKEN: SENTINEL } });
    expect(report.ok).toBe(false);
    const paths = report.issues.map((item) => item.path);
    expect(paths).toContain('presets/bad-shape.json');
    expect(paths).toContain('vmas.text.start');
    for (const item of report.issues) {
      expect(item.path.length).toBeGreaterThan(0);
      expect(item.message.length).toBeGreaterThan(0);
    }
  });

  it('题目包不存在时给出明确问题', () => {
    const report = checkChallenge('nosuch', { root: FIXTURES });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.message).toContain('题目包不存在');
  });

  it('非法题目 id 被拒绝（防路径穿越）', () => {
    const report = checkChallenge('../etc', { root: FIXTURES });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.path).toBe('<id>');
  });

  it('public.json 不是合法 JSON 时报解析错误', () => {
    const root = makeTempRepo({});
    writeFile(join(root, 'challenges', 'badjson', 'public.json'), '{ not json');
    writeFile(join(root, 'challenges', 'badjson', 'private.json'), '{}');
    const report = checkChallenge('badjson', { root });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.path).toBe('public.json');
    expect(report.issues[0]?.message).toContain('不是合法 JSON');
  });

  it('--all 会把坏题目算进失败，但报全所有题目', () => {
    const reports = checkAllChallenges({ root: FIXTURES, presetRoot: REPO_ROOT, env: ret2winEnv });
    expect(reports.map((report) => report.id)).toEqual(['broken', 'preset-user', 'ret2win']);
    expect(reports.find((report) => report.id === 'ret2win')?.ok).toBe(true);
    expect(reports.find((report) => report.id === 'broken')?.ok).toBe(false);
  });
});

describe('check：编码表增删', () => {
  function presetUserRepo(encoding: string): string {
    const root = makeTempRepo({});
    writeFile(
      join(root, 'challenges', 'preset-user', 'public.json'),
      fixtureText('preset-user', 'public.json').replace(
        '"encoding": { "preset": "x86ish" }',
        `"encoding": ${encoding}`,
      ),
    );
    writeFile(
      join(root, 'challenges', 'preset-user', 'private.json'),
      fixtureText('preset-user', 'private.json'),
    );
    return root;
  }

  it('add 追加本题特有 opcode', () => {
    const root = presetUserRepo(
      '{ "preset": "x86ish", "add": [{ "opcode": "0x11", "op": "syscall", "operands": ["const:60"] }] }',
    );
    const report = checkChallenge('preset-user', {
      root,
      presetRoot: REPO_ROOT,
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('remove 删掉不想给学习者用的 opcode', () => {
    const root = presetUserRepo('{ "preset": "x86ish", "remove": ["0xb8"] }');
    const loaded = loadChallengeDefinition('preset-user', {
      root,
      presetRoot: REPO_ROOT,
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.issues)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.definition.lookup.byOpcode(0xb8)).toBeUndefined();
  });

  it('add 撞上未 remove 的 opcode 时报重复', () => {
    const root = presetUserRepo(
      '{ "preset": "x86ish", "add": [{ "opcode": "0xb8", "op": "mov", "operands": ["reg:RAX", "imm"] }] }',
    );
    const report = checkChallenge('preset-user', {
      root,
      presetRoot: REPO_ROOT,
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((item) => item.message.includes('重复声明'))).toBe(true);
  });

  it('声明了 preset 却没提供内容时拒绝（shared 的兜底）', () => {
    const report = checkChallenge('preset-user', {
      root: FIXTURES,
      presetRoot: join(FIXTURES, 'empty-presets'),
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((item) => item.path === 'presets/x86ish.json')).toBe(true);
  });
});

describe('challenge-files：四件套读取', () => {
  it('flag 从环境变量取，缺失为 undefined', () => {
    const withFlag = readChallengeFiles('ret2win', { root: FIXTURES, env: ret2winEnv });
    expect(withFlag.ok && withFlag.files.flagValue).toBe(SENTINEL);
    const withoutFlag = readChallengeFiles('ret2win', { root: FIXTURES, env: {} });
    expect(withoutFlag.ok && withoutFlag.files.flagValue).toBeUndefined();
  });

  it('program.asm / solution.md 缺失时为 undefined，不报错', () => {
    const root = makeTempRepo({
      'challenges/bare/public.json': fixtureText('okwin', 'public.json'),
      'challenges/bare/private.json': fixtureText('okwin', 'private.json'),
    });
    const result = readChallengeFiles('bare', { root, env: { FLAG_BARE: SENTINEL } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.programAsm).toBeUndefined();
    expect(result.files.solutionMarkdown).toBeUndefined();
  });
});
