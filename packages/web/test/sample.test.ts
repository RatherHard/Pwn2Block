import { ProjectionSchema } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_PROJECTION_AFTER,
  SAMPLE_PROJECTION_START,
  SAMPLE_PROJECTIONS,
  SAMPLE_PUBLIC_CHALLENGE,
} from '../src/fixtures/sample';

describe('D1 样例投影（05 §2.2–2.5）', () => {
  it('两份样例都通过冻结的 ProjectionSchema', () => {
    for (const projection of SAMPLE_PROJECTIONS) {
      expect(ProjectionSchema.safeParse(projection).success).toBe(true);
    }
  });

  it('隐藏 VMA 只有布局，没有 hex', () => {
    const key = SAMPLE_PROJECTION_START.vmas.find((vma) => vma.id === 'key');
    expect(key).toBeDefined();
    expect(key?.hidden).toBe(true);
    expect(key?.hex).toBeUndefined();
    expect(key?.start).toBe('0x80000000');
    expect(key?.size).toBe('0x1000');
    expect(key?.perm).toBe('rw');
  });

  it('可见 VMA 的内容长度等于声明的 size', () => {
    for (const vma of SAMPLE_PROJECTION_START.vmas) {
      if (vma.hidden) continue;
      expect(vma.hex?.length).toBe(Number(BigInt(vma.size)) * 2);
    }
  });

  it('样例布局与 ret2win 公开包一致（text / stack）', () => {
    const text = SAMPLE_PROJECTION_START.vmas.find((vma) => vma.id === 'text');
    const stack = SAMPLE_PROJECTION_START.vmas.find((vma) => vma.id === 'stack');
    expect(text?.start).toBe('0x400000');
    expect(text?.size).toBe('0x1000');
    expect(text?.perm).toBe('rx');
    expect(stack?.start).toBe('0x7fffe000');
    expect(stack?.size).toBe('0x2000');
    expect(SAMPLE_PROJECTION_START.roles).toEqual({ sp: 'RSP', bp: 'RBP', ip: 'RIP' });
    expect(SAMPLE_PUBLIC_CHALLENGE.labels?.length).toBe(3);
  });

  it('角色随投影下发，且都指向投影里真实存在的寄存器（不再有前端硬编码的那一份）', () => {
    for (const projection of SAMPLE_PROJECTIONS) {
      const names = new Set(projection.registers.map((item) => item.name));
      for (const name of Object.values(projection.roles)) {
        expect(names.has(name)).toBe(true);
      }
    }
    expect(SAMPLE_PROJECTION_START.roles).toEqual(SAMPLE_PROJECTION_AFTER.roles);
  });

  it('disasm 的字节与 text 内容逐字节一致（前端不解码，只对齐展示）', () => {
    const text = SAMPLE_PROJECTION_START.vmas.find((vma) => vma.id === 'text');
    expect(text?.hex).toBeDefined();
    for (const entry of SAMPLE_PROJECTION_START.disasm) {
      const offset = Number(BigInt(entry.addr) - BigInt(text?.start ?? '0x0')) * 2;
      expect(text?.hex?.slice(offset, offset + entry.bytes.length)).toBe(entry.bytes);
    }
  });

  it('投影里没有 flag / win / fail 谓词字段', () => {
    const json = JSON.stringify(SAMPLE_PROJECTION_START);
    expect(json).not.toContain('"flag":');
    expect(json).not.toContain('"win":');
    expect(json).not.toContain('"fail":');
    expect(json).not.toContain('env:');
  });

  it('第二份样例是执行两步后的状态，且栈上已写入 payload', () => {
    expect(SAMPLE_PROJECTION_AFTER.steps).toBe(2);
    expect(SAMPLE_PROJECTION_AFTER.registers.find((item) => item.name === 'RIP')?.value).toBe('0x400002');
    expect(SAMPLE_PROJECTION_AFTER.registers.find((item) => item.name === 'RSP')?.value).toBe('0x7fffff20');
    expect(SAMPLE_PROJECTION_AFTER.lastStop).toBeUndefined();
  });
});
