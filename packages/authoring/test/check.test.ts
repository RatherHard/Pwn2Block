import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagEnvVarName, ret2winPrivate, ret2winPublic } from '@pwn2block/shared';
import { checkAllChallenges, checkChallenge, loadChallengeDefinition } from '../src/check';
import { readChallengeFiles } from '../src/challenge-files';
import { clearPresetCache } from '../src/presets';
import {
  FIXTURES,
  OK_ROOT,
  REPO_ROOT,
  SENTINEL,
  makeRet2winRepo,
  makeTempRepo,
  writeFile,
} from './helpers';

/** 读夹具题目包的原文；`okwin` 在全绿夹具根下。 */
function fixtureText(id: string, name: string): string {
  const dir =
    id === 'okwin' ? join(OK_ROOT, 'challenges', 'okwin') : join(FIXTURES, 'challenges', id);
  return readFileSync(join(dir, name), 'utf8');
}

const ret2winEnv = { FLAG_RET2WIN: SENTINEL };

/**
 * 把 ret2win 夹具放成目录名 `dirId` 的题目包，并按需改写包内的 `id` / `flag`。
 * 默认两处都与目录名自洽，用来单独复现「目录名与包内容不一致」的坏包。
 */
function ret2winRepoAs(
  dirId: string,
  patch: { readonly publicId?: string; readonly flag?: string } = {},
): string {
  const publicText = fixtureText('ret2win', 'public.json').replace(
    '"id": "ret2win"',
    `"id": ${JSON.stringify(patch.publicId ?? dirId)}`,
  );
  const privateText = fixtureText('ret2win', 'private.json').replace(
    '"flag": "env:FLAG_RET2WIN"',
    `"flag": ${JSON.stringify(patch.flag ?? `env:${flagEnvVarName(dirId)}`)}`,
  );
  return makeTempRepo({
    [`challenges/${dirId}/public.json`]: publicText,
    [`challenges/${dirId}/private.json`]: privateText,
  });
}

/** 目录名对应的 flag 环境变量，值用本地哨兵（06 §6）。 */
function envOf(dirId: string): NodeJS.ProcessEnv {
  return { [flagEnvVarName(dirId)]: SENTINEL };
}

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

describe('check：program.asm 与 private.json 的 init 必须同步', () => {
  /** 夹具 ret2win 的最新 init 是 program.asm 汇编出的 `c9c30f0e`。 */
  function ret2winRepoWithInitText(replacement: string): string {
    const root = makeRet2winRepo();
    const path = join(root, 'challenges', 'ret2win', 'private.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"c9c30f0e"', replacement), 'utf8');
    return root;
  }

  it('一致时 check 通过（夹具走的就是这条路）', () => {
    const report = checkChallenge('ret2win', { root: makeRet2winRepo(), env: ret2winEnv });
    expect(report).toEqual({ id: 'ret2win', ok: true, issues: [] });
  });

  it('init 陈旧一个字节就报 private.json 并把命令写给出来', () => {
    const report = checkChallenge('ret2win', {
      root: ret2winRepoWithInitText('"ffffffff"'),
      env: ret2winEnv,
    });
    expect(report.ok).toBe(false);
    const first = report.issues[0];
    expect(first?.path).toBe('private.json');
    expect(first?.message).toContain('「text」段的 init 与 program.asm 的汇编结果不一致');
    expect(first?.message).toContain('pnpm challenge:asm ret2win');
    expect(first?.message).toContain('c9c30f0e');
  });

  it('init 比程序多出字节 / init 整个缺失都算不一致', () => {
    const longer = ret2winRepoWithInitText('"c9c30f0e9090"');
    expect(checkChallenge('ret2win', { root: longer, env: ret2winEnv }).ok).toBe(false);

    const missing = ret2winRepoWithInitText('"00000000"');
    expect(checkChallenge('ret2win', { root: missing, env: ret2winEnv }).ok).toBe(false);
  });

  it('program.asm 编译不过时报在 program.asm 上，并带上行号', () => {
    const root = makeRet2winRepo();
    writeFileSync(join(root, 'challenges', 'ret2win', 'program.asm'), '.vma text\n    jmp nowhere\n', 'utf8');
    const report = checkChallenge('ret2win', { root, env: ret2winEnv });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.path).toBe('program.asm');
    expect(report.issues[0]?.message).toContain('伪汇编编译失败');
    expect(report.issues[0]?.message).toContain('第 2 行');
  });

  it('没有 program.asm 的题目包跳过这条检查（老包行为不变）', () => {
    const root = makeTempRepo({
      'challenges/okwin/public.json': fixtureText('okwin', 'public.json'),
      'challenges/okwin/private.json': fixtureText('okwin', 'private.json'),
      'presets/x86ish.json': readFileSync(join(REPO_ROOT, 'presets', 'x86ish.json'), 'utf8'),
    });
    expect(checkChallenge('okwin', { root, env: { FLAG_OKWIN: SENTINEL } })).toEqual({
      id: 'okwin',
      ok: true,
      issues: [],
    });
  });
});

