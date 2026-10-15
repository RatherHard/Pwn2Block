import { describe, expect, it, vi } from 'vitest';
import type { CompileResult } from './types';

/**
 * 来源表错位不变式是**活的**，不是摆设（05 §3、09 §3.4）。
 *
 * 正常编译永远给出等长同序的来源表，所以"不误报"只能证明它不会被触发；这里把编译器换成
 * 一个故意错位的替身，验证 `createArtifactTracker` 真的会拦住错位产物——宁可显式抛错，
 * 也不能让界面按错位的来源表把某一步定位到另一块积木上。
 *
 * 本文件用 `vi.mock` 顶掉 `./compile`，所以单独一个文件，不污染 `artifact.test.ts`。
 */

const state = vi.hoisted(() => ({ result: undefined as CompileResult | undefined }));

vi.mock('./compile', () => ({
  compileProgram: (): CompileResult => {
    if (state.result === undefined) throw new Error('用例没有设置编译结果');
    return state.result;
  },
}));

const { createArtifactTracker } = await import('./artifact');
const { ret2winPublic } = await import('@pwn2block/shared');

const program = { blocks: [] };
/** 用真实公开包：tracker 的 `compile` 要完整 `PublicChallenge`。 */
const challenge = ret2winPublic;

describe('产物跟踪器：来源表错位时显式抛错', () => {
  it('来源表比动作短：抛出"不等长"而不是存下一份错位产物', () => {
    state.result = {
      ok: true,
      actions: [{ type: 'pop' }, { type: 'ret' }],
      origins: [{ index: 0, blockId: 'only_one' }],
      originsVersion: 1,
    };
    const tracker = createArtifactTracker();
    expect(() => tracker.compile(program, challenge)).toThrow(/来源表与动作不等长/);
    expect(tracker.state.artifact).toBeUndefined();
  });

  it('来源表下标错位：抛出"下标错位"', () => {
    state.result = {
      ok: true,
      actions: [{ type: 'pop' }],
      origins: [{ index: 1, blockId: 'b1' }],
      originsVersion: 1,
    };
    const tracker = createArtifactTracker();
    expect(() => tracker.compile(program, challenge)).toThrow(/来源表下标错位/);
    expect(tracker.state.artifact).toBeUndefined();
  });

  it('等长同序时不抛错，并正常记录产物（不变式不误报）', () => {
    state.result = {
      ok: true,
      actions: [{ type: 'pop' }, { type: 'ret' }],
      origins: [
        { index: 0, blockId: 'b1' },
        { index: 1, blockId: 'b2' },
      ],
      originsVersion: 1,
    };
    const tracker = createArtifactTracker();
    const artifact = tracker.compile(program, challenge);
    expect(artifact?.origins).toHaveLength(2);
    expect(tracker.state.revision).toBe(1);
  });

  it('抛错发生在改状态之前：上一份产物与 revision 保持原样', () => {
    state.result = {
      ok: true,
      actions: [{ type: 'pop' }],
      origins: [{ index: 0, blockId: 'b1' }],
      originsVersion: 1,
    };
    const tracker = createArtifactTracker();
    const good = tracker.compile(program, challenge);
    const before = tracker.state;

    state.result = {
      ok: true,
      actions: [{ type: 'ret' }],
      origins: [{ index: 0, blockId: 'b1' }, { index: 1, blockId: 'b2' }],
      originsVersion: 1,
    };
    expect(() => tracker.compile(program, challenge)).toThrow();
    expect(tracker.state).toBe(before);
    expect(tracker.state.artifact).toBe(good);
    expect(tracker.state.revision).toBe(1);
  });
});
