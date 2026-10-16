/**
 * 自研 Markdown 解析器（设计 §5.2）：输出纯数据的块与行内节点树，不依赖第三方库。
 * 渲染交给 `components/markdown.ts`，所有文本都经 Lit 插值转义，不用
 * `innerHTML` / `unsafeHTML`，原始 HTML 一律按文本原样显示。
 */

export type MdInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'em' | 'link'; readonly children: readonly MdInline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'break' };

export interface MdListItem {
  readonly inline: readonly MdInline[];
  readonly children?: MdBlock;
}

export type MdBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: readonly MdInline[] }
  | { readonly kind: 'paragraph'; readonly inline: readonly MdInline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'quote'; readonly blocks: readonly MdBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly MdListItem[] }
  | { readonly kind: 'rule' };

const MAX_LIST_DEPTH = 3;

/**
 * 块起始的判定全部集中在这几个正则 + `matchListLine`，`isBlockStart` 和各
 * `parse*Block` 共用它们，避免段落续行判定和块级分发各写一套、彼此漂移。
 */
const HEADING_START = /^#{1,6}(?:\s|$)/;
const RULE_RE = /^-{3,}$/;
const FENCE_RE = /^```/;
const QUOTE_START = /^>\s?/;

/** 列表项：缩进、是否有序、文字。嵌套层级 = `min(3, floor(缩进/2)+1)`。 */
interface ListLine {
  readonly depth: number;
  readonly ordered: boolean;
  readonly text: string;
}

function matchListLine(line: string): ListLine | undefined {
  const unordered = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (unordered !== null) {
    return { depth: listDepth(unordered[1]), ordered: false, text: unordered[2] };
  }
  const ordered = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
  if (ordered !== null) {
    return { depth: listDepth(ordered[1]), ordered: true, text: ordered[2] };
  }
  return undefined;
}

function listDepth(indent: string): number {
  return Math.min(MAX_LIST_DEPTH, Math.floor(indent.length / 2) + 1);
}

/** 这一行是否会开启一个新块（标题/分隔线/围栏/引用/列表），段落续行判定据此停下。 */
function isBlockStart(line: string): boolean {
  return (
    HEADING_START.test(line) ||
    RULE_RE.test(line.trim()) ||
    FENCE_RE.test(line.trim()) ||
    QUOTE_START.test(line) ||
    matchListLine(line) !== undefined
  );
}

/** 标题标记后允许只有空白、甚至没有内容：和 `HEADING_START` 判定同一条件。 */
function parseHeadingLine(line: string): { readonly level: number; readonly content: string } | undefined {
  const match = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
  if (match === null) return undefined;
  return { level: match[1].length, content: match[2] ?? '' };
}

/** 把一串同层级的列表行（已剥掉比 `baseDepth` 浅的缩进语境）组装成一个 list 块。 */
function buildList(lines: readonly ListLine[]): MdBlock {
  const ordered = lines[0]?.ordered ?? false;
  const items: MdListItem[] = [];
  let index = 0;
  while (index < lines.length) {
    const depth = lines[index].depth;
    const group: ListLine[] = [lines[index]];
    index += 1;
    while (index < lines.length && lines[index].depth > depth) {
      group.push(lines[index]);
      index += 1;
    }
    const [head, ...rest] = group;
    const children = rest.length === 0 ? undefined : buildList(rest);
    items.push(children === undefined ? { inline: parseInline(head.text) } : { inline: parseInline(head.text), children });
  }
  return { kind: 'list', ordered, items };
}

/** 一次块解析的结果：解出的块与下一次扫描应该从哪一行继续。 */
interface BlockResult {
  readonly block: MdBlock;
  readonly next: number;
}

function parseHeadingBlock(line: string, index: number): BlockResult {
  const heading = parseHeadingLine(line);
  // 调用处已用 `isBlockStart` 判过是标题起始，这里一定能解析成功。
  const content = heading?.content ?? '';
  return {
    block: { kind: 'heading', level: (heading?.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(content) },
    next: index + 1,
  };
}

function parseFenceBlock(lines: readonly string[], index: number): BlockResult {
  const codeLines: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && !FENCE_RE.test(lines[cursor].trim())) {
    codeLines.push(lines[cursor]);
    cursor += 1;
  }
  const closed = cursor < lines.length;
  if (closed) return { block: { kind: 'code', text: codeLines.join('\n') }, next: cursor + 1 };
  // 未闭合的围栏：按段落原文显示，起始的 ``` 行也是文本的一部分。
  return { block: buildParagraph([lines[index], ...codeLines]), next: cursor };
}

function parseQuoteBlock(lines: readonly string[], index: number): BlockResult {
  const quoteLines: string[] = [];
  let cursor = index;
  while (cursor < lines.length && QUOTE_START.test(lines[cursor])) {
    quoteLines.push(lines[cursor].replace(QUOTE_START, ''));
    cursor += 1;
  }
  return { block: { kind: 'quote', blocks: parseMarkdown(quoteLines.join('\n')) }, next: cursor };
}

function parseListBlock(lines: readonly string[], index: number): BlockResult {
  const listLines: ListLine[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = matchListLine(lines[cursor]);
    if (line === undefined) break;
    listLines.push(line);
    cursor += 1;
  }
  return { block: buildList(listLines), next: cursor };
}

