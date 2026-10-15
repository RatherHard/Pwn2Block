import { describe, expect, it } from 'vitest';
import { ret2winPublic } from '@pwn2block/shared';
import { compileProgram } from './compile';
import type {
  CompileError,
  CompileOptions,
  CompileResult,
  CompilerChallenge,
  NormalizedBlock,
  NormalizedWorkspace,
} from './types';
import {
  BLOCK_TYPES,
  INPUTS,
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
  MESSAGE_READS_STATE,
} from './types';

/**
 * 编译错误与上限测试（05 §4）。
 *
 * 每条错误都必须带得出错积木的 id —— UI 靠它高亮积木，所以这里连 blockId 一起断言。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, fields: {}, inputs: {}, ...extras, type };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });
const address = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.valueAddr, { fields: { ADDR: `0x${value.toString(16)}` } });
const rawBytes = (hex: string): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: hex } });
const push = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) } });

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

function chainOf(chain: readonly NormalizedBlock[]): NormalizedBlock | undefined {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i] as NormalizedBlock;
    head = { ...current, next: head };
  }
  return head;
}

function programOf(chain: readonly NormalizedBlock[]): NormalizedWorkspace {
  return { blocks: [blk(BLOCK_TYPES.start, { next: chainOf(chain) })] };
}

/** 断言编译失败并取出结构化错误。 */
function errorsOf(result: CompileResult): readonly CompileError[] {
  if (result.ok) throw new Error(`期望编译失败，实际成功：${JSON.stringify(result.actions)}`);
  return result.errors;
}

function firstErrorOf(result: CompileResult): CompileError {
  const errors = errorsOf(result);
  const first = errors[0];
  if (first === undefined) throw new Error('期望至少一条错误，实际为空');
  return first;
}

function compile(
  chain: readonly NormalizedBlock[],
  challenge: CompilerChallenge = openChallenge,
  options?: CompileOptions,
): CompileResult {
  return compileProgram({ program: programOf(chain), challenge }, options);
}

describe('编译器错误：开始积木', () => {
  it('没有开始积木时报错，blockId 为空串（没有具体位置可指）', () => {
    const result = compileProgram({
      program: { blocks: [push(0x41)] },
      challenge: openChallenge,
    });
    expect(firstErrorOf(result)).toEqual({ blockId: '', message: MESSAGE_NO_START_BLOCK });
  });

  it('两个开始积木时报错，并分别指出各自的 id', () => {
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, { id: 's1' }),
          blk(BLOCK_TYPES.start, { id: 's2', next: push(0x41) }),
        ],
      },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 's1', message: MESSAGE_MULTIPLE_START_BLOCKS },
      { blockId: 's2', message: MESSAGE_MULTIPLE_START_BLOCKS },
    ]);
  });
});

describe('编译器错误：动作白名单与禁用构造', () => {
  it('allowedActions 之外的动作报错并指出积木', () => {
    const result = compile(
      [
        blk(BLOCK_TYPES.actionWriteBytes, {
          id: 'wb',
          inputs: { [INPUTS.addr]: address(0x7fffff00), [INPUTS.bytes]: rawBytes('41') },
        }),
      ],
      ret2winPublic,
    );
    const error = firstErrorOf(result);
    expect(error.blockId).toBe('wb');
    expect(error.message).toContain('write_bytes');
    expect(error.message).toContain('allowedActions');
  });

  it('读当前状态的积木编译期直接报错（05 §4 的理由）', () => {
    const result = compile([
      blk('state_read_reg', { id: 'sp1', fields: { REG: 'RSP' } }),
    ]);
    expect(firstErrorOf(result)).toEqual({ blockId: 'sp1', message: MESSAGE_READS_STATE });
  });

  it('未知积木类型报错', () => {
    const result = compile([blk('totally_unknown', { id: 'x1' })]);
    expect(firstErrorOf(result)).toEqual({
      blockId: 'x1',
      message: '未知积木类型：totally_unknown',
    });
  });

  it('表达式积木放在语句位置会给出专门文案', () => {
    const result = compile([blk(BLOCK_TYPES.mathNumber, { id: 'n1', fields: { NUM: 1 } })]);
    expect(firstErrorOf(result).message).toContain('不能单独放在语句位置');
  });
});

