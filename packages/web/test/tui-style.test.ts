import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TUI 样式清扫的回归测试（任务 2，`docs/superpowers/specs/2026-10-17-frontend-tui-design.md` §1）。
 *
 * 直接读源码文本做正则断言：不依赖 Blockly / jsdom 渲染，只保证装饰性 CSS、旧 token
 * 名字和终端装饰文案不会再出现在 `theme.ts`、`mount.ts` 与各组件源码里。
 */

const THEME_PATH = fileURLToPath(new URL('../src/theme.ts', import.meta.url));
const MOUNT_PATH = fileURLToPath(new URL('../src/blocks/mount.ts', import.meta.url));

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

async function componentSources(): Promise<readonly (readonly [string, string])[]> {
  const { glob } = await import('node:fs/promises');
  const dir = fileURLToPath(new URL('../src/components', import.meta.url));
  const files: string[] = [];
  for await (const entry of glob('*.ts', { cwd: dir })) files.push(entry);
  return files.map((name) => [name, readSource(fileURLToPath(new URL(`../src/components/${name}`, import.meta.url)))] as const);
}

export const BANNED_PATTERNS: readonly RegExp[] = [
  /gradient\(/,
  /box-shadow:(?!\s*none)/,
  /border-radius:(?!\s*0[;\s])/,
  /rgba?\([^)]*\/\s*\d/,
  /rgba\(/,
  /backdrop-filter/,
  /--p2b-(accent|warn|panel|bg-alt|line-soft|shadow|terminal)/,
  /\/proc\/pwn2block/,
  /root@pwn2block/,
  /window-lights/,
  /◈/,
  /innerHTML/,
  /unsafeHTML/,
  /font-size:(?!\s*(?:inherit|var\(--p2b-size\)))/,
];

const [BOX_SHADOW, BORDER_RADIUS, FONT_SIZE] = [
  BANNED_PATTERNS[1]!,
  BANNED_PATTERNS[2]!,
  BANNED_PATTERNS[BANNED_PATTERNS.length - 1]!,
];

describe('TUI 样式清扫（设计 §1）', () => {
  it('禁用正则不会因 \\s* 回溯而误判合法写法（冒号后带空格）', () => {
    expect('border-radius: 0;').not.toMatch(BORDER_RADIUS);
    expect('box-shadow: none;').not.toMatch(BOX_SHADOW);
    expect('font-size: inherit;').not.toMatch(FONT_SIZE);
    expect('font-size: var(--p2b-size);').not.toMatch(FONT_SIZE);
    expect('border-radius: 4px;').toMatch(BORDER_RADIUS);
    expect('box-shadow: 0 1px red;').toMatch(BOX_SHADOW);
    expect('font-size: 12px;').toMatch(FONT_SIZE);
  });


  it('theme.ts 不含装饰性 CSS、旧 token 或禁用标记，并声明 color-scheme: dark', async () => {
    const source = readSource(THEME_PATH);
    for (const pattern of BANNED_PATTERNS) {
      expect(source, `theme.ts 命中 ${pattern}`).not.toMatch(pattern);
    }
    expect(source).toContain('color-scheme: dark');
  });

  it('mount.ts 不含装饰性 CSS、旧 token 或禁用标记', async () => {
    const source = readSource(MOUNT_PATH);
    for (const pattern of BANNED_PATTERNS) {
      expect(source, `mount.ts 命中 ${pattern}`).not.toMatch(pattern);
    }
  });

  it('components/*.ts 不含装饰性 CSS、旧 token 或禁用标记', async () => {
    const sources = await componentSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const [file, source] of sources) {
      for (const pattern of BANNED_PATTERNS) {
        expect(source, `${file} 命中 ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