function parseParagraphBlock(lines: readonly string[], index: number): BlockResult {
  const paragraphLines: string[] = [];
  let cursor = index;
  while (cursor < lines.length && lines[cursor].trim().length > 0 && !isBlockStart(lines[cursor])) {
    paragraphLines.push(lines[cursor]);
    cursor += 1;
  }
  return { block: buildParagraph(paragraphLines), next: cursor };
}

function buildParagraph(paragraphLines: readonly string[]): MdBlock {
  const inline: MdInline[] = [];
  paragraphLines.forEach((paragraphLine, lineIndex) => {
    if (lineIndex > 0) inline.push({ kind: 'break' });
    inline.push(...parseInline(paragraphLine));
  });
  return { kind: 'paragraph', inline: mergeText(inline) };
}

/** 按行扫描的块级状态机：空行跳过，其余按 `isBlockStart` 判出的类型分发。 */
export function parseMarkdown(text: string): readonly MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const result = parseOneBlock(lines, index, line);
    blocks.push(result.block);
    index = result.next;
  }

  return blocks;
}

function parseOneBlock(lines: readonly string[], index: number, line: string): BlockResult {
  if (HEADING_START.test(line)) return parseHeadingBlock(line, index);
  if (RULE_RE.test(line.trim())) return { block: { kind: 'rule' }, next: index + 1 };
  if (FENCE_RE.test(line.trim())) return parseFenceBlock(lines, index);
  if (QUOTE_START.test(line)) return parseQuoteBlock(lines, index);
  if (matchListLine(line) !== undefined) return parseListBlock(lines, index);
  return parseParagraphBlock(lines, index);
}

type InlineMark = '**' | '*' | '_' | '`' | '[';

/** 单遍扫描：遇到开标记就向后找同种闭标记，找不到就把开标记当文本吞下继续。 */
export function parseInline(text: string): readonly MdInline[] {
  const nodes: MdInline[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const mark = detectMark(text, cursor);
    if (mark === undefined) {
      const next = findNextMarkStart(text, cursor + 1);
      nodes.push({ kind: 'text', text: text.slice(cursor, next) });
      cursor = next;
      continue;
    }
    const parsed = parseMark(text, cursor, mark);
    if (parsed === undefined) {
      nodes.push({ kind: 'text', text: text.slice(cursor, cursor + mark.length) });
      cursor += mark.length;
      continue;
    }
    nodes.push(parsed.node);
    cursor = parsed.next;
  }

  return mergeText(nodes);
}

function detectMark(text: string, cursor: number): InlineMark | undefined {
  if (text.startsWith('**', cursor)) return '**';
  if (text.startsWith('*', cursor)) return '*';
  if (text.startsWith('_', cursor)) return '_';
  if (text.startsWith('`', cursor)) return '`';
  if (text.startsWith('[', cursor)) return '[';
  return undefined;
}

function findNextMarkStart(text: string, from: number): number {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    if (detectMark(text, cursor) !== undefined) return cursor;
  }
  return text.length;
}

interface MarkResult {
  readonly node: MdInline;
  readonly next: number;
}

function parseMark(text: string, start: number, mark: InlineMark): MarkResult | undefined {
  if (mark === '`') return parseDelimited(text, start, '`', '`', (inner) => ({ kind: 'code', text: inner }));
  if (mark === '**') {
    return parseDelimited(text, start, '**', '**', (inner) => ({ kind: 'strong', children: parseInline(inner) }));
  }
  if (mark === '*') return parseDelimited(text, start, '*', '*', (inner) => ({ kind: 'em', children: parseInline(inner) }));
  if (mark === '_') return parseDelimited(text, start, '_', '_', (inner) => ({ kind: 'em', children: parseInline(inner) }));
  return parseLink(text, start);
}

function parseDelimited(
  text: string,
  start: number,
  open: string,
  close: string,
  build: (inner: string) => MdInline,
): MarkResult | undefined {
  const contentStart = start + open.length;
  const closeAt = text.indexOf(close, contentStart);
  if (closeAt === -1 || closeAt === contentStart) return undefined;
  return { node: build(text.slice(contentStart, closeAt)), next: closeAt + close.length };
}

/** `[文字](url)`：只保留文字，不生成 `<a>`，不放出 url。url 里允许嵌套圆括号，按配平扫描收尾。 */
function parseLink(text: string, start: number): MarkResult | undefined {
  const closeBracket = text.indexOf(']', start + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') return undefined;
  const closeParen = findBalancedParenEnd(text, closeBracket + 2);
  if (closeParen === -1) return undefined;
  const label = text.slice(start + 1, closeBracket);
  return { node: { kind: 'link', children: parseInline(label) }, next: closeParen + 1 };
}

/** 从已经吞掉一个 `(` 之后的位置开始，找配平的 `)`；全程未配平返回 -1。 */
function findBalancedParenEnd(text: string, from: number): number {
  let depth = 1;
  for (let cursor = from; cursor < text.length; cursor += 1) {
    if (text[cursor] === '(') depth += 1;
    else if (text[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function mergeText(nodes: readonly MdInline[]): readonly MdInline[] {
  const merged: MdInline[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + node.text };
    } else {
      merged.push(node);
    }
  }
  return merged;
}
