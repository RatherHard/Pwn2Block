import { describe, expect, it } from 'vitest';
import { compileProgram } from './compile';
import type { CompileResult, CompilerChallenge, NormalizedBlock, NormalizedWorkspace } from './types';
import {
  BLOCK_TYPES,
  INPUTS,
  MAX_COMPILE_ERRORS,
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
  MESSAGE_READS_STATE,
  MESSAGE_START_BLOCK_HAS_PREVIOUS,
} from './types';

/**
 * 错误定位（05 §4、09 §3.2）。
 *
 * UI 把每条错误按 `blockId` 高亮到画布上的积木，所以这里守三条：
 * 1. 每条错误的 `blockId` 都是**画布上真实存在**的积木 id（唯一的例外是"一个开始积木都没有"——
 *    那时没有位置可指，契约就规定是空串，见 `compiler/types.ts`）；
 * 2. 错误条数不超过 `MAX_COMPILE_ERRORS`，且同一块积木的同一句话不重复刷屏；
 * 3. 重新编译（积木被删掉之后）不会带出上一层树的过期 id。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const ret = (extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionRet, extras);

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

function compile(program: NormalizedWorkspace, challenge = openChallenge): CompileResult {
  return compileProgram({ program, challenge });
}

function errorsOf(result: CompileResult): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

/** 画布上真实存在的积木 id（含输入槽与 next 链）。 */
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
 * 断言每一条错误都能定位到画布上的真实积木。
 * 空串只允许出现在"没有开始积木"那一条上（契约明写的例外）。
 */
function expectErrorsLocatable(result: CompileResult, program: NormalizedWorkspace): void {
  const errors = errorsOf(result);
  const ids = canvasIds(program);
  expect(errors.length).toBeLessThanOrEqual(MAX_COMPILE_ERRORS);
  for (const error of errors) {
    if (error.blockId === '') {
      expect(error.message).toBe(MESSAGE_NO_START_BLOCK);
      continue;
    }
    expect(ids.has(error.blockId), `错误指向画布上不存在的积木：${error.blockId}`).toBe(true);
  }
}

describe('错误定位：blockId 指向真实画布积木', () => {
  it('顶层多处错误各自定位到出错的那块积木', () => {
    const program = programOf([
      blk('bad_one', { id: 'b1' }),
      ret({ id: 'ok1' }),
      blk('bad_two', { id: 'b2' }),
      blk('bad_three', { id: 'b3' }),
    ]);
    const result = compile(program);
    expect(errorsOf(result).map((error) => error.blockId)).toEqual(['b1', 'b2', 'b3']);
    expectErrorsLocatable(result, program);
  });

  it('嵌套错误：循环体 → 分支体 → 输入槽深处的错，定位到最深那一块', () => {
    const deep = blk(BLOCK_TYPES.bytesRaw, { id: 'deep_raw', fields: { HEX: 'abc' } });
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'outer',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([
            blk(BLOCK_TYPES.controlsIf, {
              id: 'branch',
              inputs: {
                [INPUTS.if0]: num(1),
                [INPUTS.do0]: chainOf([
                  blk(BLOCK_TYPES.actionFeed, { id: 'feed', inputs: { [INPUTS.bytes]: deep } }),
                ]),
              },
            }),
          ]),
        },
      }),
    ]);
    const errors = errorsOf(compile(program));
    expect(errors).toEqual([
      { blockId: 'deep_raw', message: 'raw 需要偶数个十六进制字符（无 0x 前缀），收到 "abc"' },
    ]);
    expectErrorsLocatable(compile(program), program);
  });

  it('循环里的重复错误只进列表一次：一块坏积木不会刷满 16 条（05 §4）', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop',
        inputs: {
          [INPUTS.times]: num(8),
          [INPUTS.body]: chainOf([blk('state_read_reg', { id: 'bad' })]),
        },
      }),
    ]);
    expect(errorsOf(compile(program))).toEqual([{ blockId: 'bad', message: MESSAGE_READS_STATE }]);
  });

  it('while 循环体报错后不再继续展开，也不会多报一条误导性的"展开超上限"', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsWhileUntil, {
        id: 'while',
        fields: { MODE: 'WHILE' },
        inputs: {
          [INPUTS.bool]: num(1),
          [INPUTS.body]: chainOf([blk('state_get_sp', { id: 'bad' })]),
        },
      }),
    ]);
    expect(errorsOf(compile(program))).toEqual([{ blockId: 'bad', message: MESSAGE_READS_STATE }]);
  });

  it('错误条数不超过 MAX_COMPILE_ERRORS，超出的部分按顺序截断', () => {
    expect(MAX_COMPILE_ERRORS).toBe(16);
    const bad = Array.from({ length: 20 }, (_unused, index) =>
      blk('bad_block', { id: `bad_${index}` }),
    );
    const program = programOf(bad);
    const errors = errorsOf(compile(program));
    expect(errors).toHaveLength(MAX_COMPILE_ERRORS);
    expect(errors.map((error) => error.blockId)).toEqual(
      Array.from({ length: MAX_COMPILE_ERRORS }, (_unused, index) => `bad_${index}`),
    );
    expectErrorsLocatable(compile(program), program);
  });
});

