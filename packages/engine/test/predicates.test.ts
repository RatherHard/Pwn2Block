import { describe, expect, it } from 'vitest';
import { NO_FLAGS } from '@pwn2block/shared';
import type { Predicate, VmState } from '@pwn2block/shared';
import { evaluatePredicate, evaluateVerdict } from '../src/predicates';
import { archMask, withExitCode } from '../src/state';
import { hex } from './helpers/fake-memory';

const MASK64 = archMask(64);

/** 谓词求值只读状态，不需要真实内存。 */
function stateOf(overrides: Partial<VmState> = {}): VmState {
  return {
    archBits: 64,
    registers: { RAX: 0x2an, FLAG: 0n },
    flags: NO_FLAGS,
    memory: { kind: 'cow-memory' },
    revealed: [],
    stdin: { bytes: new Uint8Array(0), pos: 0 },
    stdout: Uint8Array.from([0x68, 0x69, 0x0a]),
    fileOffsets: {},
    status: 'ready',
    steps: 0,
    ...overrides,
  };
}

const REG_IS_42: Predicate = { reg_eq: { reg: 'RAX', value: '0x2a' } };

describe('evaluatePredicate：reg_eq', () => {
  it('值相等时为 true', () => {
    expect(evaluatePredicate(REG_IS_42, { state: stateOf() })).toBe(true);
  });

  it('值不等时为 false', () => {
    expect(evaluatePredicate({ reg_eq: { reg: 'RAX', value: '0x2b' } }, { state: stateOf() })).toBe(false);
  });

  it('未列出的寄存器按 0 比较', () => {
    expect(evaluatePredicate({ reg_eq: { reg: 'RCX', value: '0x0' } }, { state: stateOf() })).toBe(true);
  });
});

describe('evaluatePredicate：mem_eq / mem_contains / stdout_contains', () => {
  it('mem_eq 精确比较字节', () => {
    const ctx = { state: stateOf(), readMemory: () => hex('deadbeef') };
    expect(evaluatePredicate({ mem_eq: { addr: '0x2000', hex: 'deadbeef' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ mem_eq: { addr: '0x2000', hex: 'deadbeee' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ mem_eq: { addr: '0x2000', hex: 'deadbe' } }, ctx)).toBe(false);
  });

  it('mem_eq 读不到（越权 / 未映射）时为 false，不抛错', () => {
    const ctx = { state: stateOf(), readMemory: () => undefined };
    expect(evaluatePredicate({ mem_eq: { addr: '0x2000', hex: 'dead' } }, ctx)).toBe(false);
  });

  it('mem_contains 在整个 VMA 里找子串', () => {
    const ctx = { state: stateOf(), readVma: () => hex('0011223344') };
    expect(evaluatePredicate({ mem_contains: { vma: 'data', hex: '1122' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ mem_contains: { vma: 'data', hex: '2233' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ mem_contains: { vma: 'data', hex: '4455' } }, ctx)).toBe(false);
  });

  it('mem_contains 在 VMA 不存在时为 false', () => {
    expect(
      evaluatePredicate({ mem_contains: { vma: 'nope', hex: '00' } }, { state: stateOf() }),
    ).toBe(false);
  });

  it('上下文没有读写器时（离线判题场景）涉及内存 / stdin 的谓词一律 false', () => {
    const ctx = { state: stateOf() };
    expect(evaluatePredicate({ mem_eq: { addr: '0x2000', hex: '00' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ mem_contains: { vma: 'data', hex: '00' } }, ctx)).toBe(false);
  });

  it('stdout_contains 只匹配 stdout 里的字节', () => {
    const ctx = { state: stateOf() };
    expect(evaluatePredicate({ stdout_contains: { hex: '6869' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ stdout_contains: { hex: '686a' } }, ctx)).toBe(false);
  });
});

describe('evaluatePredicate：exited', () => {
  it('status = exited 时为 true', () => {
    expect(evaluatePredicate({ exited: {} }, { state: stateOf({ status: 'exited' }) })).toBe(true);
  });

  it('程序已退出但状态显示 satisfied 时仍为 true（退出事实不能被抹掉）', () => {
    const state = stateOf({ status: 'satisfied', lastStop: { reason: 'exit', addr: 0x1000n } });
    expect(evaluatePredicate({ exited: {} }, { state })).toBe(true);
  });

  it('没退出时为 false', () => {
    const state = stateOf({ status: 'satisfied', lastStop: { reason: 'step', addr: 0x1000n } });
    expect(evaluatePredicate({ exited: {} }, { state })).toBe(false);
  });

  it('带 code 时要求退出码完全相等', () => {
    const exited = withExitCode(stateOf({ status: 'exited' }), 0x2an, MASK64);
    expect(evaluatePredicate({ exited: { code: '0x2a' } }, { state: exited })).toBe(true);
    expect(evaluatePredicate({ exited: { code: '0x2b' } }, { state: exited })).toBe(false);
  });

  it('引擎没有记录退出码时，带 code 的谓词判 false（不猜）', () => {
    expect(
      evaluatePredicate({ exited: { code: '0x0' } }, { state: stateOf({ status: 'exited' }) }),
    ).toBe(false);
  });
});

describe('evaluatePredicate：组合', () => {
  it('all / any / not 按语义求值', () => {
    const ctx = { state: stateOf() };
    const is42: Predicate = { reg_eq: { reg: 'RAX', value: '0x2a' } };
    const is43: Predicate = { reg_eq: { reg: 'RAX', value: '0x2b' } };
    expect(evaluatePredicate({ all: [is42, { not: is43 }] }, ctx)).toBe(true);
    expect(evaluatePredicate({ all: [is42, is43] }, ctx)).toBe(false);
    expect(evaluatePredicate({ any: [is43, is42] }, ctx)).toBe(true);
    expect(evaluatePredicate({ any: [is43] }, ctx)).toBe(false);
    expect(evaluatePredicate({ not: is43 }, ctx)).toBe(true);
  });
});

describe('evaluateVerdict：fail 优先于 win', () => {
  const win: Predicate = { reg_eq: { reg: 'FLAG', value: '0x1' } };

  it('都成立时判 fail', () => {
    const state = stateOf({ registers: { RAX: 0x0n, FLAG: 1n } });
    const fail: Predicate[] = [{ stdout_contains: { hex: '68' } }];
    expect(evaluateVerdict(win, fail, { state })).toBe('fail');
  });

  it('只有 win 成立时判 win', () => {
    const state = stateOf({ registers: { RAX: 0x0n, FLAG: 1n } });
    expect(evaluateVerdict(win, [], { state })).toBe('win');
  });

  it('都不成立时判 none', () => {
    expect(evaluateVerdict(win, [], { state: stateOf() })).toBe('none');
  });

  it('多条 fail 谓词任一成立即判 fail', () => {
    const state = stateOf({ registers: { RAX: 0x2an, FLAG: 0n } });
    const fail: Predicate[] = [
      { reg_eq: { reg: 'RCX', value: '0x9' } },
      { exited: {} },
    ];
    expect(evaluateVerdict(win, fail, { state: { ...state, status: 'exited' } })).toBe('fail');
  });
});
