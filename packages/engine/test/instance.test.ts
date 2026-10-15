import { describe, expect, it } from 'vitest';
import type { Action, DebugInstance } from '@pwn2block/shared';
import { createDebugInstance } from '../src/instance';
import { readRegister } from '../src/state';
import type { EngineEnv } from '../src/env';
import type { TestChallengeOptions } from './helpers/challenge';
import { DATA_START, HIDDEN_START, RODATA_START, code, p64, testKit } from './helpers/challenge';
import { memoryHex, memoryWord } from './helpers/fake-memory';

function start(options: TestChallengeOptions = {}): { env: EngineEnv; instance: DebugInstance } {
  const kit = testKit(options);
  return { env: kit.env, instance: createDebugInstance(kit.env) };
}

function hexAt(
  env: EngineEnv,
  instance: DebugInstance,
  addr: bigint,
  len: number,
): string {
  return memoryHex(env.memory, instance.state().memory, addr, len);
}

const WRITE_AA: Action = { type: 'write_bytes', addr: '0x2000', hex: 'aa' };
const WRITE_BB: Action = { type: 'write_bytes', addr: '0x2001', hex: 'bb' };

describe('applyRequest：写内存与一次请求一次撤销', () => {
  it('write_bytes 生效并压一份请求级快照', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'deadbeef' }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'write_bytes' }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(0);
    expect(hexAt(env, instance, DATA_START, 4)).toBe('deadbeef');
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 0 });
  });

  it('一次请求里多个动作只压一份快照，undo 一次全部回滚', () => {
    const { env, instance } = start();
    instance.applyRequest([WRITE_AA, WRITE_BB]);
    expect(hexAt(env, instance, DATA_START, 2)).toBe('aabb');
    expect(instance.historyDepth().undo).toBe(1);

    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(undone.executed).toBe(1);
    expect(hexAt(env, instance, DATA_START, 2)).toBe('0000');
    expect(instance.historyDepth().undo).toBe(0);
  });

  it('连续两个请求可以连续回退两步，各回一步', () => {
    const { env, instance } = start();
    instance.applyRequest([WRITE_AA]);
    instance.applyRequest([WRITE_BB]);
    expect(instance.historyDepth().undo).toBe(2);

    instance.applyRequest([{ type: 'undo' }]);
    expect(hexAt(env, instance, DATA_START, 2)).toBe('aa00');

    instance.applyRequest([{ type: 'undo' }]);
    expect(hexAt(env, instance, DATA_START, 2)).toBe('0000');
    expect(instance.historyDepth().undo).toBe(0);
  });

  it('历史为空时 undo 被拒绝并计一次失败', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'undo' }]);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('empty_history');
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toBe(1);
    expect(instance.failures()).toBe(1);
  });

  it('reset 可被撤销（它自己压栈）', () => {
    const { env, instance } = start();
    instance.applyRequest([WRITE_AA]);
    const reset = instance.applyRequest([{ type: 'reset' }]);
    expect(reset.results).toEqual([{ ok: true, action: 'reset' }]);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('00');

    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('aa');
    expect(undone.state.steps).toBe(0);
  });

  it('undo 后指令层缓冲清空（不能跨时间线回退）', () => {
    const { instance } = start({ code: code(0x90, 0x90) });
    instance.applyRequest([{ type: 'step', count: 2 }]);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 2 });

    instance.applyRequest([{ type: 'undo' }]);
    expect(instance.historyDepth()).toEqual({ undo: 0, stepBack: 0 });
  });
});

