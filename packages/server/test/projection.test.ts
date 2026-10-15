import { describe, expect, it } from 'vitest';
import type { SubmitOutcome, VmState } from '@pwn2block/shared';
import { HIDDEN_KEY_HEX, makeFakeRuntime, padded, testPrivate, testPublic } from './support';
import { createProjectionContext, projectReplay, projectState } from '../src/projection';

/**
 * 投影的精确断言：不做模糊匹配，逐字段钉住返回对象。
 * 样例是 shared 的 ret2win（03 §4），VMA 内容按 patch 补齐后按字节精确比对。
 */

const TEXT_PATCH = 'c9c30f0e';
const TEXT_HEX = padded(TEXT_PATCH, 0x1000);

const STACK_PATCH = '40ffff7f000000000300400000000000';
const STACK_OFFSET = 0x7fffff10 - 0x7fffe000;
const STACK_HEX = padded('00'.repeat(STACK_OFFSET) + STACK_PATCH, 0x2000);

/** ret2win 初态的完整投影（04 §4）。 */
const INITIAL_PROJECTION = {
  status: 'ready',
  steps: 0,
  failures: 0,
  registers: [
    { name: 'RAX', value: '0x0' },
    { name: 'RDI', value: '0x0' },
    { name: 'RSP', value: '0x7fffff00' },
    { name: 'RBP', value: '0x7fffff10' },
    { name: 'RIP', value: '0x400000' },
    { name: 'FLAG', value: '0x0' },
  ],
  flags: { ZF: false, CF: false, SF: false },
  vmas: [
    {
      id: 'text',
      kind: 'code',
      start: '0x400000',
      size: '0x1000',
      perm: 'rx',
      hidden: false,
      hex: TEXT_HEX,
    },
    {
      id: 'stack',
      kind: 'stack',
      start: '0x7fffe000',
      size: '0x2000',
      perm: 'rw',
      hidden: false,
      hex: STACK_HEX,
    },
    { id: 'key', kind: 'key', start: '0x600000', size: '0x1000', perm: 'r', hidden: true },
  ],
  stdin: { hex: '', pos: 0 },
  stdout: { hex: '' },
  disasm: [{ addr: '0x400000', bytes: 'c9', text: 'leave' }],
} as const;

const DISASM = [
  { addr: '0x400000', bytes: 'c9', text: 'leave' },
  { addr: '0x600000', bytes: '0f', text: '隐藏区的指令不该出现' },
  { addr: '0x7fffff00', bytes: '41', text: '栈不可执行' },
];

function contextOf(options: Parameters<typeof makeFakeRuntime>[0] = {}) {
  const { runtime } = makeFakeRuntime(options);
  return { runtime, ctx: createProjectionContext(runtime) };
}

