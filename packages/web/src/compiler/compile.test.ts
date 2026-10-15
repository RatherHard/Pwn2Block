import { describe, expect, it } from 'vitest';
import { ActionSchema, ret2winPublic, ret2winSolutionActions } from '@pwn2block/shared';
import { compileProgram } from './compile';
import type { CompilerChallenge, NormalizedBlock, NormalizedWorkspace } from './types';
import { BLOCK_TYPES, INPUTS, ACTION_ORIGIN_VERSION } from './types';

/**
 * 编译器主路径测试（05 §3、§4）。
 *
 * 断言一律精确到动作对象与每个字节：小端序是本题考点，模糊断言等于没测。
 */

let sequence = 0;

/** 造一块归一化积木：`extras` 里可以覆盖 id，或补 inputs / fields / next。 */
function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, fields: {}, inputs: {}, ...extras, type };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });
const address = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.valueAddr, { fields: { ADDR: `0x${value.toString(16)}` } });
const paddingBytes = (byte: number, count: number): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesPadding, {
    inputs: { [INPUTS.byte]: num(byte), [INPUTS.count]: num(count) },
  });
const rawBytes = (hex: string): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: hex } });

/** 允许全部原子动作的题目，用来单独验证每个动作积木。 */
const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

function programOf(...chain: NormalizedBlock[]): NormalizedWorkspace {
  return { blocks: [blk(BLOCK_TYPES.start, { next: chainOf(chain) })] };
}

/** 把一串语句用 next 连起来。 */
function chainOf(chain: readonly NormalizedBlock[]): NormalizedBlock | undefined {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i] as NormalizedBlock;
    head = current.next === undefined ? { ...current, next: head } : current;
  }
  return head;
}

function actionsOf(result: ReturnType<typeof compileProgram>): readonly unknown[] {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result.actions;
}

describe('编译器：ret2win 主路径', () => {
  it('gets(buf) 的参数按小端序拼出 padding + 返回地址，复现 03 §4 的参考解法', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, {
          next: blk('author_gets', {
            inputs: {
              data: blk(BLOCK_TYPES.bytesConcat, {
                inputs: {
                  item0: paddingBytes(0x41, 16),
                  item1: paddingBytes(0x42, 8),
                  item2: blk(BLOCK_TYPES.bytesAddr, { inputs: { [INPUTS.value]: num(0x400002) } }),
                },
              }),
            },
            next: blk(BLOCK_TYPES.actionStep, { inputs: { [INPUTS.count]: num(3) } }),
          }),
        }),
      ],
    };

    const result = compileProgram({ program, challenge: ret2winPublic });
    expect(actionsOf(result)).toEqual(ret2winSolutionActions);
    expect(actionsOf(result)).toEqual([
      {
        type: 'block',
        id: 'gets',
        args: { data: `${'41'.repeat(16)}${'42'.repeat(8)}0200400000000000` },
      },
      { type: 'step', count: 3 },
    ]);
  });

  it('出题人积木只发 { id, args }，展开留给服务端（03 §3）', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, {
          next: blk('author_gets', { inputs: { data: rawBytes('aa') } }),
        }),
      ],
    };
    const result = compileProgram({ program, challenge: ret2winPublic });
    expect(actionsOf(result)).toEqual([{ type: 'block', id: 'gets', args: { data: 'aa' } }]);
  });
});

describe('编译器：动作积木逐个精确断言', () => {
  it('write_bytes / push / pop / call / ret / feed / step / run 的顺序与字段', () => {
    const program = programOf(
      blk(BLOCK_TYPES.actionWriteBytes, {
        inputs: { [INPUTS.addr]: address(0x7fffff00), [INPUTS.bytes]: rawBytes('c9c3') },
      }),
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x1234) } }),
      blk(BLOCK_TYPES.actionPop),
      blk(BLOCK_TYPES.actionCall, { inputs: { [INPUTS.addr]: address(0x400002) } }),
      blk(BLOCK_TYPES.actionRet),
      blk(BLOCK_TYPES.actionFeed, { inputs: { [INPUTS.bytes]: paddingBytes(0x41, 4) } }),
      blk(BLOCK_TYPES.actionStep),
      blk(BLOCK_TYPES.actionRun),
    );

    const actions = actionsOf(compileProgram({ program, challenge: openChallenge }));
    expect(actions).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: 'c9c3' },
      { type: 'push', value: '0x1234' },
      { type: 'pop' },
      { type: 'call', addr: '0x400002' },
      { type: 'ret' },
      { type: 'feed', hex: '41414141' },
      { type: 'step' },
      { type: 'run' },
    ]);
  });

  it('step / run 带参数时写成 count / maxSteps', () => {
    const program = programOf(
      blk(BLOCK_TYPES.actionStep, { inputs: { [INPUTS.count]: num(5) } }),
      blk(BLOCK_TYPES.actionRun, { inputs: { [INPUTS.maxSteps]: num(10) } }),
    );
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'step', count: 5 },
      { type: 'run', maxSteps: 10 },
    ]);
  });

  it('编译产物全部通过 shared 的 ActionSchema（跨包契约）', () => {
    const program = programOf(
      blk(BLOCK_TYPES.actionWriteBytes, {
        inputs: { [INPUTS.addr]: address(0x7fffff00), [INPUTS.bytes]: rawBytes('c9c3') },
      }),
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x1234) } }),
      blk(BLOCK_TYPES.actionFeed, { inputs: { [INPUTS.bytes]: rawBytes('4142') } }),
      blk(BLOCK_TYPES.actionStep, { inputs: { [INPUTS.count]: num(2) } }),
    );
    for (const action of actionsOf(compileProgram({ program, challenge: openChallenge }))) {
      expect(ActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('feed 与 step 的先后顺序原样保留（feed 必须在触发 read 的 step 之前）', () => {
    const program = programOf(
      blk(BLOCK_TYPES.actionFeed, { inputs: { [INPUTS.bytes]: rawBytes('4141') } }),
      blk(BLOCK_TYPES.actionStep, { inputs: { [INPUTS.count]: num(1) } }),
    );
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'feed', hex: '4141' },
      { type: 'step', count: 1 },
    ]);
  });
});

