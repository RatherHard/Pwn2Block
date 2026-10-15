import { describe, expect, it } from 'vitest';
import { ret2winPublic, type PublicChallenge } from '@pwn2block/shared';
import { createArtifactTracker } from './artifact';
import { compileProgram } from './compile';
import type {
  CompileResult,
  CompilerChallenge,
  NormalizedBlock,
  NormalizedWorkspace,
} from './types';
import { ACTION_ORIGIN_VERSION, BLOCK_TYPES, INPUTS } from './types';

/**
 * 来源表的逐条审计（08 §9.2、09 §3.4）。
 *
 * `origins.test.ts` 钉住四条硬约定本身；这里补的是**审计缺口的枚举**：通用 / 字节 / 动作 /
 * 出题人积木、多层嵌套、重新编译、上限拒绝时来源表的一致性。审计的原则是「先说出正确行为，
 * 再让实现证明」，所以每条用例都写明它守的是哪一句契约，而不是只断言"能跑"。
 *
 * 三条贯穿全文件的判定，抽在 `expectWellFormed` 里：
 * 1. 来源表与动作等长同序（`origins[i].index === i`）——实现层错位就是界面定位错积木；
 * 2. 来源表的 id 必须是画布上真实存在的积木（不是合成 id）；
 * 3. **值 / 字节表达式积木永不进来源表**：它们只在编译期求值，不产生动作；
 *    来源表里出现它们只能说明归因错到了子块上。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const rawBytes = (hex: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: hex }, ...extras });

const push = (value: number, extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) }, ...extras });

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

const repeat = (
  times: number,
  body: readonly NormalizedBlock[],
  extras: Partial<NormalizedBlock> = {},
): NormalizedBlock =>
  blk(BLOCK_TYPES.controlsRepeat, {
    inputs: { [INPUTS.times]: num(times), [INPUTS.body]: chainOf(body) },
    ...extras,
  });

function successOf(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result;
}

function errorsOf(result: CompileResult): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

/** 画布上所有积木 id 与「值 / 字节表达式积木」id 的集合。 */
function canvasIndex(program: NormalizedWorkspace): {
  readonly all: ReadonlySet<string>;
  readonly expressions: ReadonlySet<string>;
} {
  const all = new Set<string>();
  const expressions = new Set<string>();
  const expressionTypes = new Set<string>([
    BLOCK_TYPES.mathNumber,
    BLOCK_TYPES.mathArithmetic,
    BLOCK_TYPES.logicCompare,
    BLOCK_TYPES.valueAddr,
    BLOCK_TYPES.varsGet,
    BLOCK_TYPES.varsSet,
    BLOCK_TYPES.bytesPadding,
    BLOCK_TYPES.bytesString,
    BLOCK_TYPES.bytesInt,
    BLOCK_TYPES.bytesAddr,
    BLOCK_TYPES.bytesRaw,
    BLOCK_TYPES.bytesConcat,
  ]);
  const walk = (block: NormalizedBlock | undefined): void => {
    if (block === undefined || all.has(block.id)) return;
    all.add(block.id);
    if (expressionTypes.has(block.type)) expressions.add(block.id);
    for (const child of Object.values(block.inputs)) walk(child);
    walk(block.next);
  };
  for (const block of program.blocks) walk(block);
  return { all, expressions };
}

/** 三条结构判定：等长同序、id 真实存在、表达式积木不占来源表。 */
function expectWellFormed(
  result: Extract<CompileResult, { ok: true }>,
  program: NormalizedWorkspace,
): void {
  const { all, expressions } = canvasIndex(program);
  expect(result.origins).toHaveLength(result.actions.length);
  expect(result.originsVersion).toBe(ACTION_ORIGIN_VERSION);
  result.origins.forEach((origin, index) => {
    expect(origin.index, `来源表下标错位：origins[${index}].index=${origin.index}`).toBe(index);
    expect(all.has(origin.blockId), `来源指向画布上不存在的积木：${origin.blockId}`).toBe(true);
    expect(
      expressions.has(origin.blockId),
      `表达式积木不该出现在来源表里：${origin.blockId}`,
    ).toBe(false);
  });
}

