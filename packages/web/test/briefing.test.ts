import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../src/viewmodel/briefing';

/**
 * 自研 Markdown 解析器（设计 §5.2）：输出纯数据节点树，不依赖第三方库，不用
 * `innerHTML`。这里逐语法钉住精确节点树，组件层的渲染测试见
 * `briefing-panel.test.ts`。
 */

describe('parseMarkdown 块级', () => {
  it('标题 1–6 级', () => {
    expect(parseMarkdown('### 栈帧')).toEqual([
      { kind: 'heading', level: 3, inline: [{ kind: 'text', text: '栈帧' }] },
    ]);
    expect(parseMarkdown('# a')).toEqual([{ kind: 'heading', level: 1, inline: [{ kind: 'text', text: 'a' }] }]);
    expect(parseMarkdown('###### f')).toEqual([
      { kind: 'heading', level: 6, inline: [{ kind: 'text', text: 'f' }] },
    ]);
  });

  it('段落内单个换行变 break，空行分段', () => {
    expect(parseMarkdown('a\nb\n\nc')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'a' }, { kind: 'break' }, { kind: 'text', text: 'b' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'c' }] },
    ]);
  });

  it('围栏代码块原样保留，内部不解析行内', () => {
    expect(parseMarkdown('```\n**x** <b>\n```')).toEqual([{ kind: 'code', text: '**x** <b>' }]);
  });

  it('未闭合的围栏按段落原文显示', () => {
    expect(parseMarkdown('```\nx')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: '```' }, { kind: 'break' }, { kind: 'text', text: 'x' }] },
    ]);
  });

  it('> 引用内可再含块', () => {
    expect(parseMarkdown('> a\n> - b')).toEqual([
      {
        kind: 'quote',
        blocks: [
          { kind: 'paragraph', inline: [{ kind: 'text', text: 'a' }] },
          { kind: 'list', ordered: false, items: [{ inline: [{ kind: 'text', text: 'b' }] }] },
        ],
      },
    ]);
  });

  it('有序 / 无序列表', () => {
    expect(parseMarkdown('1. a\n2. b')).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [{ inline: [{ kind: 'text', text: 'a' }] }, { inline: [{ kind: 'text', text: 'b' }] }],
      },
    ]);
    expect(parseMarkdown('- a')).toEqual([
      { kind: 'list', ordered: false, items: [{ inline: [{ kind: 'text', text: 'a' }] }] },
    ]);
  });

  it('缩进 ≥2 空格嵌套', () => {
    expect(parseMarkdown('- a\n  - b')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          {
            inline: [{ kind: 'text', text: 'a' }],
            children: {
              kind: 'list',
              ordered: false,
              items: [{ inline: [{ kind: 'text', text: 'b' }] }],
            },
          },
        ],
      },
    ]);
  });

  it('嵌套截到 3 层：第 4、5 层并入第 3 层的同一个 list', () => {
    expect(parseMarkdown('- a\n  - b\n    - c\n      - d\n        - e')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          {
            inline: [{ kind: 'text', text: 'a' }],
            children: {
              kind: 'list',
              ordered: false,
              items: [
                {
                  inline: [{ kind: 'text', text: 'b' }],
                  children: {
                    kind: 'list',
                    ordered: false,
                    items: [
                      { inline: [{ kind: 'text', text: 'c' }] },
                      { inline: [{ kind: 'text', text: 'd' }] },
                      { inline: [{ kind: 'text', text: 'e' }] },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ]);
  });

  it('--- 分隔线', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]);
  });

  it('标题标记后只有空白也算标题起始，段落续行判定与块级分发一致', () => {
    expect(parseMarkdown('#   ')).toEqual([{ kind: 'heading', level: 1, inline: [] }]);
    // 段落续行判定必须认出同一行是块起始而停下，否则 'a' 会把 '#   ' 吞进段落。
    expect(parseMarkdown('a\n#   \nb')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'a' }] },
      { kind: 'heading', level: 1, inline: [] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'b' }] },
    ]);
  });

  it('CRLF 与 LF 等价', () => {
    expect(parseMarkdown('# a\r\n\r\n- b\r\n  - c')).toEqual(parseMarkdown('# a\n\n- b\n  - c'));
  });

  it('空串返回空数组', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

describe('parseInline 行内', () => {
  it('粗体、两种斜体、代码', () => {
    expect(parseInline('**a** *b* _c_ `d`')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
    ]);
  });

  it('链接只留文字', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { kind: 'link', children: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('未闭合标记按原文', () => {
    expect(parseInline('**a `b [c](')).toEqual([{ kind: 'text', text: '**a `b [c](' }]);
  });

  it('<script> 与 <img onerror> 只是文本', () => {
    expect(parseInline('<script>x</script><img src=x onerror=y>')).toEqual([
      { kind: 'text', text: '<script>x</script><img src=x onerror=y>' },
    ]);
  });
});
