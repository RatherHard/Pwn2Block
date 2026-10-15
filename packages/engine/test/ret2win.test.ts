import { describe, expect, it } from 'vitest';
import { ret2winPrivate, ret2winPublic, ret2winSolutionActions } from '@pwn2block/shared';
import type { Action } from '@pwn2block/shared';
import { buildEnvironment } from '../src/env';
import { createDebugInstance } from '../src/instance';
import { replaySubmit } from '../src/replay';
import { readRegister } from '../src/state';
import { createFakeMemory } from './helpers/fake-memory';

/**
 * 用 shared 的真实夹具跑 D1 首题（ret2win）的参考解法。
 *
 * 两道关卡各有侧重：
 * - **不被误拒**（A 的契约修正）：`allowedActions` 里没有 `write_bytes` 也没有 `block`，
 *   但出题人积木 `gets` 必须始终可用（03 §3、04 §2）。
 * - **跑得通**：解码 → leave/ret → syscall win → 判胜。这条链路用测试内存替身，
 *   不依赖 G 的内存实现，因此能在 D1 独立锁定。
 */

function makeEnv(): ReturnType<typeof buildEnvironment> {
  return buildEnvironment(ret2winPublic, ret2winPrivate, createFakeMemory());
}

describe('ret2win 参考解法：动作不被拒绝', () => {
  it('gets 积木不在 allowedActions 里也始终可用', () => {
    expect(ret2winPublic.allowedActions).not.toContain('block');
    expect(ret2winPublic.allowedActions).not.toContain('write_bytes');

    const env = makeEnv();
    const instance = createDebugInstance(env);
    const outcome = instance.applyRequest([...ret2winSolutionActions] as Action[]);

    expect(outcome.results.map((result) => result.ok)).toEqual([true, true]);
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.executed).toBe(2);
    expect(outcome.failures).toBe(0);
  });

  it('裸 write_bytes 仍然被 allowedActions 拒（积木没有开后门）', () => {
    const env = makeEnv();
    const instance = createDebugInstance(env);
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x7fffff00', hex: '41' }]);
    expect(outcome.results[0]?.error?.code).toBe('action_not_allowed');
  });

  it('未声明的积木 id → unknown_action（不是 action_not_allowed）', () => {
    const env = makeEnv();
    const instance = createDebugInstance(env);
    const outcome = instance.applyRequest([{ type: 'block', id: 'nope', args: {} }]);
    expect(outcome.results[0]?.error?.code).toBe('unknown_action');
  });
});

describe('ret2win 参考解法：端到端判胜', () => {
  it('回放参考解法 → won，FLAG 置位，返回地址 0x400002', () => {
    const env = makeEnv();
    const outcome = replaySubmit(env, [...ret2winSolutionActions] as Action[]);

    expect(outcome.verdict).toBe('won');
    expect(outcome.executed).toBe(2);
    expect(outcome.results.every((result) => result.ok)).toBe(true);
    expect(readRegister(outcome.finalState, 'FLAG')).toBe(1n);
    // ret 落到 0x400002 执行 syscall win，取指自增使 ip 停在 0x400003
    expect(readRegister(outcome.finalState, 'RIP')).toBe(0x400003n);
    expect(outcome.finalState.steps).toBe(3);
    expect(outcome.finalState.status).toBe('satisfied');
    // 首帧 init + gets 一帧 + leave/ret/syscall win 三帧 + step 一帧
    expect(outcome.frames.map((frame) => frame.label)).toEqual([
      'init',
      'block',
      'leave',
      'ret',
      'syscall win',
      'step',
    ]);
  });

  it('调试实例里同一个 payload 只提示 satisfied，不发 flag', () => {
    const env = makeEnv();
    const instance = createDebugInstance(env);
    const outcome = instance.applyRequest([...ret2winSolutionActions] as Action[]);

    expect(outcome.state.status).toBe('satisfied');
    expect(readRegister(outcome.state, 'FLAG')).toBe(1n);
    expect(Object.keys(outcome)).toEqual(['results', 'executed', 'state', 'failures']);
    expect(JSON.stringify(outcome, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    )).not.toContain(ret2winPrivate.flag);
  });
});
