// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import '../src/components/code-editor';
import type { Pwn2BlockCodeEditor } from '../src/components/code-editor';
import { applyIndent, autoIndent, indentOf, tokenizePython } from '../src/graph/python-highlight';
import type { PythonToken } from '../src/graph/python-highlight';

/**
 * 内嵌 Python 代码编辑器（`components/code-editor.ts` + `graph/python-highlight.ts`）。
 *
 * 前半是纯函数：词法切分必须无损（拼接等于原文），缩进策略必须算准光标位置；
 * 后半在 jsdom 里挂真组件，只断言渲染与事件契约——组件不执行任何代码，测试也没有后端。
 */

/**
 * 取文本（去掉空白后）恰好等于 `text` 的 token：空白会并进相邻的 `plain`，
 * 所以比对普通标识符时先把空白剥掉（`return`、`0x1f` 这些本来就原样）。
 */
function tokenOf(code: string, text: string): PythonToken | undefined {
  return tokenizePython(code).find((token) => token.text === text || token.text.replace(/\s+/g, '') === text);
}

describe('tokenizePython', () => {
  const samples: readonly string[] = [
    'def add(a, b):\n    return a + b\n',
    'x = "未闭合',
    "s = '''第一行\n第二行'''\n# 注释到行尾",
    'n = 0x1f + 0b1010 + 3.5e-2 + 1_000\n',
    'print(len(b"A" * 8), struct.pack("<Q", 1))\n',
    '',
    'if x:\n\tpass',
  ];

  it('无损：所有 token 依次拼接严格等于原文', () => {
    for (const code of samples) {
      expect(tokenizePython(code).map((token) => token.text).join(''), code).toBe(code);
    }
  });

  it('按词法分类：注释、字符串、关键字、数字、内置名、运算符、普通标识符', () => {
    expect(tokenOf('a = 1  # 注释', '# 注释')?.kind).toBe('comment');
    expect(tokenOf('s = "hi"', '"hi"')?.kind).toBe('string');
    expect(tokenOf("c = 'x'", "'x'")?.kind).toBe('string');
    expect(tokenOf('def f():', 'def')?.kind).toBe('keyword');
    expect(tokenOf('    return 1', 'return')?.kind).toBe('keyword');
    expect(tokenOf('x = None', 'None')?.kind).toBe('keyword');
    expect(tokenOf('n = 0x1f', '0x1f')?.kind).toBe('number');
    expect(tokenOf('n = 0b1010', '0b1010')?.kind).toBe('number');
    expect(tokenOf('n = 3.5', '3.5')?.kind).toBe('number');
    expect(tokenOf('n = 12', '12')?.kind).toBe('number');
    expect(tokenOf('x = len(y)', 'len')?.kind).toBe('builtin');
    expect(tokenOf('x = print(1)', 'print')?.kind).toBe('builtin');
    expect(tokenOf('a + b', '+')?.kind).toBe('operator');
    expect(tokenOf('a == b', '==')?.kind).toBe('operator');
    expect(tokenOf('f(x)', '(')?.kind).toBe('operator');
    expect(tokenOf('a + b', 'a')?.kind).toBe('plain');
  });

  it('字符串里的 # 不是注释', () => {
    const tokens = tokenizePython('x = "#不是注释"  # 真注释');
    expect(tokens.filter((token) => token.kind === 'comment').map((token) => token.text)).toEqual(['# 真注释']);
  });

  it('三引号字符串可以跨行，且整段是一个 token', () => {
    const tokens = tokenizePython('s = """第一行\n第二行"""\n');
    const strings = tokens.filter((token) => token.kind === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0]?.text).toBe('"""第一行\n第二行"""');
    // 字符串之后的换行仍按普通文本处理，后面的代码没有被吞掉。
    expect(tokenOf('s = """a\nb"""\npass', 'pass')?.kind).toBe('keyword');
  });

  it('未闭合的三引号吃到文本末尾，不抛异常', () => {
    const code = "s = '''没写完";
    expect(() => tokenizePython(code)).not.toThrow();
    const tokens = tokenizePython(code);
    expect(tokens.at(-1)?.kind).toBe('string');
    expect(tokens.at(-1)?.text).toBe("'''没写完");
    expect(tokens.map((token) => token.text).join('')).toBe(code);
  });

  it('未闭合的单引号止于行尾，不把后面的代码也染成字符串', () => {
    const tokens = tokenizePython("a = 'x\nb = 1");
    expect(tokens.find((token) => token.kind === 'string')?.text).toBe("'x");
    expect(tokenOf("a = 'x\nb = 1", 'b')?.kind).toBe('plain');
    expect(tokenOf("a = 'x\nb = 1", '1')?.kind).toBe('number');
  });
});

