import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { FIXTURES, SENTINEL, captureStdio } from './helpers';

const markdown = readFileSync(join(FIXTURES, 'challenges/ret2win/solution.md'), 'utf8');
const tempRoots: string[] = [];

function makeRepo(bytes?: Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'pwn2block-solution-encoding-'));
  tempRoots.push(root);
  const dir = join(root, 'challenges/ret2win');
  mkdirSync(dir, { recursive: true });
  for (const name of ['public.json', 'private.json', 'program.asm']) {
    cpSync(join(FIXTURES, 'challenges/ret2win', name), join(dir, name));
  }
  if (bytes !== undefined) writeFileSync(join(dir, 'solution.md'), bytes);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    const withinTemp = relative(resolve(tmpdir()), resolve(root));
    if (!withinTemp.startsWith('pwn2block-solution-encoding-') || withinTemp.includes(sep)) {
      throw new Error('拒绝清理测试临时目录之外的路径');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function runCli(command: string, target: string, root: string) {
  const captured = captureStdio();
  try {
    // 不注入 replay：成功用例必须走真实引擎，坏正文也不能借助回放失败蒙混过关。
    const code = await main([command, target], { root, env: { FLAG_RET2WIN: SENTINEL } });
    return { code, out: captured.stdoutText(), err: captured.stderrText() };
  } finally {
    captured.restore();
  }
}

const invalidFiles = [
  { name: '正文中孤立的续字节', bytes: Buffer.concat([Buffer.from([0x80]), Buffer.from(markdown)]), message: '不是合法 UTF-8' },
  { name: '文件尾截断的多字节字符', bytes: Buffer.concat([Buffer.from(markdown), Buffer.from([0xe4, 0xb8])]), message: '不是合法 UTF-8' },
  { name: '过长 UTF-8 编码', bytes: Buffer.concat([Buffer.from([0xc0, 0xaf]), Buffer.from(markdown)]), message: '不是合法 UTF-8' },
  { name: 'UTF-16 LE 文件', bytes: Buffer.from(`\uFEFF${markdown}`, 'utf16le'), message: '不是合法 UTF-8' },
  { name: '正文中的 U+FFFD', bytes: Buffer.from(`说明\uFFFD\n${markdown}`), message: '包含替换字符 U+FFFD' },
  { name: '整个文件为 CRLF', bytes: Buffer.from(markdown.replaceAll('\n', '\r\n')), message: '行尾必须使用 LF' },
  { name: '正文单独 CR', bytes: Buffer.from(`说明\r${markdown}`), message: '行尾必须使用 LF' },
  { name: '正文混合 LF 与 CRLF', bytes: Buffer.from(`说明\r\n${markdown}`), message: '行尾必须使用 LF' },
];

for (const command of ['check', 'solve']) {
  for (const target of ['ret2win', '--all']) {
    describe(`solution.md 编码：CLI ${command} ${target}`, () => {
      it.each(invalidFiles)('拒绝 $name，并定位文件与中文原因', async ({ bytes, message }) => {
        const root = makeRepo(bytes);
        const result = await runCli(command, target, root);
        expect(result.code).toBe(1);
        expect(result.out).toContain(`challenges/ret2win/solution.md: ${message}`);
        expect(result.out).not.toContain('challenges/ret2win: ok');
        expect(result.out).not.toContain('回放通过');
        expect(result.err).toBe('');
        expect(readFileSync(join(root, 'challenges/ret2win/solution.md'))).toEqual(bytes);
      });

      it.each([
        { name: '中文与四字节字符、LF', text: `中文说明 🧩\n${markdown}` },
        // 仓库只规定 LF，没有禁止 UTF-8 BOM；不得误判为非法编码。
        { name: 'UTF-8 BOM', text: `\uFEFF${markdown}` },
        { name: '没有末尾换行', text: markdown.trimEnd() },
        // 这些字符是合法 UTF-8，无法静态判断是否由错误转码造成。
        { name: '已乱码但 UTF-8 仍有效的正文', text: `鍙傝€冭В娉曘€傘€\n${markdown}` },
      ])('接受 $name', async ({ text }) => {
        const root = makeRepo(Buffer.from(text));
        const result = await runCli(command, target, root);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(command === 'check' ? 'challenges/ret2win: ok' : '回放通过');
        expect(result.err).toBe('');
        expect(readFileSync(join(root, 'challenges/ret2win/solution.md'), 'utf8')).toBe(text);
      });

      it('读取失败不能当作文件缺失而跳过检查', async () => {
        const root = makeRepo();
        mkdirSync(join(root, 'challenges/ret2win/solution.md'));
        const result = await runCli(command, target, root);
        expect(result.code).toBe(1);
        expect(result.out).toContain('challenges/ret2win/solution.md: 读取失败：');
      });

      it('保留缺失文件的现有语义：check 可通过，solve 必须失败', async () => {
        const result = await runCli(command, target, makeRepo());
        expect(result.code).toBe(command === 'check' ? 0 : 1);
        if (command === 'solve') expect(result.out).toContain('没有 solution.md');
      });
    });
  }
}