describe('编译器：字节表达式的小端序', () => {
  const writeWith = (bytes: NormalizedBlock): readonly unknown[] =>
    actionsOf(
      compileProgram({
        program: programOf(
          blk(BLOCK_TYPES.actionWriteBytes, {
            inputs: { [INPUTS.addr]: address(0x7fffff00), [INPUTS.bytes]: bytes },
          }),
        ),
        challenge: openChallenge,
      }),
    );

  it('bytes_int 默认小端、默认字长 W = 8 字节', () => {
    const bytes = blk(BLOCK_TYPES.bytesInt, { inputs: { [INPUTS.value]: num(0x1234) } });
    expect(writeWith(bytes)).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: '3412000000000000' },
    ]);
  });

  it('bytes_int 可以指定宽度与端序', () => {
    const little = blk(BLOCK_TYPES.bytesInt, {
      fields: { WIDTH: 2, ENDIAN: 'LITTLE' },
      inputs: { [INPUTS.value]: num(0x1234) },
    });
    const big = blk(BLOCK_TYPES.bytesInt, {
      fields: { WIDTH: 2, ENDIAN: 'BIG' },
      inputs: { [INPUTS.value]: num(0x1234) },
    });
    expect(writeWith(little)).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: '3412' },
    ]);
    expect(writeWith(big)).toEqual([{ type: 'write_bytes', addr: '0x7fffff00', hex: '1234' }]);
  });

  it('bytes_addr 等价于按字长小端写地址', () => {
    const bytes = blk(BLOCK_TYPES.bytesAddr, { inputs: { [INPUTS.value]: num(0x400002) } });
    expect(writeWith(bytes)).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: '0200400000000000' },
    ]);
  });

  it('bytes_string 是 UTF-8，bytes_raw 原样（统一小写）', () => {
    expect(writeWith(blk(BLOCK_TYPES.bytesString, { fields: { TEXT: 'AB' } }))).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: '4142' },
    ]);
    expect(writeWith(blk(BLOCK_TYPES.bytesString, { fields: { TEXT: '中' } }))).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: 'e4b8ad' },
    ]);
    expect(writeWith(rawBytes('C9C3'))).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: 'c9c3' },
    ]);
  });

  it('bytes_concat 按 item0 / item1 / item2 顺序拼接', () => {
    const bytes = blk(BLOCK_TYPES.bytesConcat, {
      inputs: {
        item0: rawBytes('aa'),
        item1: paddingBytes(0x00, 2),
        item2: rawBytes('bb'),
      },
    });
    expect(writeWith(bytes)).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: 'aa0000bb' },
    ]);
  });

  it('地址字面量在表达式里可以直接参与算术', () => {
    const offset = blk(BLOCK_TYPES.mathArithmetic, {
      fields: { OP: 'ADD' },
      inputs: { [INPUTS.a]: address(0x7fffff00), [INPUTS.b]: num(0x18) },
    });
    const bytes = blk(BLOCK_TYPES.bytesAddr, { inputs: { [INPUTS.value]: offset } });
    // 0x7fffff00 + 0x18 = 0x7fffff18，按小端写出去
    expect(writeWith(bytes)).toEqual([
      { type: 'write_bytes', addr: '0x7fffff00', hex: '18ffff7f00000000' },
    ]);
  });
});

