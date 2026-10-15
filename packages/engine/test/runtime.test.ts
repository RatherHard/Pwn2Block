import { describe, expect, it } from 'vitest';
import {
  buildEncodingLookup,
  bytesToHex,
  ret2winPrivate,
  ret2winPublic,
  ret2winSolutionActions,
} from '@pwn2block/shared';
import type { Action, PublicChallenge } from '@pwn2block/shared';
import { createRuntime } from '../src/index';
import { readRegister } from '../src/state';

/**
 * 包入口的真实装配（D1 交付物之一）：`createRuntime` 用 G 的 `createMemory` 拼出
 * 冻结契约里的 `EngineRuntime`，并用真实的 ret2win 夹具跑通整条链路。
 *
 * 这里刻意**不**用测试内存替身：入口装配的正确性只有在真装配下才有意义。
 */

const runtime = createRuntime(ret2winPublic, ret2winPrivate);

describe('createRuntime：装配出的运行时形状', () => {
  it('暴露冻结契约要求的全部字段', () => {
    expect(Object.keys(runtime).sort()).toEqual([
      'archBits',
      'challengeId',
      'createDebugInstance',
      'disassemble',
      'evaluate',
      'initialState',
      'layout',
      'memory',
      'privatePkg',
      'publicPkg',
      'readVisible',
      'readVmaVisible',
      'replaySubmit',
      'run',
      'step',
      'wordBytes',
    ]);
  });

  it('题目标识、位宽与字长来自公开包', () => {
    expect(runtime.challengeId).toBe('ret2win');
    expect(runtime.archBits).toBe(64);
    expect(runtime.wordBytes).toBe(8);
    expect(runtime.publicPkg).toBe(ret2winPublic);
    expect(runtime.privatePkg).toBe(ret2winPrivate);
  });

  it('公开布局列出全部 VMA，隐藏标记保留', () => {
    expect(runtime.layout.map((vma) => vma.id)).toEqual(['text', 'stack']);
    expect(runtime.layout[0]).toEqual({
      id: 'text',
      kind: 'code',
      label: undefined,
      start: '0x400000',
      size: '0x1000',
      perm: 'rx',
      hidden: false,
    });
  });

  it('内存实现来自 G 的 createMemory（页大小 4KB）', () => {
    expect(runtime.memory.pageSize).toBe(0x1000);
  });

  it('初态按私有包初始化', () => {
    const state = runtime.initialState();
    expect(state.archBits).toBe(64);
    expect(state.registers).toEqual({
      RAX: 0n,
      RDI: 0n,
      RSP: 0x7fffff00n,
      RBP: 0x7fffff10n,
      RIP: 0x400000n,
      FLAG: 0n,
    });
    expect(state.status).toBe('ready');
    expect(state.steps).toBe(0);
  });

  it('每次 initialState 都是独立实例', () => {
    const first = runtime.initialState();
    const second = runtime.initialState();
    expect(runtime.memory.write(first.memory, 0x7fffff00n, new Uint8Array([0x41])).ok).toBe(true);
    expect(
      bytesToHex((runtime.memory.read(second.memory, 0x7fffff00n, 1) as { bytes: Uint8Array }).bytes),
    ).toBe('00');
  });
});

describe('createRuntime：执行与判定', () => {
  it('step 执行 leave，RSP / RBP 精确变化', () => {
    const outcome = runtime.step(runtime.initialState(), 1);
    expect(outcome.executed).toBe(1);
    // 栈上预置：[0x7fffff10] = 0x7fffff40（保存的 RBP），[0x7fffff18] = 0x400003
    expect(readRegister(outcome.state, 'RSP')).toBe(0x7fffff18n);
    expect(readRegister(outcome.state, 'RBP')).toBe(0x7fffff40n);
    expect(readRegister(outcome.state, 'RIP')).toBe(0x400001n);
  });

  it('后门帧还没写时 run 会走到 syscall exit，判负', () => {
    const outcome = runtime.run(runtime.initialState(), 10);
    expect(outcome.stop).toBe('exception');
    expect(outcome.state.status).toBe('failed');
    // leave → ret（回到 0x400003）→ syscall exit
    expect(outcome.executed).toBe(3);
    expect(outcome.state.error).toBeUndefined();
  });

  it('evaluate 直接按 win / fail 给出判定', () => {
    const initial = runtime.initialState();
    expect(runtime.evaluate(initial)).toBe('none');
    const won = { ...initial, registers: { ...initial.registers, FLAG: 1n } };
    expect(runtime.evaluate(won)).toBe('win');
    const lost = { ...initial, status: 'exited' as const };
    expect(runtime.evaluate(lost)).toBe('fail');
  });

  it('replaySubmit 回放参考解法判胜', () => {
    const outcome = runtime.replaySubmit([...ret2winSolutionActions] as Action[]);
    expect(outcome.verdict).toBe('won');
    expect(outcome.executed).toBe(2);
    expect(readRegister(outcome.finalState, 'FLAG')).toBe(1n);
  });

  it('replaySubmit 是纯函数：连跑两次结果一致，且不动调试实例', () => {
    const debug = runtime.createDebugInstance();
    const first = runtime.replaySubmit([...ret2winSolutionActions] as Action[]);
    const after = debug.state();
    const second = runtime.replaySubmit([...ret2winSolutionActions] as Action[]);
    expect(second.verdict).toBe(first.verdict);
    expect(after.steps).toBe(0);
    expect(after.registers).toEqual(runtime.initialState().registers);
  });
});

