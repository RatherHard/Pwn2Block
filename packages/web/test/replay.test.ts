import { describe, expect, it } from 'vitest';
import {
  MESSAGE_REPLAY_DISASM_STALE,
  actionInstructionsAt,
  actionOfPosition,
  actionPositions,
  clampPosition,
  defaultPosition,
  disasmAvailability,
  failurePosition,
  frameProjection,
  instructionPositionsFor,
  positionDescription,
  positionLabel,
  projectionAtPosition,
  timelineLength,
} from '../src/viewmodel/replay';
import { CHANGED_CODE_VMA, CHANGED_DATA_VMA, makeReplay } from './fake-api';
import { makeProjection, makeVma } from './helpers';

const STACK_VMA = makeVma({
  id: 'stack',
  kind: 'stack',
  start: '0x7fffe000',
  size: '0x2000',
  perm: 'rw',
  hex: '00'.repeat(16),
});
const DATA_VMA = makeVma({ id: 'data', kind: 'global', start: '0x100000', perm: 'rw', hex: '00'.repeat(16) });
const TEXT_VMA = makeVma({ id: 'text', kind: 'code', start: '0x400000', perm: 'rx', hex: 'c3' });

const INITIAL = makeProjection({ vmas: [TEXT_VMA, STACK_VMA, DATA_VMA] });

function stackHexAt(hex: string | undefined): string {
  return hex?.slice(0, 8) ?? '';
}