describe('check：公开包 id 必须等于题目目录名', () => {
  it('一致时通过（含连字符目录名）', () => {
    expect(
      checkChallenge('ret2win', { root: ret2winRepoAs('ret2win'), env: envOf('ret2win') }),
    ).toEqual({ id: 'ret2win', ok: true, issues: [] });
    expect(
      checkChallenge('stack-frame-01', {
        root: ret2winRepoAs('stack-frame-01'),
        env: envOf('stack-frame-01'),
      }).ok,
    ).toBe(true);
  });

  it('不一致时报在 id 上，并同时给出两边名字', () => {
    const report = checkChallenge('evil-id-mismatch', {
      root: ret2winRepoAs('evil-id-mismatch', { publicId: 'another-id' }),
      env: envOf('evil-id-mismatch'),
    });
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.path).toBe('id');
    expect(report.issues[0]?.message).toBe(
      '公开包 id「another-id」与目录名「evil-id-mismatch」不一致：' +
        '服务端按目录名加载题目，这种包一上线就不可用（把 public.json 的 id 改成「evil-id-mismatch」，或把目录改名）',
    );
  });

  it('id 不一致时不会误判成 flag 问题（flag 已按目录名写对）', () => {
    const report = checkChallenge('evil-id-mismatch', {
      root: ret2winRepoAs('evil-id-mismatch', { publicId: 'another-id' }),
      env: envOf('evil-id-mismatch'),
    });
    expect(report.issues.map((item) => item.path)).toEqual(['id']);
  });
});

describe('check：flag 必须是 env:FLAG_<ID大写>（出题闸门，06 §6）', () => {
  it('real ret2win 的 env:FLAG_RET2WIN 通过', () => {
    expect(
      checkChallenge('ret2win', { root: ret2winRepoAs('ret2win'), env: envOf('ret2win') }),
    ).toEqual({ id: 'ret2win', ok: true, issues: [] });
  });

  it('目录名里的连字符换成下划线：stack-frame-01 → env:FLAG_STACK_FRAME_01', () => {
    const report = checkChallenge('stack-frame-01', {
      root: ret2winRepoAs('stack-frame-01'),
      env: envOf('stack-frame-01'),
    });
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  });

  it('明文常量一律报错，且错误文案不回显明文', () => {
    for (const literal of ['flag{literal_v2}', 'DEMO{literal_v2}', 'plain-text-flag']) {
      const report = checkChallenge('ret2win', {
        root: ret2winRepoAs('ret2win', { flag: literal }),
        env: envOf('ret2win'),
      });
      expect(report.ok).toBe(false);
      const item = report.issues.find(
        (issue) => issue.path === 'flag' && issue.message.includes('明文'),
      );
      expect(item?.message).toContain('env:FLAG_RET2WIN');
      // 明文本身可能就是真 flag，报错文案不能把它带进 CI 日志。
      expect(item?.message).not.toContain(literal);
    }
  });

  it('env: 前缀但变量名与题目 id 不匹配时报错，并给出期望与实际', () => {
    const report = checkChallenge('ret2win', {
      root: ret2winRepoAs('ret2win', { flag: 'env:FLAG_OTHER' }),
      env: envOf('ret2win'),
    });
    expect(report.ok).toBe(false);
    const item = report.issues.find((issue) => issue.path === 'flag');
    expect(item?.message).toContain('env:FLAG_RET2WIN');
    expect(item?.message).toContain('env:FLAG_OTHER');
  });

  it('全小写的 env:flag_ret2win 报错', () => {
    const report = checkChallenge('ret2win', {
      root: ret2winRepoAs('ret2win', { flag: 'env:flag_ret2win' }),
      env: envOf('ret2win'),
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((item) => item.path === 'flag')).toBe(true);
    expect(report.issues.some((item) => item.message.includes('env:FLAG_RET2WIN'))).toBe(true);
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