describe('编译器错误：输入与参数', () => {
  it('缺少输入时报出缺的是哪个槽', () => {
    const result = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f1',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesPadding, {
            id: 'p1',
            inputs: { [INPUTS.byte]: num(0x41) },
          }),
        },
      }),
    ]);
    expect(firstErrorOf(result)).toEqual({
      blockId: 'p1',
      message: '缺少输入：重复次数（COUNT）',
    });
  });

  it('字节槽接到数值积木上会说明需要字节表达式', () => {
    const result = compile([
      blk(BLOCK_TYPES.actionFeed, { id: 'f1', inputs: { [INPUTS.bytes]: num(1) } }),
    ]);
    expect(firstErrorOf(result).message).toContain('需要字节表达式');
  });

  it('数值槽接到字节积木上会说明需要数值表达式', () => {
    const result = compile([blk(BLOCK_TYPES.actionPush, {
      id: 'pu1',
      inputs: { [INPUTS.value]: rawBytes('41') },
    })]);
    expect(firstErrorOf(result).message).toContain('需要数值表达式');
  });

  it('变量未赋值时报错（变量是编译期常量）', () => {
    const result = compile([
      blk(BLOCK_TYPES.actionPush, {
        id: 'pu1',
        inputs: { [INPUTS.value]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }) },
      }),
    ]);
    expect(firstErrorOf(result).message).toContain('变量 n 还没有被赋值');
  });

  it('push 的负值显式报错', () => {
    const result = compile([push(-1)]);
    expect(firstErrorOf(result).message).toContain('不能为负');
  });

  it('字节原语的非法输入转成带积木 id 的编译错误（报在真正出错的那块积木上）', () => {
    const oddHex = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f1',
        inputs: { [INPUTS.bytes]: blk(BLOCK_TYPES.bytesRaw, { id: 'r1', fields: { HEX: 'abc' } }) },
      }),
    ]);
    expect(firstErrorOf(oddHex)).toEqual({
      blockId: 'r1',
      message: 'raw 需要偶数个十六进制字符（无 0x 前缀），收到 "abc"',
    });

    const badByte = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f2',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesPadding, {
            inputs: { [INPUTS.byte]: num(256), [INPUTS.count]: num(1) },
          }),
        },
      }),
    ]);
    expect(firstErrorOf(badByte).message).toContain('填充字节必须是 0x00..0xff');

    const overflow = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f3',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesInt, {
            fields: { WIDTH: 1 },
            inputs: { [INPUTS.value]: num(0x100) },
          }),
        },
      }),
    ]);
    expect(firstErrorOf(overflow).message).toContain('放不进 1 字节');
  });

  it('宽度与端序字段非法时给出中文错误', () => {
    const badWidth = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f1',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesInt, {
            fields: { WIDTH: 'abc' },
            inputs: { [INPUTS.value]: num(1) },
          }),
        },
      }),
    ]);
    expect(firstErrorOf(badWidth).message).toContain('宽度字段 WIDTH 需要整数');

    const badEndian = compile([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'f2',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesInt, {
            fields: { ENDIAN: 'MIDDLE' },
            inputs: { [INPUTS.value]: num(1) },
          }),
        },
      }),
    ]);
    expect(firstErrorOf(badEndian).message).toContain('端序只能是 LITTLE 或 BIG');
  });

  it('step / run 的步数越界报错', () => {
    const zero = compile([
      blk(BLOCK_TYPES.actionStep, { id: 's1', inputs: { [INPUTS.count]: num(0) } }),
    ]);
    expect(firstErrorOf(zero).message).toContain('步数必须在 1..10000 之间');

    const tooBig = compile([
      blk(BLOCK_TYPES.actionRun, { id: 'r1', inputs: { [INPUTS.maxSteps]: num(10_001) } }),
    ]);
    expect(firstErrorOf(tooBig).message).toContain('最大步数必须在 1..10000 之间');
  });
});

describe('编译器错误：出题人积木', () => {
  const authorChallenge: CompilerChallenge = {
    archBits: 64,
    allowedActions: ['step'],
    authorBlocks: [
      {
        id: 'gets',
        label: 'gets(buf)',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
      },
    ],
  };

  it('题目没声明的出题人积木报错', () => {
    const result = compile(
      [blk('author_nope', { id: 'a1', inputs: { data: rawBytes('41') } })],
      authorChallenge,
    );
    expect(firstErrorOf(result)).toEqual({
      blockId: 'a1',
      message: '题目没有声明出题人积木 nope（03 §1）',
    });
  });

  it('参数类型不匹配报错', () => {
    const result = compile(
      [blk('author_gets', { id: 'a1', inputs: { data: num(1) } })],
      authorChallenge,
    );
    expect(firstErrorOf(result).message).toContain('需要字节表达式');
  });

  it('缺少参数输入报错', () => {
    const result = compile([blk('author_gets', { id: 'a1' })], authorChallenge);
    expect(firstErrorOf(result)).toEqual({
      blockId: 'a1',
      message: '出题人积木 gets 缺少参数输入：data',
    });
  });

  it('多出来的参数输入报错', () => {
    const result = compile(
      [blk('author_gets', { id: 'a1', inputs: { data: rawBytes('41'), extra: num(1) } })],
      authorChallenge,
    );
    expect(firstErrorOf(result)).toEqual({
      blockId: 'a1',
      message: '出题人积木 gets 没有声明参数 extra',
    });
  });
});