describe('错误定位：开始积木相关（05 §3.1）', () => {
  it('一个开始积木都没有：唯一一条错误用空串（没有具体位置可指）', () => {
    const program: NormalizedWorkspace = { blocks: [ret({ id: 'loose' })] };
    expect(errorsOf(compile(program))).toEqual([
      { blockId: '', message: MESSAGE_NO_START_BLOCK },
    ]);
    expectErrorsLocatable(compile(program), program);
  });

  it('两个顶层开始积木：两块各报一条，都指向自己', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, { id: 's1' }),
        blk(BLOCK_TYPES.start, { id: 's2', next: ret({ id: 'r1' }) }),
      ],
    };
    expect(errorsOf(compile(program))).toEqual([
      { blockId: 's1', message: MESSAGE_MULTIPLE_START_BLOCKS },
      { blockId: 's2', message: MESSAGE_MULTIPLE_START_BLOCKS },
    ]);
    expectErrorsLocatable(compile(program), program);
  });

  it('开始积木出现在别的积木下面：只报那一条更精确的错，不再报"缺开始积木"', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.controlsIf, {
          id: 'if1',
          inputs: {
            [INPUTS.if0]: num(1),
            [INPUTS.do0]: chainOf([blk(BLOCK_TYPES.start, { id: 'nested_start' })]),
          },
        }),
      ],
    };
    expect(errorsOf(compile(program))).toEqual([
      { blockId: 'nested_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
    ]);
    expectErrorsLocatable(compile(program), program);
  });

  it('一个顶层 + 一个嵌套：只报嵌套那一条（顶层那块不用再挨骂）', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, { id: 'top_start' }),
        ret({
          id: 'chain',
          next: blk(BLOCK_TYPES.start, { id: 'chained_start' }),
        }),
      ],
    };
    expect(errorsOf(compile(program))).toEqual([
      { blockId: 'chained_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
    ]);
    expectErrorsLocatable(compile(program), program);
  });

  it('只有一个嵌套开始积木时也不额外报"缺开始积木"', () => {
    const program: NormalizedWorkspace = {
      blocks: [ret({ id: 'chain', next: blk(BLOCK_TYPES.start, { id: 'chained_start' }) })],
    };
    expect(errorsOf(compile(program)).map((error) => error.blockId)).toEqual(['chained_start']);
    expectErrorsLocatable(compile(program), program);
  });

  it('开始积木与其它错误混在一起时，两类错误各就各位', () => {
    const program: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, { id: 's1', next: blk('bad_block', { id: 'bad' }) }),
        blk(BLOCK_TYPES.start, { id: 's2' }),
      ],
    };
    // 两个开始积木：先报开始块的两条；此时已经出错，程序本身不编译（坏积木那条不出现）。
    expect(errorsOf(compile(program))).toEqual([
      { blockId: 's1', message: MESSAGE_MULTIPLE_START_BLOCKS },
      { blockId: 's2', message: MESSAGE_MULTIPLE_START_BLOCKS },
    ]);
    expectErrorsLocatable(compile(program), program);
  });
});

describe('错误定位：没有过期 id', () => {
  it('积木被删掉之后重新编译，错误里不再出现上一棵树的 id', () => {
    const withBad = programOf([blk('bad_block', { id: 'will_disappear' })]);
    expect(errorsOf(compile(withBad))[0]?.blockId).toBe('will_disappear');

    // 学习者把坏积木删了，换上一块别的错积木——旧 id 不能留在新结果里。
    const replaced = programOf([blk('other_bad', { id: 'still_here' })]);
    const errors = errorsOf(compile(replaced));
    expect(errors.map((error) => error.blockId)).toEqual(['still_here']);
    expect(errors.map((error) => error.blockId)).not.toContain('will_disappear');
    expectErrorsLocatable(compile(replaced), replaced);
  });

  it('每次编译的结果互不影响：改一份结果的数组不会污染下一次', () => {
    const program = programOf([blk('bad_block', { id: 'bad' })]);
    const first = compile(program);
    if (first.ok) throw new Error('期望编译失败');
    (first.errors as unknown[]).length = 0;
    expect(errorsOf(compile(program))).toEqual([
      { blockId: 'bad', message: '未知积木类型：bad_block' },
    ]);
  });
});
