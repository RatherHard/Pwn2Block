/**
 * C 伪代码的语法着色（视图「伪代码」，原文来自 `challenges/<id>/pseudocode.c`）。
 *
 * 纯函数：把源码切成 `{ kind, text }` 序列，**一个字符都不改**——所有 token 的 `text`
 * 依次拼起来就是入参原文。渲染层因此只做 Lit 插值：伪代码里的 `<` `&` 仍是文本，
 * 不需要也不允许 innerHTML。
 *
 * 着色只是可读性装饰：颜色不承载额外信息，去掉颜色后同样是完整的代码，所以这里不做
 * 语法分析，只按词法识别代码里显眼的那几类词。识别范围按「教学用 C 伪代码」取最小集：
 * 注释、预处理指令、字符串 / 字符常量、数字、关键字、内置类型与 `*_t` 标准整数类型、
 * 函数名（标识符后面紧跟 `(`）。
 */

/** 着色类别；`plain` 是原样输出的默认文本（标识符、运算符、空白）。 */
export const C_TOKEN_KINDS = [
  'plain',
  'comment',
  'preprocessor',
  'string',
  'number',
  'keyword',
  'type',
  'function',
] as const;

export type CTokenKind = (typeof C_TOKEN_KINDS)[number];

export interface CToken {
  readonly kind: CTokenKind;
  readonly text: string;
}

/** C89–C23 的关键字，外加 `true` / `false` / `nullptr` 这类字面常量：只影响着色。 */
const KEYWORDS: ReadonlySet<string> = new Set([
  '_Alignas',
  '_Alignof',
  '_Atomic',
  '_BitInt',
  '_Complex',
  '_Generic',
  '_Imaginary',
  '_Noreturn',
  '_Static_assert',
  '_Thread_local',
  'alignas',
  'alignof',
  'auto',
  'break',
  'case',
  'const',
  'constexpr',
  'continue',
  'default',
  'do',
  'else',
  'enum',
  'extern',
  'false',
  'for',
  'goto',
  'if',
  'inline',
  'nullptr',
  'register',
  'restrict',
  'return',
  'sizeof',
  'static',
  'static_assert',
  'struct',
  'switch',
  'thread_local',
  'true',
  'typedef',
  'typeof',
  'typeof_unqual',
  'union',
  'volatile',
  'while',
]);

/** 内置类型；标准整数类型（`size_t`、`uint64_t`…）由 `*_t` 后缀规则识别。 */
const TYPES: ReadonlySet<string> = new Set([
  '_Bool',
  'bool',
  'char',
  'double',
  'float',
  'int',
  'long',
  'short',
  'signed',
  'unsigned',
  'void',
]);

/** `size_t`、`ssize_t`、`uint64_t` 这类标准整数类型名。 */
const STD_TYPE = /^[A-Za-z_]\w*_t$/;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * 预处理指令到行尾；行尾的反斜杠是续行，下一行仍属于同一条指令。
 * 返回的终点不含换行，换行留给主循环当普通文本。
 */
function scanPreprocessor(source: string, start: number): number {
  let i = start;
  for (;;) {
    const newline = source.indexOf('\n', i);
    if (newline === -1) return source.length;
    let backslashes = 0;
    for (let j = newline - 1; j >= start && source[j] === '\\'; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return newline;
    i = newline + 1;
  }
}

/** 字符串 / 字符常量：跳过反斜杠转义；未闭合时止于行尾，不把后面的代码吞进同一个 token。 */
function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i += 1;
  }
  return source.length;
}

/** 数字字面量：十进制（含小数与指数）、`0x` 十六进制、`0b` 二进制，以及 `u` / `l` / `f` 后缀。 */
function scanNumber(source: string, start: number): number {
  let i = start;
  const hex = source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X');
  const bin = !hex && source[i] === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B');
  if (hex || bin) {
    i += 2;
    while (i < source.length && (bin ? source[i] === '0' || source[i] === '1' : isHexDigit(source[i]))) i += 1;
    while (i < source.length && 'uUlL'.includes(source[i])) i += 1;
    return i;
  }
  while (i < source.length && (isDigit(source[i]) || source[i] === '.')) i += 1;
  if (source[i] === 'e' || source[i] === 'E') {
    let j = i + 1;
    if (source[j] === '+' || source[j] === '-') j += 1;
    if (isDigit(source[j])) {
      i = j;
      while (i < source.length && isDigit(source[i])) i += 1;
    }
  }
  while (i < source.length && 'uUlLfF'.includes(source[i])) i += 1;
  return i;
}

/** 标识符后面第一个非空白字符：紧跟 `(` 的标识符就是函数名（调用或定义）。 */
function nextNonSpace(source: string, from: number): string {
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') return ch;
  }
  return '';
}

function classify(word: string, next: string): CTokenKind {
  if (KEYWORDS.has(word)) return 'keyword';
  if (TYPES.has(word) || STD_TYPE.test(word)) return 'type';
  return next === '(' ? 'function' : 'plain';
}

function scanIdentifier(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length && isIdentPart(source[i])) i += 1;
  return i;
}

/**
 * 把 C 伪代码切成着色 token。相邻的同类 token 会合并（主要是把空白和标点并进 `plain`），
 * 所以 token 数量与源码长度成正比，而不是与字符数成正比。
 */
export function tokenizeC(source: string): readonly CToken[] {
  const tokens: CToken[] = [];
  /** 当前行是否只有空白：只有行首的 `#` 才是预处理指令，`#` 在别处只是普通字符。 */
  let atLineStart = true;
  let i = 0;

  const push = (kind: CTokenKind, text: string): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind) {
      tokens[tokens.length - 1] = { kind, text: last.text + text };
      return;
    }
    tokens.push({ kind, text });
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      push('plain', ch);
      i += 1;
      continue;
    }

    if (ch === '\n') {
      push('plain', ch);
      atLineStart = true;
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : close + 2;
      push('comment', source.slice(i, stop));
      atLineStart = false;
      i = stop;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      const stop = newline === -1 ? source.length : newline;
      push('comment', source.slice(i, stop));
      atLineStart = false;
      i = stop;
      continue;
    }

    if (ch === '#' && atLineStart) {
      const stop = scanPreprocessor(source, i);
      push('preprocessor', source.slice(i, stop));
      atLineStart = false;
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const stop = scanQuoted(source, i, ch);
      push('string', source.slice(i, stop));
      atLineStart = false;
      i = stop;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const stop = scanNumber(source, i);
      push('number', source.slice(i, stop));
      atLineStart = false;
      i = stop;
      continue;
    }

    if (isIdentStart(ch)) {
      const stop = scanIdentifier(source, i);
      const word = source.slice(i, stop);
      push(classify(word, nextNonSpace(source, stop)), word);
      atLineStart = false;
      i = stop;
      continue;
    }

    push('plain', ch);
    atLineStart = false;
    i += 1;
  }

  return tokens;
}