describe('applyRequest：隐藏 / 权限 / 允许动作集', () => {
  it('写隐藏区 → hidden_address，字节不变，不压快照', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x4000', hex: '00' }]);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.results[0]?.error?.addr).toBe(HIDDEN_START);
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toBe(1);
    expect(memoryHex(env.memory, instance.state().memory, HIDDEN_START, 2)).toBe('aabb');
    expect(instance.historyDepth().undo).toBe(0);
  });

  it('部分压到隐藏区也拒绝', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x3ffc', hex: '0011223344556677' }]);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
  });

  it('写只读区 → inaccessible_address', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x5000', hex: '00' }]);
    expect(outcome.results[0]?.error?.code).toBe('inaccessible_address');
    expect(outcome.results[0]?.error?.addr).toBe(RODATA_START);
  });

  it('未映射地址 → inaccessible_address', () => {
    const { instance } = start();
    expect(
      instance.applyRequest([{ type: 'write_bytes', addr: '0x9000', hex: '00' }]).results[0]?.error?.code,
    ).toBe('inaccessible_address');
  });

  it('动作不在 allowedActions 里 → action_not_allowed', () => {
    const { instance } = start({ allowedActions: ['step'] });
    const outcome = instance.applyRequest([WRITE_AA]);
    expect(outcome.results[0]?.error?.code).toBe('action_not_allowed');
    expect(outcome.failures).toBe(1);
  });

  it('回退类动作不受 allowedActions 限制', () => {
    const { instance } = start({ allowedActions: ['step'] });
    expect(instance.applyRequest([{ type: 'undo' }]).results[0]?.error?.code).toBe('empty_history');
    expect(instance.applyRequest([{ type: 'reset' }]).results[0]?.ok).toBe(true);
    expect(instance.applyRequest([{ type: 'step_back' }]).results[0]?.error?.code).toBe('empty_history');
  });

  it('已退出的实例拒绝执行类动作，但仍可 undo', () => {
    const { instance } = start({ code: code(0x1c), fail: [] });
    const exited = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(exited.state.status).toBe('exited');

    expect(instance.applyRequest([WRITE_AA]).results[0]?.error?.code).toBe('not_executable');
    expect(instance.applyRequest([{ type: 'undo' }]).results[0]?.ok).toBe(true);
    expect(instance.state().status).toBe('ready');
  });
});

describe('applyRequest：failures 与批量中断', () => {
  it('failures 单调递增，不因回退减少', () => {
    const { instance } = start();
    instance.applyRequest([{ type: 'write_bytes', addr: '0x4000', hex: '00' }]);
    instance.applyRequest([{ type: 'write_bytes', addr: '0x5000', hex: '00' }]);
    expect(instance.failures()).toBe(2);
    instance.applyRequest([{ type: 'reset' }]);
    expect(instance.failures()).toBe(2);
  });

  it('内部动作被拒绝时整批中断，后续动作不执行', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([
      WRITE_AA,
      { type: 'write_bytes', addr: '0x4000', hex: '00' },
      WRITE_BB,
    ]);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.executed).toBe(1);
    expect(outcome.results[1]?.error?.code).toBe('hidden_address');
  });

  it('VM 异常也中断整批并计一次失败', () => {
    const { instance } = start({ code: code(0xee) });
    const outcome = instance.applyRequest([{ type: 'step', count: 1 }, WRITE_AA]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(outcome.results[0]?.error?.code).toBe('invalid_instruction');
    expect(outcome.failures).toBe(1);
    expect(outcome.executed).toBe(1);
  });
});

/**
 * D3 回归（04 §4、09 §8 第 1 条）：`failures` 只数两类——**进了引擎被拒绝的动作**，与**把实例
 * 推进到 `failed` 的执行类动作**（运行期异常或命中失败谓词）。回退类动作（`undo` / `step_back`
 * / `reset`）把 `failed` 状态搬回来不算推进，一律不加。
 *
 * 缺陷复现路径：`step` 进入 `failed` → `reset`（把 failed 状态压进撤销栈）→ `undo` 恢复出
 * `failed`。修复前 `undo` 那一步还会让 `failures` 再 +1。
 */
