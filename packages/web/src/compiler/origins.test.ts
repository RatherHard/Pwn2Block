import { describe, expect, it } from 'vitest';
import { actionsForRequest, compileProgram } from './compile';
import type {
  CompileResult,
  CompilerChallenge,
  NormalizedBlock,
  NormalizedWorkspace,
} from './types';
import { ACTION_ORIGIN_VERSION, BLOCK_TYPES, INPUTS } from './types';

/**
 * 动作 → 积木来源表（08 §9.2）。
 *
 * 四条硬约定各自有用例：
 * 1. 与 `actions` 等长同序，`origins[i].index === i`，`blockId` 是画布上真实存在的积木 id；
 * 2. 循环展开出的每一个动作都指向循环积木本身（不是循环体里那一块）；
 * 3. 出题人积木的动作归到出题人积木上，不是它的子块；
 * 4. 来源表不进网络：请求体里只有 `actions`。
 * 另外重新编译必须重算来源表，不许跨编译复用旧数组。
 */

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
};

const authorChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['step', 'write_bytes'],
  authorBlocks: [
    {
      id: 'gets',
      label: 'gets(buf)',
      params: [{ name: 'data', type: 'bytes' }],
      expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
    },
  ],
};

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, fields: {}, inputs: {}, ...extras, type };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const push = (value: number, extras: Partial<NormalizedBlock> = {}): NormalizedBlock =>
  blk(BLOCK_TYPES.actionPush, { inputs: { [INPUTS.value]: num(value) }, ...extras });

/** 把一串积木用 `next` 连成语句链；空数组是用法错误，直接抛（别让 `undefined` 混进编译输入）。 */
function chainOf(chain: readonly NormalizedBlock[]): NormalizedBlock {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i] as NormalizedBlock;
    head = { ...current, next: head };
  }
  if (head === undefined) throw new Error('chainOf 需要至少一块积木');
  return head;
}

function programOf(chain: readonly NormalizedBlock[]): NormalizedWorkspace {
  return { blocks: [blk(BLOCK_TYPES.start, { next: chainOf(chain) })] };
}

function successOf(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result;
}

