import { describe, expect, it } from 'vitest';
import {
  EXPR_EVAL_STEP_LIMIT,
  LOOP_UNROLL_LIMIT,
  MAX_SUBMIT_ACTIONS,
} from '@pwn2block/shared';
import { compileProgram } from './compile';
import type {
  CompileOptions,
  CompileResult,
  CompilerChallenge,
  NormalizedBlock,
  NormalizedWorkspace,
} from './types';
import { MAX_BYTE_LENGTH } from './bytes';
import {
  BLOCK_TYPES,
  DEFAULT_COMPILER_LIMITS,
  INPUTS,
  MAX_COMPILE_ERRORS,
  MAX_STATEMENT_VISITS,
} from './types';

/**
 * 编译上限（05 §4、09 §3.2）。
 *
 * 三个上限的**口径**是测试的重点，不只是"会不会报错"：
 * - 循环展开 256（`LOOP_UNROLL_LIMIT`）：恰好等于上限要能过，多一次才是错；
 * - 表达式求值 4096（`EXPR_EVAL_STEP_LIMIT`）：**一次编译累计**——循环展开里的重复求值一起算，
 *   所以下面用「最小可通过的预算」反推真实步数，非累计实现会立刻露馅；
 * - 产物动作数 `MAX_SUBMIT_ACTIONS`（4096）：正好 4096 个动作必须能编译，4097 个才是错。
 *
 * 每条上限错误都必须带**出错积木的 blockId**，不许静默截断。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const push = (value: number, extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) }, ...extras });

/** `ret` 没有输入槽：造"只占动作数、不花表达式预算"的积木时用它。 */
const ret = (extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionRet, extras);

/** 把一串语句用 `next` 连成链；空数组表示空链。 */
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

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

function compile(
  program: NormalizedWorkspace,
  options?: CompileOptions,
): CompileResult {
  return compileProgram({ program, challenge: openChallenge }, options);
}

function successOf(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result;
}

function errorsOf(result: CompileResult): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

/** 画布上真实存在的积木 id（上限错误必须指向其中之一）。 */
function canvasIds(program: NormalizedWorkspace): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (block: NormalizedBlock | undefined): void => {
    if (block === undefined || ids.has(block.id)) return;
    ids.add(block.id);
    for (const child of Object.values(block.inputs)) walk(child);
    walk(block.next);
  };
  for (const block of program.blocks) walk(block);
  return ids;
}

/**
 * 反推「恰好够用的表达式求值预算」：从 1 开始试，第一个能编译通过的上限就是真实求值步数。
 * 依赖的是累计口径本身，所以断言的是**精确数字**（每个数字都在用例里写清怎么来的）。
 */
function minEvalLimit(program: NormalizedWorkspace, ceiling = 64): number {
  for (let limit = 1; limit <= ceiling; limit += 1) {
    if (compile(program, { limits: { exprEvalSteps: limit } }).ok) return limit;
  }
  throw new Error(`预算上限试到 ${ceiling} 都没通过：程序比预期复杂`);
}

describe('编译上限：默认值来自 shared 常量（07 §2）', () => {
  it('三项默认上限逐一对齐 shared，不在这里另写一份数字', () => {
    expect(DEFAULT_COMPILER_LIMITS.loopUnroll).toBe(LOOP_UNROLL_LIMIT);
    expect(DEFAULT_COMPILER_LIMITS.exprEvalSteps).toBe(EXPR_EVAL_STEP_LIMIT);
    expect(DEFAULT_COMPILER_LIMITS.actions).toBe(MAX_SUBMIT_ACTIONS);
    expect(DEFAULT_COMPILER_LIMITS.errors).toBe(MAX_COMPILE_ERRORS);
    expect(DEFAULT_COMPILER_LIMITS.statementVisits).toBe(MAX_STATEMENT_VISITS);
    // 与文档 05 §4 的数字对齐（文档与代码不一致时以代码为准，但仍要发现漂移）。
    expect(LOOP_UNROLL_LIMIT).toBe(256);
    expect(EXPR_EVAL_STEP_LIMIT).toBe(4096);
    expect(MAX_SUBMIT_ACTIONS).toBe(4096);
  });

  it('不传 limits 与显式传默认值等价', () => {
    const program = programOf([push(1), ret()]);
    expect(compile(program, { limits: { ...DEFAULT_COMPILER_LIMITS } })).toEqual(compile(program));
  });
});

