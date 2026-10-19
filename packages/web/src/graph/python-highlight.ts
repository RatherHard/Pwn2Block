/**
 * Python 代码的语法着色与缩进辅助（节点画布右侧属性面板的内嵌编辑器用）。
 *
 * 纯函数、不碰 DOM、不执行任何代码：`tokenizePython` 只做词法切分，返回的 token 依次拼接
 * **严格等于**入参原文，渲染层因此只做文本插值。未闭合的三引号一路吃到文本末尾，绝不抛异常
 * ——用户正在敲字的半截源码也得能着色。
 *
 * 另三个函数只算「文本 + 光标位置」：`indentOf` 读行首缩进，`autoIndent` 补回车缩进，`applyIndent` 管 Tab。
 */
export type PythonTokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'builtin' | 'operator';

export interface PythonToken {
  readonly text: string;
  readonly kind: PythonTokenKind;
}

/** 一级缩进：4 空格（PEP 8）。组件与测试都显式传 `unit`，这里只作默认值。 */
const INDENT_UNIT = '    ';

/** 着色用的关键字集合：只影响颜色，不参与任何语法分析。 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or',
  'import', 'from', 'as', 'try', 'except', 'finally', 'with', 'lambda', 'pass', 'break',
  'continue', 'is', 'global', 'nonlocal', 'yield', 'assert', 'raise', 'del', 'None', 'True', 'False',
]);

/** 内置名：`struct` / `pack` / `unpack` 是 CTF 脚本里最常见的导入名与函数名，一并上色。 */
const BUILTINS: ReadonlySet<string> = new Set([
  'len', 'range', 'int', 'str', 'bytes', 'bytearray', 'ord', 'chr', 'hex', 'bin', 'enumerate',
  'zip', 'list', 'dict', 'set', 'tuple', 'sorted', 'min', 'max', 'sum', 'abs', 'print',
  'struct', 'pack', 'unpack',
]);

/** 运算符与括号；相邻的会合并成一个 token（`==`、`()` 都算 operator）。 */
const OPERATORS = '+-*/%=<>!&|^~@()[]{}';

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isHexDigit = (ch: string): boolean => isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
const isIdentStart = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
const isIdentPart = (ch: string): boolean => isIdentStart(ch) || isDigit(ch);

/** 字符串字面量的终点（不含）：三引号允许跨行、未闭合就吃到末尾；单双引号遇到换行就收手，
 * 否则刚敲下的一个引号会染绿后面整篇代码。 */
function scanString(code: string, start: number): number {
  const quote = code[start];
  const fence = code.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  const multiline = fence.length === 3;
  let i = start + fence.length;
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2;
      continue;
    }
    if (code.startsWith(fence, i)) return i + fence.length;
    if (code[i] === '\n' && !multiline) return i;
    i += 1;
  }
  return code.length; // 未闭合：吃到末尾，不抛错
}

/** 进制前缀对应的数字判定：`0x` 十六进制、`0o` 八进制、`0b` 二进制。 */
function radixDigit(marker: string): (ch: string) => boolean {
  if (marker === 'x') return isHexDigit;
  if (marker === 'b') return (ch: string): boolean => ch === '0' || ch === '1';
  return (ch: string): boolean => ch >= '0' && ch <= '7';
}

/** 数字字面量：十进制（含小数与指数）、`0x` / `0o` / `0b`，允许 `_` 分隔符。 */
function scanNumber(code: string, start: number): number {
  const marker = code[start] === '0' ? (code[start + 1] ?? '').toLowerCase() : '';
  let i = start;
  if (marker === 'x' || marker === 'o' || marker === 'b') {
    i += 2;
    const digit = radixDigit(marker);
    while (i < code.length && (digit(code[i]) || code[i] === '_')) i += 1;
    return i;
  }
  while (i < code.length && (isDigit(code[i]) || code[i] === '_')) i += 1;
  if (code[i] === '.') {
    i += 1;
    while (i < code.length && (isDigit(code[i]) || code[i] === '_')) i += 1;
  }
  if (code[i] === 'e' || code[i] === 'E') {
    let j = i + 1;
    if (code[j] === '+' || code[j] === '-') j += 1;
    if (isDigit(code[j] ?? '')) {
      i = j;
      while (i < code.length && isDigit(code[i])) i += 1;
    }
  }
  return i;
}

function classify(word: string): PythonTokenKind {
  if (KEYWORDS.has(word)) return 'keyword';
  if (BUILTINS.has(word)) return 'builtin';
  return 'plain';
}

/** 把 Python 源码切成着色 token。相邻同类会合并（主要是把空白并进 `plain`），
 * 所以 token 数量随源码长度线性增长；拼接全部 `text` 恒等于 `code`。 */
