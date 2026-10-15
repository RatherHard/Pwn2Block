import { describe, expect, it } from 'vitest';
import { MAX_STEP_COUNT } from '@pwn2block/shared';
import {
  MESSAGE_EMPTY_PROGRAM,
  MESSAGE_STALE,
  blockIdOfAction,
  describeAction,
  parseStepCount,
  programRows,
  stepAction,
} from '../src/viewmodel/program';
import { makeArtifact } from './fake-api';

const ACTIONS = [
  { type: 'write_bytes', addr: '0x7fffff00', hex: '4142' },
  { type: 'push', value: '0x400002' },
  { type: 'ret' },
] as const;

describe('程序区（05 §3）', () => {
  it('每个动作一行，带动作类型名与中文说明', () => {
    const rows = programRows(makeArtifact(ACTIONS, ['b0', 'b1', 'b2']), 0);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.type).toBe('write_bytes');
    expect(rows[0]?.label).toContain('0x7fffff00');
    expect(rows[0]?.label).toContain('41 42');
    expect(rows[0]?.label).toContain('2 字节');
    expect(rows[1]?.label).toContain('压栈');
    expect(rows[1]?.label).toContain('0x400002');
  });

  it('当前执行位置只有一个，之前的是已提交', () => {
    const rows = programRows(makeArtifact(ACTIONS), 2);
    expect(rows.map((row) => row.current)).toEqual([false, false, true]);
    expect(rows.map((row) => row.done)).toEqual([true, true, false]);
  });

  it('动作 → 积木来自来源表；来源表缺失或错位时按“来源未知”处理（09 §3.4）', () => {
    const artifact = makeArtifact(ACTIONS, ['b0', 'b1', 'b2']);
    expect(blockIdOfAction(artifact, undefined, 1)).toBe('b1');
    expect(blockIdOfAction(undefined, undefined, 1)).toBeUndefined();
    expect(blockIdOfAction(artifact, undefined, 99)).toBeUndefined();
    // 错位的来源表不下猜：宁可说“不知道”，也不定位到错的积木。
    const broken = { ...artifact, origins: [{ index: 1, blockId: 'b1' }] };
    expect(blockIdOfAction(broken, undefined, 0)).toBeUndefined();
  });

  it('没有产物时程序区为空', () => {
    expect(programRows(undefined, 0)).toEqual([]);
  });

  it('动作说明覆盖全部动作类型（step / run / 出题人积木）', () => {
    expect(describeAction({ type: 'step', count: 5 })).toContain('5 条指令');
    expect(describeAction({ type: 'run' })).toContain('连续执行');
    expect(describeAction({ type: 'feed', hex: '4142' })).toContain('stdin');
    expect(describeAction({ type: 'pop' })).toContain('丢弃值');
    expect(describeAction({ type: 'call', addr: '0x400002' })).toContain('压入当前 ip');
    expect(describeAction({ type: 'block', id: 'gets', args: { data: '0x1' } })).toContain('gets');
  });

  it('「运行 N 步」的输入只接受 1–上限的整数', () => {
    expect(parseStepCount('10', MAX_STEP_COUNT)).toBe(10);
    expect(parseStepCount(' 3 ', MAX_STEP_COUNT)).toBe(3);
    expect(parseStepCount('0', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('-1', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('abc', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount(String(MAX_STEP_COUNT + 1), MAX_STEP_COUNT)).toBeUndefined();
  });

  it('step 动作不带 count 时走契约默认值', () => {
    expect(stepAction()).toEqual({ type: 'step' });
    expect(stepAction(4)).toEqual({ type: 'step', count: 4 });
  });

  it('过期与空程序的提示文案是固定的（控制器与工具栏共用）', () => {
    expect(MESSAGE_STALE).toBe('积木已改动，请重新编译');
    expect(MESSAGE_EMPTY_PROGRAM).toContain('没有动作');
  });
});
