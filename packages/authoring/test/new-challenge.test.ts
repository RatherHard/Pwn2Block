import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagEnvVarName } from '@pwn2block/shared';
import { checkChallenge } from '../src/check';
import { CHALLENGE_FILE_NAMES } from '../src/challenge-files';
import { createChallenge } from '../src/new-challenge';
import { solveChallenge } from '../src/solve';
import { REPO_ROOT, SENTINEL, fakeReplay, makeTempRepo } from './helpers';

const NEW_ID = 'tmptest';
const newEnv = { [flagEnvVarName(NEW_ID)]: SENTINEL };

describe('new：生成题目包模板', () => {
  it('生成四个文件，并且直接就能过 check', () => {
    const root = makeTempRepo({});
    const created = createChallenge(NEW_ID, { root });
    expect(created.ok, created.ok ? '' : created.message).toBe(true);
    if (!created.ok) return;
    expect([...created.written].sort()).toEqual(
      [
        CHALLENGE_FILE_NAMES.asm,
        CHALLENGE_FILE_NAMES.private,
        CHALLENGE_FILE_NAMES.public,
        CHALLENGE_FILE_NAMES.solution,
      ].sort(),
    );

    const report = checkChallenge(NEW_ID, { root, presetRoot: REPO_ROOT, env: newEnv });
    expect(report.issues, JSON.stringify(report.issues)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('生成的 flag 是环境变量引用，真值不进仓库', () => {
    const root = makeTempRepo({});
    createChallenge(NEW_ID, { root });
    const priv = readFileSync(join(root, 'challenges', NEW_ID, 'private.json'), 'utf8');
    expect(priv).toContain(`"env:${flagEnvVarName(NEW_ID)}"`);
  });

  it('生成的 solution.md 带机器可读块，能配 fake replay 通过', async () => {
    const root = makeTempRepo({});
    createChallenge(NEW_ID, { root });
    const report = await solveChallenge(NEW_ID, {
      root,
      presetRoot: REPO_ROOT,
      env: newEnv,
      replay: fakeReplay('won'),
    });
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  });

  it('目录里已有文件时拒绝覆盖，--force 才覆盖', () => {
    const root = makeTempRepo({});
    expect(createChallenge(NEW_ID, { root }).ok).toBe(true);

    const again = createChallenge(NEW_ID, { root });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.message).toContain('拒绝覆盖');

    expect(createChallenge(NEW_ID, { root, force: true }).ok).toBe(true);
  });

  it('非法 id 被拒绝，不建目录', () => {
    const root = makeTempRepo({});
    const result = createChallenge('Bad/Id', { root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('题目 id 不合法');
    expect(existsSync(join(root, 'challenges', 'Bad'))).toBe(false);
  });
});