describe('公开投影（04 §4）', () => {
  it('ret2win 样例的初态投影逐字段精确匹配', () => {
    const { runtime, ctx } = contextOf({ disasm: DISASM });
    expect(projectState(ctx, runtime.initialState(), 0)).toEqual(INITIAL_PROJECTION);
  });

  it('隐藏 VMA 只给布局：没有 hex，hidden 为 true', () => {
    const { runtime, ctx } = contextOf();
    const projection = projectState(ctx, runtime.initialState(), 0);
    expect(projection.vmas[2]).toEqual({
      id: 'key',
      kind: 'key',
      start: '0x600000',
      size: '0x1000',
      perm: 'r',
      hidden: true,
    });
  });

  it('reveal 之后的隐藏 VMA 变成 hidden:false 并带上 hex', () => {
    const { runtime, ctx } = contextOf({ revealed: ['key'] });
    const state = runtime.initialState();
    expect(projectState(ctx, state, 0).vmas[2]).toEqual({
      id: 'key',
      kind: 'key',
      start: '0x600000',
      size: '0x1000',
      perm: 'r',
      hidden: false,
      hex: padded(HIDDEN_KEY_HEX, 0x1000),
    });
  });

  it('投影里没有 flag / win / fail / 隐藏内容 / 虚拟文件内容', () => {
    const { runtime, ctx } = contextOf();
    const projection = projectState(ctx, runtime.initialState(), 7);
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(HIDDEN_KEY_HEX);
    expect(serialized.toLowerCase()).not.toContain('flag{');
    expect(projection).not.toHaveProperty('flag');
    expect(projection).not.toHaveProperty('win');
    expect(projection).not.toHaveProperty('fail');
    expect(projection).not.toHaveProperty('files');
    expect(projection.failures).toBe(7);
    // 白名单：投影的顶层字段就是这个集合，多一个都算回归。
    expect(Object.keys(projection).sort()).toEqual(
      ['disasm', 'failures', 'flags', 'registers', 'status', 'stdin', 'stdout', 'steps', 'vmas'].sort(),
    );
  });

  it('题目未声明 stdin / stdout 时这两个字段不出现', () => {
    const { runtime, ctx } = contextOf({ publicPkg: testPublic({ fds: undefined }) });
    const projection = projectState(ctx, runtime.initialState(), 0);
    expect(projection).not.toHaveProperty('stdin');
    expect(projection).not.toHaveProperty('stdout');
  });

  it('disasm 只覆盖非隐藏的可执行区（02 §4）', () => {
    const { runtime, ctx } = contextOf({ disasm: DISASM });
    expect(projectState(ctx, runtime.initialState(), 0).disasm).toEqual([
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
    ]);
  });

  it('隐藏区没有被 reveal 时反汇编整个为空', () => {
    const { runtime, ctx } = contextOf({
      disasm: DISASM,
      privatePkg: testPrivate({
        vmas: testPrivate().vmas.map((vma) =>
          vma.id === 'text' ? { ...vma, hidden: true } : vma,
        ),
      }),
    });
    expect(projectState(ctx, runtime.initialState(), 0).disasm).toEqual([]);
  });

  it('错误文案来自 describeError，note 来自题目 errorNotes，detail 不下发', () => {
    const { runtime, ctx } = contextOf();
    const withNote: VmState = {
      ...runtime.initialState(),
      status: 'failed',
      lastStop: { reason: 'exception', addr: 0x400000n },
      error: { code: 'hidden_address', addr: 0x600000n, detail: '不该出现的补充信息' },
    };
    const projection = projectState(ctx, withNote, 1);
    expect(projection.error).toEqual({
      code: 'hidden_address',
      message: '目标落在隐藏区域，直接动作不能读写隐藏内容（地址 0x600000）',
      note: '这块内存只能让程序自己去读',
    });
    expect(JSON.stringify(projection)).not.toContain('不该出现的补充信息');
    expect(projection.lastStop).toEqual({ reason: 'exception', addr: '0x400000' });
  });

  it('题目没写 errorNotes 的错误码没有 note', () => {
    const { runtime, ctx } = contextOf();
    const failed: VmState = {
      ...runtime.initialState(),
      status: 'failed',
      error: { code: 'invalid_instruction', detail: '0xff' },
    };
    expect(projectState(ctx, failed, 1).error).toEqual({
      code: 'invalid_instruction',
      message: '无法解码的指令或未声明的调用号',
    });
  });
});

describe('回放录像（04 §5.1）', () => {
  it('首帧是完整投影，后续帧只带发生变化的 VMA', () => {
    const { runtime, ctx } = contextOf({ disasm: DISASM });
    const init = runtime.initialState();
    const stepped: VmState = { ...init, steps: 1 };
    const revealed: VmState = { ...stepped, steps: 2, revealed: ['key'] };
    const outcome: SubmitOutcome = {
      verdict: 'incomplete',
      executed: 2,
      results: [
        { ok: true, action: 'step' },
        { ok: true, action: 'step' },
      ],
      frames: [
        { kind: 'init', label: '初始状态', state: init },
        { kind: 'action', label: '动作 1：step', state: stepped },
        { kind: 'action', label: '动作 2：step', state: revealed },
      ],
      finalState: revealed,
    };

    const replay = projectReplay(ctx, outcome);
    expect(replay.initial).toEqual(INITIAL_PROJECTION);
    expect(replay.frames).toHaveLength(2);
    expect(replay.frames[0]?.changedVmas).toEqual([]);
    expect(replay.frames[0]?.steps).toBe(1);
    expect(replay.frames[0]?.index).toBe(0);
    expect(replay.frames[0]?.kind).toBe('action');
    expect(replay.frames[1]?.changedVmas).toEqual([
      {
        id: 'key',
        kind: 'key',
        start: '0x600000',
        size: '0x1000',
        perm: 'r',
        hidden: false,
        hex: padded(HIDDEN_KEY_HEX, 0x1000),
      },
    ]);
    expect(JSON.stringify(replay)).not.toContain('不该出现');
  });
});
