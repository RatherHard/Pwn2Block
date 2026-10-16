import { describe, expect, it } from 'vitest';
import { MAX_STEP_COUNT } from '@pwn2block/shared';
import {
  MESSAGE_COMPILE_FAILED,
  MESSAGE_EMPTY_PROGRAM,
  MESSAGE_NEED_COMPILE,
  MESSAGE_STALE,
  parseStepCount,
} from '../src/viewmodel/program';

describe('编译相关文案与步数解析（05 §3）', () => {
  it('「运行 N 步」的输入只接受 1–上限的整数', () => {
    expect(parseStepCount('10', MAX_STEP_COUNT)).toBe(10);
    expect(parseStepCount(' 3 ', MAX_STEP_COUNT)).toBe(3);
    expect(parseStepCount('0', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('-1', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('abc', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount('', MAX_STEP_COUNT)).toBeUndefined();
    expect(parseStepCount(String(MAX_STEP_COUNT + 1), MAX_STEP_COUNT)).toBeUndefined();
  });

  it('过期、未编译、编译失败与空程序的提示文案是固定的（控制器与工具栏共用）', () => {
    expect(MESSAGE_STALE).toBe('积木已改动，正在重新编译');
    expect(MESSAGE_NEED_COMPILE).toBe('画布还没有可运行的程序：先拼积木');
    expect(MESSAGE_COMPILE_FAILED).toBe('编译失败：先按输出区的错误修正积木');
    expect(MESSAGE_EMPTY_PROGRAM).toBe('画布上没有动作：未连到「开始」积木的积木不参与编译');
  });

  it('文案里不该再出现「程序区」或「点『编译』」（程序区已删除，global constraints）', () => {
    for (const message of [MESSAGE_STALE, MESSAGE_NEED_COMPILE, MESSAGE_COMPILE_FAILED, MESSAGE_EMPTY_PROGRAM]) {
      expect(message).not.toMatch(/编译」|程序区/);
    }
  });
});
