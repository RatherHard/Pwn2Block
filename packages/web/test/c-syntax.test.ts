import { describe, expect, it } from 'vitest';
import { C_TOKEN_KINDS, tokenizeC, type CTokenKind } from '../src/viewmodel/c-syntax';

/**
 * 伪代码语法着色的词法单元（`viewmodel/c-syntax.ts`）。
 *
 * 最要紧的一条不变量：token 的 `text` 依次拼起来必须等于原文。渲染层直接插值这些文本，
 * 只要这条成立，伪代码里出现 `<` `&` `"` 也不会改变显示内容。
 */

/** (类别, 原文) 序列：比对象数组好读，失败时的 diff 也直接。 */
function pairs(source: string): readonly (readonly [CTokenKind, string])[] {
  return tokenizeC(source).map(({ kind, text }) => [kind, text] as const);
}

function textsOf(source: string, kind: CTokenKind): readonly string[] {
  return tokenizeC(source).filter((token) => token.kind === kind).map((token) => token.text);
}

/** 各类别都有真实输入能命中：新增类别时这份清单也要跟着加，否则配色测试会漏。 */
const SAMPLES: Readonly<Record<Exclude<CTokenKind, 'plain'>, string>> = {
  comment: '// 行注释\n/* 块注释 */',
  preprocessor: '#include <stdio.h>\n',
  string: 'puts("hi"); char c = \'x\';',
  number: 'int x = 0x10;',
  keyword: 'return 1;',
  type: 'char c; size_t n;',
  function: 'vuln();',
};

describe('tokenizeC：原文一个字符都不改', () => {
  const sources: readonly string[] = [
    '',
    '   ',
    'int main(void) {\n  return 0;\n}\n',
    '/* 中文注释：栈 / RSP */\n',
    'puts("a\\"b"); char c = \'{\';',
    '#define A \\\n 1\n',
    '#include <stdio.h>\r\n',
    '/* 没写结尾的块注释',
    '"没写结尾的字符串\nint x;',
    'int x = 1.5e-3;',
  ];

  it.each(sources)('%j 拼回原文', (source) => {
    expect(tokenizeC(source).map((token) => token.text).join('')).toBe(source);
  });

  it('空输入没有 token', () => {
    expect(tokenizeC('')).toEqual([]);
  });

  it('相邻同类 token 合并，空白与标点并进 plain', () => {
    expect(pairs('int  x;')).toEqual([
      ['type', 'int'],
      ['plain', '  x;'],
    ]);
  });

  it('token 覆盖全部源码：切出来的文本既不丢弃也不重复', () => {
    const source = SAMPLES.comment + SAMPLES.preprocessor + SAMPLES.string + SAMPLES.function;
    let cursor = 0;
    for (const token of tokenizeC(source)) {
      expect(source.slice(cursor, cursor + token.text.length)).toBe(token.text);
      cursor += token.text.length;
    }
    expect(cursor).toBe(source.length);
  });
});

