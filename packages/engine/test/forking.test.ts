import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@pwn2block/shared';
import { createInitialState } from '../src/env';
import { stepState } from '../src/execute';
import { createDebugInstance } from '../src/instance';
import { replaySubmit } from '../src/replay';
import { forkState } from '../src/state';
import { code, DATA_START, p64, testKit } from './helpers/challenge';
import { memoryHex, memoryWord } from './helpers/fake-memory';

/**
 * `MemoryApi` 的写入是**就地换页表**，同一个句柄放在多个历史位置时旧位置会看到
 * 后来的写入。这一组测试专门锁死“帧 / 历史 / 返回状态各自 fork 内存”的纪律。
 *
 * 程序：`mov [RBP+8], RAX`（RAX 初值 0xaa）→ `mov RAX, 0xbb` → `mov [RBP+0x10], RAX`
 */
const PROGRAM = code(0x04, p64(8n), 0x01, p64(0xbbn), 0x04, p64(0x10n));

describe('执行结果之间不共享内存', () => {
  it('早先的状态保留当时的字节，后来的写入不可见', () => {
    const kit = testKit({ code: PROGRAM, initRegisters: { RAX: '0xaa' } });
    const initial = createInitialState(kit.env);
    const first = stepState(kit.env, initial, 1);
    const second = stepState(kit.env, first.state, 2);

    expect(memoryWord(kit.memory, first.state.memory, 0x3808n)).toBe(0xaan);
    expect(memoryWord(kit.memory, first.state.memory, 0x3810n)).toBe(0n);
    expect(memoryWord(kit.memory, second.state.memory, 0x3808n)).toBe(0xaan);
    expect(memoryWord(kit.memory, second.state.memory, 0x3810n)).toBe(0xbbn);
  });

  it('执行不修改调用方持有的状态与它的内存句柄', () => {
    const kit = testKit({ code: PROGRAM, initRegisters: { RAX: '0xaa' } });
    const initial = createInitialState(kit.env);
    stepState(kit.env, initial, 3);

    expect(initial.steps).toBe(0);
    expect(memoryWord(kit.memory, initial.memory, 0x3808n)).toBe(0n);
    expect(memoryWord(kit.memory, initial.memory, 0x3810n)).toBe(0n);
  });

  it('写旧帧的 fork 不会影响当前状态', () => {
    const kit = testKit({ code: PROGRAM, initRegisters: { RAX: '0xaa' } });
    const initial = createInitialState(kit.env);
    const first = stepState(kit.env, initial, 1);
    const second = stepState(kit.env, first.state, 2);

    const older = forkState(kit.memory, first.state);
    const written = kit.memory.write(older.memory, 0x3808n, hexToBytes(p64(0xccn)));
    expect(written.ok).toBe(true);

    expect(memoryWord(kit.memory, older.memory, 0x3808n)).toBe(0xccn);
    expect(memoryWord(kit.memory, second.state.memory, 0x3808n)).toBe(0xaan);
    expect(memoryWord(kit.memory, first.state.memory, 0x3808n)).toBe(0xaan);
  });

  it('调用方拿到的 fork 与引擎自己是两个句柄', () => {
    const kit = testKit({ code: PROGRAM, initRegisters: { RAX: '0xaa' } });
    const outcome = stepState(kit.env, createInitialState(kit.env), 3);
    const held = forkState(kit.memory, outcome.state);
    expect(held.memory).not.toBe(outcome.state.memory);
  });
});