describe('indentOf', () => {
  it('原样返回行首的空格与制表符', () => {
    expect(indentOf('    x = 1')).toBe('    ');
    expect(indentOf('\t  x')).toBe('\t  ');
    expect(indentOf('x')).toBe('');
  });
});

describe('autoIndent', () => {
  it('上一行以冒号结尾时多缩进一级，光标落在缩进之后', () => {
    expect(autoIndent('if x:', 5)).toEqual({ text: 'if x:\n    ', caret: 10 });
  });

  it('普通行沿用上一行缩进', () => {
    const text = 'def f():\n    y = 1';
    expect(autoIndent(text, text.length)).toEqual({ text: `${text}\n    `, caret: text.length + 5 });
  });

  it('空行不加缩进（只补一个换行）', () => {
    const text = 'if x:\n    ';
    expect(autoIndent(text, text.length)).toEqual({ text: `${text}\n`, caret: text.length + 1 });
  });

  it('可以指定缩进单元', () => {
    expect(autoIndent('if x:', 5, '\t')).toEqual({ text: 'if x:\n\t', caret: 7 });
  });
});

describe('applyIndent', () => {
  it('无选区时 Tab 在光标处插入一级缩进', () => {
    expect(applyIndent('x', 0, 0, false)).toEqual({ text: '    x', start: 4, end: 4 });
  });

  it('无选区时 Shift+Tab 删掉光标前的一级缩进', () => {
    expect(applyIndent('    x', 4, 4, true)).toEqual({ text: 'x', start: 0, end: 0 });
    expect(applyIndent('\tx', 1, 1, true)).toEqual({ text: 'x', start: 0, end: 0 });
  });

  it('有选区时整段缩进，选区跟着行块扩到缩进之后', () => {
    expect(applyIndent('a\nb\nc', 0, 5, false)).toEqual({ text: '    a\n    b\n    c', start: 0, end: 17 });
  });

  it('有选区时整段反缩进，选区跟着行块收缩', () => {
    expect(applyIndent('    a\n    b', 0, 11, true)).toEqual({ text: 'a\nb', start: 0, end: 3 });
  });

  it('选区停在下一行行首时，那一行不参与缩进', () => {
    expect(applyIndent('a\nb', 0, 2, false)).toEqual({ text: '    a\nb', start: 0, end: 6 });
  });
});

const mounted: Pwn2BlockCodeEditor[] = [];

async function mount(value: string): Promise<Pwn2BlockCodeEditor> {
  const editor = document.createElement('pwn2block-code-editor') as Pwn2BlockCodeEditor;
  editor.value = value;
  document.body.append(editor);
  await editor.updateComplete;
  mounted.push(editor);
  return editor;
}

function shadowOf(editor: Pwn2BlockCodeEditor): ShadowRoot {
  const root = editor.shadowRoot;
  if (root === null) throw new Error('组件没有 shadow root');
  return root;
}

function textareaOf(editor: Pwn2BlockCodeEditor): HTMLTextAreaElement {
  const input = shadowOf(editor).querySelector('textarea');
  if (input === null) throw new Error('组件里没有 textarea');
  return input;
}

function gutterLines(editor: Pwn2BlockCodeEditor): readonly string[] {
  return (shadowOf(editor).querySelector('pre.gutter')?.textContent ?? '').split('\n');
}

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.remove();
});

