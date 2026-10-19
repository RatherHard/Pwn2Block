import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TUI 样式清扫的回归测试（任务 2，`docs/superpowers/specs/2026-10-17-frontend-tui-design.md` §1）。
 *
 * 直接读源码文本做正则断言：不依赖 DOM 渲染，只保证装饰性 CSS、旧 token
 * 名字和终端装饰文案不会再出现在 `theme.ts` 与各组件源码里。
 */

const THEME_PATH = fileURLToPath(new URL('../src/theme.ts', import.meta.url));
const TOP_BAR_PATH = fileURLToPath(new URL('../src/components/top-bar.ts', import.meta.url));

/** 引号字符串：值里不含同种引号，否则 `'x' / ''` 整段会被当成一个值。 */
const QUOTED = String.raw`(?:'([^']+)'|"([^"]+)")`;
/** 一条只有字符串值的 `content` 声明；单双引号、冒号与分号两侧的空白都算。 */
const CONTENT_DECL = new RegExp(String.raw`^\s*content\s*:\s*${QUOTED}\s*;\s*$`);
/** 同一条声明的空替代文本版本：`content: 'x' / '';`，同样容许引号与空白的写法差异。 */
const CONTENT_ALT_DECL = new RegExp(String.raw`^\s*content\s*:\s*${QUOTED}\s*\/\s*(?:''|"")\s*;\s*$`);

/** 声明里的字符串值（单引号或双引号那一组）。 */
function quotedValue(match: RegExpExecArray | null): string | undefined {
  return match === null ? undefined : match[1] ?? match[2];
}

/**
 * 每条装饰性 `content` 后面紧跟同值的空替代文本版本：`content: 'x'; content: 'x' / '';`。
 * 否则 Chromium 把「[ 」「 ]」「⌄」算进按钮 / 菜单的无障碍名称，读屏会念出来。
 * 返回不合规的声明，空数组表示合规。
 */
export function contentWithoutAltText(source: string): readonly string[] {
  const lines = source.split('\n');
  const bad: string[] = [];
  for (const [index, line] of lines.entries()) {
    const value = quotedValue(CONTENT_DECL.exec(line));
    if (value === undefined) continue;
    if (quotedValue(CONTENT_ALT_DECL.exec(lines[index + 1] ?? '')) !== value) bad.push(line.trim());
  }
  return bad;
}

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

const BOX_SHADOW = /box-shadow:(?!\s*none)/;
const BORDER_RADIUS = /border-radius:(?!\s*0[;\s])/;
const FONT_SIZE = /font-size:(?!\s*(?:inherit|var\(--p2b-size\)))/;

export const BANNED_PATTERNS: readonly RegExp[] = [
  /gradient\(/,
  BOX_SHADOW,
  BORDER_RADIUS,
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
  FONT_SIZE,
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

  it('装饰性 content 检查能识别缺少替代文本的写法', () => {
    expect(contentWithoutAltText("  content: '[ ';\n  content: '[ ' / '';")).toEqual([]);
    expect(contentWithoutAltText("  content: '[ ';")).toEqual(["content: '[ ';"]);
    expect(contentWithoutAltText("  content: '⌄';\n  content: '⌃' / '';")).toEqual(["content: '⌄';"]);
  });

  it('装饰性 content 检查覆盖双引号与空白的写法差异', () => {
    // 缺替代文本：双引号、无空格、冒号前后与分号前带空格都要被抓到。
    expect(contentWithoutAltText('  content:"x";')).toEqual(['content:"x";']);
    expect(contentWithoutAltText("  content : 'x' ;")).toEqual(["content : 'x' ;"]);
    expect(contentWithoutAltText('  content: "x";\n  content: "y" / "";')).toEqual(['content: "x";']);
    // 合规：替代文本版本同样容许这些写法差异。
    expect(contentWithoutAltText('  content:"x";\n  content:"x"/"";')).toEqual([]);
    expect(contentWithoutAltText("  content : 'x' ;\n  content : 'x' / '' ;")).toEqual([]);
    // 非字符串值与别的属性不算装饰性 content。
    expect(contentWithoutAltText('  content: none;\n  justify-content: center;')).toEqual([]);
  });

  it('theme.ts 与组件里的装饰性 content 都带空替代文本，不计入无障碍名称', async () => {
    expect(contentWithoutAltText(readSource(THEME_PATH)), 'theme.ts').toEqual([]);
    for (const [file, source] of await componentSources()) {
      expect(contentWithoutAltText(source), file).toEqual([]);
    }
  });

  it('theme.ts 不含装饰性 CSS、旧 token 或禁用标记，并声明 color-scheme: dark', async () => {
    const source = readSource(THEME_PATH);
    for (const pattern of BANNED_PATTERNS) {
      expect(source, `theme.ts 命中 ${pattern}`).not.toMatch(pattern);
    }
    expect(source).toContain('color-scheme: dark');
  });

  it('顶栏模式按钮的选中态在 .modes 作用域里重新反显（透明背景会盖过 button.on）', () => {
    const source = readSource(TOP_BAR_PATH);
    expect(source).toMatch(/\.modes button\.on,\s*\.modes button:hover:not\(:disabled\) \{\s*color: var\(--p2b-bg\);\s*background: var\(--p2b-fg\);/);
  });

  it('运行菜单的开合箭头用同一个两边框图形旋转，不用高低不一的字符箭头', () => {
    const source = readSource(TOP_BAR_PATH);
    expect(source).not.toMatch(/[⌄⌃›]/u);
    expect(source).toMatch(/\.menu > summary::after \{[^}]*border-right:[^}]*border-bottom:[^}]*transform: rotate\(-45deg\);/);
    expect(source).toMatch(/\.menu\[open\] > summary::after \{[^}]*rotate\(45deg\)/);
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
