/** 题面只支持段落、单层列表和行内代码；文本交给 Lit 转义，不解析 HTML。 */
export type BriefingBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'unordered' | 'ordered'; readonly items: readonly string[] };

export function briefingBlocks(text: string): readonly BriefingBlock[] {
  const blocks: BriefingBlock[] = [];
  let lines: string[] = [];
  let kind: 'paragraph' | 'unordered' | 'ordered' = 'paragraph';
  const flush = (): void => {
    if (lines.length === 0) return;
    blocks.push(kind === 'paragraph' ? { kind, text: lines.join('\n') } : { kind, items: lines });
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const next = unordered ? 'unordered' : ordered ? 'ordered' : 'paragraph';
    if (kind !== next) flush();
    kind = next;
    lines.push(unordered?.[1] ?? ordered?.[1] ?? line);
  }
  flush();
  return blocks;
}

export function inlineCode(text: string): readonly { readonly code: boolean; readonly text: string }[] {
  // 未闭合的反引号保留原样；不处理链接、HTML、图片或脚本。
  return text.split(/(`[^`\n]+`)/g).filter(part => part.length > 0).map(part => {
    const code = part.length > 2 && part.startsWith('`') && part.endsWith('`');
    return { code, text: code ? part.slice(1, -1) : part };
  });
}
