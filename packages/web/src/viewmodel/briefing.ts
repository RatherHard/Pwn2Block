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

/** 列表项：缩进、是否有序、文字。嵌套层级 = `min(3, floor(缩进/2)+1)`。 */
interface ListLine {
  readonly depth: number;
  readonly ordered: boolean;
  readonly text: string;
}

function matchListLine(line: string): ListLine | undefined {
  const unordered = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (unordered !== undefined && unordered !== null) {
    return { depth: listDepth(unordered[1]), ordered: false, text: unordered[2] };
  }
  const ordered = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
  if (ordered !== undefined && ordered !== null) {
    return { depth: listDepth(ordered[1]), ordered: true, text: ordered[2] };
  }
  return undefined;
}

function listDepth(indent: string): number {
  return Math.min(MAX_LIST_DEPTH, Math.floor(indent.length / 2) + 1);
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

/** 按行扫描的块级状态机：段内换行、代码围栏、引用、列表、分隔线、标题。 */
export function parseMarkdown(text: string): readonly MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;

  const flushParagraph = (paragraphLines: readonly string[]): void => {
    if (paragraphLines.length === 0) return;
    const inline: MdInline[] = [];
    paragraphLines.forEach((paragraphLine, lineIndex) => {
      if (lineIndex > 0) inline.push({ kind: 'break' });
      inline.push(...parseInline(paragraphLine));
    });
    blocks.push({ kind: 'paragraph', inline: mergeText(inline) });
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^-{3,}$/.exec(line.trim()) !== null) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (/^```/.exec(line.trim()) !== null) {
      const codeLines: string[] = [];
      let closed = false;
      let cursor = index + 1;
      while (cursor < lines.length) {
        if (/^```/.exec(lines[cursor].trim()) !== null) {
          closed = true;
          break;
        }
        codeLines.push(lines[cursor]);
        cursor += 1;
      }
      if (closed) {
        blocks.push({ kind: 'code', text: codeLines.join('\n') });
        index = cursor + 1;
      } else {
        // 未闭合的围栏：按段落原文显示，第一行（```）也是文本的一部分。
        flushParagraph([line, ...codeLines]);
        index = cursor;
      }
      continue;
    }

    if (/^>\s?/.exec(line) !== null) {
      const quoteLines: string[] = [];
      let cursor = index;
      while (cursor < lines.length && /^>\s?/.exec(lines[cursor]) !== null) {
        quoteLines.push(lines[cursor].replace(/^>\s?/, ''));
        cursor += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseMarkdown(quoteLines.join('\n')) });
      index = cursor;
      continue;
    }

    const list = matchListLine(line);
    if (list !== undefined) {
      const listLines: ListLine[] = [list];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = matchListLine(lines[cursor]);
        if (next === undefined) break;
        listLines.push(next);
        cursor += 1;
      }
      blocks.push(buildList(listLines));
      index = cursor;
      continue;
    }

    const paragraphLines: string[] = [line];
    let cursor = index + 1;
    while (
      cursor < lines.length &&
      lines[cursor].trim().length > 0 &&
      /^(#{1,6})\s+/.exec(lines[cursor]) === null &&
      /^-{3,}$/.exec(lines[cursor].trim()) === null &&
      /^```/.exec(lines[cursor].trim()) === null &&
      /^>\s?/.exec(lines[cursor]) === null &&
      matchListLine(lines[cursor]) === undefined
    ) {
      paragraphLines.push(lines[cursor]);
      cursor += 1;
    }
    flushParagraph(paragraphLines);
    index = cursor;
  }

  return blocks;
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
