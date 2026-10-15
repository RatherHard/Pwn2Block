import { describe, expect, it } from 'vitest';
import { describeError, type AuthorBlock } from '@pwn2block/shared';
import { compileProgram } from './compile';
import type { CompileResult, CompilerChallenge, NormalizedBlock, NormalizedWorkspace } from './types';
import {
  BLOCK_TYPES,
  FORBIDDEN_STATE_BLOCK_TYPES,
  INPUTS,
  MESSAGE_READS_STATE,
  authorBlockType,
} from './types';
import { BLOCK_SPECS, blocksForChallenge } from '../blocks/catalog';
import { toolboxBlockTypes } from '../blocks/toolbox';

/**
 * 禁止读状态（05 §4、07 §5 S04）。
 *
 * 三条要求：
 * 1. 工具箱里**根本没有**这类积木（`catalog.ts` 不生成，定义也就无从注册）；
 * 2. 旧存档 / 手写树 / 未来误加进来的保留类型名，只要参与编译就报 `MESSAGE_READS_STATE`，
 *    绝不是"静默当 0"；
 * 3. 文案与 shared 的 `reads_state` 语义一致，学习者看到的解释与安全语义不分叉。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

/** 保留的读状态积木：旧存档里可能长这样。 */
const stateBlock = (type: string, id?: string): NormalizedBlock =>
  blk(type, { ...(id === undefined ? {} : { id }), fields: { REG: 'RSP' } });

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

function errorsOf(result: CompileResult): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

