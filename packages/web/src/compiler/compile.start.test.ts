import { describe, expect, it } from 'vitest';
import { compileProgram } from './compile';
import type { CompileResult, CompilerChallenge, NormalizedBlock, NormalizedWorkspace } from './types';
import {
  ACTION_ORIGIN_VERSION,
  BLOCK_TYPES,
  INPUTS,
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
  MESSAGE_START_BLOCK_HAS_PREVIOUS,
} from './types';

/**
 * 「开始」积木与离散块的编译入口契约（05 §3.1，`types.ts` 里写的是同一条规则）。
 *
 * 这里逐条钉死三件事，UI 文案与高亮都依赖它们：
 * 1. 只能有一个顶层「开始」积木，程序从它往下编译；
 * 2. 「开始」积木不许有上一个连接（不能出现在别人的输入槽或 next 链里）；
 * 3. 未连到「开始」积木的离散块既不产生动作、**也不产生错误**。
 */

const openChallenge: CompilerChallenge = {
  archBits: 64,
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
  authorBlocks: [],
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

function errorsOf(result: CompileResult): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error(`期望编译失败，实际成功：${JSON.stringify(result.actions)}`);
  return result.errors;
}

describe('编译入口：唯一开始积木', () => {
  it('没有开始积木时报错，blockId 是空串', () => {
    const result = compileProgram({
      program: { blocks: [push(0x41), blk(BLOCK_TYPES.actionRet)] },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([{ blockId: '', message: MESSAGE_NO_START_BLOCK }]);
  });

  it('两个顶层开始积木：每块各报一条，并指出各自的 id', () => {
    const first = blk(BLOCK_TYPES.start, { id: 'start_a', next: push(1) });
    const second = blk(BLOCK_TYPES.start, { id: 'start_b', next: push(2) });
    const result = compileProgram({
      program: { blocks: [first, second] },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 'start_a', message: MESSAGE_MULTIPLE_START_BLOCKS },
      { blockId: 'start_b', message: MESSAGE_MULTIPLE_START_BLOCKS },
    ]);
  });

  it('开始积木出现在别人的 next 链里（有上一个连接）时报错，不再报"缺少开始积木"', () => {
    const nested = blk(BLOCK_TYPES.start, { id: 'nested_start', next: push(1) });
    const result = compileProgram({
      program: { blocks: [blk(BLOCK_TYPES.actionRet, { id: 'outer', next: nested })] },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 'nested_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
    ]);
  });

  it('开始积木被接到输入槽里也报同一条错', () => {
    const nested = blk(BLOCK_TYPES.start, { id: 'nested_start' });
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.actionPush, { id: 'push_with_start', inputs: { [INPUTS.value]: nested } }),
        ],
      },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 'nested_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
    ]);
  });

  it('一个合法开始块 + 一个错位的开始块：只报错位那块，且不产出动作', () => {
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, { id: 'ok_start', next: push(0x41) }),
          blk(BLOCK_TYPES.actionRet, {
            id: 'outer',
            next: blk(BLOCK_TYPES.start, { id: 'nested_start' }),
          }),
        ],
      },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 'nested_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
    ]);
  });

  it('两个顶层 + 一个错位：三种违规各自报到具体积木', () => {
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, { id: 'top_a' }),
          blk(BLOCK_TYPES.start, { id: 'top_b' }),
          blk(BLOCK_TYPES.actionRet, {
            id: 'outer',
            next: blk(BLOCK_TYPES.start, { id: 'nested_start' }),
          }),
        ],
      },
      challenge: openChallenge,
    });
    expect(errorsOf(result)).toEqual([
      { blockId: 'nested_start', message: MESSAGE_START_BLOCK_HAS_PREVIOUS },
      { blockId: 'top_a', message: MESSAGE_MULTIPLE_START_BLOCKS },
      { blockId: 'top_b', message: MESSAGE_MULTIPLE_START_BLOCKS },
    ]);
  });
});

describe('编译入口：离散块不参与编译', () => {
  it('没连到开始积木的积木不产生动作', () => {
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, {
            id: 'start1',
            next: blk(BLOCK_TYPES.actionStep, {
              id: 'step1',
              inputs: { [INPUTS.count]: num(1) },
            }),
          }),
          push(0xdead, { id: 'discrete1' }),
          blk(BLOCK_TYPES.actionPush, {
            id: 'discrete2',
            inputs: { [INPUTS.value]: num(0xbeef) },
          }),
        ],
      },
      challenge: openChallenge,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('期望编译成功');
    expect(result.actions).toEqual([{ type: 'step', count: 1 }]);
    expect(result.origins).toEqual([{ index: 0, blockId: 'step1' }]);
    expect(result.originsVersion).toBe(ACTION_ORIGIN_VERSION);
  });

  it('离散块自己有问题也不报错：不参与编译就是"看不见"（05 §3.1）', () => {
    const result = compileProgram({
      program: {
        blocks: [
          blk(BLOCK_TYPES.start, { id: 'start1' }),
          // 未知类型
          blk('totally_unknown', { id: 'discrete_unknown' }),
          // 缺少必需输入
          blk(BLOCK_TYPES.actionWriteBytes, { id: 'discrete_missing_input' }),
          // 不允许的动作
          blk(BLOCK_TYPES.actionRet, { id: 'discrete_ret' }),
          // 读状态类保留类型
          blk('state_read_reg', { id: 'discrete_state', fields: { REG: 'RSP' } }),
        ],
      },
      challenge: { ...openChallenge, allowedActions: ['step'] },
    });
    expect(result).toEqual({
      ok: true,
      actions: [],
      origins: [],
      originsVersion: ACTION_ORIGIN_VERSION,
    });
  });

  it('同一条链上的积木按顺序编译（开始块下面不是只有一块）', () => {
    const chain: NormalizedWorkspace = {
      blocks: [
        blk(BLOCK_TYPES.start, {
          id: 'start1',
          next: blk(BLOCK_TYPES.actionPush, {
            id: 'p1',
            inputs: { [INPUTS.value]: num(1) },
            next: blk(BLOCK_TYPES.actionPush, {
              id: 'p2',
              inputs: { [INPUTS.value]: num(2) },
              next: blk(BLOCK_TYPES.actionRet, { id: 'r1' }),
            }),
          }),
        }),
      ],
    };
    const result = compileProgram({ program: chain, challenge: openChallenge });
    if (!result.ok) throw new Error('期望编译成功');
    expect(result.actions).toEqual([
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x2' },
      { type: 'ret' },
    ]);
    expect(result.origins).toEqual([
      { index: 0, blockId: 'p1' },
      { index: 1, blockId: 'p2' },
      { index: 2, blockId: 'r1' },
    ]);
  });
});