/** 编译并同时核对来源表的形状；返回 `blockId` 序列，方便逐条断言归因。 */
function originsOf(
  program: NormalizedWorkspace,
  challenge: CompilerChallenge = openChallenge,
): readonly string[] {
  const result = successOf(compileProgram({ program, challenge }));
  expectWellFormed(result, program);
  return result.origins.map((origin) => origin.blockId);
}

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

/** tracker 要完整 `PublicChallenge`：用真实公开包换掉动作白名单。 */
const openPublic: PublicChallenge = {
  ...ret2winPublic,
  allowedActions: [...openChallenge.allowedActions],
};

describe('来源表审计：通用积木', () => {
  it('分支里的动作指向产生它的语句块（if 不重复展开，位置要精确到那一块）', () => {
    const inside = push(0x11, { id: 'inside_if' });
    const program = programOf([
      blk(BLOCK_TYPES.controlsIf, {
        id: 'if1',
        inputs: {
          [INPUTS.if0]: num(1),
          [INPUTS.do0]: chainOf([inside, push(0x12, { id: 'inside_if_2' })]),
        },
      }),
      push(0x13, { id: 'after_if' }),
    ]);
    // 循环展开会把同一块积木算很多遍，所以归到循环本身；分支只会走一条，精确到块。
    expect(originsOf(program)).toEqual(['inside_if', 'inside_if_2', 'after_if']);
  });

  it('没被选中的分支不产生动作，也不占来源表', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsIf, {
        id: 'if1',
        inputs: {
          [INPUTS.if0]: num(0),
          [INPUTS.do0]: chainOf([push(0xaa, { id: 'not_taken' })]),
          [INPUTS.else]: chainOf([push(0xbb, { id: 'else_taken' })]),
        },
      }),
    ]);
    expect(originsOf(program)).toEqual(['else_taken']);
  });

  it('变量积木与字节积木不产生动作：来源表里只有真正产出动作的语句块', () => {
    const program = programOf([
      blk(BLOCK_TYPES.varsSet, {
        id: 'set_n',
        fields: { VAR: 'n' },
        inputs: { [INPUTS.value]: num(5) },
      }),
      blk(BLOCK_TYPES.actionFeed, {
        id: 'feed1',
        inputs: {
          [INPUTS.bytes]: blk(BLOCK_TYPES.bytesConcat, {
            id: 'concat1',
            inputs: {
              item0: rawBytes('41', { id: 'raw1' }),
              item1: blk(BLOCK_TYPES.bytesPadding, {
                id: 'pad1',
                inputs: { [INPUTS.byte]: num(0), [INPUTS.count]: num(4) },
              }),
            },
          }),
        },
      }),
    ]);
    expect(originsOf(program)).toEqual(['feed1']);
  });
});

describe('来源表审计：动作积木各自归因', () => {
  it('每个动作积木都指向自己，不会指到它的输入子块', () => {
    const program = programOf([
      blk(BLOCK_TYPES.actionWriteBytes, {
        id: 'write1',
        inputs: { [INPUTS.addr]: num(0x1000), [INPUTS.bytes]: rawBytes('4142', { id: 'write_bytes_input' }) },
      }),
      blk(BLOCK_TYPES.actionCall, { id: 'call1', inputs: { [INPUTS.addr]: num(0x2000) } }),
      blk(BLOCK_TYPES.actionPop, { id: 'pop1' }),
      blk(BLOCK_TYPES.actionStep, { id: 'step1', inputs: { [INPUTS.count]: num(3) } }),
      blk(BLOCK_TYPES.actionRun, { id: 'run1', inputs: { [INPUTS.maxSteps]: num(9) } }),
      blk(BLOCK_TYPES.actionRet, { id: 'ret1' }),
    ]);
    expect(originsOf(program)).toEqual(['write1', 'call1', 'pop1', 'step1', 'run1', 'ret1']);
  });
});