describe('编译器：控制流与变量（编译期展开）', () => {
  it('只编译连到「开始」积木的积木', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, {
          next: blk(BLOCK_TYPES.actionStep, { inputs: { [INPUTS.count]: num(1) } }),
        }),
        blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0xdead) } }),
      ],
    };
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'step', count: 1 },
    ]);
  });

  it('空程序合法：开始积木下面没有东西', () => {
    const program: NormalizedWorkspace = { blocks: [blk(BLOCK_TYPES.start)] };
    expect(compileProgram({ program, challenge: openChallenge })).toEqual({
      ok: true,
      actions: [],
      origins: [],
      originsVersion: ACTION_ORIGIN_VERSION,
    });
  });

  it('repeat 按常量次数展开，并把循环体里的变量带到下一轮', () => {
    const increment = blk(BLOCK_TYPES.varsSet, {
      fields: { VAR: 'n' },
      inputs: {
        [INPUTS.value]: blk(BLOCK_TYPES.mathArithmetic, {
          fields: { OP: 'ADD' },
          inputs: {
            [INPUTS.a]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }),
            [INPUTS.b]: num(1),
          },
        }),
      },
    });
    const program = programOf(
      blk(BLOCK_TYPES.varsSet, { fields: { VAR: 'n' }, inputs: { [INPUTS.value]: num(0) } }),
      blk(BLOCK_TYPES.controlsRepeat, {
        inputs: { [INPUTS.times]: num(3), [INPUTS.body]: chainOf([increment]) },
      }),
      blk(BLOCK_TYPES.actionPush, {
        inputs: { [INPUTS.value]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }) },
      }),
    );
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'push', value: '0x3' },
    ]);
  });

  it('while 按编译期条件展开：n < 3 循环三次', () => {
    const increment = blk(BLOCK_TYPES.varsSet, {
      fields: { VAR: 'n' },
      inputs: {
        [INPUTS.value]: blk(BLOCK_TYPES.mathArithmetic, {
          fields: { OP: 'ADD' },
          inputs: {
            [INPUTS.a]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }),
            [INPUTS.b]: num(1),
          },
        }),
      },
    });
    const body = chainOf([
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(1) } }),
      increment,
    ]);
    const loop = blk(BLOCK_TYPES.controlsWhileUntil, {
      fields: { MODE: 'WHILE' },
      inputs: {
        [INPUTS.bool]: blk(BLOCK_TYPES.logicCompare, {
          fields: { OP: 'LT' },
          inputs: {
            [INPUTS.a]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }),
            [INPUTS.b]: num(3),
          },
        }),
        [INPUTS.body]: body,
      },
    });
    const program = programOf(
      blk(BLOCK_TYPES.varsSet, { fields: { VAR: 'n' }, inputs: { [INPUTS.value]: num(0) } }),
      loop,
    );
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
    ]);
  });

  it('controls_if 只编译命中的分支', () => {
    const thenBranch = chainOf([
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x11) } }),
    ]);
    const elseBranch = chainOf([
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x22) } }),
    ]);
    const makeIf = (condition: number): NormalizedWorkspace =>
      programOf(
        blk(BLOCK_TYPES.controlsIf, {
          inputs: {
            [INPUTS.if0]: num(condition),
            [INPUTS.do0]: thenBranch,
            [INPUTS.else]: elseBranch,
          },
        }),
      );

    expect(actionsOf(compileProgram({ program: makeIf(1), challenge: openChallenge }))).toEqual([
      { type: 'push', value: '0x11' },
    ]);
    expect(actionsOf(compileProgram({ program: makeIf(0), challenge: openChallenge }))).toEqual([
      { type: 'push', value: '0x22' },
    ]);
  });
});

describe('编译器：出题人积木的参数类型', () => {
  const authorChallenge: CompilerChallenge = {
    archBits: 64,
    allowedActions: ['step'],
    authorBlocks: [
      {
        id: 'readfile',
        label: 'readfile(fd, buf, data)',
        params: [
          { name: 'fd', type: 'int' },
          { name: 'buf', type: 'addr' },
          { name: 'data', type: 'bytes' },
        ],
        expand: [{ type: 'write_bytes', addr: '$buf', hex: '$data' }],
      },
    ],
  };

  it('int / addr / bytes 参数分别编码成 args 里的字符串', () => {
    const program = programOf(
      blk('author_readfile', {
        inputs: { fd: num(3), buf: address(0x7fffff00), data: rawBytes('aabb') },
      }),
    );
    expect(actionsOf(compileProgram({ program, challenge: authorChallenge }))).toEqual([
      { type: 'block', id: 'readfile', args: { fd: '0x3', buf: '0x7fffff00', data: 'aabb' } },
    ]);
  });
});

describe('编译器：纯函数与不可变', () => {
  it('同样输入得到同样输出，且不改动输入树', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, {
          next: blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x41) } }),
        }),
      ],
    };
    const before = JSON.stringify(program);
    const first = compileProgram({ program, challenge: openChallenge });
    const second = compileProgram({ program, challenge: openChallenge });
    expect(second).toEqual(first);
    expect(JSON.stringify(program)).toBe(before);
  });

  it('返回的动作数组是新副本，改动它不影响下一次编译', () => {
    const program = programOf(
      blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(0x41) } }),
    );
    const first = compileProgram({ program, challenge: openChallenge });
    if (!first.ok) throw new Error('期望编译成功');
    (first.actions as unknown[]).length = 0;
    expect(actionsOf(compileProgram({ program, challenge: openChallenge }))).toEqual([
      { type: 'push', value: '0x41' },
    ]);
  });
});