describe('编译器错误：多处错误定位', () => {
  it('兄弟语句各自报错，一次报出两个 blockId', () => {
    const result = compile([blk('bad_one', { id: 'b1' }), blk('bad_two', { id: 'b2' })]);
    expect(errorsOf(result).map((error) => error.blockId)).toEqual(['b1', 'b2']);
  });

  it('错误条数达到上限后停止继续报错', () => {
    const result = compile(
      [blk('bad_one'), blk('bad_two'), blk('bad_three'), blk('bad_four'), blk('bad_five')],
      openChallenge,
      { limits: { errors: 2 } },
    );
    expect(errorsOf(result)).toHaveLength(2);
  });
});

describe('编译器上限', () => {
  it('循环展开超过 loopUnroll 报错并指出循环积木', () => {
    const loop = blk(BLOCK_TYPES.controlsRepeat, {
      id: 'loop1',
      inputs: { [INPUTS.times]: num(4), [INPUTS.body]: chainOf([push(1)]) },
    });
    const result = compile([loop], openChallenge, { limits: { loopUnroll: 3 } });
    expect(firstErrorOf(result)).toEqual({
      blockId: 'loop1',
      message: '循环展开 4 次超过上限 3（05 §4）',
    });
  });

  it('while 条件恒真时按展开上限报错', () => {
    const result = compile(
      [
        blk(BLOCK_TYPES.controlsWhileUntil, {
          id: 'loop1',
          fields: { MODE: 'WHILE' },
          inputs: { [INPUTS.bool]: num(1), [INPUTS.body]: chainOf([push(1)]) },
        }),
      ],
      openChallenge,
      { limits: { loopUnroll: 3 } },
    );
    expect(firstErrorOf(result)).toEqual({
      blockId: 'loop1',
      message: '循环展开超过上限 3 次仍未结束（05 §4），检查循环条件',
    });
  });

  it('表达式求值步数超过 exprEvalSteps 报错', () => {
    const result = compile(
      [
        blk(BLOCK_TYPES.actionPush, {
          id: 'pu1',
          inputs: {
            [INPUTS.value]: blk(BLOCK_TYPES.mathArithmetic, {
              id: 'arith1',
              fields: { OP: 'ADD' },
              inputs: {
                [INPUTS.a]: num(1),
                [INPUTS.b]: blk(BLOCK_TYPES.mathNumber, { id: 'b1', fields: { NUM: 2 } }),
              },
            }),
          },
        }),
      ],
      openChallenge,
      { limits: { exprEvalSteps: 2 } },
    );
    // 求值顺序：算术块(1) → 左操作数(2) → 右操作数(3) 超限，报在右操作数这块积木上
    expect(firstErrorOf(result)).toEqual({
      blockId: 'b1',
      message: '表达式求值超过上限 2 步（05 §4），把表达式或循环拆小一些',
    });
  });

  it('动作数超过上限时报错（一次 submit 发不出去）', () => {
    const result = compile([push(1), push(2), push(3)], openChallenge, {
      limits: { actions: 2 },
    });
    const error = firstErrorOf(result);
    expect(error.message).toContain('动作数超过上限 2');
    expect(error.blockId).toMatch(/^action_push_/);
  });

  it('环状 next 由语句访问兜底拦住，不会死循环', () => {
    // 适配器会拒绝环，这里人为造一个，专门验证编译器的兜底护栏
    interface MutableBlock {
      id: string;
      type: string;
      fields: Record<string, never>;
      inputs: Record<string, NormalizedBlock | undefined>;
      next?: NormalizedBlock;
    }
    const first: MutableBlock = {
      id: 'loop_a',
      type: BLOCK_TYPES.controlsIf,
      fields: {},
      inputs: {},
    };
    const second: MutableBlock = {
      id: 'loop_b',
      type: BLOCK_TYPES.controlsIf,
      fields: {},
      inputs: {},
    };
    first.next = second;
    second.next = first;

    const result = compileProgram(
      {
        program: { blocks: [blk(BLOCK_TYPES.start, { next: first })] },
        challenge: openChallenge,
      },
      { limits: { statementVisits: 5 } },
    );
    const error = firstErrorOf(result);
    expect(error.blockId).toBe('loop_b');
    expect(error.message).toContain('疑似成环');
  });
});