export function tokenizePython(code: string): readonly PythonToken[] {
  const tokens: PythonToken[] = [];
  const push = (kind: PythonTokenKind, text: string): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind) tokens[tokens.length - 1] = { kind, text: last.text + text };
    else tokens.push({ kind, text });
  };

  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '#') {
      const newline = code.indexOf('\n', i);
      const stop = newline === -1 ? code.length : newline;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const stop = scanString(code, i);
      push('string', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (isDigit(ch)) {
      const stop = scanNumber(code, i);
      push('number', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (isIdentStart(ch)) {
      let stop = i + 1;
      while (stop < code.length && isIdentPart(code[stop])) stop += 1;
      const word = code.slice(i, stop);
      push(classify(word), word);
      i = stop;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      push('operator', ch);
      i += 1;
      continue;
    }
    push('plain', ch);
    i += 1;
  }
  return tokens;
}

/** 一行开头的缩进（空格与制表符原样返回）。 */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** 回车后的缩进建议：在 `caret` 处插入换行加建议缩进，返回新文本与新光标位。
 * 上一行（光标所在行、光标之前的部分）以 `:` 结尾时多缩进一级，否则沿用它的缩进；空行不加缩进。 */
export function autoIndent(
  text: string,
  caret: number,
  unit: string = INDENT_UNIT,
): { readonly text: string; readonly caret: number } {
  const width = unit === '' ? INDENT_UNIT : unit;
  const at = Math.max(0, Math.min(caret, text.length));
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  const trimmed = line.trim();
  const indent = trimmed === '' ? '' : indentOf(line) + (trimmed.endsWith(':') ? width : '');
  const insert = `\n${indent}`;
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}

/** 行首能删掉的缩进字符数：一个制表符算一级，空格最多删一级。 */
function removableIndent(text: string, lineStart: number, width: string): number {
  if (text[lineStart] === '\t') return 1;
  let count = 0;
  while (count < width.length && text[lineStart + count] === ' ') count += 1;
  return count;
}

/** 缩进结果：新文本 + 新选区（无选区时 start === end）。 */
type Indented = { readonly text: string; readonly start: number; readonly end: number };

/** 无选区：Tab 在光标处插入一级缩进，Shift+Tab 删掉光标前那一级。 */
function indentAtCaret(text: string, at: number, outdent: boolean, width: string): Indented {
  if (!outdent) {
    return { text: text.slice(0, at) + width + text.slice(at), start: at + width.length, end: at + width.length };
  }
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const removed = removableIndent(text, lineStart, width);
  if (removed === 0) return { text, start: at, end: at };
  const caret = Math.max(lineStart, at - removed);
  return { text: text.slice(0, lineStart) + text.slice(lineStart + removed), start: caret, end: caret };
}

/** 有选区：整段（覆盖到的行）增减一级缩进。 */
function indentSelection(text: string, start: number, end: number, outdent: boolean, width: string): Indented {
  // 选区刚好停在下一行行首时，那一行不参与缩进。
  const blockEnd = text[end - 1] === '\n' ? end - 1 : end;
  const first = text.lastIndexOf('\n', start - 1) + 1;
  const starts: number[] = [];
  for (let cursor = first; ; ) {
    starts.push(cursor);
    const newline = text.indexOf('\n', cursor);
    if (newline === -1 || newline >= blockEnd) break;
    cursor = newline + 1;
  }

  let out = '';
  let read = 0;
  let firstRemoved = 0;
  let totalRemoved = 0;
  for (const [index, lineStart] of starts.entries()) {
    out += text.slice(read, lineStart);
    read = lineStart;
    if (!outdent) {
      out += width;
      continue;
    }
    const removed = removableIndent(text, lineStart, width);
    if (index === 0) firstRemoved = removed;
    totalRemoved += removed;
    read = lineStart + removed;
  }
  out += text.slice(read);

  // 缩进时整段后移；反缩进时整段前移。选区起点落在行首就保持行首，
  // 否则跟着原来那个字符走（两种情况都能再用 Shift+Tab 还原）。
  const shifted = outdent ? Math.max(first, start - firstRemoved) : start + width.length;
  const nextStart = start === first ? first : shifted;
  const nextEnd = outdent
    ? Math.max(nextStart, end - totalRemoved)
    : Math.min(out.length, end + width.length * starts.length);
  return { text: out, start: nextStart, end: nextEnd };
}

/** Tab / Shift+Tab：有选区时整段增减一级缩进，无选区时在光标处插入或删除一级缩进；
 * 返回新文本与新选区，调用方据此写回并恢复 `selectionStart/End`。 */
export function applyIndent(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
  unit: string = INDENT_UNIT,
): { readonly text: string; readonly start: number; readonly end: number } {
  const width = unit === '' ? INDENT_UNIT : unit;
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return from === to ? indentAtCaret(text, from, outdent, width) : indentSelection(text, from, to, outdent, width);
}
