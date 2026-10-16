/**
 * 把 `viewmodel/briefing.ts` 解析出的节点树渲染成 Lit 模板（设计 §5.2）。
 *
 * 不注入原始 HTML，只经 Lit 插值：题面里的原始 HTML
 * 永远只是字符串，不会被当成标签解释。链接只渲染文字，不生成 `<a>`，不放出外链。
 */
import { css, html, type CSSResult, type TemplateResult } from 'lit';
import type { MdBlock, MdInline, MdListItem } from '../viewmodel/briefing';

/**
 * 标题级别映射为 `h${level + 1}`，上限 h6：题面所在面板自身占用 h2。
 * Lit 的标签名不支持动态绑定，只能按级别枚举固定模板。
 */
function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, inline: readonly MdInline[]): TemplateResult {
  switch (Math.min(6, level + 1)) {
    case 2:
      return html`<h2>${renderInline(inline)}</h2>`;
    case 3:
      return html`<h3>${renderInline(inline)}</h3>`;
    case 4:
      return html`<h4>${renderInline(inline)}</h4>`;
    case 5:
      return html`<h5>${renderInline(inline)}</h5>`;
    default:
      return html`<h6>${renderInline(inline)}</h6>`;
  }
}

export function renderInline(nodes: readonly MdInline[]): TemplateResult {
  return html`${nodes.map(renderInlineNode)}`;
}

function renderInlineNode(node: MdInline): unknown {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'break':
      return html`<br />`;
    case 'strong':
      return html`<strong>${renderInline(node.children)}</strong>`;
    case 'em':
      return html`<em>${renderInline(node.children)}</em>`;
    case 'link':
      return html`<span class="md-link">${renderInline(node.children)}</span>`;
    case 'code':
      return html`<code>${node.text}</code>`;
  }
}

export function renderMarkdown(blocks: readonly MdBlock[]): TemplateResult {
  return html`${blocks.map(renderBlock)}`;
}

function renderBlock(block: MdBlock): unknown {
  switch (block.kind) {
    case 'heading':
      return renderHeading(block.level, block.inline);
    case 'paragraph':
      return html`<p>${renderInline(block.inline)}</p>`;
    case 'code':
      return html`<pre><code>${block.text}</code></pre>`;
    case 'quote':
      return html`<blockquote>${renderMarkdown(block.blocks)}</blockquote>`;
    case 'list':
      return renderList(block.ordered, block.items);
    case 'rule':
      return html`<hr />`;
  }
}

function renderList(ordered: boolean, items: readonly MdListItem[]): TemplateResult {
  const children = items.map(
    (item) => html`<li>${renderInline(item.inline)}${item.children === undefined ? '' : renderBlock(item.children)}</li>`,
  );
  return ordered ? html`<ol>${children}</ol>` : html`<ul>${children}</ul>`;
}

export const markdownStyles: CSSResult = css`
  .md p {
    margin: 0 0 0.65rem;
    white-space: pre-line;
  }
  .md p:last-child {
    margin-bottom: 0;
  }
  .md h2,
  .md h3,
  .md h4,
  .md h5,
  .md h6 {
    margin: 0.75rem 0 0.4rem;
    color: var(--p2b-fg);
    font-weight: 700;
  }
  .md h2:first-child,
  .md h3:first-child,
  .md h4:first-child,
  .md h5:first-child,
  .md h6:first-child {
    margin-top: 0;
  }
  .md ul,
  .md ol {
    margin: 0.65rem 0;
    padding-left: 1.5rem;
  }
  .md li + li {
    margin-top: 0.3rem;
  }
  .md li > ul,
  .md li > ol {
    margin: 0.3rem 0;
  }
  .md code {
    font-family: var(--p2b-font);
    color: var(--p2b-fg);
    padding: 0.05rem 0.2rem;
    overflow-wrap: anywhere;
  }
  .md pre {
    margin: 0.65rem 0;
    padding: 0.6rem 0.7rem;
    overflow-x: auto;
    border: 1px solid var(--p2b-line);
    color: var(--p2b-fg);
  }
  .md pre code {
    padding: 0;
  }
  .md blockquote {
    margin: 0.65rem 0;
    padding: 0 0.75rem;
    border-left: 2px solid var(--p2b-line);
    color: var(--p2b-dim);
  }
  .md hr {
    margin: 0.75rem 0;
    border: none;
    border-top: 1px solid var(--p2b-line);
  }
  .md .md-link {
    color: var(--p2b-fg);
    text-decoration: underline;
    text-decoration-color: var(--p2b-line);
  }
`;
