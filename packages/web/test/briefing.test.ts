import { describe, expect, it } from 'vitest';
import { briefingBlocks, inlineCode } from '../src/viewmodel/briefing';

describe('题面基础排版', () => {
  it('分开段落、无序列表和有序列表，并保留普通换行', () => {
    expect(briefingBlocks('第一行\r\n第二行\r\n\r\n- `leave`\n- `ret`\n\n1. 查看\n2. 执行\n结束')).toEqual([
      { kind: 'paragraph', text: '第一行\n第二行' },
      { kind: 'unordered', items: ['`leave`', '`ret`'] },
      { kind: 'ordered', items: ['查看', '执行'] },
      { kind: 'paragraph', text: '结束' },
    ]);
    expect(briefingBlocks(' \n\n')).toEqual([]);
  });

  it('HTML 与链接保持普通文本，代码内容和未闭合反引号不丢失', () => {
    expect(inlineCode('执行 `ret`，`<script>` 和 <img onerror=alert(1)> [链接](javascript:alert(1)) `未闭合')).toEqual([
      { code: false, text: '执行 ' },
      { code: true, text: 'ret' },
      { code: false, text: '，' },
      { code: true, text: '<script>' },
      { code: false, text: ' 和 <img onerror=alert(1)> [链接](javascript:alert(1)) `未闭合' },
    ]);
  });
});