describe('回放录像（04 §5.1、09 §3.4）', () => {
  it('时间线位置 0 是初态，i + 1 是 frames[i]', () => {
    const replay = makeReplay([{ label: '写入' }, { label: '返回' }], INITIAL);
    expect(timelineLength(replay)).toBe(3);
    expect(positionLabel(replay, 0)).toBe('初态');
    expect(positionLabel(replay, 1)).toBe('写入');
    expect(positionLabel(replay, 2)).toBe('返回');
    // 越界一律夹到合法范围。
    expect(clampPosition(replay, -5)).toBe(0);
    expect(clampPosition(replay, 99)).toBe(2);
    expect(projectionAtPosition(replay, 0).steps).toBe(INITIAL.steps);
  });

  it('changedVmas 是逐帧增量，必须累计叠到初态上', () => {
    const replay = makeReplay(
      [
        {
          label: '写栈',
          changedVmas: [
            makeVma({
              id: 'stack',
              kind: 'stack',
              start: '0x7fffe000',
              size: '0x2000',
              perm: 'rw',
              hex: '11'.repeat(16),
            }),
          ],
        },
        {
          label: '写数据',
          changedVmas: [
            makeVma({ id: 'data', kind: 'global', start: '0x100000', perm: 'rw', hex: '22'.repeat(16) }),
          ],
        },
      ],
      INITIAL,
    );

    const first = projectionAtPosition(replay, 1);
    expect(stackHexAt(first.vmas.find((vma) => vma.id === 'stack')?.hex)).toBe('11111111');
    expect(stackHexAt(first.vmas.find((vma) => vma.id === 'data')?.hex)).toBe('00000000');

    const second = projectionAtPosition(replay, 2);
    // 第二帧只改 data，但 stack 的变化必须还在。
    expect(stackHexAt(second.vmas.find((vma) => vma.id === 'stack')?.hex)).toBe('11111111');
    expect(stackHexAt(second.vmas.find((vma) => vma.id === 'data')?.hex)).toBe('22222222');
    // text 从未在帧里出现，保持初态内容。
    expect(second.vmas.find((vma) => vma.id === 'text')?.hex).toBe('c3');
  });

  it('寄存器、标志位与指令数取当前帧的绝对值', () => {
    const replay = makeReplay(
      [
        { steps: 3, registers: [{ name: 'RIP', value: '0x400003' }], flags: { ZF: true, CF: false, SF: false } },
        { steps: 7, registers: [{ name: 'RIP', value: '0x400007' }], status: 'failed' },
      ],
      INITIAL,
    );
    const at1 = projectionAtPosition(replay, 1);
    expect(at1.steps).toBe(3);
    expect(at1.flags.ZF).toBe(true);
    expect(at1.registers[0]).toEqual({ name: 'RIP', value: '0x400003' });

    // 帧里的寄存器与标志位是**绝对值**，不是增量：第 2 帧没写 ZF=true 就是 false。
    const at2 = projectionAtPosition(replay, 2);
    expect(at2.steps).toBe(7);
    expect(at2.status).toBe('failed');
    expect(at2.flags.ZF).toBe(false);
    expect(at2.registers[0]).toEqual({ name: 'RIP', value: '0x400007' });
  });

  it('stdin / stdout 是完整快照，帧没给就沿用前值', () => {
    const initial = makeProjection({ stdout: { hex: '41' }, stdin: { hex: '42', pos: 1 } });
    const replay = makeReplay(
      [
        { stdout: { hex: '4142' } },
        { changedVmas: [], stdout: { hex: '414243' } },
      ],
      initial,
    );
    expect(projectionAtPosition(replay, 1).stdout?.hex).toBe('4142');
    expect(projectionAtPosition(replay, 1).stdin).toEqual({ hex: '42', pos: 1 });
    expect(projectionAtPosition(replay, 2).stdout?.hex).toBe('414243');
  });

  it('角色寄存器与反汇编沿用初态（录像帧不带这两样）', () => {
    const replay = makeReplay([{}], INITIAL);
    const at1 = projectionAtPosition(replay, 1);
    expect(at1.roles).toEqual(INITIAL.roles);
    expect(at1.disasm).toEqual(INITIAL.disasm);
  });

  it('错误不跨帧继承：只有出事的那一帧带 error', () => {
    const replay = makeReplay(
      [{ status: 'ready' }, { status: 'failed', error: { code: 'memory_fault', message: '访问了未映射的地址' } }],
      INITIAL,
    );
    expect(projectionAtPosition(replay, 1).error).toBeUndefined();
    expect(projectionAtPosition(replay, 2).error?.code).toBe('memory_fault');
  });

  it('隐藏 VMA 的变化不保留上一帧的字节（隐藏即不下发，01 §6）', () => {
    const initial = makeProjection({
      vmas: [TEXT_VMA, STACK_VMA, makeVma({ id: 'key', kind: 'key', start: '0x80000000', perm: 'rw', hidden: false, hex: 'aa' })],
    });
    const replay = makeReplay(
      [
        {
          changedVmas: [
            { id: 'key', kind: 'key', start: '0x80000000', size: '0x1000', perm: 'rw', hidden: true, hex: 'bb' },
          ],
        },
      ],
      initial,
    );
    const key = projectionAtPosition(replay, 1).vmas.find((vma) => vma.id === 'key');
    expect(key?.hidden).toBe(true);
    expect(key?.hex).toBeUndefined();
  });

  it('失败那一帧默认选中：优先带 error 的 action 帧，其次 failed，最后停在末帧（05 §6）', () => {
    expect(defaultPosition(makeReplay([{}, {}, {}], INITIAL))).toBe(3);
    expect(defaultPosition(makeReplay([{}, { status: 'failed' }, {}], INITIAL))).toBe(2);
    expect(
      defaultPosition(
        makeReplay(
          [
            { kind: 'action' },
            { kind: 'instruction', status: 'failed' },
            { kind: 'action', status: 'failed', error: { code: 'invalid_ip', message: '跑飞了' } },
          ],
          INITIAL,
        ),
      ),
    ).toBe(3);
    expect(defaultPosition(makeReplay([], INITIAL))).toBe(0);
    expect(failurePosition(makeReplay([{ kind: 'instruction', status: 'failed' }], INITIAL))).toBe(1);
  });

  it('第 k 个提交动作对应第 k 个 action 帧（09 §3.4）', () => {
    const replay = makeReplay(
      [
        { kind: 'action', label: 'write_bytes' },
        { kind: 'instruction' },
        { kind: 'instruction' },
        { kind: 'action', label: 'ret' },
      ],
      INITIAL,
    );
    expect(actionPositions(replay)).toEqual([1, 4]);
  });

  /**
   * A 收口更正过的归属规则（09 §3.4）：真实例子是提交 `[block gets, step]`，
   * 帧序为 `action:block → instruction:leave → instruction:ret → instruction:syscall win → action:step`，
   * 那三条 instruction 属于**第 2 个**动作 `step`，不是第 1 个。
   */
  it('夹在两个 action 帧之间的 instruction 帧属于后一个动作', () => {
    const replay = makeReplay(
      [
        { kind: 'action', label: 'block gets' },
        { kind: 'instruction', label: 'leave' },
        { kind: 'instruction', label: 'ret' },
        { kind: 'instruction', label: 'syscall win' },
        { kind: 'action', label: 'step' },
      ],
      INITIAL,
    );
    expect(instructionPositionsFor(replay, 0)).toEqual([]);
    expect(instructionPositionsFor(replay, 1)).toEqual([2, 3, 4]);
    expect(actionInstructionsAt(replay, 3)).toEqual({ action: 1, positions: [2, 3, 4], labels: ['leave', 'ret', 'syscall win'] });
    // 每个位置（除初态）都能归属到一个动作。
    expect(actionOfPosition(replay, 0)).toBeUndefined();
    expect(actionOfPosition(replay, 1)).toBe(0);
    expect(actionOfPosition(replay, 2)).toBe(1);
    expect(actionOfPosition(replay, 4)).toBe(1);
    expect(actionOfPosition(replay, 5)).toBe(1);
    expect(instructionPositionsFor(replay, 5)).toEqual([]);
  });

  it('第一个 action 帧之前的 instruction 帧属于第 1 个动作', () => {
    const replay = makeReplay(
      [
        { kind: 'instruction', label: 'push' },
        { kind: 'instruction', label: 'syscall' },
        { kind: 'action', label: 'step' },
      ],
      INITIAL,
    );
    expect(instructionPositionsFor(replay, 0)).toEqual([1, 2]);
    expect(actionOfPosition(replay, 1)).toBe(0);
    expect(positionDescription(replay, 2)).toContain('第 1 个动作执行途中');
    // action 帧本身不是“执行途中”：它带的是动作完成之后的快照。
    expect(positionDescription(replay, 3)).not.toContain('执行途中');
  });

  it('录像期间代码段被改写 → 指令视图不可用，绝不给过期反汇编', () => {
    const clean = makeReplay([{ changedVmas: [CHANGED_DATA_VMA] }], INITIAL);
    expect(disasmAvailability(clean)).toEqual({ available: true });
    expect(frameProjection(clean, 1).disasmNotice).toBeUndefined();

    const dirty = makeReplay([{ changedVmas: [CHANGED_DATA_VMA] }, { changedVmas: [CHANGED_CODE_VMA] }], INITIAL);
    expect(disasmAvailability(dirty).available).toBe(false);
    expect(disasmAvailability(dirty).notice).toBe(MESSAGE_REPLAY_DISASM_STALE);
    const frame = frameProjection(dirty, 1);
    expect(frame.disasmNotice).toBe(MESSAGE_REPLAY_DISASM_STALE);
    // 连“还没改代码”的那一帧也不给：整段回放共用初态那一份反汇编。
    expect(frame.projection.disasm).toEqual([]);
    expect(frameProjection(dirty, 2).projection.disasm).toEqual([]);
  });

  it('帧视图给出当前帧与上一帧（差分高亮用），初态没有上一帧', () => {
    const replay = makeReplay([{ steps: 1 }, { steps: 2 }], INITIAL);
    expect(frameProjection(replay, 0).previous).toBeUndefined();
    expect(frameProjection(replay, 2).previous?.steps).toBe(1);
    expect(frameProjection(replay, 1).projection.steps).toBe(1);
  });

  it('读屏用的位置描述包含帧标签、指令数与状态（05 §7）', () => {
    const replay = makeReplay([{ label: 'ret', steps: 4, status: 'exited' }], INITIAL);
    expect(positionDescription(replay, 1)).toContain('ret');
    expect(positionDescription(replay, 1)).toContain('4 条指令');
    expect(positionDescription(replay, 1)).toContain('程序已结束');
  });
});
