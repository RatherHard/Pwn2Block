import { describe, expect, it } from 'vitest';
import { main, type CliOptions } from '../src/cli';
import { FIXTURES, OK_ROOT, REPO_ROOT, SENTINEL, captureStdio, failingReplay, fakeReplay, makeTempRepo } from './helpers';

interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** 跑一次 CLI 并截获输出；不碰 `process.exitCode`。 */
async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  const captured = captureStdio();
  try {
    const code = await main(argv, options);
    return { code, out: captured.stdoutText(), err: captured.stderrText() };
  } finally {
    captured.restore();
  }
}

const ret2winEnv = { FLAG_RET2WIN: SENTINEL };

describe('CLI：用法与退出码', () => {
  it('无参数与 --help 都打印用法并返回 0', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['check', '--help']]) {
      const result = await runCli(argv);
      expect(result.code, argv.join(' ')).toBe(0);
      expect(result.out).toContain('pnpm challenge:<command>');
      expect(result.out).toContain('check <id>');
      expect(result.out).toContain('solve <id>');
      expect(result.out).toContain('FLAG_<ID大写>');
    }
  });

  it('未知子命令返回 2', async () => {
    const result = await runCli(['bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('未知子命令');
  });

  it('check / solve / new / asm 缺 id 返回 2', async () => {
    for (const command of ['check', 'solve', 'new', 'asm']) {
      const result = await runCli([command]);
      expect(result.code, command).toBe(2);
      expect(result.err).toContain(`challenge:${command} <id>`);
    }
  });
});

describe('CLI：check', () => {
  it('没有题目包时提示并返回 0（出题前 CI 也要绿）', async () => {
    const result = await runCli(['check', '--all'], { root: makeTempRepo({}) });
    expect(result.code).toBe(0);
    expect(result.out).toContain('还没有题目包');
  });

  it('全部题目通过时返回 0', async () => {
    const result = await runCli(['check', '--all'], {
      root: OK_ROOT,
      env: { FLAG_OKWIN: SENTINEL },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('challenges/okwin: ok');
    expect(result.out).toContain('共 1 道，0 道有问题');
  });

  it('单题通过时返回 0', async () => {
    const result = await runCli(['check', 'ret2win'], { root: FIXTURES, env: ret2winEnv });
    expect(result.code).toBe(0);
    expect(result.out).toContain('challenges/ret2win: ok');
  });

  it('有问题时逐条打印 path: message 并返回 1', async () => {
    const result = await runCli(['check', 'broken'], {
      root: FIXTURES,
      env: { FLAG_BROKEN: SENTINEL },
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('challenges/broken/vmas.text.start: 地址必须按 0x1000 对齐');
    expect(result.out).toContain('challenges/broken/presets/bad-shape.json:');
  });

  it('flag 缺失时返回 1 并说明环境变量名', async () => {
    const result = await runCli(['check', 'ret2win'], { root: FIXTURES, env: {} });
    expect(result.code).toBe(1);
    expect(result.out).toContain('challenges/ret2win/flag:');
    expect(result.out).toContain('FLAG_RET2WIN');
  });

  it('--all 里有坏题目时返回 1，但报全所有题目', async () => {
    const result = await runCli(['check', '--all'], {
      root: FIXTURES,
      presetRoot: REPO_ROOT,
      env: ret2winEnv,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('challenges/ret2win: ok');
    expect(result.out).toContain('challenges/broken/');
    expect(result.out).toContain('共 3 道');
  });

  it('不存在的题目返回 1', async () => {
    const result = await runCli(['check', 'nosuch'], { root: FIXTURES });
    expect(result.code).toBe(1);
    expect(result.out).toContain('题目包不存在');
  });
});

describe('CLI：solve', () => {
  it('回放通过时返回 0', async () => {
    const result = await runCli(['solve', 'ret2win'], {
      root: FIXTURES,
      env: ret2winEnv,
      replay: fakeReplay('won'),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('回放通过');
  });

  it('verdict 不符时返回 1', async () => {
    const result = await runCli(['solve', 'ret2win'], {
      root: FIXTURES,
      env: ret2winEnv,
      replay: fakeReplay('failed'),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('期望 won');
  });

  it('回放不可用时返回 1 并说明原因，绝不假装通过', async () => {
    const result = await runCli(['solve', 'ret2win'], {
      root: FIXTURES,
      env: ret2winEnv,
      replay: failingReplay('引擎回放不可用：B01/B03 未接通'),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('引擎回放不可用');
  });

  it('--all 没有题目包时返回 0', async () => {
    const result = await runCli(['solve', '--all'], { root: makeTempRepo({}) });
    expect(result.code).toBe(0);
    expect(result.out).toContain('还没有题目包');
  });

  it('--all 汇总全部题目', async () => {
    const result = await runCli(['solve', '--all'], {
      root: OK_ROOT,
      env: { FLAG_OKWIN: SENTINEL },
      replay: fakeReplay('won'),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('challenges/okwin: 回放通过');
    expect(result.out).toContain('共 1 道，0 道未通过');
  });
});

describe('CLI：new', () => {
  it('生成四个文件并返回 0，同时提示 flag 环境变量名', async () => {
    const root = makeTempRepo({});
    const result = await runCli(['new', 'hello'], { root });
    expect(result.code).toBe(0);
    expect(result.out).toContain('challenges/hello: 已生成 4 个文件');
    expect(result.out).toContain('FLAG_HELLO');

    const again = await runCli(['new', 'hello'], { root });
    expect(again.code).toBe(1);
    expect(again.err).toContain('拒绝覆盖');

    const forced = await runCli(['new', 'hello', '--force'], { root });
    expect(forced.code).toBe(0);
  });
});

describe('CLI：asm', () => {
  it('伪汇编器未实现时返回 1 并说明（不假装成功）', async () => {
    const result = await runCli(['asm', 'ret2win'], { root: FIXTURES, env: ret2winEnv });
    expect(result.code).toBe(1);
    expect(result.err).toContain('伪汇编器尚未实现');
  });

  it('题目不存在时返回 1', async () => {
    const result = await runCli(['asm', 'nosuch'], { root: FIXTURES });
    expect(result.code).toBe(1);
    expect(result.out).toContain('题目包不存在');
  });
});
