import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  checkChallengePair,
  expandBlock,
  isAllowedByChallenge,
  ret2winPrivate,
  ret2winPublic,
  stepCount,
  runMaxSteps,
  MAX_STEPS_PER_RUN,
  MAX_STEP_COUNT,
} from '@pwn2block/shared';

describe('动作 Schema', () => {
  it('解析合法动作并规范化为小写', () => {
    const action = ActionSchema.parse({ type: 'write_bytes', addr: '0x7FFFFF00', hex: '41' });
    expect(action).toEqual({ type: 'write_bytes', addr: '0x7fffff00', hex: '41' });
  });

  it('step / run 的上限受资源限制约束', () => {
    expect(ActionSchema.safeParse({ type: 'step', count: MAX_STEP_COUNT }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'step', count: MAX_STEP_COUNT + 1 }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'step', count: 0 }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'run' }).success).toBe(true);
  });

  it('未知动作被拒绝', () => {
    expect(ActionSchema.safeParse({ type: 'read_memory', addr: '0x0' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'run', maxSteps: 10, extra: 1 }).success).toBe(false);
  });

  it('默认值：step 为 1 条，run 为单次运行上限', () => {
    expect(stepCount({ type: 'step' })).toBe(1);
    expect(runMaxSteps({ type: 'run' })).toBe(MAX_STEPS_PER_RUN);
  });

  it('回退类动作不受 allowedActions 约束，其余动作受约束', () => {
    expect(isAllowedByChallenge(ret2winPublic, 'undo')).toBe(true);
    expect(isAllowedByChallenge(ret2winPublic, 'step_back')).toBe(true);
    expect(isAllowedByChallenge(ret2winPublic, 'reset')).toBe(true);
    expect(isAllowedByChallenge(ret2winPublic, 'step')).toBe(true);
    expect(isAllowedByChallenge(ret2winPublic, 'write_bytes')).toBe(false);
    expect(isAllowedByChallenge(ret2winPublic, 'call')).toBe(false);
  });
});

describe('出题人积木的服务端展开', () => {
  it('ret2win 的 gets 展开成固定地址的 write_bytes', () => {
    const result = expandBlock(ret2winPublic, {
      type: 'block',
      id: 'gets',
      args: { data: '41414141' },
    });
    expect(result).toEqual({
      ok: true,
      actions: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '41414141' }],
    });
  });

  it('未声明的积木 id 回 unknown_action', () => {
    const result = expandBlock(ret2winPublic, { type: 'block', id: 'nope', args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_action');
  });

  it('缺参数、多参数、类型不符都回 invalid_arguments', () => {
    const missing = expandBlock(ret2winPublic, { type: 'block', id: 'gets', args: {} });
    expect(missing.ok === false && missing.code).toBe('invalid_arguments');

    const extra = expandBlock(ret2winPublic, {
      type: 'block',
      id: 'gets',
      args: { data: '41', other: '42' },
    });
    expect(extra.ok === false && extra.code).toBe('invalid_arguments');

    const wrongType = expandBlock(ret2winPublic, {
      type: 'block',
      id: 'gets',
      args: { data: '0x41' },
    });
    expect(wrongType.ok === false && wrongType.code).toBe('invalid_arguments');
  });

  it('int 参数代入地址槽位时格式化成 0x 形式', () => {
    const pub = {
      ...ret2winPublic,
      authorBlocks: [
        {
          id: 'jump',
          label: 'jump(addr)',
          params: [
            { name: 'target', type: 'int' as const },
            { name: 'payload', type: 'bytes' as const },
          ],
          expand: [
            { type: 'call' as const, addr: '$target' },
            { type: 'feed' as const, hex: '$payload' },
          ],
        },
      ],
    };
    const result = expandBlock(pub, {
      type: 'block',
      id: 'jump',
      args: { target: 0x400002, payload: '4141' },
    });
    expect(result).toEqual({
      ok: true,
      actions: [
        { type: 'call', addr: '0x400002' },
        { type: 'feed', hex: '4141' },
      ],
    });
  });

  it('展开结果不受 allowedActions 限制（这是积木存在的意义）', () => {
    const result = expandBlock(ret2winPublic, {
      type: 'block',
      id: 'gets',
      args: { data: '41' },
    });
    expect(result.ok).toBe(true);
    expect(ret2winPublic.allowedActions).not.toContain('write_bytes');
  });

  it('未知积木 id 不会因为 args 而通过', () => {
    const result = expandBlock(ret2winPublic, { type: 'block', id: 'gets2', args: { data: '41' } });
    expect(result.ok).toBe(false);
  });
});

describe('样例题目包（03 §4）', () => {
  it('公开包与私有包配对校验通过，并解析出 flag 环境变量引用', () => {
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, {
      flagValue: 'flag{local-test-sentinel}',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.encoding).toHaveLength(4);
      expect(result.definition.flagRef).toEqual({
        kind: 'env',
        envVar: 'FLAG_RET2WIN',
        resolved: 'flag{local-test-sentinel}',
      });
      expect(result.definition.lookup.wordBytes).toBe(8);
    }
  });

  it('环境变量缺失时拒绝加载该题', () => {
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((item) => item.message.includes('FLAG_RET2WIN'))).toBe(true);
    }
  });
});
