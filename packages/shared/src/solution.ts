import { z } from 'zod';
import { ActionSchema } from './actions';

/**
 * `solution.md` 的解法定稿格式（A02 冻结，06 §2 与 09 §4 的契约）。
 *
 * 约定：文件正文用中文说明思路，**必须且只能有一个** ```json 代码块，内容是：
 *
 * ```json
 * { "actions": [ … ], "expectedVerdict": "won", "note": "可选备注" }
 * ```
 *
 * 为什么要求机器可读块：`challenge:solve` 要把这份 payload **当成一次提交回放**，
 * 断言 verdict 为 `won`（06 §2）。解法必须是自足的 payload：偏移写字面量、
 * 不含读状态积木，从初始状态回放就能赢（04 §5.1、05 §4）。
 * `expectedVerdict` 默认 `won`，个别题目可以写成 `failed` 来固化“这条错路必然失败”的反例。
 */

export const SolutionDocSchema = z.strictObject({
  actions: z.array(ActionSchema).min(1),
  expectedVerdict: z.enum(['won', 'failed', 'rejected', 'incomplete']).default('won'),
  note: z.string().max(500).optional(),
});
export type SolutionDoc = z.infer<typeof SolutionDocSchema>;

export type SolutionParseResult =
  | { readonly ok: true; readonly doc: SolutionDoc }
  | { readonly ok: false; readonly message: string };

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)```/g;

/** 从 `solution.md` 正文里取出唯一的 ```json 代码块并校验。 */
export function parseSolutionMarkdown(markdown: string): SolutionParseResult {
  const blocks = [...markdown.matchAll(JSON_FENCE_RE)].map((match) => match[1] ?? '');
  if (blocks.length === 0) {
    return { ok: false, message: 'solution.md 里没有 ```json 代码块' };
  }
  if (blocks.length > 1) {
    return { ok: false, message: 'solution.md 里出现了多个 ```json 代码块，只允许一个' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0] as string);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `solution.md 的 JSON 无法解析：${message}` };
  }

  const parsed = SolutionDocSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '<root>';
    return { ok: false, message: `solution.md 的解法格式不合法（${path}）：${first?.message ?? ''}` };
  }
  return { ok: true, doc: parsed.data };
}

/** 生成 `challenge:new` 用的解法模板。 */
export function renderSolutionTemplate(challengeId: string): string {
  return `# ${challengeId} 参考解法

写清思路：从哪个偏移入手、为什么这么算。下面的 JSON 是**自足的 payload**，
\`challenge:solve\` 会把它当成一次提交回放，断言 verdict 为 won。

- 偏移必须是字面量，不能依赖调试时看到的运行时值（04 §5.1）。
- payload 里不允许出现读当前状态的构造（05 §4）。

\`\`\`json
{
  "actions": [
    { "type": "block", "id": "gets", "args": { "data": "4100000000000000" } },
    { "type": "step", "count": 1 }
  ],
  "expectedVerdict": "won"
}
\`\`\`
`;
}
