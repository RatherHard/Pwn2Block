import { describe, expect, it } from 'vitest';
import type { Action } from '@pwn2block/shared';
import { replaySubmit } from '../src/replay';
import { readRegister } from '../src/state';
import { code, p64, testKit } from './helpers/challenge';
import { memoryHex } from './helpers/fake-memory';

const WRITE_AA: Action = { type: 'write_bytes', addr: '0x2000', hex: 'aa' };
const WRITE_BB: Action = { type: 'write_bytes', addr: '0x2001', hex: 'bb' };

describe('replaySubmit：判定', () => {
  it('满足 win → won，并且帧序列是 init + instruction + action', () => {
    const kit = testKit({ code: code(0x1b) });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 1 }]);

    expect(outcome.verdict).toBe('won');
    expect(outcome.executed).toBe(1);
    expect(outcome.results).toEqual([{ ok: true, action: 'step' }]);
    expect(outcome.frames.map((frame) => frame.kind)).toEqual(['init', 'instruction', 'action']);
    expect(outcome.frames.map((frame) => frame.label)).toEqual(['init', 'syscall win', 'step']);
    expect(readRegister(outcome.finalState, 'FLAG')).toBe(1n);
  });

  it('什么都没满足 → incomplete', () => {
    const kit = testKit({ code: code(0x90) });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 1 }]);
    expect(outcome.verdict).toBe('incomplete');
    expect(outcome.finalState.status).toBe('ready');
  });

  it('命中 fail 谓词（退出但没置 FLAG）→ failed', () => {
    const kit = testKit({ code: code(0x1c) });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 1 }]);
    expect(outcome.verdict).toBe('failed');
    expect(outcome.finalState.status).toBe('failed');
    expect(outcome.finalState.error).toBeUndefined();
  });

  it('运行期异常即判负（02 §6：判题实例不回退）', () => {
    const kit = testKit({ code: code(0xee), fail: [] });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 1 }]);
    expect(outcome.verdict).toBe('failed');
    expect(outcome.results[0]?.ok).toBe(true);
    expect(outcome.results[0]?.error?.code).toBe('invalid_instruction');
  });

  it('动作被拒绝 → rejected', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [{ type: 'write_bytes', addr: '0x4000', hex: '00' }]);
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.executed).toBe(0);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.frames).toHaveLength(2);
  });

  it('payload 里出现回退类动作 → rejected', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [{ type: 'undo' }]);
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.results[0]?.error?.code).toBe('action_not_allowed');
    expect(outcome.results[0]?.error?.detail).toContain('回退');
  });
});

describe('replaySubmit：计数与帧', () => {
  it('executed 数的是生效的动作数，不是指令数', () => {
    const kit = testKit({ code: code(0x90, 0x90) });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 2 }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.finalState.steps).toBe(2);
    expect(outcome.frames).toHaveLength(4);
  });

  it('satisfied 不限制动作（04 §1.1）：置 FLAG 后的写动作照常执行', () => {
    const kit = testKit({ code: code(0x1b) });
    const outcome = replaySubmit(kit.env, [
      { type: 'step', count: 3 },
      { type: 'write_bytes', addr: '0x2000', hex: 'ff' },
    ]);
    expect(outcome.verdict).toBe('won');
    expect(outcome.executed).toBe(2);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.finalState.status).toBe('satisfied');
    expect(memoryHex(kit.memory, outcome.finalState.memory, 0x2000n, 1)).toBe('ff');
  });

  it('exited 中断后续动作：第二个动作不再被处理', () => {
    const kit = testKit({ code: code(0x1c), fail: [] });
    const outcome = replaySubmit(kit.env, [
      { type: 'step', count: 1 },
      { type: 'write_bytes', addr: '0x2000', hex: 'ff' },
    ]);
    expect(outcome.finalState.status).toBe('exited');
    expect(outcome.executed).toBe(1);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.verdict).toBe('incomplete');
    expect(memoryHex(kit.memory, outcome.finalState.memory, 0x2000n, 1)).toBe('00');
  });

  it('动作被拒绝后不再执行后续动作', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [
      WRITE_AA,
      { type: 'write_bytes', addr: '0x4000', hex: '00' },
      WRITE_BB,
    ]);
    expect(outcome.executed).toBe(1);
    expect(outcome.results).toHaveLength(2);
    expect(memoryHex(kit.memory, outcome.finalState.memory, 0x2000n, 2)).toBe('aa00');
  });

  it('积木作为一个动作回放', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [{ type: 'block', id: 'setip', args: { addr: '0x1234' } }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.frames.map((frame) => frame.kind)).toEqual(['init', 'action']);
    expect(readRegister(outcome.finalState, 'RIP')).toBe(0x1234n);
  });
});

describe('replaySubmit：端到端最小 ret2win', () => {
  it('写栈 + leave; ret 跳到 syscall win → won', () => {
    // 0x1000 leave，0x1001 ret，0x1002 syscall win；[RBP]=保存的 bp，[RBP+8]=返回地址 0x1002
    const kit = testKit({ code: code(0x19, 0x18, 0x1b) });
    const payload: Action[] = [
      { type: 'write_bytes', addr: '0x3800', hex: `${p64(0n)}${p64(0x1002n)}` },
      { type: 'step', count: 3 },
    ];
    const outcome = replaySubmit(kit.env, payload);

    expect(outcome.verdict).toBe('won');
    expect(outcome.executed).toBe(2);
    expect(readRegister(outcome.finalState, 'FLAG')).toBe(1n);
    // 取指自增后 syscall 落在 0x1002，执行完 ip 指向下一条 0x1003
    expect(readRegister(outcome.finalState, 'RIP')).toBe(0x1003n);
    expect(readRegister(outcome.finalState, 'RSP')).toBe(0x3810n);
    expect(outcome.finalState.steps).toBe(3);
    expect(outcome.finalState.status).toBe('satisfied');
    // init + write_bytes + leave + ret + syscall win + step
    expect(outcome.frames.map((frame) => frame.label)).toEqual([
      'init',
      'write_bytes',
      'leave',
      'ret',
      'syscall win',
      'step',
    ]);
  });

  it('纯函数：重复调用结果一致，且不受调试实例影响', () => {
    const kit = testKit({ code: code(0x1b) });
    const payload: Action[] = [{ type: 'step', count: 1 }];
    const first = replaySubmit(kit.env, payload);
    const second = replaySubmit(kit.env, payload);
    expect(second.verdict).toBe(first.verdict);
    expect(second.executed).toBe(first.executed);
    expect(second.finalState.registers).toEqual(first.finalState.registers);
    expect(second.finalState.steps).toBe(1);
  });
});

describe('replaySubmit：不读也不发 flag', () => {
  it('返回结构里没有 flag 字段，序列化结果里也没有 flag 真值', () => {
    const kit = testKit({ code: code(0x1b) });
    const outcome = replaySubmit(kit.env, [{ type: 'step', count: 1 }]);
    // BigInt 不能直接喂 JSON.stringify，转成十进制字符串再查
    const serialized = JSON.stringify(outcome, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    expect(Object.keys(outcome).sort()).toEqual([
      'executed',
      'finalState',
      'frames',
      'results',
      'verdict',
    ]);
    expect(serialized).not.toContain('env:FLAG');
    expect(serialized).not.toContain(kit.priv.flag);
  });
});
