import { describe, expect, it } from 'vitest';
import {
  byteChanged,
  diffProjections,
  isEmptyDiff,
  rangeChanged,
} from '../src/viewmodel/diff';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { hexOf, makeProjection, p64 } from './helpers';

const STACK = 'stack'; // 栈 VMA 起点 0x7fffe000

describe('投影差分（04 §4、05 §2.1）', () => {
  const prev = SAMPLE_PROJECTION_START;
  const next = SAMPLE_PROJECTION_AFTER;
  const diff = diffProjections(prev, next);

  it('首份投影没有差分，首次渲染不高亮', () => {
    expect(isEmptyDiff(diffProjections(undefined, next))).toBe(true);
  });

  it('同一份投影之间没有差分', () => {
    expect(isEmptyDiff(diffProjections(next, next))).toBe(true);
  });

  it('只标出真正变化的寄存器', () => {
    expect([...diff.registers].sort()).toEqual(['RBP', 'RIP', 'RSP']);
    expect(diff.registers.has('RAX')).toBe(false);
    expect(diff.registers.has('FLAG')).toBe(false);
  });

  it('标志位单独一套差分', () => {
    const flagsProjection = makeProjection({ flags: { ZF: true, CF: false, SF: false } });
    const changed = diffProjections(prev, flagsProjection);
    expect([...changed.flags]).toEqual(['ZF']);
    expect(diff.flags.size).toBe(0);
  });

  it('字节差分按 VMA + 偏移给出，隐藏区不参与', () => {
    const bytes = diff.vmaBytes.get(STACK);
    expect(bytes).toBeDefined();
    expect(bytes?.has(0x1f00)).toBe(true); // buf 首字节：00 → 41
    expect(bytes?.has(0x1f18)).toBe(true); // 返回地址 0x400003 → 0x400002
    expect(bytes?.has(0x1f20)).toBe(false); // 前后都是 0x7fffff00，不该高亮
    expect(diff.vmaBytes.has('key')).toBe(false); // 隐藏 VMA 没有内容
    expect(diff.vmaBytes.has('text')).toBe(false); // 内容没变
  });

  it('单字节与区间查询', () => {
    expect(byteChanged(diff, STACK, 0x1f00)).toBe(true);
    expect(byteChanged(diff, STACK, 0x1f20)).toBe(false);
    expect(rangeChanged(diff, STACK, 0x1f10, 8)).toBe(true);
    expect(rangeChanged(diff, STACK, 0x1f28, 8)).toBe(false);
    expect(rangeChanged(diff, 'unknown', 0, 8)).toBe(false);
  });

  it('步数与停因变化单独标记', () => {
    expect(diff.stepsChanged).toBe(true);
    expect(diff.statusChanged).toBe(false);
    expect(diff.lastStopChanged).toBe(true);
  });

  it('stdin 读位置与 stdout 各自单独比较', () => {
    const before = makeProjection({ stdin: { hex: '4141', pos: 1 }, stdout: { hex: '68656c6c6f' } });
    const after = makeProjection({ stdin: { hex: '4141', pos: 2 }, stdout: { hex: '68656c6c6f21' } });
    const changed = diffProjections(before, after);
    expect(changed.stdoutChanged).toBe(true);
    expect(changed.stdinPosChanged).toBe(true);
    expect(diffProjections(before, before).stdoutChanged).toBe(false);
    expect(diffProjections(before, before).stdinPosChanged).toBe(false);
  });

  it('新出现的 VMA（上一份没有）不算字节变化，但内容本身仍可读', () => {
    const before = makeProjection({ vmas: [makeVmaStub()] });
    const after = makeProjection({
      vmas: [makeVmaStub(), { id: 'late', kind: 'global', start: '0x200000', size: '0x1000', perm: 'rw', hidden: false, hex: hexOf(0x10, { 0: p64(1n) }) }],
    });
    const changed = diffProjections(before, after);
    expect(changed.vmaBytes.get('late')).toBeUndefined();
  });
});

function makeVmaStub(): Record<string, unknown> {
  return { id: 'text', kind: 'code', start: '0x400000', size: '0x1000', perm: 'rx', hidden: false, hex: hexOf(0x1000) };
}