describe('createRuntime：调试实例', () => {
  it('动作请求返回状态、已执行数与历史深度', () => {
    const instance = runtime.createDebugInstance();
    const outcome = instance.applyRequest([
      { type: 'block', id: 'gets', args: { data: '41'.repeat(8) } },
    ]);
    expect(outcome.results).toEqual([{ ok: true, action: 'block' }]);
    expect(outcome.executed).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 0 });
    expect(instance.failures()).toBe(0);
    expect(
      bytesToHex(
        (runtime.memory.read(outcome.state.memory, 0x7fffff00n, 8) as { bytes: Uint8Array }).bytes,
      ),
    ).toBe('4141414141414141');
  });

  it('回退类动作不写 allowedActions 也不被拒', () => {
    const instance = runtime.createDebugInstance();
    expect(
      instance.applyRequest([{ type: 'write_bytes', addr: '0x7fffff00', hex: '41' }]).results[0]?.error
        ?.code,
    ).toBe('action_not_allowed');
    expect(instance.applyRequest([{ type: 'reset' }]).results[0]?.ok).toBe(true);
    expect(instance.applyRequest([{ type: 'undo' }]).executed).toBe(1);
  });
});

describe('createRuntime：编码表来源（RuntimeOptions）', () => {
  const presetPub = {
    ...ret2winPublic,
    encoding: { preset: 'x86ish' },
  } satisfies PublicChallenge;

  it('题目直接给完整编码表时可以省略 options', () => {
    const complete = createRuntime(ret2winPublic, ret2winPrivate);
    const entries = complete.disassemble(complete.initialState());
    expect(entries.map((entry) => entry.text)).toEqual([
      'leave',
      'ret',
      'syscall win',
      'syscall exit',
    ]);
  });

  it('引用 preset 时用 options.encoding 传展开结果', () => {
    const expanded = createRuntime(presetPub, ret2winPrivate, {
      encoding: ret2winPublic.encoding,
    });
    expect(expanded.disassemble(expanded.initialState())[0]?.text).toBe('leave');
    expect(expanded.replaySubmit([...ret2winSolutionActions] as Action[]).verdict).toBe('won');
  });

  it('引用 preset 时也可以直接传已建好的 lookup', () => {
    const byLookup = createRuntime(presetPub, ret2winPrivate, {
      lookup: buildEncodingLookup(ret2winPublic.encoding, 8),
    });
    expect(byLookup.initialState().registers.RIP).toBe(0x400000n);
    expect(byLookup.disassemble(byLookup.initialState())[0]?.text).toBe('leave');
  });

  it('lookup 优先于 encoding', () => {
    const byLookup = createRuntime(presetPub, ret2winPrivate, {
      lookup: buildEncodingLookup([], 8),
      encoding: ret2winPublic.encoding,
    });
    // 空查询表命中不了任何 opcode：四条指令全部退化成 db
    const entries = byLookup.disassemble(byLookup.initialState());
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.text.startsWith('db 0x'))).toBe(true);
  });

  it('引用 preset 又没传展开结果 → 显式抛错，不静默用空表', () => {
    expect(() => createRuntime(presetPub, ret2winPrivate)).toThrow(/展开/);
    expect(() => createRuntime(presetPub, ret2winPrivate)).toThrow(/preset/);
    expect(() => createRuntime(presetPub, ret2winPrivate, {})).toThrow(/options\.encoding/);
  });
});

describe('createRuntime：投影相关的读取', () => {
  it('disassemble 覆盖 text 区的四条指令并带显示名', () => {
    const entries = runtime.disassemble(runtime.initialState());
    expect(entries.map((entry) => entry.text)).toEqual([
      'leave',
      'ret',
      'syscall win',
      'syscall exit',
    ]);
    expect(entries.map((entry) => entry.addr)).toEqual(['0x400000', '0x400001', '0x400002', '0x400003']);
    expect(entries[0]?.bytes).toBe('c9');
  });

  it('readVisible 读公开区，readVmaVisible 读整个 VMA', () => {
    const state = runtime.initialState();
    const visible = runtime.readVisible(state, 0x400000n, 2);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(bytesToHex(visible.bytes)).toBe('c9c3');

    const text = runtime.readVmaVisible(state, 'text');
    expect(text).toBeDefined();
    expect(bytesToHex((text ?? new Uint8Array(0)).subarray(0, 4))).toBe('c9c30f0e');
  });

  it('readVisible 拒绝未映射区间', () => {
    expect(runtime.readVisible(runtime.initialState(), 0x1234n, 1)).toEqual({
      ok: false,
      reason: 'unmapped',
    });
  });
});
