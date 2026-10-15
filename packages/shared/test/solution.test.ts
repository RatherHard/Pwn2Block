import { describe, expect, it } from 'vitest';
import { parseSolutionMarkdown, renderSolutionTemplate } from '@pwn2block/shared';

describe('solution.md 格式', () => {
  it('解析唯一的 json 代码块，expectedVerdict 默认 won', () => {
    const result = parseSolutionMarkdown(`# 思路

先填 16 字节 padding。

\`\`\`json
{ "actions": [ { "type": "step", "count": 3 } ] }
\`\`\`
`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.expectedVerdict).toBe('won');
      expect(result.doc.actions).toEqual([{ type: 'step', count: 3 }]);
    }
  });

  it('缺少 json 代码块时报错', () => {
    const result = parseSolutionMarkdown('# 只有说明文字\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('```json');
  });

  it('出现多个 json 代码块时报错，避免解法含糊', () => {
    const result = parseSolutionMarkdown('```json\n{"actions":[]}\n```\n```json\n{"actions":[]}\n```\n');
    expect(result.ok).toBe(false);
  });

  it('JSON 非法或动作形状非法时报错', () => {
    expect(parseSolutionMarkdown('```json\n{ oops }\n```').ok).toBe(false);
    const badAction = parseSolutionMarkdown('```json\n{"actions":[{"type":"teleport"}]}\n```');
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) expect(badAction.message).toContain('actions');
  });

  it('模板本身能被自己解析', () => {
    const text = renderSolutionTemplate('ret2win');
    const result = parseSolutionMarkdown(text);
    expect(result.ok).toBe(true);
  });
});