describe('编译上限：循环展开（05 §4）', () => {
  it('次数恰好等于上限（默认 256）时通过', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: { [INPUTS.times]: num(LOOP_UNROLL_LIMIT), [INPUTS.body]: chainOf([ret()]) },
      }),
    ]);
    const result = successOf(compile(program));
    expect(result.actions).toHaveLength(LOOP_UNROLL_LIMIT);
    // 展开出来的每个动作都指向循环积木本身（08 §9.2）。
    expect(new Set(result.origins.map((origin) => origin.blockId))).toEqual(new Set(['loop']));
  });

  it('超过上限时报错并指出循环积木，不静默截断', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: {
          [INPUTS.times]: num(LOOP_UNROLL_LIMIT + 1),
          [INPUTS.body]: chainOf([ret()]),
        },
      }),
    ]);
    const result = compile(program);
    expect(errorsOf(result)).toEqual([
      { blockId: 'loop', message: `循环展开 ${LOOP_UNROLL_LIMIT + 1} 次超过上限 ${LOOP_UNROLL_LIMIT}（05 §4）` },
    ]);
    // 失败时没有半截产物：调用方只能拿到错误，不能拿到被截断的动作。
    expect(result.ok).toBe(false);
  });

  it('自定义上限时边界同样精确：恰好 3 次过，4 次不过', () => {
    const loopWith = (times: number): NormalizedWorkspace =>
      programOf([
        blk(BLOCK_TYPES.controlsRepeat, {
          id: 'loop',
          inputs: { [INPUTS.times]: num(times), [INPUTS.body]: chainOf([ret()]) },
        }),
      ]);
    expect(successOf(compile(loopWith(3), { limits: { loopUnroll: 3 } })).actions).toHaveLength(3);
    expect(errorsOf(compile(loopWith(4), { limits: { loopUnroll: 3 } }))[0]?.blockId).toBe('loop');
  });

  it('while 恰好展开到上限次后条件转假：通过', () => {
    // n = 0; while (n < 256) { n = n + 1 }  —— 正好 256 轮。
    const program = programOf([
      blk(BLOCK_TYPES.varsSet, {
        id: 'init',
        fields: { VAR: 'n' },
        inputs: { [INPUTS.value]: num(0) },
      }),
      blk(BLOCK_TYPES.controlsWhileUntil, {
        id: 'while',
        fields: { MODE: 'WHILE' },
        inputs: {
          [INPUTS.bool]: compare(),
          [INPUTS.body]: chainOf([increment()]),
        },
      }),
      push(0x41),
    ]);
    const result = successOf(compile(program));
    expect(result.actions).toEqual([{ type: 'push', value: '0x41' }]);
  });

  it('while 需要第 257 轮时报错并指出循环积木', () => {
    const program = programOf([
      blk(BLOCK_TYPES.varsSet, {
        id: 'init',
        fields: { VAR: 'n' },
        inputs: { [INPUTS.value]: num(0) },
      }),
      blk(BLOCK_TYPES.controlsWhileUntil, {
        id: 'while',
        fields: { MODE: 'WHILE' },
        inputs: {
          [INPUTS.bool]: compare(LOOP_UNROLL_LIMIT + 1),
          [INPUTS.body]: chainOf([increment()]),
        },
      }),
    ]);
    const error = errorsOf(compile(program))[0];
    expect(error?.blockId).toBe('while');
    expect(error?.message).toContain(`超过上限 ${LOOP_UNROLL_LIMIT} 次仍未结束`);
  });
});

/** `n < bound`：构造 while 条件用。 */
function compare(bound = LOOP_UNROLL_LIMIT): NormalizedBlock {
  return blk(BLOCK_TYPES.logicCompare, {
    fields: { OP: 'LT' },
    inputs: {
      [INPUTS.a]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }),
      [INPUTS.b]: num(bound),
    },
  });
}

