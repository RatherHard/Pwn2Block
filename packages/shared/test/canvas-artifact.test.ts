import { canvas } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';

/**
 * 产物契约的搬迁守护。
 *
 * `canvas/artifact.ts` 里的 `PortType` 与 `WorkflowIssue` 是从已删除的 `workflow/types.ts`
 * 原样搬来的（原因见该文件的文件头）：web 的产物模块按扁平名字引用它们，问题代码映射表
 * 以 `WorkflowIssue['code']` 的字面量为值。所以这里只钉一件事——**搬过来的东西没被悄悄改小**。
 * 具体文案与界面分组属于界面契约，不在 shared 里断言。
 */
describe('canvas · 产物契约（端口类型与问题代码）', () => {
  it('端口类型仍是四类，且每类都有中文标签', () => {
    expect([...canvas.PORT_TYPES]).toEqual(['int', 'bool', 'bytes', 'text']);
    for (const type of canvas.PORT_TYPES) {
      expect(canvas.PORT_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('问题代码没有重复，且仍覆盖新旧画布都在用的那几条', () => {
    const codes = canvas.WORKFLOW_ISSUE_CODES;
    expect(new Set(codes).size).toBe(codes.length);
    // 新版画布的问题映射表用到的取值：少一个就会让 web 侧那张表编译不过。
    for (const code of ['unknown_node', 'invalid_param', 'eval_failed', 'missing_input'] as const) {
      expect(codes).toContain(code);
    }
  });
});
