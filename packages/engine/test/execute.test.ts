import { describe, expect, it } from 'vitest';
import { bytesToBigIntLE, bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { VmState } from '@pwn2block/shared';
import { createInitialState } from '../src/env';
import type { EngineEnv } from '../src/env';
import { runState, stepOnce, stepState } from '../src/execute';
import { readRegister, withStatus } from '../src/state';
import type { TestChallengeOptions } from './helpers/challenge';
import { code, p32, p64, testKit } from './helpers/challenge';

const STACK_SLOT = 0x37f8n;

interface Harness {
  readonly env: EngineEnv;
  readonly state: VmState;
}

function start(codeHex: string, options: TestChallengeOptions = {}): Harness {
  const kit = testKit({ code: codeHex, ...options });
  return { env: kit.env, state: createInitialState(kit.env) };
}

/** 测试里摆内存用：直接写进当前状态的内存句柄。 */
function poke(env: EngineEnv, state: VmState, addr: bigint, hexStr: string): VmState {
  const result = env.memory.write(state.memory, addr, hexToBytes(hexStr));
  if (!result.ok) throw new Error(`poke 失败：${hexStr} → 0x${addr.toString(16)}`);
  return state;
}

function word(env: EngineEnv, state: VmState, addr: bigint, len = 8): bigint {
  const result = env.memory.read(state.memory, addr, len);
  if (!result.ok) throw new Error(`读取 0x${addr.toString(16)} 失败`);
  return bytesToBigIntLE(result.bytes);
}

function bytesAt(env: EngineEnv, state: VmState, addr: bigint, len: number): string {
  const result = env.memory.read(state.memory, addr, len);
  if (!result.ok) throw new Error(`读取 0x${addr.toString(16)} 失败`);
  return bytesToHex(result.bytes);
}

function reg(state: VmState, name: string): bigint {
  return readRegister(state, name);
}

describe('stepOnce：取指与推进', () => {
  it('nop 让 RIP 前进 1，steps +1，stop = step', () => {
    const { env, state } = start(code(0x90));
    const outcome = stepOnce(env, state);
    expect(outcome.executed).toBe(1);
    expect(outcome.stop).toBe('step');
    expect(outcome.state.status).toBe('ready');
    expect(outcome.state.steps).toBe(1);
    expect(reg(outcome.state, 'RIP')).toBe(0x1001n);
    expect(outcome.error).toBeUndefined();
  });

  it('mov RAX, imm 前进整个指令长度（1 + 8）', () => {
    const { env, state } = start(code(0x01, p64(0x10n)));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0x10n);
    expect(reg(outcome.state, 'RIP')).toBe(0x1009n);
  });

  it('32 位题目里立即数是 4 字节，RIP 前进 5', () => {
    const { env, state } = start(code(0x01, p32(0x11223344n)), { archBits: 32 });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0x11223344n);
    expect(reg(outcome.state, 'RIP')).toBe(0x1005n);
    expect(outcome.state.exitCode).toBeUndefined();
  });

  it('mov 不动标志位', () => {
    const { env, state } = start(code(0x01, p64(0x1n)));
    const outcome = stepOnce(env, state);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: false, SF: false });
  });
});

