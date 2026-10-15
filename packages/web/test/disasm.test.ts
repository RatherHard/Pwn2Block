import { describe, expect, it } from 'vitest';
import { buildDisasmRows, findDisasmRow, isClickableTarget } from '../src/viewmodel/disasm';
import { diffProjections } from '../src/viewmodel/diff';
import { funcLabels } from '../src/viewmodel/labels';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { hexOf, makeProjection, makeVma } from './helpers';

describe('指令视图行投影（05 §2.3）', () => {
  it('列数据直接来自投影 disasm，前端不解码', () => {
    const rows = buildDisasmRows({ projection: SAMPLE_PROJECTION_START, archBits: 64 });
    expect(rows.map((row) => row.text)).toEqual([
      'leave',
      'ret',
      'syscall win',
      'syscall exit',
      'jmp 0x400000',
    ]);
    expect(rows[0]?.address).toBe('0x0000000000400000');
    expect(rows[0]?.bytesText).toBe('c9');
  });

  it('ip 所在行高亮', () => {
    const startRows = buildDisasmRows({ projection: SAMPLE_PROJECTION_START, archBits: 64, ip: 0x400000n });
    const afterRows = buildDisasmRows({ projection: SAMPLE_PROJECTION_AFTER, archBits: 64, ip: 0x400002n });
    expect(startRows.filter((row) => row.isIp).map((row) => row.text)).toEqual(['leave']);
    expect(afterRows.filter((row) => row.isIp).map((row) => row.text)).toEqual(['syscall win']);
  });

  it('target 可点击：给出目标地址与显示文本', () => {
    const rows = buildDisasmRows({ projection: SAMPLE_PROJECTION_START, archBits: 64 });
    const jump = rows[4];
    expect(jump?.target).toBe(0x400000n);
    expect(jump?.targetText).toBe('0x400000');
    expect(isClickableTarget(jump!)).toBe(true);
    expect(isClickableTarget(rows[0]!)).toBe(false);
    expect(findDisasmRow(rows, 0x400002n)?.text).toBe('syscall win');
    expect(findDisasmRow(rows, 0x500000n)).toBeUndefined();
  });

  it('target 命中公开标注时显示标注名', () => {
    const rows = buildDisasmRows({
      projection: SAMPLE_PROJECTION_START,
      archBits: 64,
      labels: [{ name: 'vuln', addr: '0x400000', size: 4, kind: 'func' }],
    });
    expect(rows[4]?.targetText).toBe('vuln');
    expect(rows[0]?.funcName).toBe('vuln');
    expect(funcLabels([{ name: 'vuln', addr: '0x400000', size: 4, kind: 'func' }])).toHaveLength(1);
    expect(funcLabels(undefined)).toHaveLength(0);
  });

  it('字节变化的指令行被标记（差分来自投影，不是自己解码出来的）', () => {
    const before = makeProjection({
      vmas: [makeVma({ id: 'code', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c9' }) })],
      disasm: [{ addr: '0x400000', bytes: 'c9', text: 'leave' }],
    });
    const after = makeProjection({
      vmas: [makeVma({ id: 'code', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c3' }) })],
      disasm: [{ addr: '0x400000', bytes: 'c3', text: 'ret' }],
    });
    const diff = diffProjections(before, after);
    const rows = buildDisasmRows({ projection: after, archBits: 64, diff });
    expect(rows[0]?.changed).toBe(true);
    expect(buildDisasmRows({ projection: after, archBits: 64 }).every((row) => !row.changed)).toBe(true);
  });
});