describe('tokenizeC：各类词', () => {
  it('关键字、内置类型、函数名、数字各归各类', () => {
    expect(pairs('int main(void) { return 0; }')).toEqual([
      ['type', 'int'],
      ['plain', ' '],
      ['function', 'main'],
      ['plain', '('],
      ['type', 'void'],
      ['plain', ') { '],
      ['keyword', 'return'],
      ['plain', ' '],
      ['number', '0'],
      ['plain', '; }'],
    ]);
  });

  it('`*_t` 标准整数类型算类型，普通标识符不算函数名', () => {
    expect(pairs('ssize_t n = read(0, buf, 0x100);')).toEqual([
      ['type', 'ssize_t'],
      ['plain', ' n = '],
      ['function', 'read'],
      ['plain', '('],
      ['number', '0'],
      ['plain', ', buf, '],
      ['number', '0x100'],
      ['plain', ');'],
    ]);
  });

  it('标识符后面紧跟括号才是函数名，关键字优先于函数名', () => {
    expect(textsOf('if (x) printf("hi");', 'keyword')).toEqual(['if']);
    expect(textsOf('if (x) printf("hi");', 'function')).toEqual(['printf']);
    expect(textsOf('int f;', 'function')).toEqual([]);
  });

  it('十六进制、二进制、小数、指数与整数后缀都算一个数字', () => {
    expect(textsOf('a 0x1010 b 0b1010 c 60 d 1.5e-3 e 123ULL f 0xFFul', 'number')).toEqual([
      '0x1010',
      '0b1010',
      '60',
      '1.5e-3',
      '123ULL',
      '0xFFul',
    ]);
  });

  it('行注释止于行尾，换行留给下一行；注释里的引号不开字符串', () => {
    expect(pairs('// "不是字符串"\nint x;')).toEqual([
      ['comment', '// "不是字符串"'],
      ['plain', '\n'],
      ['type', 'int'],
      ['plain', ' x;'],
    ]);
  });

  it('块注释可以跨行，字符串里的注释符也不开注释', () => {
    expect(pairs('/* 第一行\n第二行 */ int x;')).toEqual([
      ['comment', '/* 第一行\n第二行 */'],
      ['plain', ' '],
      ['type', 'int'],
      ['plain', ' x;'],
    ]);
    expect(textsOf('puts("/* 不是注释 */");', 'comment')).toEqual([]);
  });

  it('字符串与字符常量按转义跳读，单引号里的花括号不打断它', () => {
    expect(textsOf(String.raw`char c = '\''; s = "a\"b";`, 'string')).toEqual([
      String.raw`'\''`,
      String.raw`"a\"b"`,
    ]);
  });

  it('未闭合的块注释吃到文件末尾，不抛错也不吞掉换行', () => {
    expect(pairs('/* 没有结尾')).toEqual([['comment', '/* 没有结尾']]);
  });

  it('未闭合的字符串止于行尾，后面的代码照常着色', () => {
    expect(pairs('"没写结尾\nint x;')).toEqual([
      ['string', '"没写结尾'],
      ['plain', '\n'],
      ['type', 'int'],
      ['plain', ' x;'],
    ]);
  });

  it('行首的 `#` 才是预处理指令，行中的 `#` 是普通字符', () => {
    expect(textsOf('  #include <stdio.h>\n#define X 1\n', 'preprocessor')).toEqual([
      '#include <stdio.h>',
      '#define X 1',
    ]);
    expect(pairs('int x = 1; # 2')).toEqual([
      ['type', 'int'],
      ['plain', ' x = '],
      ['number', '1'],
      ['plain', '; # '],
      ['number', '2'],
    ]);
  });

  it('预处理指令的行尾反斜杠是续行，下一行仍属于同一条指令', () => {
    expect(textsOf('#define A \\\n  1\nint x;\n', 'preprocessor')).toEqual(['#define A \\\n  1']);
  });

  it('真实伪代码形状：注释、类型、函数名、数字各自成立', () => {
    const source = [
      '/* vuln：read 想读 0x100 字节，只给 buf 留了 0x50。 */',
      'void vuln(void)',
      '{',
      '    char buf[0x50];',
      '    ssize_t n = read(0, buf, 0x100);',
      '    (void)n;',
      '}',
      '',
    ].join('\n');

    expect(tokenizeC(source).map((token) => token.text).join('')).toBe(source);
    expect(textsOf(source, 'type')).toEqual(['void', 'void', 'char', 'ssize_t', 'void']);
    expect(textsOf(source, 'function')).toEqual(['vuln', 'read']);
    expect(textsOf(source, 'number')).toEqual(['0x50', '0', '0x100']);
    expect(textsOf(source, 'comment')).toEqual(['/* vuln：read 想读 0x100 字节，只给 buf 留了 0x50。 */']);
  });

  it('每个类别都有样例命中（防止样例写坏后测试悄悄空转）', () => {
    for (const kind of C_TOKEN_KINDS) {
      if (kind === 'plain') continue;
      expect(textsOf(SAMPLES[kind], kind).length, `${kind} 没有样例命中`).toBeGreaterThan(0);
    }
  });
});