describe('pwn2block-code-editor', () => {
  it('行号与 value 的行数一致', async () => {
    expect(gutterLines(await mount('a\nb\nc'))).toEqual(['1', '2', '3']);
    expect(gutterLines(await mount(''))).toEqual(['1']);
    expect(gutterLines(await mount('a\n'))).toEqual(['1', '2']);
  });

  it('高亮层用 span 渲染，全部文本仍是原文（末尾补一个换行对齐尾行高度）', async () => {
    const code = 'def f():  # 注释\n    return 1';
    const editor = await mount(code);
    const highlight = shadowOf(editor).querySelector('pre.highlight');
    expect(highlight).not.toBeNull();
    expect(highlight?.getAttribute('aria-hidden')).toBe('true');
    expect(highlight?.textContent).toBe(`${code}\n`);
    const kinds = Array.from(highlight?.querySelectorAll('span') ?? []).map((span) => span.className);
    expect(kinds).toContain('syn-keyword');
    expect(kinds).toContain('syn-comment');
    expect(kinds).toContain('syn-number');
    expect(kinds).toContain('syn-operator');
  });

  it('输入后派发 p2b-code-input，detail.value 就是 textarea 里的内容', async () => {
    const editor = await mount('a = 1');
    const seen: string[] = [];
    editor.addEventListener('p2b-code-input', (event) => {
      seen.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    const input = textareaOf(editor);
    input.value = 'a = 2';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(seen).toEqual(['a = 2']);
  });

  it('change 事件派发 p2b-code-change（父组件据此写文档）', async () => {
    const editor = await mount('a = 1');
    const seen: string[] = [];
    editor.addEventListener('p2b-code-change', (event) => {
      seen.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    const input = textareaOf(editor);
    input.value = 'a = 3';
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    expect(seen).toEqual(['a = 3']);
  });

  it('Tab 缩进立即提交：编辑器自己改文本，浏览器不会再补发 change', async () => {
    const editor = await mount('a = 1');
    const changes: string[] = [];
    editor.addEventListener('p2b-code-change', (event) => {
      changes.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    const input = textareaOf(editor);
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    await editor.updateComplete;
    const indented = textareaOf(editor).value;
    expect(indented.length).toBeGreaterThan('a = 1'.length);
    expect(changes).toEqual([indented]);
  });

  it('点按钮派发 p2b-code-expand 且 detail.expanded 取反', async () => {
    const editor = await mount('x = 1');
    const seen: boolean[] = [];
    editor.addEventListener('p2b-code-expand', (event) => {
      seen.push((event as CustomEvent<{ expanded: boolean }>).detail.expanded);
    });
    const button = shadowOf(editor).querySelector('button');
    expect(button?.textContent?.trim()).toBe('扩大编辑');
    button?.click();
    expect(seen).toEqual([true]);
    // 组件不自作主张：状态在父组件手里，只有写回 expanded 才真的扩大。
    expect(editor.hasAttribute('expanded')).toBe(false);
    editor.expanded = true;
    await editor.updateComplete;
    expect(editor.hasAttribute('expanded')).toBe(true);
    expect(shadowOf(editor).querySelector('button')?.textContent?.trim()).toBe('返回画布');
    shadowOf(editor).querySelector('button')?.click();
    expect(seen).toEqual([true, false]);
  });

  it('扩大再退出后内容与行号都不丢', async () => {
    const code = 'if x:\n    y = 1';
    const editor = await mount(code);
    editor.expanded = true;
    await editor.updateComplete;
    expect(editor.hasAttribute('expanded')).toBe(true);
    editor.expanded = false;
    await editor.updateComplete;
    expect(editor.hasAttribute('expanded')).toBe(false);
    expect(textareaOf(editor).value).toBe(code);
    expect(gutterLines(editor)).toEqual(['1', '2']);
  });

  it('label 作为无障碍名称：属性写法与 `.label` 属性都能用', async () => {
    const editor = await mount('x');
    expect(textareaOf(editor).getAttribute('aria-label')).toBe('Python 代码');
    editor.label = '爬虫脚本';
    await editor.updateComplete;
    expect(textareaOf(editor).getAttribute('aria-label')).toBe('爬虫脚本');

    // 模板里写成 `label="..."`（而非 `.label`）时也要认，否则无障碍名称会退回默认值。
    const viaAttribute = document.createElement('pwn2block-code-editor') as Pwn2BlockCodeEditor;
    viaAttribute.setAttribute('label', '利用脚本');
    viaAttribute.value = 'x';
    document.body.append(viaAttribute);
    mounted.push(viaAttribute);
    await viaAttribute.updateComplete;
    expect(textareaOf(viaAttribute).getAttribute('aria-label')).toBe('利用脚本');
  });

  it('readOnly 时 textarea 只读、隐藏扩大按钮，文本仍在、仍可选中复制', async () => {
    const editor = await mount('x = 1');
    editor.readOnly = true;
    await editor.updateComplete;
    const input = textareaOf(editor);
    expect(input.hasAttribute('readonly')).toBe(true);
    expect(input.value).toBe('x = 1');
    expect(shadowOf(editor).querySelector('button')).toBeNull();
    // 文本还是可选的：只读不等于禁用。
    expect(input.disabled).toBe(false);
  });

  it('Tab 插入 4 空格、Shift+Tab 反缩进，并派发输入事件', async () => {
    const editor = await mount('x');
    const seen: string[] = [];
    editor.addEventListener('p2b-code-input', (event) => {
      seen.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    const input = textareaOf(editor);
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    expect(input.value).toBe('    x');
    expect(input.selectionStart).toBe(4);
    expect(seen).toEqual(['    x']);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, composed: true }));
    expect(input.value).toBe('x');
    expect(input.selectionStart).toBe(0);
  });

  it('Enter 走 autoIndent：冒号结尾的行自动补一级缩进', async () => {
    const editor = await mount('if x:');
    const input = textareaOf(editor);
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    expect(input.value).toBe('if x:\n    ');
    expect(input.selectionStart).toBe(10);
  });

  it('Escape 在组内按下时派发 p2b-code-cancel', async () => {
    const editor = await mount('x');
    let cancelled = 0;
    editor.addEventListener('p2b-code-cancel', () => {
      cancelled += 1;
    });
    textareaOf(editor).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(cancelled).toBe(1);
  });
});