/** 画布上真实存在的积木 id（含输入槽与 next 链），用来验证来源表的 id 不是合成出来的。 */
function collectBlockIds(program: NormalizedWorkspace): ReadonlySet<string> {
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

/** 来源表的两条结构不变式：等长同序、id 真实存在。 */
function expectOriginsAligned(
  result: Extract<CompileResult, { ok: true }>,
  program: NormalizedWorkspace,
): void {
  expect(result.origins.length).toBe(result.actions.length);
  expect(result.originsVersion).toBe(ACTION_ORIGIN_VERSION);
  const ids = collectBlockIds(program);
  result.origins.forEach((origin, index) => {
    expect(origin.index).toBe(index);
    expect(origin.blockId).not.toBe('');
    expect(ids.has(origin.blockId)).toBe(true);
  });
}

describe('来源表：等长同序与真实 id', () => {
  it('每个动作都能定位到产生它的那块积木', () => {
    const program = programOf([
      blk(BLOCK_TYPES.actionStep, { id: 's1', inputs: { [INPUTS.count]: num(2) } }),
      push(0x41, { id: 'p1' }),
      blk(BLOCK_TYPES.actionRet, { id: 'r1' }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(result.actions).toHaveLength(3);
    expect(result.origins).toEqual([
      { index: 0, blockId: 's1' },
      { index: 1, blockId: 'p1' },
      { index: 2, blockId: 'r1' },
    ]);
    expectOriginsAligned(result, program);
  });

  it('空程序的来源表也是空表', () => {
    const program: NormalizedWorkspace = { blocks: [blk(BLOCK_TYPES.start, { id: 'start1' })] };
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(result.origins).toEqual([]);
    expect(result.originsVersion).toBe(ACTION_ORIGIN_VERSION);
  });
});

describe('来源表：循环展开归到循环积木', () => {
  const loopBody = (): NormalizedBlock => chainOf([push(1, { id: 'body_push' })]);

  it('repeat 展开的每一次迭代都指向 repeat 积木，而不是循环体那一块', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop1',
        inputs: { [INPUTS.times]: num(3), [INPUTS.body]: loopBody() },
      }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(result.actions).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
    ]);
    expect(result.origins).toEqual([
      { index: 0, blockId: 'loop1' },
      { index: 1, blockId: 'loop1' },
      { index: 2, blockId: 'loop1' },
    ]);
    expectOriginsAligned(result, program);
  });

  it('while 展开同理，循环外的动作仍指向自己的积木', () => {
    // while n < 3：循环体里 push 一次并把 n 加一，编译期展开三次（与 compile.test.ts 同一套路）。
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
              [INPUTS.b]: num(3),
            },
          }),
          [INPUTS.body]: chainOf([push(7, { id: 'while_body_push' }), increment]),
        },
      }),
      push(0x99, { id: 'after_loop' }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    expect(result.actions).toEqual([
      { type: 'push', value: '0x7' },
      { type: 'push', value: '0x7' },
      { type: 'push', value: '0x7' },
      { type: 'push', value: '0x99' },
    ]);
    expect(result.origins.map((origin) => origin.blockId)).toEqual([
      'while1',
      'while1',
      'while1',
      'after_loop',
    ]);
  });

  it('嵌套循环里，动作归到最内层循环积木', () => {
    const inner = blk(BLOCK_TYPES.controlsRepeat, {
      id: 'inner_loop',
      inputs: {
        [INPUTS.times]: num(2),
        [INPUTS.body]: chainOf([push(2, { id: 'inner_push' })]),
      },
    });
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'outer_loop',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([push(1, { id: 'outer_push' }), inner]),
        },
      }),
    ]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));
    // 外层两轮，每轮：push(1) 归外层，内层两次 push(2) 归内层。
    expect(result.actions).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x2' },
      { type: 'push', value: '0x2' },
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x2' },
      { type: 'push', value: '0x2' },
    ]);
    expect(result.origins.map((origin) => origin.blockId)).toEqual([
      'outer_loop',
      'inner_loop',
      'inner_loop',
      'outer_loop',
      'inner_loop',
      'inner_loop',
    ]);
  });
});

describe('来源表：出题人积木', () => {
  it('block 动作的来源是出题人积木本身，不是它的参数子块', () => {
    const program = programOf([
      blk('author_gets', {
        id: 'author1',
        inputs: {
          data: blk(BLOCK_TYPES.bytesRaw, { id: 'raw1', fields: { HEX: 'aabb' } }),
        },
      }),
    ]);
    const result = successOf(compileProgram({ program, challenge: authorChallenge }));
    expect(result.actions).toEqual([{ type: 'block', id: 'gets', args: { data: 'aabb' } }]);
    expect(result.origins).toEqual([{ index: 0, blockId: 'author1' }]);
    expectOriginsAligned(result, program);
  });
});

describe('来源表：不进网络 payload', () => {
  it('actionsForRequest 只给出动作，不含 origins / originsVersion', () => {
    const program = programOf([push(0x41, { id: 'p1' })]);
    const result = successOf(compileProgram({ program, challenge: openChallenge }));

    const actions = actionsForRequest(result);
    expect(actions).toEqual([{ type: 'push', value: '0x41' }]);
    expect(Object.keys(actions as object)).not.toContain('origins');

    // 直接当请求体发出去时，JSON 里只有动作。
    const body = JSON.stringify({ actions });
    expect(body).toBe('{"actions":[{"type":"push","value":"0x41"}]}');
    expect(body).not.toContain('origins');
    expect(body).not.toContain('blockId');
  });

  it('编译失败时没有可发的动作', () => {
    const result = compileProgram({
      program: { blocks: [push(1)] },
      challenge: openChallenge,
    });
    expect(result.ok).toBe(false);
    expect(actionsForRequest(result)).toEqual([]);
  });
});

