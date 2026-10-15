import { describe, expect, it } from 'vitest';
import { diffProjections } from '../src/viewmodel/diff';
import { FLAG_DESCRIPTIONS, buildRegisterRows, flagRow } from '../src/viewmodel/registers';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { hexOf, makeProjection, makeVma } from './helpers';

const LABELS = [
  { name: 'buf', addr: '0x7fffff00', size: 16, kind: 'buffer' as const },
  { name: 'win', addr: '0x400002', size: 1, kind: 'func' as const },
];

describe('寄存器视图行投影（05 §2.4）', () => {
  it('显示投影里的全部寄存器，并标出 sp / bp / ip 角色', () => {
    const rows = buildRegisterRows({
      projection: SAMPLE_PROJECTION_START,
      archBits: 64,
      roles: SAMPLE_PROJECTION_START.roles,
    });
    expect(rows.registers.map((row) => row.name)).toEqual(['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG']);
    expect(rows.registers.find((row) => row.name === 'RSP')?.role).toBe('sp');
    expect(rows.registers.find((row) => row.name === 'RBP')?.role).toBe('bp');
    expect(rows.registers.find((row) => row.name === 'RIP')?.role).toBe('ip');
    expect(rows.registers.find((row) => row.name === 'RAX')?.role).toBeUndefined();
  });

  it('值按位宽定宽显示，并给出十进制', () => {
    const projection = makeProjection({ registers: { RAX: '0x63', RSP: '0x0', RBP: '0x0', RIP: '0x0' } });
    const rows = buildRegisterRows({ projection, archBits: 64, roles: projection.roles });
    expect(rows.registers[0]?.hex).toBe('0x0000000000000063');
    expect(rows.registers[0]?.decimal).toBe('99');
  });

  it('指向说明：VMA / 公开标注 / 隐藏 / 未映射', () => {
    const rows = buildRegisterRows({
      projection: SAMPLE_PROJECTION_START,
      archBits: 64,
      roles: SAMPLE_PROJECTION_START.roles,
      labels: LABELS,
    });
    expect(rows.registers.find((row) => row.name === 'RSP')).toMatchObject({
      targetKind: 'vma',
      targetText: '标注「buf」（缓冲区） · VMA stack+1f00',
    });
    expect(rows.registers.find((row) => row.name === 'RIP')).toMatchObject({
      targetKind: 'vma',
      targetText: 'VMA text',
    });
    expect(rows.registers.find((row) => row.name === 'RAX')).toMatchObject({ targetKind: 'unmapped' });

    const withKey = makeProjection({
      registers: { RAX: '0x80000000', RSP: '0x7fffff00', RBP: '0x7fffff10', RIP: '0x400000' },
      vmas: [
        makeVma({ id: 'stack', kind: 'stack', start: '0x7fffe000', size: '0x2000', hex: hexOf(0x2000) }),
        makeVma({ id: 'key', kind: 'key', start: '0x80000000', hidden: true }),
      ],
    });
    const hiddenRow = buildRegisterRows({ projection: withKey, archBits: 64, roles: withKey.roles }).registers[0];
    expect(hiddenRow).toMatchObject({
      targetKind: 'hidden',
      targetText: '隐藏 VMA「key」（内容未下发）',
    });
  });

  it('变化的值被差分标记', () => {
    const diff = diffProjections(SAMPLE_PROJECTION_START, SAMPLE_PROJECTION_AFTER);
    const rows = buildRegisterRows({
      projection: SAMPLE_PROJECTION_AFTER,
      archBits: 64,
      roles: SAMPLE_PROJECTION_AFTER.roles,
      diff,
    });
    const changed = rows.registers.filter((row) => row.changed).map((row) => row.name);
    expect(changed).toEqual(['RSP', 'RBP', 'RIP']);
  });

  it('标志位显示值与变化，并带中文说明', () => {
    const projection = makeProjection({ flags: { ZF: true, CF: false, SF: true } });
    const diff = diffProjections(makeProjection({ flags: { ZF: false, CF: false, SF: false } }), projection);
    const rows = buildRegisterRows({ projection, archBits: 64, roles: projection.roles, diff });
    expect(rows.flags.map((flag) => flag.name)).toEqual(['ZF', 'CF', 'SF']);
    expect(rows.flags.map((flag) => flag.value)).toEqual([true, false, true]);
    expect(rows.flags.map((flag) => flag.changed)).toEqual([true, false, true]);
    expect(rows.flags[0]?.description).toBe(FLAG_DESCRIPTIONS.ZF);
    expect(flagRow(projection.flags, 'CF', diff).changed).toBe(false);
  });
});