describe('来源表审计：循环展开与嵌套', () => {
  it('repeat 展开出的动作归到 repeat，循环**之后**的动作归回自己', () => {
    const program = programOf([
      repeat(2, [push(1, { id: 'body_push' })], { id: 'loop1' }),
      push(2, { id: 'after_loop' }),
    ]);
    expect(originsOf(program)).toEqual(['loop1', 'loop1', 'after_loop']);
  });

  it('循环体里的分支不影响归因：整段都算循环展开出来的', () => {
    const program = programOf([
      repeat(
        2,
        [
          blk(BLOCK_TYPES.controlsIf, {
            id: 'if_in_loop',
            inputs: {
              [INPUTS.if0]: num(1),
              [INPUTS.do0]: chainOf([push(3, { id: 'push_in_if' })]),
              [INPUTS.else]: chainOf([push(4, { id: 'else_in_if' })]),
            },
          }),
        ],
        { id: 'loop1' },
      ),
    ]);
    expect(originsOf(program)).toEqual(['loop1', 'loop1']);
  });

  it('while 里再嵌 repeat：最内层循环拿归因，循环外的动作归自己', () => {
    // n = 0; while (n < 2) { push 1; repeat(2){ push 2 } ; n = n + 1 }
    const increment = blk(BLOCK_TYPES.varsSet, {
      id: 'while_increment',
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
    const program = programOf([
      blk(BLOCK_TYPES.varsSet, {
        id: 'init_n',
        fields: { VAR: 'n' },
        inputs: { [INPUTS.value]: num(0) },
      }),
      blk(BLOCK_TYPES.controlsWhileUntil, {
        id: 'while1',
        fields: { MODE: 'WHILE' },
        inputs: {
          [INPUTS.bool]: blk(BLOCK_TYPES.logicCompare, {
            fields: { OP: 'LT' },
            inputs: {
              [INPUTS.a]: blk(BLOCK_TYPES.varsGet, { fields: { VAR: 'n' } }),
              [INPUTS.b]: num(2),
            },
          }),
          [INPUTS.body]: chainOf([
            push(1, { id: 'outer_body_push' }),
            repeat(2, [push(2, { id: 'inner_body_push' })], { id: 'inner_loop' }),
            increment,
          ]),
        },
      }),
      push(5, { id: 'after_while' }),
    ]);
    // 两轮循环：外层 push + 内层两次 push，各归到对应的循环积木。
    expect(originsOf(program)).toEqual([
      'while1',
      'inner_loop',
      'inner_loop',
      'while1',
      'inner_loop',
      'inner_loop',
      'after_while',
    ]);
  });

  it('两个并列的循环各自归因，不互相串台', () => {
    const program = programOf([
      repeat(2, [push(1, { id: 'body_a' })], { id: 'loop_a' }),
      repeat(3, [push(2, { id: 'body_b' })], { id: 'loop_b' }),
    ]);
    expect(originsOf(program)).toEqual(['loop_a', 'loop_a', 'loop_b', 'loop_b', 'loop_b']);
  });

  it('零次循环与空循环体都不产生动作，也就不占来源表', () => {
    const zero = programOf([repeat(0, [push(1, { id: 'never' })], { id: 'loop0' })]);
    expect(originsOf(zero)).toEqual([]);

    const emptyBody = programOf([repeat(3, [], { id: 'no_body' })]);
    expect(originsOf(emptyBody)).toEqual([]);
  });

  it('循环体里只有编译期赋值（没有动作）时，来源表为空而不是造出占位的来源', () => {
    const program = programOf([
      repeat(
        3,
        [
          blk(BLOCK_TYPES.varsSet, {
            id: 'set_in_loop',
            fields: { VAR: 'n' },
            inputs: { [INPUTS.value]: num(1) },
          }),
        ],
        { id: 'loop1' },
      ),
    ]);
    expect(originsOf(program)).toEqual([]);
  });
});

describe('来源表审计：重新编译', () => {
  it('换掉产生动作的那块积木后，来源表跟着动作一起换新', () => {
    const first = programOf([push(1, { id: 'old_push' })]);
    expect(originsOf(first)).toEqual(['old_push']);

    const second = programOf([push(2, { id: 'new_push' }), push(3, { id: 'new_push_2' })]);
    expect(originsOf(second)).toEqual(['new_push', 'new_push_2']);
  });

  it('循环次数变了，来源表长度跟着动作数一起变（不是缓存的旧表）', () => {
    const twice = programOf([repeat(2, [push(1, { id: 'body' })], { id: 'loop1' })]);
    const thrice = programOf([repeat(3, [push(1, { id: 'body' })], { id: 'loop1' })]);
    expect(originsOf(twice)).toEqual(['loop1', 'loop1']);
    expect(originsOf(thrice)).toEqual(['loop1', 'loop1', 'loop1']);
  });

  it('同一棵树编译两次：来源表内容相同但不是同一个数组（不可变数据）', () => {
    const program = programOf([repeat(2, [push(1, { id: 'body' })], { id: 'loop1' })]);
    const first = successOf(compileProgram({ program, challenge: openChallenge }));
    const second = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(second.origins).toEqual(first.origins);
    expect(second.origins).not.toBe(first.origins);
  });
});

describe('来源表审计：编译被拒时没有半截产物', () => {
  it('两个开始积木：整次编译失败，调用方拿不到任何来源表', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, { id: 'start_a', next: push(1, { id: 'a_push' }) }),
        blk(BLOCK_TYPES.start, { id: 'start_b', next: push(2, { id: 'b_push' }) }),
      ],
    };
    const result = compileProgram({ program, challenge: openChallenge });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 失败结果里根本没有 `origins` 字段：界面不可能按半截来源表去定位。
    expect(Object.keys(result)).toEqual(['ok', 'errors']);
  });

  it('上限拒绝时不产出产物：tracker 里没有可定位的旧来源表', () => {
    const tracker = createArtifactTracker({ actions: 2 });
    const program = programOf([
      push(1, { id: 'p1' }),
      push(2, { id: 'p2' }),
      push(3, { id: 'p3' }),
    ]);
    expect(tracker.compile(program, openPublic)).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.state.errors).toEqual([
      { blockId: 'p3', message: '编译出的动作数超过上限 2，一次 submit 发不出去（04 §6）' },
    ]);
    // 无产物 → `stale` 必须是 false（没有东西可供过期，09 §8 第 8 条）。
    expect(tracker.state.stale).toBe(false);
  });

  it('动作数上限在**循环体内**溢出：错误指向溢出的那块积木，循环归因不掩盖它', () => {
    const program = programOf([
      repeat(2, [push(1, { id: 'body_push' })], { id: 'loop1' }),
    ]);
    const errors = errorsOf(
      compileProgram({ program, challenge: openChallenge }, { limits: { actions: 1 } }),
    );
    expect(errors).toEqual([
      { blockId: 'body_push', message: '编译出的动作数超过上限 1，一次 submit 发不出去（04 §6）' },
    ]);
  });

  it('循环展开超上限：错误指向循环积木本身，且没有部分动作泄漏出来', () => {
    const program = programOf([repeat(4, [push(1, { id: 'body_push' })], { id: 'loop1' })]);
    const errors = errorsOf(
      compileProgram({ program, challenge: openChallenge }, { limits: { loopUnroll: 3 } }),
    );
    expect(errors).toEqual([
      { blockId: 'loop1', message: '循环展开 4 次超过上限 3（05 §4）' },
    ]);
  });

  it('表达式求值超上限：已经编译出的动作不作数，来源表不随失败结果下发', () => {
    const tracker = createArtifactTracker({ exprEvalSteps: 1 });
    // 第一块的表达式花掉唯一一步；第二块的表达式会撞上限——错误指向**那个表达式积木**。
    const secondValue = num(2);
    const program = programOf([
      push(1, { id: 'p1' }),
      blk(BLOCK_TYPES.actionPush, { id: 'p2', inputs: { [INPUTS.value]: secondValue } }),
    ]);
    expect(tracker.compile(program, openPublic)).toBeUndefined();
    expect(tracker.state.artifact).toBeUndefined();
    expect(tracker.state.errors).toHaveLength(1);
    expect(tracker.state.errors[0]?.blockId).toBe(secondValue.id);
    expect(tracker.state.errors[0]?.message).toContain('表达式求值超过上限 1 步');
  });
});