describe('调试实例：历史与返回状态各自 fork', () => {
  it('undo 栈里的每一层都保留自己的字节', () => {
    const kit = testKit();
    const instance = createDebugInstance(kit.env);
    const first = instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'aa' }]);
    const second = instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'bb' }]);

    expect(memoryHex(kit.memory, first.state.memory, DATA_START, 1)).toBe('aa');
    expect(memoryHex(kit.memory, second.state.memory, DATA_START, 1)).toBe('bb');
  });

  it('undo 回到上一层后，被回滚的那一层帧仍保留自己的字节', () => {
    const kit = testKit();
    const instance = createDebugInstance(kit.env);
    instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'aa' }]);
    const second = instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'bb' }]);

    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(memoryHex(kit.memory, undone.state.memory, DATA_START, 1)).toBe('aa');
    expect(memoryHex(kit.memory, second.state.memory, DATA_START, 1)).toBe('bb');
    expect(memoryHex(kit.memory, instance.state().memory, DATA_START, 1)).toBe('aa');
  });

  it('通过调用方持有的状态写内存，改不到调试实例', () => {
    const kit = testKit({ code: code(0x04, p64(8n)), initRegisters: { RAX: '0x77' } });
    const instance = createDebugInstance(kit.env);
    instance.applyRequest([{ type: 'step', count: 1 }]);

    const snapshot = instance.state();
    const written = kit.memory.write(snapshot.memory, 0x3808n, hexToBytes(p64(0xccn)));
    expect(written.ok).toBe(true);

    expect(memoryWord(kit.memory, snapshot.memory, 0x3808n)).toBe(0xccn);
    expect(memoryWord(kit.memory, instance.state().memory, 0x3808n)).toBe(0x77n);
  });

  it('step_back 恢复出来的状态与历史帧互不影响', () => {
    const kit = testKit({ code: code(0x04, p64(8n)), initRegisters: { RAX: '0x11' } });
    const instance = createDebugInstance(kit.env);
    instance.applyRequest([{ type: 'step', count: 1 }]);
    const back = instance.applyRequest([{ type: 'step_back' }]);
    expect(memoryWord(kit.memory, back.state.memory, 0x3808n)).toBe(0n);

    const again = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(memoryWord(kit.memory, again.state.memory, 0x3808n)).toBe(0x11n);
    expect(memoryWord(kit.memory, back.state.memory, 0x3808n)).toBe(0n);
  });
});

describe('提交回放：录像帧各自 fork', () => {
  it('init / 各动作帧的内存内容互不串味', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [
      { type: 'write_bytes', addr: '0x2000', hex: 'aa' },
      { type: 'write_bytes', addr: '0x2000', hex: 'bb' },
    ]);

    const [init, first, second] = outcome.frames;
    expect(init).toBeDefined();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (init === undefined || first === undefined || second === undefined) return;

    expect(memoryHex(kit.memory, init.state.memory, DATA_START, 1)).toBe('00');
    expect(memoryHex(kit.memory, first.state.memory, DATA_START, 1)).toBe('aa');
    expect(memoryHex(kit.memory, second.state.memory, DATA_START, 1)).toBe('bb');
    expect(first.state.memory).not.toBe(second.state.memory);
    expect(init.state.memory).not.toBe(first.state.memory);
  });

  it('指令帧也各自 fork（ret2win 路径逐帧可读）', () => {
    const kit = testKit({ code: code(0x19, 0x18, 0x1b) });
    const outcome = replaySubmit(kit.env, [
      { type: 'write_bytes', addr: '0x3800', hex: `${p64(0n)}${p64(0x1002n)}` },
      { type: 'step', count: 3 },
    ]);

    const writeFrame = outcome.frames[1];
    expect(writeFrame).toBeDefined();
    if (writeFrame === undefined) return;
    expect(memoryWord(kit.memory, writeFrame.state.memory, 0x3808n)).toBe(0x1002n);
    // 回放结束后 finalState 是终态，但早先的帧仍停在当时
    expect(memoryWord(kit.memory, outcome.finalState.memory, 0x3808n)).toBe(0x1002n);
    expect(writeFrame.state.memory).not.toBe(outcome.finalState.memory);
  });

  it('finalState 与调用方持有的引用互不影响', () => {
    const kit = testKit();
    const outcome = replaySubmit(kit.env, [{ type: 'write_bytes', addr: '0x2000', hex: 'aa' }]);
    const held = forkState(kit.memory, outcome.finalState);
    const written = kit.memory.write(held.memory, DATA_START, hexToBytes('ff'));
    expect(written.ok).toBe(true);
    expect(memoryHex(kit.memory, outcome.finalState.memory, DATA_START, 1)).toBe('aa');
  });
});
