import { describe, expect, it } from 'vitest';
import { buildEnvironment, createInitialState } from '../src/env';
import { stepOnce } from '../src/execute';
import { createDebugInstance } from '../src/instance';
import { createMemory } from '../src/memory/index';
import { readRegister } from '../src/state';
import type { TestChallengeOptions } from './helpers/challenge';
import { code, p64, setRegisters, testKit } from './helpers/challenge';

function environment(options: TestChallengeOptions = {}) {
  const { pub, priv } = testKit(options);
  return buildEnvironment(pub, priv, createMemory);
}

describe('状态工具：生产调用仍依赖的单寄存器契约', () => {
  it('读取已声明的值，未声明的名字回 0n', () => {
    const env = environment();
    const state = setRegisters(env, createInitialState(env), { RAX: 0x10n, RBX: 0x3n });

    expect(readRegister(state, 'RAX')).toBe(0x10n);
    expect(readRegister(state, 'NOPE')).toBe(0n);
    expect(readRegister(state, 'RBX')).toBe(0x3n);
  });

  it('32 位写入先掩蔽，读取不改原状态', () => {
    const env = environment({ archBits: 32 });
    const initial = createInitialState(env);
    const state = setRegisters(env, initial, { RAX: 0x1_ffff_ffffn });

    expect(readRegister(state, 'RAX')).toBe(0xffff_ffffn);
    expect(readRegister(initial, 'RAX')).toBe(0n);
  });
});

/** 不构造 ready + error：用真实内存、执行和历史恢复守住 judge 的入口不变量。 */
describe('错误状态不变量（02 §6–7、09 §7 第 3 条）', () => {
  it.each([
    { name: '取指异常', bytes: code(0x90), ip: '0x9000', error: 'invalid_ip' },
    { name: '解码异常', bytes: code(0xff), ip: '0x1000', error: 'invalid_instruction' },
    { name: '执行异常', bytes: code(0x04, p64(0n)), ip: '0x1000', error: 'memory_fault' },
  ])('$name 进入 failed，重复执行保留整份状态和错误', ({ bytes, ip, error }) => {
    const env = environment({ code: bytes, initRegisters: { RIP: ip, RBP: '0x5000' } });
    const initial = createInitialState(env);
    const outcome = stepOnce(env, initial);
    const failed = outcome.state;

    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe(error);
    expect(failed.lastStop).toStrictEqual({ reason: 'exception', addr: BigInt(ip) });
    expect(failed.registers).toBe(initial.registers);
    expect(failed.flags).toBe(initial.flags);
    expect(outcome.executed).toBe(0);
    expect('error' in initial).toBe(false);

    const repeated = stepOnce(env, failed);
    expect(repeated).toStrictEqual({ state: failed, executed: 0, stop: 'exception', error: failed.error });
    expect(repeated.state).toBe(failed);
  });

  it.each(['undo', 'step_back'] as const)('%s 恢复异常前状态，随后可正常判题且不残留 error', (type) => {
    const instance = createDebugInstance(environment({ code: code(0x90, 0xff) }));
    const initial = instance.state();
    instance.applyRequest([{ type: 'step', count: 2 }]);
    expect(instance.state().status).toBe('failed');
    expect(instance.state().error?.code).toBe('invalid_instruction');

    // step_back 先退回非法指令之前，再退回 nop 之前；undo 一次退回整个请求之前。
    const actions = type === 'undo' ? [{ type }] : [{ type }, { type }];
    const restored = instance.applyRequest(actions).state;
    expect(restored.status).toBe('ready');
    expect('error' in restored).toBe(false);
    expect('lastStop' in restored).toBe(false);
    expect(Object.keys(restored).sort()).toEqual(Object.keys(initial).sort());
    expect(restored.registers).toStrictEqual(initial.registers);
    expect(restored.flags).toStrictEqual(initial.flags);
    expect(restored.steps).toBe(0);

    const next = instance.applyRequest([{ type: 'step', count: 1 }]).state;
    expect(next.status).toBe('ready');
    expect(next.registers.RIP).toBe(0x1001n);
    expect(next.steps).toBe(1);
    expect('error' in next).toBe(false);
  });

  it('命中 fail 谓词属于判负，保留停因但不制造运行期 error', () => {
    const env = environment({ code: code(0x1c) });
    const outcome = stepOnce(env, createInitialState(env));

    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.lastStop).toStrictEqual({ reason: 'exception', addr: 0x1000n });
    expect(outcome.state.exitCode).toBe(0n);
    expect(outcome.executed).toBe(1);
    expect(outcome.stop).toBe('exception');
    expect('error' in outcome.state).toBe(false);
    expect('error' in outcome).toBe(false);
  });
});