/** `n = n + 1`：while 循环体用。 */
function increment(): NormalizedBlock {
  return blk(BLOCK_TYPES.varsSet, {
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
}

describe('编译上限：表达式求值步数按一次编译累计（05 §4）', () => {
  it('循环展开里的重复求值一起累计：3 轮循环里的值要算 3 步', () => {
    // 步数 = 循环次数表达式 1 + 每轮循环体里的值 3 = 4。按"每个表达式只算一次"的口径会是 2。
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: { [INPUTS.times]: num(3), [INPUTS.body]: chainOf([push(7)]) },
      }),
    ]);
    expect(minEvalLimit(program)).toBe(4);
    const error = errorsOf(compile(program, { limits: { exprEvalSteps: 3 } }))[0];
    // 预算是在第 3 轮被那块的求值撞破的：错误就报在那块数字积木上。
    expect(error?.blockId).toBe(
      (program.blocks[0]?.next?.inputs[INPUTS.body] as NormalizedBlock).inputs[INPUTS.value]?.id,
    );
    expect(error?.message).toBe('表达式求值超过上限 3 步（05 §4），把表达式或循环拆小一些');
  });

  it('嵌套循环的重复求值也一起累计', () => {
    // 外层 2 轮：外层次数 1 + 2 ×（内层次数 1 + 内层 2 轮 × 值 1）= 7。
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'outer',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([
            blk(BLOCK_TYPES.controlsRepeat, {
              id: 'inner',
              inputs: { [INPUTS.times]: num(2), [INPUTS.body]: chainOf([push(1)]) },
            }),
          ]),
        },
      }),
    ]);
    expect(minEvalLimit(program)).toBe(7);
    expect(successOf(compile(program, { limits: { exprEvalSteps: 7 } })).actions).toHaveLength(4);
    expect(compile(program, { limits: { exprEvalSteps: 6 } }).ok).toBe(false);
  });

  it('while 的条件每次迭代都算一步', () => {
    // 初始化 n=0：字面 1 步。
    // 条件 n<2 检查 3 次（n=0,1,2）：3 ×（比较 1 + 变量 1 + 字面 1）= 9。
    // 循环体 2 轮：2 ×（算术 1 + 变量 1 + 字面 1）= 6。合计 16。
    const program = programOf([
      blk(BLOCK_TYPES.varsSet, {
        id: 'init',
        fields: { VAR: 'n' },
        inputs: { [INPUTS.value]: num(0) },
      }),
      blk(BLOCK_TYPES.controlsWhileUntil, {
        id: 'while',
        fields: { MODE: 'WHILE' },
        inputs: { [INPUTS.bool]: compare(2), [INPUTS.body]: chainOf([increment()]) },
      }),
    ]);
    expect(minEvalLimit(program)).toBe(16);
    expect(compile(program, { limits: { exprEvalSteps: 16 } }).ok).toBe(true);
    const error = errorsOf(compile(program, { limits: { exprEvalSteps: 15 } }))[0];
    expect(error?.blockId).toBeDefined();
    expect(canvasIds(program).has(error?.blockId ?? '')).toBe(true);
  });

  it('求值预算超限的错误指向真正被求值的那块积木', () => {
    const program = programOf([
      push(1),
      push(2),
      push(3),
      push(4),
    ]);
    const error = errorsOf(compile(program, { limits: { exprEvalSteps: 3 } }))[0];
    // 前三块的值各 1 步；第 4 块撞上限，报在它上面。
    const fourth = program.blocks[0]?.next?.next?.next?.next;
    expect(error?.blockId).toBe(fourth?.inputs[INPUTS.value]?.id);
    expect(canvasIds(program).has(error?.blockId ?? '')).toBe(true);
  });
});