describe('禁止读状态：保留类型名一律编译报错（05 §4）', () => {
  it('保留清单非空，且每一个在语句位置都被拒、错误指向那块积木', () => {
    expect(FORBIDDEN_STATE_BLOCK_TYPES.length).toBeGreaterThan(0);
    for (const type of FORBIDDEN_STATE_BLOCK_TYPES) {
      const result = compileProgram({
        program: programOf([stateBlock(type, 'legacy')]),
        challenge: openChallenge,
      });
      expect(errorsOf(result), `保留类型 ${type} 没有被拒`).toEqual([
        { blockId: 'legacy', message: MESSAGE_READS_STATE },
      ]);
    }
  });

  it('接在值输入槽上（push 的值）同样被拒', () => {
    const forbidden = stateBlock('state_get_sp', 'sp1');
    const result = compileProgram({
      program: programOf([
        blk(BLOCK_TYPES.actionPush, { id: 'push1', inputs: { [INPUTS.value]: forbidden } }),
      ]),
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([{ blockId: 'sp1', message: MESSAGE_READS_STATE }]);
  });

  it('接在字节输入槽上（feed 的字节）同样被拒', () => {
    const forbidden = stateBlock('state_read_memory', 'mem1');
    const result = compileProgram({
      program: programOf([
        blk(BLOCK_TYPES.actionFeed, { id: 'feed1', inputs: { [INPUTS.bytes]: forbidden } }),
      ]),
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([{ blockId: 'mem1', message: MESSAGE_READS_STATE }]);
  });

  it('藏在拼接 / 循环条件 / 循环体 / 分支里都会被拒，错误指向读状态那块', () => {
    const inConcat = stateBlock('state_read_reg', 'concat_item');
    const concat = blk(BLOCK_TYPES.actionFeed, {
      id: 'feed1',
      inputs: {
        [INPUTS.bytes]: blk(BLOCK_TYPES.bytesConcat, {
          inputs: { item0: blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: '41' } }), item1: inConcat },
        }),
      },
    });
    expect(errorsOf(compileProgram({ program: programOf([concat]), challenge: openChallenge }))).toEqual(
      [{ blockId: 'concat_item', message: MESSAGE_READS_STATE }],
    );

    const inCondition = stateBlock('state_get_ip', 'cond_item');
    const loop = blk(BLOCK_TYPES.controlsWhileUntil, {
      id: 'while1',
      fields: { MODE: 'WHILE' },
      inputs: {
        [INPUTS.bool]: inCondition,
        [INPUTS.body]: chainOf([blk(BLOCK_TYPES.actionRet, { id: 'body' })]),
      },
    });
    expect(errorsOf(compileProgram({ program: programOf([loop]), challenge: openChallenge }))).toEqual([
      { blockId: 'cond_item', message: MESSAGE_READS_STATE },
    ]);

    const inBody = stateBlock('state_get_bp', 'body_item');
    const repeat = blk(BLOCK_TYPES.controlsRepeat, {
      id: 'repeat1',
      inputs: { [INPUTS.times]: num(2), [INPUTS.body]: chainOf([inBody]) },
    });
    expect(
      errorsOf(compileProgram({ program: programOf([repeat]), challenge: openChallenge })),
    ).toEqual([{ blockId: 'body_item', message: MESSAGE_READS_STATE }]);

    const inBranch = stateBlock('state_read_stdin', 'branch_item');
    const branch = blk(BLOCK_TYPES.controlsIf, {
      id: 'if1',
      inputs: {
        [INPUTS.if0]: num(1),
        [INPUTS.do0]: chainOf([
          blk(BLOCK_TYPES.actionPush, { id: 'push1', inputs: { [INPUTS.value]: inBranch } }),
        ]),
      },
    });
    expect(
      errorsOf(compileProgram({ program: programOf([branch]), challenge: openChallenge })),
    ).toEqual([{ blockId: 'branch_item', message: MESSAGE_READS_STATE }]);
  });

  it('手写树里读状态积木接在「开始」下面：编译失败且不产生任何可用动作', () => {
    const result = compileProgram({
      program: programOf([stateBlock('state_read_reg', 'legacy'), blk(BLOCK_TYPES.actionRet)]),
      challenge: openChallenge,
    });
    expect(result.ok).toBe(false);
    // 失败结果里没有 actions 字段：不存在"前面那块编译出来了"的半截产物。
    expect(Object.keys(result)).toEqual(['ok', 'errors']);
  });

  it('离散（没连到「开始」积木）的读状态积木不参与编译，也不报错（05 §3.1）', () => {
    // 与"未连到开始积木的积木不报错"是同一个口径：编译器只沿着开始积木往下看。
    const result = compileProgram({
      program: {
        blocks: [blk(BLOCK_TYPES.start, { id: 'start1' }), stateBlock('state_read_reg', 'loose')],
      },
      challenge: openChallenge,
    });
    expect(result).toEqual({ ok: true, actions: [], origins: [], originsVersion: 1 });
  });

  it('文案与 shared 的 reads_state 语义一致（同一条安全口径，不分叉）', () => {
    const sharedMessage = describeError('reads_state');
    expect(sharedMessage).toContain('payload 不能');
    expect(sharedMessage).toContain('状态');
    expect(MESSAGE_READS_STATE).toContain('payload 不能');
    expect(MESSAGE_READS_STATE).toContain('状态');
    expect(MESSAGE_READS_STATE).toContain('回放');
  });
});

describe('禁止读状态：工具箱与积木定义里根本没有这些积木', () => {
  /** 出题人积木 id 能起成 `read_reg`，但类型名是 `author_read_reg`，撞不上保留名。 */
  const authorBlocks: readonly AuthorBlock[] = FORBIDDEN_STATE_BLOCK_TYPES.map((type, index) => ({
    id: type.replace('state_', '').replace(/_/g, ''),
    label: `伪装 ${index}`,
    params: [],
    expand: [{ type: 'step', count: 1 }],
  }));

  it('catalog 的静态积木里一个保留类型都没有', () => {
    for (const spec of BLOCK_SPECS) {
      expect(FORBIDDEN_STATE_BLOCK_TYPES).not.toContain(spec.type);
    }
  });

  it('工具箱（含出题人积木）与保留名的交集为空', () => {
    const types = toolboxBlockTypes({
      allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
      authorBlocks,
    });
    // 出题人积木确实都生成了（否则"交集为空"是白捡的）。
    expect(types.filter((type) => type.startsWith('author_'))).toHaveLength(authorBlocks.length);
    for (const type of types) {
      expect(FORBIDDEN_STATE_BLOCK_TYPES).not.toContain(type);
    }
  });

  it('目录生成的积木集合与保留名无关：禁止清单里的名字永远不是积木类型', () => {
    const generated = new Set([
      ...BLOCK_SPECS.map((spec) => spec.type),
      ...blocksForChallenge({ allowedActions: [], authorBlocks }).map((spec) => spec.type),
    ]);
    for (const forbidden of FORBIDDEN_STATE_BLOCK_TYPES) {
      expect(generated.has(forbidden)).toBe(false);
      // 出题人积木那份也撞不上：前缀是 author_，保留名都以 state_ 开头。
      expect(authorBlockType(forbidden.slice('state_'.length))).not.toBe(forbidden);
    }
  });
});
