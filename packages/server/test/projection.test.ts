import { describe, expect, it } from 'vitest';
import { PublicChallengeSchema, describeError } from '@pwn2block/shared';
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
  // 角色寄存器名随投影下发（04 §4、09 §4）：来源是私有包，但属于固定的已知信息。
  roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
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
      [
        'disasm',
        'failures',
        'flags',
        'registers',
        'roles',
        'status',
        'stdin',
        'stdout',
        'steps',
        'vmas',
      ].sort(),
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

  it('隐藏的 x 区域即使可执行也不进反汇编，reveal 之后才出现', () => {
    // 把隐藏的 key 区改成可执行（perm 'rx'）：隐藏优先于可执行，未 reveal 前一条都不该出现。
    const execHidden = testPrivate({
      vmas: testPrivate().vmas.map((vma) =>
        vma.id === 'key' ? { ...vma, perm: 'rx' as const } : vma,
      ),
    });
    const entries = [
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
      { addr: '0x600000', bytes: '0f', text: '隐藏的可执行区' },
    ];
    const hidden = contextOf({ disasm: entries, privatePkg: execHidden });
    expect(projectState(hidden.ctx, hidden.runtime.initialState(), 0).disasm).toEqual([
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
    ]);

    const revealed = contextOf({ disasm: entries, privatePkg: execHidden, revealed: ['key'] });
    expect(projectState(revealed.ctx, revealed.runtime.initialState(), 0).disasm).toEqual([
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
      { addr: '0x600000', bytes: '0f', text: '隐藏的可执行区' },
    ]);
  });

  it('落在任何 VMA 之外的地址不进反汇编', () => {
    const { runtime, ctx } = contextOf({
      disasm: [
        { addr: '0x400000', bytes: 'c9', text: 'leave' },
        { addr: '0x1234', bytes: '90', text: '未映射地址' },
        { addr: '0x7fffff00', bytes: '41', text: '栈不可执行' },
        { addr: '0xb00000', bytes: '90', text: '映射表之外' },
      ],
    });
    expect(projectState(ctx, runtime.initialState(), 0).disasm).toEqual([
      { addr: '0x400000', bytes: 'c9', text: 'leave' },
    ]);
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

/** 递归收集对象 / 数组里出现过的所有字段名（与 S01 字段白名单同一条思路，直接扫真实返回值）。 */
function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** 投影 / 录像里一律不允许出现的字段名：私有内容与判胜谓词的载体（01 §6 第 2、3 条）。 */
const FORBIDDEN_KEYS = [
  'flag',
  'win',
  'fail',
  'files',
  'fileContents',
  'private',
  'privateChallenge',
  'solution',
  'init',
  'content',
  'detail',
] as const;

describe('roles 随投影下发（04 §4、09 §4）', () => {
  it('值逐字段取自私有包声明，且只有 sp / bp / ip 三个键', () => {
    const priv = testPrivate();
    const { runtime, ctx } = contextOf({ privatePkg: priv });
    const projection = projectState(ctx, runtime.initialState(), 0);

    expect(projection.roles).toEqual(priv.roles);
    expect(Object.keys(projection.roles).sort()).toEqual(['bp', 'ip', 'sp']);
    // 三个名字都必须是题目声明过的寄存器，否则前端根本标不出来。
    const names = projection.registers.map((item) => item.name);
    for (const role of ['sp', 'bp', 'ip'] as const) {
      expect(names).toContain(projection.roles[role]);
    }
  });

  it('上下文里预取的是新对象，不与私有包共享引用，也不夹带私有信息', () => {
    const priv = testPrivate();
    const { ctx } = contextOf({ privatePkg: priv });

    expect(ctx.roles).toEqual(priv.roles);
    expect(ctx.roles).not.toBe(priv.roles);
    expect(Object.keys(ctx.roles).sort()).toEqual(['bp', 'ip', 'sp']);
    // 预取结果里只有三个寄存器名：私有包的 flag / win / fail / files 一律没进来。
    const serialized = JSON.stringify(ctx.roles);
    expect(serialized).not.toContain(priv.flag);
    const roleKeys = collectKeys(ctx.roles);
    expect(roleKeys).toEqual(new Set(['sp', 'bp', 'ip']));
    for (const forbidden of FORBIDDEN_KEYS) expect([...roleKeys]).not.toContain(forbidden);
  });

  it('非 RSP / RBP / RIP 的自定义命名原样透传，不做硬编码', () => {
    const priv = testPrivate({
      registers: ['ESP', 'EBP', 'EIP'],
      roles: { sp: 'ESP', bp: 'EBP', ip: 'EIP' },
    });
    const { runtime, ctx } = contextOf({
      privatePkg: priv,
      registers: { ESP: 0x7fffff00n, EBP: 0x7fffff10n, EIP: 0x400000n },
    });
    const projection = projectState(ctx, runtime.initialState(), 0);

    expect(projection.roles).toEqual({ sp: 'ESP', bp: 'EBP', ip: 'EIP' });
    expect(projection.registers.map((item) => item.name)).toEqual(['ESP', 'EBP', 'EIP']);
  });

  it('roles 不进 public.json：公开包没有这个字段，且 Schema 直接拒收', () => {
    const pub = testPublic();
    expect(Object.keys(pub)).not.toContain('roles');
    expect(JSON.stringify(pub)).not.toContain('roles');
    expect(
      PublicChallengeSchema.safeParse({ ...pub, roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' } })
        .success,
    ).toBe(false);
  });

  it('投影与录像的实际返回在任何层级都没有私有字段', () => {
    const { runtime, ctx } = contextOf({ disasm: DISASM });
    const init = runtime.initialState();
    const failed: VmState = {
      ...init,
      steps: 1,
      status: 'failed',
      error: { code: 'hidden_address', addr: 0x600000n, detail: '不该出现的补充信息' },
    };
    const projection = projectState(ctx, init, 0);
    const replay = projectReplay(ctx, {
      verdict: 'rejected',
      executed: 0,
      results: [{ ok: false, action: 'step', error: { code: 'hidden_address', detail: '不该出现的补充信息' } }],
      frames: [
        { kind: 'init', label: '初始状态', state: init },
        { kind: 'action', label: '动作 1：step', state: failed, error: { code: 'hidden_address', detail: '不该出现的补充信息' } },
      ],
      finalState: failed,
    });

    const keys = collectKeys(projection);
    for (const key of collectKeys(replay)) keys.add(key);
    for (const forbidden of FORBIDDEN_KEYS) expect([...keys]).not.toContain(forbidden);

    const serialized = JSON.stringify(replay);
    expect(serialized).not.toContain('不该出现的补充信息');
    expect(serialized).not.toContain(HIDDEN_KEY_HEX);
    expect(serialized.toLowerCase()).not.toContain('flag{');
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
    // 录像初态走的是同一条 `projectState` 路径，所以同样带 roles（09 §4）。
    expect(replay.initial.roles).toEqual(testPrivate().roles);
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

  it('帧自己的 error 优先：被拒绝的动作帧照样带拒绝原因，且 detail 不下发', () => {
    const { runtime, ctx } = contextOf();
    const init = runtime.initialState();
    const rejected: SubmitOutcome = {
      verdict: 'rejected',
      executed: 0,
      results: [
        {
          ok: false,
          action: 'write_bytes',
          error: { code: 'action_not_allowed', detail: '内部细节不下发' },
        },
      ],
      frames: [
        { kind: 'init', label: '初始状态', state: init },
        // 被拒绝的动作只拒绝动作，不写 state.error——帧自己的 error 必须透出来（08 §9.2）。
        {
          kind: 'action',
          label: 'write_bytes',
          state: init,
          error: { code: 'action_not_allowed', detail: '内部细节不下发' },
        },
      ],
      finalState: init,
    };

    const frame = projectReplay(ctx, rejected).frames[0];
    expect(frame?.error).toEqual({
      code: 'action_not_allowed',
      message: describeError('action_not_allowed'),
    });
    expect(JSON.stringify(frame)).not.toContain('内部细节不下发');
    expect(frame?.failures).toBe(1);
  });

  it('帧没有自己的 error 时回落到 state.error（运行期异常路径）', () => {
    const { runtime, ctx } = contextOf();
    const init = runtime.initialState();
    const failed: VmState = {
      ...init,
      steps: 1,
      status: 'failed',
      error: { code: 'invalid_instruction', detail: '0xff' },
    };
    const outcome: SubmitOutcome = {
      verdict: 'failed',
      executed: 1,
      results: [{ ok: true, action: 'step', error: { code: 'invalid_instruction' } }],
      frames: [
        { kind: 'init', label: '初始状态', state: init },
        { kind: 'action', label: 'step', state: failed },
      ],
      finalState: failed,
    };

    expect(projectReplay(ctx, outcome).frames[0]?.error).toEqual({
      code: 'invalid_instruction',
      message: describeError('invalid_instruction'),
    });
  });
});