describe('编译上限：产物动作数（MAX_SUBMIT_ACTIONS）', () => {
  it('恰好等于上限时通过', () => {
    const result = successOf(compile(programOf([ret(), ret()]), { limits: { actions: 2 } }));
    expect(result.actions).toEqual([{ type: 'ret' }, { type: 'ret' }]);
    expect(result.origins).toHaveLength(2);
  });

  it('超过上限时报错一次，并指向溢出的那块积木', () => {
    const program = programOf([ret({ id: 'r1' }), ret({ id: 'r2' }), ret({ id: 'r3' })]);
    const errors = errorsOf(compile(program, { limits: { actions: 2 } }));
    // 只报一次：同一批里每块都报会把输出区刷满。
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      blockId: 'r3',
      message: '编译出的动作数超过上限 2，一次 submit 发不出去（04 §6）',
    });
  });

  it('默认上限就是 MAX_SUBMIT_ACTIONS：恰好 4096 个动作能编译', () => {
    // 256 轮 × 16 个动作 = 4096。循环体用没有输入的 `ret`，不占用表达式求值预算。
    const body = Array.from({ length: 16 }, (_unused, index) => ret({ id: `body_${index}` }));
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: { [INPUTS.times]: num(LOOP_UNROLL_LIMIT), [INPUTS.body]: chainOf(body) },
      }),
    ]);
    const result = successOf(compile(program));
    expect(result.actions).toHaveLength(MAX_SUBMIT_ACTIONS);
    expect(result.origins).toHaveLength(MAX_SUBMIT_ACTIONS);
    expect(result.origins[MAX_SUBMIT_ACTIONS - 1]).toEqual({
      index: MAX_SUBMIT_ACTIONS - 1,
      blockId: 'loop',
    });
  });

  it('4097 个动作被拒，错误指向多出来的那块积木', () => {
    const body = Array.from({ length: 16 }, (_unused, index) => ret({ id: `body_${index}` }));
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: { [INPUTS.times]: num(LOOP_UNROLL_LIMIT), [INPUTS.body]: chainOf(body) },
      }),
      ret({ id: 'one_too_many' }),
    ]);
    const errors = errorsOf(compile(program));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.blockId).toBe('one_too_many');
    expect(errors[0]?.message).toBe(
      `编译出的动作数超过上限 ${MAX_SUBMIT_ACTIONS}，一次 submit 发不出去（04 §6）`,
    );
  });
});

describe('编译上限：单个字节构造的长度', () => {
  /** 填充次数来自学习者的输入框，可以填任意整数。 */
  const padProgram = (count: number): NormalizedWorkspace =>
    programOf([
      blk(BLOCK_TYPES.actionFeed, {
        id: 'feed1',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesPadding, {
            id: 'pad1',
            inputs: { [INPUTS.byte]: num(0x41), [INPUTS.count]: num(count) },
          }),
        },
      }),
    ]);

  it('天文数字的次数是编译错误，而不是让 RangeError 逃出编译器', () => {
    // 契约：`compileProgram` 要么给动作、要么给带 blockId 的错误，永远不抛异常。
    const program = padProgram(Number.MAX_SAFE_INTEGER);
    let result: CompileResult | undefined;
    expect(() => {
      result = compile(program);
    }).not.toThrow();
    const errors = errorsOf(result as CompileResult);
    expect(errors[0]?.blockId).toBe('pad1');
    expect(errors[0]?.message).toContain('超过单个字节构造的上限');
    expect(canvasIds(program).has(errors[0]?.blockId ?? '')).toBe(true);
  });

  it('比请求体还大的字节串被挡在编译期（发出去也一定被拒）', () => {
    const errors = errorsOf(compile(padProgram(MAX_BYTE_LENGTH + 1)));
    expect(errors[0]?.blockId).toBe('pad1');
  });
});

describe('编译上限：语句访问兜底', () => {
  it('恰好用完预算时通过', () => {
    const program = programOf([ret(), ret()]);
    // 「开始」积木本身不算语句：链上两块积木正好两次访问。
    expect(successOf(compile(program, { limits: { statementVisits: 2 } })).actions).toHaveLength(2);
  });

  it('超过预算时报"疑似成环"，不会静默跑下去', () => {
    const program = programOf([ret({ id: 'first' }), ret({ id: 'second' })]);
    const errors = errorsOf(compile(program, { limits: { statementVisits: 1 } }));
    expect(errors[0]?.message).toContain('疑似成环');
    expect(errors[0]?.blockId).toBe('second');
    expect(canvasIds(program).has(errors[0]?.blockId ?? '')).toBe(true);
  });
});