describe('applyRequest：failures 的口径（被拒绝 + 执行类动作推进到 failed）', () => {
  /** `leave` → `ret`：栈槽为 0，ip 跳到未映射的 0 → `invalid_ip`，`step` 把实例推进到 failed。 */
  const FAIL_CODE = code(0x19, 0x18);
  const INVALID_IP = { code: 'invalid_ip', addr: 0n, detail: '取指地址未映射' };
  const BAD_OPCODE_AT_1000 = {
    code: 'invalid_instruction',
    addr: 0x1000n,
    detail: '未命中编码表的 opcode 0xee',
  };

  it('undo 恢复出 failed 状态：failures 不变，executed / history 仍按契约', () => {
    const { instance } = start({ code: FAIL_CODE });

    const failed = instance.applyRequest([{ type: 'step', count: 3 }]);
    expect(failed.results).toEqual([{ ok: true, action: 'step', error: INVALID_IP }]);
    expect(failed.state.status).toBe('failed');
    expect(failed.state.steps).toBe(2);
    expect(failed.executed).toBe(1);
    expect(failed.failures).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 3 });

    // reset 把当前的 failed 状态压进撤销栈（04 §3：reset 自己可被撤销）。
    const reset = instance.applyRequest([{ type: 'reset' }]);
    expect(reset.results).toEqual([{ ok: true, action: 'reset' }]);
    expect(reset.state.status).toBe('ready');
    expect(reset.failures).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 2, stepBack: 0 });

    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(undone.results).toEqual([{ ok: true, action: 'undo' }]);
    expect(undone.state.status).toBe('failed');
    expect(undone.state.error).toEqual(INVALID_IP);
    expect(undone.state.steps).toBe(2);
    expect(undone.executed).toBe(1);
    // 修复点：undo 自己成功了，只是把 failed 状态搬了回来，不算「推进到 failed」。
    expect(undone.failures).toBe(1);
    expect(instance.failures()).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 0 });

    // 回退之后 failures 仍只由真实事件推动：这次 step_back 是历史为空的**被拒绝**回退，
    // 计一次失败的理由是「被拒绝」，不是回退动作本身，也没有为 failed 状态额外 +1。
    const rejected = instance.applyRequest([{ type: 'step_back' }]);
    expect(rejected.results).toEqual([
      { ok: false, action: 'step_back', error: { code: 'empty_history' } },
    ]);
    expect(rejected.state.status).toBe('failed');
    expect(rejected.executed).toBe(0);
    expect(rejected.failures).toBe(2);
  });

  it('step_back 回退失败现场：failures 不被回退动作虚增', () => {
    const { instance } = start({ code: FAIL_CODE });
    const failed = instance.applyRequest([{ type: 'step', count: 3 }]);
    expect(failed.state.status).toBe('failed');
    expect(failed.failures).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 3 });

    // 指令层条目一律压在该条指令**取指前**，而 failed 之后不再取指（`stepOnce` 先看 status），
    // 所以环形缓冲里不存在 failed 快照：这里退掉的是取指失败前的那一步现场。
    const back = instance.applyRequest([{ type: 'step_back' }]);
    expect(back.results).toEqual([{ ok: true, action: 'step_back' }]);
    expect(back.state.status).toBe('ready');
    expect(back.state.error).toBeUndefined();
    expect(back.state.steps).toBe(2);
    expect(readRegister(back.state, 'RIP')).toBe(0n);
    expect(back.executed).toBe(1);
    expect(back.failures).toBe(1);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 2 });

    const backAgain = instance.applyRequest([{ type: 'step_back' }]);
    expect(backAgain.state.status).toBe('ready');
    expect(backAgain.state.steps).toBe(1);
    expect(readRegister(backAgain.state, 'RIP')).toBe(0x1001n);
    expect(backAgain.failures).toBe(1);
  });

  it('reset 后可 undo 撤销回 failed：failures 轨迹单调，且不被回退动作虚增', () => {
    const { instance } = start({ code: FAIL_CODE });
    const trace: number[] = [];

    trace.push(instance.applyRequest([{ type: 'step', count: 3 }]).failures);
    trace.push(instance.applyRequest([{ type: 'reset' }]).failures);
    const undone = instance.applyRequest([{ type: 'undo' }]);
    trace.push(undone.failures);
    trace.push(instance.applyRequest([{ type: 'reset' }]).failures);
    const failedAgain = instance.applyRequest([{ type: 'step', count: 3 }]);
    trace.push(failedAgain.failures);

    // 只有两次真正的「执行类动作推进到 failed」各 +1，中间的 reset / undo 一次都没加。
    expect(trace).toEqual([1, 1, 1, 1, 2]);
    expect(undone.state.status).toBe('failed');
    expect(failedAgain.state.status).toBe('failed');
    for (let i = 1; i < trace.length; i += 1) {
      expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1] as number);
    }
  });

  it('step 触发运行期异常：failures 恰好 +1', () => {
    const { instance } = start({ code: code(0xee) });
    const outcome = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'step', error: BAD_OPCODE_AT_1000 }]);
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.steps).toBe(0);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(1);

    // 撤销这次失败（状态回到 ready）不减少 failures，也不额外增加。
    const undone = instance.applyRequest([{ type: 'undo' }]);
    expect(undone.state.status).toBe('ready');
    expect(undone.failures).toBe(1);

    // 再失败一次才是第二次：每次执行类失败恰好 +1。
    const again = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(again.state.status).toBe('failed');
    expect(again.failures).toBe(2);
  });

  it('run 触发运行期异常：failures 恰好 +1', () => {
    const { instance } = start({ code: code(0x90, 0xee) });
    const outcome = instance.applyRequest([{ type: 'run' }]);
    expect(outcome.results).toEqual([
      {
        ok: true,
        action: 'run',
        error: { code: 'invalid_instruction', addr: 0x1001n, detail: '未命中编码表的 opcode 0xee' },
      },
    ]);
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.steps).toBe(1);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(1);
  });

  it('命中失败谓词进入 failed：failures 恰好 +1，且不是运行期异常', () => {
    // syscall exit 未置 FLAG → 命中题目默认的 fail 谓词（03 §2.1：fail 优先于 win）。
    const { instance } = start({ code: code(0x1c) });
    const outcome = instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'step' }]);
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.error).toBeUndefined();
    expect(outcome.state.lastStop).toEqual({ reason: 'exception', addr: 0x1000n });
    expect(outcome.state.steps).toBe(1);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(1);
  });

  it('被拒绝的动作计一次失败，回退类动作不叠加', () => {
    const { instance } = start();
    const rejected = instance.applyRequest([{ type: 'write_bytes', addr: '0x4000', hex: '00' }]);
    expect(rejected.results).toEqual([
      {
        ok: false,
        action: 'write_bytes',
        error: { code: 'hidden_address', addr: 0x4000n, detail: '区间落在隐藏 VMA 内（长度 1）' },
      },
    ]);
    expect(rejected.executed).toBe(0);
    expect(rejected.failures).toBe(1);

    // 成功的回退类动作不加。
    const reset = instance.applyRequest([{ type: 'reset' }]);
    expect(reset.results).toEqual([{ ok: true, action: 'reset' }]);
    expect(reset.failures).toBe(1);

    // 再拒绝一次 → 第二次。
    const rejectedAgain = instance.applyRequest([{ type: 'write_bytes', addr: '0x5000', hex: '00' }]);
    expect(rejectedAgain.results).toEqual([
      {
        ok: false,
        action: 'write_bytes',
        error: { code: 'inaccessible_address', addr: 0x5000n, detail: '区间未映射或权限不足（需要写，长度 1）' },
      },
    ]);
    expect(rejectedAgain.failures).toBe(2);
  });

  it('批量里执行类动作推进到 failed：只 +1，后续动作不执行', () => {
    const { env, instance } = start({ code: code(0xee) });
    const outcome = instance.applyRequest([{ type: 'step', count: 1 }, WRITE_AA, WRITE_BB]);
    expect(outcome.results).toEqual([{ ok: true, action: 'step', error: BAD_OPCODE_AT_1000 }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(1);
    expect(instance.failures()).toBe(1);
    // 后续两个写动作一个都没落地。
    expect(hexAt(env, instance, DATA_START, 2)).toBe('0000');
  });

  it('回退类动作恢复出 failed 后同批后续动作仍不执行（break 现状不变）且不计失败', () => {
    const { env, instance } = start({ code: FAIL_CODE });
    instance.applyRequest([{ type: 'step', count: 3 }]);

    const outcome = instance.applyRequest([{ type: 'reset' }, { type: 'undo' }, WRITE_AA]);
    expect(outcome.results).toEqual([
      { ok: true, action: 'reset' },
      { ok: true, action: 'undo' },
    ]);
    expect(outcome.state.status).toBe('failed');
    expect(outcome.executed).toBe(2);
    expect(outcome.failures).toBe(1);
    expect(hexAt(env, instance, DATA_START, 1)).toBe('00');
  });

  it('block 内部执行指令推进到 failed：按执行类动作计一次失败', () => {
    const kit = testKit({
      code: code(0xee),
      authorBlocks: [
        { id: 'boom', label: '执行一条指令', params: [], expand: [{ type: 'step', count: 1 }] },
      ],
    });
    const instance = createDebugInstance(kit.env);
    const outcome = instance.applyRequest([{ type: 'block', id: 'boom', args: {} }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'block', error: BAD_OPCODE_AT_1000 }]);
    expect(outcome.state.status).toBe('failed');
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(1);
  });
});

