import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 出题 CLI（E01–E02 实现）：`new / asm / check / solve`（06 §2）。
 *
 * D1 只保证：
 * - 子命令路由与用法输出可用；
 * - `check --all` / `solve --all` 在没有题目包时**通过**（CI 在出题前也能绿）；
 * - 一旦 `challenges/` 下出现题目包，未实现的子命令返回非零，绝不假装通过。
 */

export const USAGE = `用法：pnpm challenge:<command> [<id>|--all]

  new <id>     从模板生成 challenges/<id>/ 的四个文件
  asm <id>     编译 program.asm，把 hex 写回 private.json
  check <id>   校验 public.json / private.json（Schema、VMA 布局、编码表、谓词）
  solve <id>   把 solution.md 里的 payload 当成一次提交回放，断言 verdict 为 won

  --all 对 challenges/ 下全部题目执行 check / solve
`;

export function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/** 列出 `challenges/` 下有 public.json + private.json 的题目 id。 */
export function listChallengeIds(root = repoRoot()): string[] {
  const dir = join(root, 'challenges');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter(
      (name) =>
        existsSync(join(dir, name, 'public.json')) && existsSync(join(dir, name, 'private.json')),
    )
    .sort();
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (!['new', 'asm', 'check', 'solve'].includes(command)) {
    process.stderr.write(`未知子命令：${command}\n\n${USAGE}`);
    return 2;
  }

  const all = rest.includes('--all');
  const target = rest.find((item) => !item.startsWith('-'));

  if (command === 'check' || command === 'solve') {
    const ids = all ? listChallengeIds() : target ? [target] : [];
    if (ids.length === 0) {
      process.stdout.write('challenges/ 下还没有题目包，跳过。\n');
      return 0;
    }
    process.stderr.write(
      `challenge:${command} 尚未实现（E01，D1–D3），不假装通过：${ids.join(', ')}\n`,
    );
    return 1;
  }

  process.stderr.write(`challenge:${command} 尚未实现（E01，D1–D3）\n`);
  return 1;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