describe('来源表：每次编译都是新的自洽产物', () => {
  it('两次编译的来源表不是同一个数组，改动旧产物不影响新产物', () => {
    const program = programOf([
      push(1, { id: 'p1' }),
      push(2, { id: 'p2' }),
    ]);
    const first = successOf(compileProgram({ program, challenge: openChallenge }));
    const second = successOf(compileProgram({ program, challenge: openChallenge }));

    expect(second.actions).toEqual(first.actions);
    expect(second.origins).toEqual(first.origins);
    expect(second.origins).not.toBe(first.origins);

    (first.origins as unknown[]).length = 0;
    expect(successOf(compileProgram({ program, challenge: openChallenge })).origins).toEqual([
      { index: 0, blockId: 'p1' },
      { index: 1, blockId: 'p2' },
    ]);
  });
});

describe('来源表：混合程序的归因与网络边界', () => {
  /** 这个 describe 要同时用到 `push` 与出题人积木，所以在公共挑战上补一个动作白名单。 */
  const mixedChallenge: CompilerChallenge = {
    ...authorChallenge,
    allowedActions: ['step', 'write_bytes', 'push'],
  };

  /** 循环里外都有动作，再接一块出题人积木：三类归因同时出现。 */
  const mixedProgram = (): NormalizedWorkspace =>
    programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop1',
        inputs: { [INPUTS.times]: num(2), [INPUTS.body]: chainOf([push(1, { id: 'body' })]) },
      }),
      blk('author_gets', {
        id: 'author1',
        inputs: { data: blk(BLOCK_TYPES.bytesRaw, { id: 'raw1', fields: { HEX: 'aabb' } }) },
      }),
    ]);

  it('循环展开归循环积木、循环外归自己、出题人积木归自己', () => {
    const program = mixedProgram();
    const result = successOf(compileProgram({ program, challenge: mixedChallenge }));
    expect(result.actions).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x1' },
      { type: 'block', id: 'gets', args: { data: 'aabb' } },
    ]);
    expect(result.origins).toEqual([
      { index: 0, blockId: 'loop1' },
      { index: 1, blockId: 'loop1' },
      { index: 2, blockId: 'author1' },
    ]);
    expectOriginsAligned(result, program);
  });

  it('循环体里的出题人积木：动作归到循环积木（循环展开的归因优先）', () => {
    const program = programOf([
      blk(BLOCK_TYPES.controlsRepeat, {
        id: 'loop1',
        inputs: {
          [INPUTS.times]: num(2),
          [INPUTS.body]: chainOf([
            blk('author_gets', {
              id: 'author1',
              inputs: { data: blk(BLOCK_TYPES.bytesRaw, { id: 'raw1', fields: { HEX: '41' } }) },
            }),
          ]),
        },
      }),
    ]);
    const result = successOf(compileProgram({ program, challenge: mixedChallenge }));
    expect(result.origins).toEqual([
      { index: 0, blockId: 'loop1' },
      { index: 1, blockId: 'loop1' },
    ]);
    expectOriginsAligned(result, program);
  });

  it('请求体只有动作：mixed 程序的 JSON 里没有 origins / blockId / index', () => {
    const result = successOf(
      compileProgram({ program: mixedProgram(), challenge: mixedChallenge }),
    );
    const body = JSON.stringify({ actions: actionsForRequest(result) });
    expect(body).toBe(
      '{"actions":[{"type":"push","value":"0x1"},{"type":"push","value":"0x1"},' +
        '{"type":"block","id":"gets","args":{"data":"aabb"}}]}',
    );
    for (const key of ['origins', 'originsVersion', 'blockId', '"index"']) {
      expect(body).not.toContain(key);
    }
  });

  it('来源表版本与常量一致，且永远不是空串 id', () => {
    const result = successOf(
      compileProgram({ program: mixedProgram(), challenge: mixedChallenge }),
    );
    expect(result.originsVersion).toBe(ACTION_ORIGIN_VERSION);
    expect(result.originsVersion).toBe(1);
    for (const origin of result.origins) {
      expect(origin.blockId).not.toBe('');
    }
  });
});