describe('stepOnce：算术与标志', () => {
  it('add 产生进位：0xffffffffffffffff + 1 = 0，CF/ZF 置位，SF 清零', () => {
    const { env, state } = start(code(0x08, p64(1n)), {
      initRegisters: { RAX: '0xffffffffffffffff' },
    });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0n);
    expect(outcome.state.flags).toEqual({ ZF: true, CF: true, SF: false });
  });

  it('add 无进位：0x10 + 0x20 = 0x30', () => {
    const { env, state } = start(code(0x08, p64(0x20n)), { initRegisters: { RAX: '0x10' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0x30n);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: false, SF: false });
  });

  it('add 结果最高位为 1 时置 SF', () => {
    const { env, state } = start(code(0x08, p64(1n)), {
      initRegisters: { RAX: '0x7fffffffffffffff' },
    });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0x8000000000000000n);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: false, SF: true });
  });

  it('sub 借位：0 - 1 = 0xffffffffffffffff，CF/SF 置位', () => {
    const { env, state } = start(code(0x0a, p64(1n)));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0xffffffffffffffffn);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: true, SF: true });
  });

  it('sub 相等：5 - 5 = 0，ZF 置位且 CF 清零', () => {
    const { env, state } = start(code(0x0a, p64(5n)), { initRegisters: { RAX: '0x5' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0n);
    expect(outcome.state.flags).toEqual({ ZF: true, CF: false, SF: false });
  });

  it('cmp 只置标志，不回写寄存器', () => {
    const { env, state } = start(code(0x0b, p64(5n)), { initRegisters: { RAX: '0x5' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(5n);
    expect(outcome.state.flags).toEqual({ ZF: true, CF: false, SF: false });
  });

  it('and / or / xor 只改 ZF、SF，保留 CF', () => {
    const { env, state } = start(
      code(0x08, p64(1n), 0x0c, p64(0xfn), 0x0e, p64(0xf0n), 0x0d, p64(0xfn)),
      { initRegisters: { RAX: '0xffffffffffffffff' } },
    );
    const added = stepOnce(env, state);
    expect(added.state.flags).toEqual({ ZF: true, CF: true, SF: false });

    const anded = stepOnce(env, added.state);
    expect(reg(anded.state, 'RAX')).toBe(0n);
    expect(anded.state.flags).toEqual({ ZF: true, CF: true, SF: false });

    const ored = stepOnce(env, anded.state);
    expect(reg(ored.state, 'RAX')).toBe(0xf0n);
    expect(ored.state.flags).toEqual({ ZF: false, CF: true, SF: false });

    const xored = stepOnce(env, ored.state);
    expect(reg(xored.state, 'RAX')).toBe(0xffn);
    expect(xored.state.flags).toEqual({ ZF: false, CF: true, SF: false });
  });

  it('移位量对位宽取模：shl 1, 65 → 2（65 % 64）', () => {
    const { env, state } = start(code(0x0f, p64(65n)), { initRegisters: { RAX: '0x1' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(2n);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: false, SF: false });
  });

  it('shr 逻辑右移，CF 不被修改', () => {
    const { env, state } = start(code(0x10, p64(63n)), {
      initRegisters: { RAX: '0x8000000000000000' },
    });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(1n);
    expect(outcome.state.flags).toEqual({ ZF: false, CF: false, SF: false });
  });

  it('add RAX, [RBP+disp] 走内存操作数', () => {
    const { env, state } = start(code(0x1e, p64(8n)), { initRegisters: { RAX: '0x3' } });
    poke(env, state, 0x3808n, p64(2n));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(5n);
  });
});

describe('stepOnce：栈与函数调用', () => {
  it('push imm：RSP - 8，值小端落在栈上', () => {
    const { env, state } = start(code(0x06, p64(0x1122334455667788n)));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RSP')).toBe(STACK_SLOT);
    expect(bytesAt(env, outcome.state, STACK_SLOT, 8)).toBe('8877665544332211');
  });

  it('push reg 推寄存器的当前值', () => {
    const { env, state } = start(code(0x05), { initRegisters: { RAX: '0xabc' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RSP')).toBe(STACK_SLOT);
    expect(word(env, outcome.state, STACK_SLOT)).toBe(0xabcn);
  });

  it('32 位题目里 push 只减 4', () => {
    const { env, state } = start(code(0x05), { archBits: 32, initRegisters: { RAX: '0xabc' } });
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RSP')).toBe(0x37fcn);
    expect(word(env, outcome.state, 0x37fcn, 4)).toBe(0xabcn);
  });

  it('pop reg：读栈顶并抬高 RSP', () => {
    const { env, state } = start(code(0x07));
    poke(env, state, 0x3800n, p64(0xdeadn));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0xdeadn);
    expect(reg(outcome.state, 'RSP')).toBe(0x3808n);
  });

  it('call imm 压当前 RIP + 长度 作为返回地址', () => {
    const { env, state } = start(code(0x17, p64(0x1234n)));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RIP')).toBe(0x1234n);
    expect(reg(outcome.state, 'RSP')).toBe(STACK_SLOT);
    expect(word(env, outcome.state, STACK_SLOT)).toBe(0x1009n);
  });

  it('ret 弹出返回地址（ROP：允许没有配对 call）', () => {
    const { env, state } = start(code(0x18));
    poke(env, state, 0x3800n, p64(0x2222n));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RIP')).toBe(0x2222n);
    expect(reg(outcome.state, 'RSP')).toBe(0x3808n);
  });

  it('leave：RSP = RBP + W，RBP = [RBP]', () => {
    const { env, state } = start(code(0x19), { initRegisters: { RBP: '0x3800' } });
    poke(env, state, 0x3800n, p64(0x9999n));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RSP')).toBe(0x3808n);
    expect(reg(outcome.state, 'RBP')).toBe(0x9999n);
  });

  it('mov [RBP+disp], RAX 把寄存器写进栈', () => {
    const { env, state } = start(code(0x04, p64(0x10n)), {
      initRegisters: { RAX: '0x1122334455667788' },
    });
    const outcome = stepOnce(env, state);
    expect(bytesAt(env, outcome.state, 0x3810n, 8)).toBe('8877665544332211');
  });

  it('mov RAX, [RBP+disp] 从内存读', () => {
    const { env, state } = start(code(0x03, p64(0x8n)));
    poke(env, state, 0x3808n, p64(0x55n));
    const outcome = stepOnce(env, state);
    expect(reg(outcome.state, 'RAX')).toBe(0x55n);
  });
});

describe('stepOnce：跳转与条件', () => {
  it('jmp imm 直接改 RIP', () => {
    const { env, state } = start(code(0x11, p64(0x1500n)));
    expect(reg(stepOnce(env, state).state, 'RIP')).toBe(0x1500n);
  });

  it('jmp reg 用寄存器值', () => {
    const { env, state } = start(code(0x12), { initRegisters: { RAX: '0x1600' } });
    expect(reg(stepOnce(env, state).state, 'RIP')).toBe(0x1600n);
  });

  it('je 在 ZF = 1 时跳转', () => {
    const { env, state } = start(code(0x0b, p64(0n), 0x13, p64(0x1400n)));
    const compared = stepOnce(env, state);
    expect(compared.state.flags.ZF).toBe(true);
    expect(reg(compared.state, 'RIP')).toBe(0x1009n);
    expect(reg(stepOnce(env, compared.state).state, 'RIP')).toBe(0x1400n);
  });

  it('je 在 ZF = 0 时不跳转，只前进指令长度', () => {
    const { env, state } = start(code(0x0b, p64(0n), 0x13, p64(0x1400n)), {
      initRegisters: { RAX: '0x5' },
    });
    const compared = stepOnce(env, state);
    expect(compared.state.flags.ZF).toBe(false);
    expect(reg(stepOnce(env, compared.state).state, 'RIP')).toBe(0x1012n);
  });

  it('jne 在 ZF = 0 时跳转', () => {
    const { env, state } = start(code(0x0b, p64(0n), 0x14, p64(0x1400n)), {
      initRegisters: { RAX: '0x5' },
    });
    const compared = stepOnce(env, state);
    expect(reg(stepOnce(env, compared.state).state, 'RIP')).toBe(0x1400n);
  });

  it('jb 在 CF = 1 时跳转，jae 在 CF = 0 时跳转', () => {
    const below = start(code(0x0a, p64(1n), 0x15, p64(0x1300n)));
    const borrowed = stepOnce(below.env, below.state);
    expect(borrowed.state.flags.CF).toBe(true);
    expect(reg(stepOnce(below.env, borrowed.state).state, 'RIP')).toBe(0x1300n);

    const above = start(code(0x0a, p64(1n), 0x16, p64(0x1300n)), {
      initRegisters: { RAX: '0x5' },
    });
    const noBorrow = stepOnce(above.env, above.state);
    expect(noBorrow.state.flags.CF).toBe(false);
    expect(reg(stepOnce(above.env, noBorrow.state).state, 'RIP')).toBe(0x1300n);
  });
});

describe('stepOnce：异常映射与“不留半截效果”', () => {
  it('RIP 落在未映射区间 → invalid_ip', () => {
    const { env, state } = start(code(0x90), { initRegisters: { RIP: '0x9000' } });
    const outcome = stepOnce(env, state);
    expect(outcome.executed).toBe(0);
    expect(outcome.stop).toBe('exception');
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.error?.code).toBe('invalid_ip');
    expect(outcome.state.error?.addr).toBe(0x9000n);
    expect(outcome.state.lastStop).toEqual({ reason: 'exception', addr: 0x9000n });
    expect(outcome.state.steps).toBe(0);
  });

  it('RIP 落在已映射但不可执行的区间 → invalid_ip（不泄露内容）', () => {
    const { env, state } = start(code(0x90), { initRegisters: { RIP: '0x2000' } });
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('invalid_ip');
    expect(outcome.state.error?.detail).toContain('不可执行');
  });

  it('opcode 不在编码表 → invalid_instruction', () => {
    const { env, state } = start(code(0xee));
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('invalid_instruction');
    expect(outcome.state.error?.addr).toBe(0x1000n);
    expect(outcome.state.steps).toBe(0);
  });

  it('指令被 VMA 边界截断 → invalid_instruction，不读跨界字节', () => {
    // 编码表里 `mov RAX, imm` 是 1 + 8 字节，但 `01` 落在 code 区最后一字节
    const { env, state } = start(code(0x01), {
      codeAt: '0x1fff',
      initRegisters: { RIP: '0x1fff' },
    });
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('invalid_instruction');
    expect(outcome.state.error?.addr).toBe(0x1fffn);
    expect(outcome.state.error?.detail).toContain('内联操作数');
    expect(outcome.state.steps).toBe(0);
  });

  it('pop 读到未映射地址 → memory_fault，且 RSP 不变', () => {
    const { env, state } = start(code(0x07), { initRegisters: { RSP: '0x9000' } });
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('memory_fault');
    expect(outcome.state.error?.addr).toBe(0x9000n);
    expect(reg(outcome.state, 'RSP')).toBe(0x9000n);
    expect(outcome.state.steps).toBe(0);
  });

  it('push 写只读区 → memory_fault，内存与 RSP 都不变', () => {
    const { env, state } = start(code(0x06, p64(0x1122n)), { initRegisters: { RSP: '0x5008' } });
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('memory_fault');
    expect(reg(outcome.state, 'RSP')).toBe(0x5008n);
    const untouched = env.memory.read(outcome.state.memory, 0x5000n, 4);
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(bytesToHex(untouched.bytes)).toBe('00000000');
  });

  it('syscall 调用号未知 → invalid_instruction', () => {
    const { env, state } = start(code(0x1a), { initRegisters: { RAX: '0x7' } });
    const outcome = stepOnce(env, state);
    expect(outcome.state.error?.code).toBe('invalid_instruction');
    expect(outcome.state.error?.detail).toContain('调用号 7');
  });

  it('已失败的实例不再执行', () => {
    const { env, state } = start(code(0x90));
    const failed = withStatus(state, 'failed');
    const outcome = stepOnce(env, failed);
    expect(outcome.executed).toBe(0);
    expect(outcome.stop).toBe('exception');
    expect(outcome.state.steps).toBe(0);
  });

  it('已退出的实例不再执行', () => {
    const { env, state } = start(code(0x90));
    const outcome = stepOnce(env, withStatus(state, 'exited'));
    expect(outcome.executed).toBe(0);
    expect(outcome.stop).toBe('exit');
  });

  it('已退出但 status 是 satisfied 的实例也不再执行（判胜那一刻程序已经结束）', () => {
    // syscall win：置 FLAG 并退出 → 同时满足 win 与「已退出」，status 记 satisfied。
    const { env, state } = start(code(0x1b, 0xee));
    const won = stepOnce(env, state);
    expect(won.state.status).toBe('satisfied');
    expect(won.state.lastStop).toEqual({ reason: 'exit', addr: 0x1000n });
    expect(reg(won.state, 'FLAG')).toBe(1n);

    // 修复点：判据是 `isExited` 而不是 `status === 'exited'`，这里必须停，不能再取指 0xee。
    const blocked = stepOnce(env, won.state);
    expect(blocked.executed).toBe(0);
    expect(blocked.stop).toBe('exit');
    expect(blocked.state.status).toBe('satisfied');
    expect(blocked.state.error).toBeUndefined();
    expect(blocked.state.steps).toBe(1);
    expect(reg(blocked.state, 'RIP')).toBe(0x1001n);
    expect(reg(blocked.state, 'FLAG')).toBe(1n);
  });
});

describe('stepOnce：syscall', () => {
  it('custom 效果的 exit：置 FLAG 后退出，状态转 satisfied，stop = exit', () => {
    const { env, state } = start(code(0x1b));
    const outcome = stepOnce(env, state);
    expect(outcome.executed).toBe(1);
    expect(outcome.stop).toBe('exit');
    expect(outcome.state.status).toBe('satisfied');
    expect(reg(outcome.state, 'FLAG')).toBe(1n);
    expect(outcome.state.lastStop).toEqual({ reason: 'exit', addr: 0x1000n });
    expect(outcome.state.error).toBeUndefined();
  });

  it('exit syscall 的退出码取第一个参数（RBX），但判负优先于退出', () => {
    const { env, state } = start(code(0x1c), { initRegisters: { RBX: '0x2a' } });
    const outcome = stepOnce(env, state);
    expect(outcome.state.exitCode).toBe(0x2an);
    // shared 的 VmState.exitCode 是唯一出处（A 已补进契约，引擎不再多挂自由字段）
    expect(outcome.state.exitCode).toBe(0x2an);
    // 默认 fail 谓词是「已退出且没置 FLAG」，所以判负压过退出：stop 记为 exception
    expect(outcome.state.status).toBe('failed');
    expect(outcome.stop).toBe('exception');
    expect(outcome.state.error).toBeUndefined();
    expect(outcome.state.lastStop?.reason).toBe('exception');
  });

  it('退出码按位宽掩蔽后写进 exitCode', () => {
    const { env, state } = start(code(0x1c), {
      archBits: 32,
      initRegisters: { RBX: '0x10000002a' },
    });
    expect(stepOnce(env, state).state.exitCode).toBe(0x2an);
  });

  it('没有 fail 谓词时，退出即 exited', () => {
    const { env, state } = start(code(0x1c), { fail: [] });
    const outcome = stepOnce(env, state);
    expect(outcome.state.status).toBe('exited');
    expect(outcome.stop).toBe('exit');
    expect(outcome.state.error).toBeUndefined();
  });

  it('read / write syscall 在 D1 由 G02 提供宿主，当前显式报错而不是静默成功', () => {
    const { env, state } = start(code(0x1a), { initRegisters: { RAX: '0x1' } });
    expect(() => stepOnce(env, state)).toThrow(/G02/);
  });
});

describe('stepState / runState', () => {
  it('连续执行 3 条 nop，steps 与 RIP 精确推进', () => {
    const { env, state } = start(code(0x90, 0x90, 0x90));
    const outcome = stepState(env, state, 3);
    expect(outcome.executed).toBe(3);
    expect(outcome.state.steps).toBe(3);
    expect(reg(outcome.state, 'RIP')).toBe(0x1003n);
    expect(outcome.stop).toBe('step');
  });

  it('遇到退出就提前结束，不执行多余指令', () => {
    const { env, state } = start(code(0x1b, 0x90, 0x90));
    const outcome = stepState(env, state, 5);
    expect(outcome.executed).toBe(1);
    expect(outcome.state.steps).toBe(1);
    expect(outcome.stop).toBe('exit');
    expect(outcome.state.status).toBe('satisfied');
  });

  it('遇到异常就提前结束', () => {
    const { env, state } = start(code(0x90, 0xee, 0x90));
    const outcome = stepState(env, state, 3);
    expect(outcome.executed).toBe(1);
    expect(outcome.stop).toBe('exception');
    expect(outcome.state.error?.code).toBe('invalid_instruction');
  });

  it('步数上限超出单次 run 限制 → resource_limit', () => {
    const { env, state } = start(code(0x90));
    const outcome = stepState(env, state, 10001);
    expect(outcome.state.error?.code).toBe('resource_limit');
    expect(outcome.state.status).toBe('failed');
    expect(outcome.executed).toBe(0);
    expect(outcome.state.steps).toBe(0);
    expect(outcome.stop).toBe('exception');
  });

  it('步数不是合法整数 → resource_limit', () => {
    const { env, state } = start(code(0x90));
    expect(stepState(env, state, 0).state.error?.code).toBe('resource_limit');
    expect(stepState(env, state, -1).state.error?.code).toBe('resource_limit');
    expect(stepState(env, state, 1.5).state.error?.code).toBe('resource_limit');
  });

  it('run 到达 maxSteps 只是暂停：stop = limit，没有错误', () => {
    const { env, state } = start(code(0x90, 0x90, 0x90));
    const outcome = runState(env, state, 2);
    expect(outcome.executed).toBe(2);
    expect(outcome.stop).toBe('limit');
    expect(outcome.state.status).toBe('ready');
    expect(outcome.state.error).toBeUndefined();
    expect(outcome.state.steps).toBe(2);
  });

  it('run 一直跑到退出', () => {
    const { env, state } = start(code(0x90, 0x1b));
    const outcome = runState(env, state, 100);
    expect(outcome.executed).toBe(2);
    expect(outcome.stop).toBe('exit');
    expect(outcome.state.status).toBe('satisfied');
  });

  it('run 的 maxSteps 超出上限 → resource_limit', () => {
    const { env, state } = start(code(0x90));
    const outcome = runState(env, state, 10001);
    expect(outcome.state.error?.code).toBe('resource_limit');
  });

  it('run 的 maxSteps 非法 → resource_limit', () => {
    const { env, state } = start(code(0x90));
    expect(runState(env, state, 0).state.error?.code).toBe('resource_limit');
    expect(runState(env, state, -5).state.error?.code).toBe('resource_limit');
  });

  it('执行不修改入参状态（内存句柄已 fork）', () => {
    const { env, state } = start(code(0x04, p64(0x8n)), { initRegisters: { RAX: '0x77' } });
    const outcome = stepState(env, state, 1);
    expect(reg(outcome.state, 'RAX')).toBe(0x77n);
    expect(word(env, outcome.state, 0x3808n)).toBe(0x77n);
    expect(word(env, state, 0x3808n)).toBe(0n);
    expect(state.steps).toBe(0);
  });
});