describe('applyRequest：回退到指令级', () => {
  it('step_back 回到上一条指令之前，且不压栈', () => {
    const { instance } = start({ code: code(0x90, 0x90) });
    instance.applyRequest([{ type: 'step', count: 2 }]);
    expect(instance.state().steps).toBe(2);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1002n);

    const back = instance.applyRequest([{ type: 'step_back' }]);
    expect(back.results).toEqual([{ ok: true, action: 'step_back' }]);
    expect(back.state.steps).toBe(1);
    expect(readRegister(back.state, 'RIP')).toBe(0x1001n);
    expect(instance.historyDepth()).toEqual({ undo: 1, stepBack: 1 });
  });

  it('step 动作默认执行一条指令', () => {
    const { instance } = start({ code: code(0x90, 0x90) });
    const outcome = instance.applyRequest([{ type: 'step' }]);
    expect(outcome.state.steps).toBe(1);
    expect(readRegister(outcome.state, 'RIP')).toBe(0x1001n);
  });

  it('run 动作跑到 maxSteps 上限后停下（stop = limit），仍算成功执行', () => {
    const { instance } = start({ code: code(0x90, 0x90, 0x90) });
    const outcome = instance.applyRequest([{ type: 'run', maxSteps: 2 }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'run' }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.state.steps).toBe(2);
    expect(outcome.state.status).toBe('ready');
  });

  it('run 动作跑出异常时算已执行但状态进入 failed', () => {
    const { instance } = start({ code: code(0x90, 0xee) });
    const outcome = instance.applyRequest([{ type: 'run' }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(outcome.results[0]?.error?.code).toBe('invalid_instruction');
    expect(outcome.failures).toBe(1);
  });

  it('step_back 只回退内存与寄存器，回退过的指令可以重新执行', () => {
    const { env, instance } = start({ code: code(0x04, p64(0x8n)), initRegisters: { RAX: '0x77' } });
    instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(memoryWord(env.memory, instance.state().memory, 0x3808n)).toBe(0x77n);

    instance.applyRequest([{ type: 'step_back' }]);
    expect(memoryWord(env.memory, instance.state().memory, 0x3808n)).toBe(0n);

    instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(memoryWord(env.memory, instance.state().memory, 0x3808n)).toBe(0x77n);
  });

  it('指令缓冲窗口默认为 64 条', () => {
    const { instance } = start();
    expect(instance.historyDepth().stepBack).toBe(0);
    instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(instance.historyDepth().stepBack).toBe(1);
  });

  it('指令缓冲按 stepBackWindow 截断', () => {
    const { instance } = start({ code: code(0x90, 0x90, 0x90), limits: { stepBackWindow: 2 } });
    instance.applyRequest([{ type: 'step', count: 3 }]);
    expect(instance.historyDepth().stepBack).toBe(2);

    expect(readRegister(instance.applyRequest([{ type: 'step_back' }]).state, 'RIP')).toBe(0x1002n);
    expect(readRegister(instance.applyRequest([{ type: 'step_back' }]).state, 'RIP')).toBe(0x1001n);
    expect(instance.applyRequest([{ type: 'step_back' }]).results[0]?.error?.code).toBe('empty_history');
  });

  it('reset 清空指令缓冲', () => {
    const { instance } = start({ code: code(0x90) });
    instance.applyRequest([{ type: 'step', count: 1 }]);
    expect(instance.historyDepth().stepBack).toBe(1);
    instance.applyRequest([{ type: 'reset' }]);
    expect(instance.historyDepth().stepBack).toBe(0);
  });
});

describe('applyRequest：栈动作、stdin 与出题积木', () => {
  it('push 动作把值压到栈上', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'push', value: '0x1122334455667788' }]);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(readRegister(instance.state(), 'RSP')).toBe(0x37f8n);
    expect(memoryWord(env.memory, instance.state().memory, 0x37f8n)).toBe(0x1122334455667788n);
  });

  it('pop 动作抬高 RSP（04 §2 未定义目标寄存器，当前丢弃弹出的值）', () => {
    const { instance } = start();
    instance.applyRequest([{ type: 'write_bytes', addr: '0x3800', hex: p64(0x99n) }]);
    const outcome = instance.applyRequest([{ type: 'pop' }]);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(readRegister(instance.state(), 'RSP')).toBe(0x3808n);
    expect(readRegister(instance.state(), 'RAX')).toBe(0n);
  });

  it('pop 动作在栈不可读时被拒绝（04 §2：先做区间校验）', () => {
    const kit = testKit({ initRegisters: { RSP: '0x9000' } });
    const other = createDebugInstance(kit.env);
    const outcome = other.applyRequest([{ type: 'pop' }]);
    expect(outcome.results[0]?.error?.code).toBe('inaccessible_address');
    expect(outcome.results[0]?.error?.addr).toBe(0x9000n);
  });

  it('pop 动作在栈落在隐藏区时被拒绝（否则会变成读隐藏内容的通道）', () => {
    const kit = testKit({ initRegisters: { RSP: '0x4000' } });
    const other = createDebugInstance(kit.env);
    expect(other.applyRequest([{ type: 'pop' }]).results[0]?.error?.code).toBe('hidden_address');
  });

  it('call 动作压入当前 RIP 作为返回地址', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'call', addr: '0x1234' }]);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1234n);
    expect(readRegister(instance.state(), 'RSP')).toBe(0x37f8n);
  });

  it('ret 动作从栈上取下一个 RIP', () => {
    const { instance } = start();
    instance.applyRequest([{ type: 'write_bytes', addr: '0x3800', hex: p64(0x2222n) }]);
    const outcome = instance.applyRequest([{ type: 'ret' }]);
    expect(outcome.results[0]?.ok).toBe(true);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x2222n);
    expect(readRegister(instance.state(), 'RSP')).toBe(0x3808n);
  });

  it('feed 追加 stdin 字节', () => {
    const { env, instance } = start();
    instance.applyRequest([{ type: 'feed', hex: '4142' }]);
    const state = instance.state();
    expect([...state.stdin.bytes]).toEqual([0x41, 0x42]);
    expect(state.stdin.pos).toBe(0);
    expect(env.memory).toBeDefined();
  });

  it('feed 超过 4KB 上限被拒且 stdin 不变', () => {
    const { instance } = start();
    instance.applyRequest([{ type: 'feed', hex: '41' }]);
    const tooLong = '42'.repeat(4097);
    const outcome = instance.applyRequest([{ type: 'feed', hex: tooLong }]);
    expect(outcome.results[0]?.error?.code).toBe('stdin_overflow');
    expect([...instance.state().stdin.bytes]).toEqual([0x41]);
  });

  it('出题积木 setip 展开成 call，且整块可撤销', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'block', id: 'setip', args: { addr: '0x1234' } }]);
    expect(outcome.results).toEqual([{ ok: true, action: 'block' }]);
    expect(outcome.executed).toBe(1);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1234n);

    instance.applyRequest([{ type: 'undo' }]);
    expect(readRegister(instance.state(), 'RIP')).toBe(0x1000n);
    expect(readRegister(instance.state(), 'RSP')).toBe(0x3800n);
  });

  it('未知积木 id → unknown_action', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'block', id: 'nope', args: {} }]);
    expect(outcome.results[0]?.error?.code).toBe('unknown_action');
  });

  it('积木参数不合法 → invalid_arguments', () => {
    const { instance } = start();
    const outcome = instance.applyRequest([{ type: 'block', id: 'setip', args: {} }]);
    expect(outcome.results[0]?.error?.code).toBe('invalid_arguments');
  });

  it('积木内部被拒绝时整块回滚', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'block', id: 'leak', args: { data: '00' } }]);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(memoryHex(env.memory, instance.state().memory, HIDDEN_START, 2)).toBe('aabb');
    expect(instance.historyDepth().undo).toBe(0);
  });
});

describe('state()：返回的状态可以安全长期持有', () => {
  it('调用方拿到的状态不会被后续请求改写', () => {
    const { env, instance } = start();
    const before = instance.state();
    instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: 'ff' }]);

    expect(memoryHex(env.memory, before.memory, DATA_START, 1)).toBe('00');
    expect(memoryHex(env.memory, instance.state().memory, DATA_START, 1)).toBe('ff');
  });

  it('applyRequest 返回的状态同样独立', () => {
    const { env, instance } = start();
    const first = instance.applyRequest([WRITE_AA]);
    instance.applyRequest([WRITE_BB]);
    expect(memoryHex(env.memory, first.state.memory, DATA_START, 2)).toBe('aa00');
    expect(memoryHex(env.memory, instance.state().memory, DATA_START, 2)).toBe('aabb');
  });
});
