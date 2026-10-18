import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as compiler from './index';
import { createArtifactTracker } from './artifact';
import { compileProgram } from './compile';
import type { NormalizedWorkspace } from './types';
import { ACTION_ORIGIN_VERSION, BLOCK_TYPES } from './types';

/**
 * 编译层的纯度与冻结导出名（08 §2 规则 3、09 §3.2）。
 *
 * 两条硬约束：
 * 1. `compiler/**` 不 import Blockly、不碰 DOM——它只吃归一化后的纯数据，所以能在 node 里
 *    单测、也能在服务端或任何没有 DOM 的地方复用。这条用**源码扫描**守住：允许的模块说明符
 *    只有相对同目录文件与 `@pwn2block/shared`，代码里不出现 DOM 标识符（注释里提到 Blockly
 *    是允许的，所以先去掉注释再扫）。
 * 2. 对外导出名与 D 的接线一致：`compileProgram / actionsForRequest / createArtifactTracker`
 *    与 `BLOCK_TYPES / INPUTS / FIELDS` 等契约常量都从 `index.ts` 出得来。
 */

const COMPILER_DIR = dirname(fileURLToPath(import.meta.url));

/** 本目录下的实现文件（测试文件与探针不算：它们可以 import Blockly、也可以出现任何字符串）。 */
function implementationFiles(): readonly string[] {
  return readdirSync(COMPILER_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

function readSource(name: string): string {
  return readFileSync(join(COMPILER_DIR, name), 'utf8');
}

/** 去掉块注释与行注释：注释里可以解释"为什么不 import Blockly"，扫描只看代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 源码里所有模块说明符：`from '...'` 与动态 `import('...')`。 */
function moduleSpecifiers(code: string): readonly string[] {
  const found: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(pattern)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

const ALLOWED_SPECIFIER = /^\.\/[a-zA-Z0-9._-]+$/;

describe('编译层纯度：不 import Blockly、不碰 DOM（08 §2 规则 3）', () => {
  it('测试环境是纯 node：没有 document / window 也照样能编译', () => {
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');

    const program: NormalizedWorkspace = {
      blocks: [
        {
          id: 'start1',
          type: BLOCK_TYPES.start,
          fields: {},
          inputs: {},
          next: { id: 'p1', type: BLOCK_TYPES.actionPop, fields: {}, inputs: {} },
        },
      ],
    };
    const result = compileProgram({
      program,
      challenge: { archBits: 64, allowedActions: ['pop'], authorBlocks: [] },
    });
    expect(result).toEqual({
      ok: true,
      actions: [{ type: 'pop' }],
      origins: [{ index: 0, blockId: 'p1' }],
      originsVersion: ACTION_ORIGIN_VERSION,
    });
  });

  it('实现文件只 import 同目录相对模块与 @pwn2block/shared', () => {
    const files = implementationFiles();
    // 目录里确实有实现文件，否则这条断言会白捡通过。
    expect(files).toContain('compile.ts');
    expect(files).toContain('artifact.ts');

    for (const name of files) {
      for (const specifier of moduleSpecifiers(readSource(name))) {
        const allowed =
          ALLOWED_SPECIFIER.test(specifier) || specifier === '@pwn2block/shared';
        expect(allowed, `${name} 引入了不该引入的模块：${specifier}`).toBe(true);
      }
    }
  });

  it('实现文件里不出现 Blockly 与 DOM 标识符', () => {
    const forbidden: readonly (readonly [string, RegExp])[] = [
      ['Blockly', /blockly/i],
      ['document', /\bdocument\b/],
      ['window', /\bwindow\b/],
      ['HTMLElement', /\bHTMLElement\b/],
      ['localStorage', /\blocalStorage\b/],
      ['navigator', /\bnavigator\b/],
      ['fetch', /\bfetch\b/],
    ];
    for (const name of implementationFiles()) {
      const code = stripComments(readSource(name));
      for (const [label, pattern] of forbidden) {
        expect(pattern.test(code), `${name} 里出现了 ${label}`).toBe(false);
      }
    }
  });
});

describe('编译层：冻结的导出名（D 按它接线）', () => {
  it('入口导出编译入口、来源表版本与四个契约常量表', () => {
    expect(typeof compiler.compileProgram).toBe('function');
    expect(typeof compiler.actionsForRequest).toBe('function');
    expect(typeof compiler.createArtifactTracker).toBe('function');
    expect(compiler.ACTION_ORIGIN_VERSION).toBe(ACTION_ORIGIN_VERSION);
    expect(compiler.BLOCK_TYPES).toBe(BLOCK_TYPES);
    expect(Object.keys(compiler.INPUTS).length).toBeGreaterThan(0);
    expect(Object.keys(compiler.FIELDS).length).toBeGreaterThan(0);
    expect(compiler.DEFAULT_COMPILER_LIMITS.loopUnroll).toBeGreaterThan(0);
    expect(compiler.MAX_COMPILE_ERRORS).toBeGreaterThan(0);
    expect(compiler.FORBIDDEN_STATE_BLOCK_TYPES.length).toBeGreaterThan(0);
    expect(compiler.MESSAGE_READS_STATE).toContain('payload 不能');
  });

  it('入口导出字节原语（05 §3.1 的 padding / string / int / addr / raw / concat）', () => {
    expect(typeof compiler.padding).toBe('function');
    expect(typeof compiler.string).toBe('function');
    expect(typeof compiler.int).toBe('function');
    expect(typeof compiler.addr).toBe('function');
    expect(typeof compiler.raw).toBe('function');
    expect(typeof compiler.concat).toBe('function');
    expect(typeof compiler.wordBytes).toBe('function');
    expect(compiler.ByteBuildError).toBeTypeOf('function');
  });

  it('跟踪器的五个成员一个不多一个不少（D 读 state，调 compile / adopt / noteEdit / clear）', () => {
    const tracker = createArtifactTracker();
    expect(Object.keys(tracker).sort()).toEqual(['adopt', 'clear', 'compile', 'noteEdit', 'state']);
    expect(typeof tracker.compile).toBe('function');
    expect(typeof tracker.adopt).toBe('function');
    expect(typeof tracker.noteEdit).toBe('function');
    expect(typeof tracker.clear).toBe('function');
    expect(Object.keys(tracker.state).sort()).toEqual([
      'artifact',
      'errors',
      'revision',
      'stale',
    ]);
  });
});
