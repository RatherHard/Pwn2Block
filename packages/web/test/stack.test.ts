import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROWS_BEFORE_SP,
  DEFAULT_STACK_ROWS,
  buildStackRows,
  findRowIndex,
  refollowBase,
  stackRowPrefix,
} from '../src/viewmodel/stack';
import { diffProjections } from '../src/viewmodel/diff';
import { alignDown } from '../src/viewmodel/format';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { hexOf, makeProjection, makeVma } from './helpers';

const BASE = 64;

function startRows(overrides: Partial<Parameters<typeof buildStackRows>[0]> = {}) {
  return buildStackRows({
    projection: SAMPLE_PROJECTION_START,
    archBits: BASE,
    roles: SAMPLE_PROJECTION_START.roles,
    labels: [
      { name: 'buf', addr: '0x7fffff00', size: 16, kind: 'buffer' },
      { name: 'saved rbp', addr: '0x7fffff10', size: 8, kind: 'saved_bp' },
      { name: 'ret addr', addr: '0x7fffff18', size: 8, kind: 'ret_addr' },
    ],
    ...overrides,
  });
}

describe('栈视图行投影（05 §2.2）', () => {
  it('每行 W 字节，默认窗口覆盖 sp 之前的上下文', () => {
    const rows = startRows();
    expect(rows.length).toBe(DEFAULT_STACK_ROWS);
    expect(rows[0]?.cells.length).toBe(8);
    expect(rows[0]?.addr).toBe(alignDown(0x7fffff00n, 8) - BigInt(DEFAULT_ROWS_BEFORE_SP * 8));
    expect(rows[0]?.prefix).toBe('00:0000');
  });

  it('sp / bp 所在行带锚点标签', () => {
    const rows = startRows();
    const spRow = rows.find((row) => row.addr === 0x7fffff00n);
    const bpRow = rows.find((row) => row.addr === 0x7fffff10n);
    expect(spRow?.anchors).toEqual([{ role: 'sp', name: 'RSP' }]);
    expect(bpRow?.anchors).toEqual([{ role: 'bp', name: 'RBP' }]);
    expect(spRow?.prefix).toBe(stackRowPrefix(4, 8));
  });

  it('stackRowPrefix：两位十六进制行号 + 四位十六进制字节偏移', () => {
    expect(stackRowPrefix(0, 8)).toBe('00:0000');
    expect(stackRowPrefix(3, 8)).toBe('03:0018');
    expect(stackRowPrefix(17, 4)).toBe('11:0044');
  });

  it('labels 显示类别与名称（不带专属颜色：TUI 调色板每色只表一种语义）', () => {
    const rows = startRows();
    const bufRow = rows.find((row) => row.addr === 0x7fffff00n);
    const retRow = rows.find((row) => row.addr === 0x7fffff18n);
    expect(bufRow?.label).toEqual({ name: 'buf', kind: 'buffer', kindName: '缓冲区' });
    expect(retRow?.label).toEqual({ name: 'ret addr', kind: 'ret_addr', kindName: '返回地址' });
  });

  it('隐藏 VMA 的字节显示 ?? 并标出所属 VMA', () => {
    const rows = startRows();
    const hiddenRows = rows.filter((row) => row.addr >= 0x80000000n);
    expect(hiddenRows.length).toBeGreaterThan(0);
    for (const row of hiddenRows) {
      expect(row.state).toBe('hidden');
      expect(row.cells.every((cell) => cell.text === '??')).toBe(true);
      expect(row.cells.every((cell) => cell.vmaId === 'key')).toBe(true);
      expect(row.hiddenVmaIds).toEqual(['key']);
      expect(row.chain).toBeUndefined();
      // 整行都在隐藏 VMA 里，字读不出来：region 必须退到 unmapped，不能从隐藏字节猜颜色。
      expect(row.region).toBe('unmapped');
    }
  });

  it('行字不可完全读取（跨到未映射区）时 region 退到 unmapped，不从隐藏/未映射字节推导颜色', () => {
    const projection = makeProjection({
      registers: { RSP: '0x500000', RBP: '0x500000', RIP: '0x400000' },
      vmas: [
        makeVma({ id: 'tiny', kind: 'stack', start: '0x500000', size: '0x4', hex: '41424344' }),
      ],
    });
    const rows = buildStackRows({ projection, archBits: BASE, roles: projection.roles, rowCount: 1 });
    // 只有 4 字节映射，8 字节的字跨到未映射区：readWordLE 返回 undefined。
    expect(rows[0]?.chain).toBeUndefined();
    expect(rows[0]?.region).toBe('unmapped');
  });

  it('未映射的地址显示为空', () => {
    const projection = makeProjection({
      registers: { RSP: '0x90000000', RBP: '0x90000010', RIP: '0x400000', RAX: '0x0' },
      vmas: [makeVma({ id: 'text', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c9' }) })],
    });
    const rows = buildStackRows({ projection, archBits: BASE, roles: projection.roles, rowCount: 2 });
    expect(rows[0]?.state).toBe('unmapped');
    expect(rows[0]?.cells.every((cell) => cell.text === '')).toBe(true);
    expect(rows[0]?.ascii).toBeUndefined();
  });

  it('指向可见内存的值给出跳转链，指向代码的给出伪汇编附注', () => {
    const rows = startRows();
    const pointerRow = rows.find((row) => row.addr === 0x7fffff20n);
    const retRow = rows.find((row) => row.addr === 0x7fffff18n);
    expect(pointerRow?.chain?.arrows).toBe('—▸ 0x7fffff00');
    expect(pointerRow?.chain?.annotation).toBe('buf');
    expect(retRow?.chain?.arrows).toBe('—▸ 0x400003');
    expect(retRow?.chain?.annotation).toBe('◂— syscall exit');
  });

  it('不是指针的值不显示跳转链（0 号地址是数据）', () => {
    const rows = startRows();
    expect(rows.find((row) => row.addr === 0x7fffff00n)?.chain).toBeUndefined();
    // 保存的 rbp 槽位里存的是 0x7fffff40，是栈内可见地址 → 有链，但只有一跳
    const savedBp = rows.find((row) => row.addr === 0x7fffff10n)?.chain;
    expect(savedBp?.arrows).toBe('—▸ 0x7fffff40');
    expect(savedBp?.annotation).toBeUndefined();
  });

  it('写入 payload 之后：行 ASCII 与多跳链都能显示', () => {
    const rows = buildStackRows({
      projection: SAMPLE_PROJECTION_AFTER,
      archBits: BASE,
      roles: SAMPLE_PROJECTION_AFTER.roles,
      labels: [{ name: 'buf', addr: '0x7fffff00', size: 16, kind: 'buffer' }],
    });
    const bufRow = rows.find((row) => row.addr === 0x7fffff00n);
    const retRow = rows.find((row) => row.addr === 0x7fffff18n);
    const pointerRow = rows.find((row) => row.addr === 0x7fffff20n);
    expect(bufRow?.ascii).toBe('AAAAAAAA');
    expect(bufRow?.chain).toBeUndefined(); // 0x4141… 不是地址
    expect(retRow?.chain?.annotation).toBe('◂— syscall win');
    expect(pointerRow?.chain?.arrows).toBe('—▸ 0x7fffff00');
    expect(pointerRow?.chain?.annotation).toBe('buf · "AAAAAAAA"');
  });

  it('差分高亮：写入 payload 的字节被标记，未变化的字节不标记', () => {
    const diff = diffProjections(SAMPLE_PROJECTION_START, SAMPLE_PROJECTION_AFTER);
    const rows = buildStackRows({
      projection: SAMPLE_PROJECTION_AFTER,
      archBits: BASE,
      roles: SAMPLE_PROJECTION_AFTER.roles,
      diff,
    });
    const retRow = rows.find((row) => row.addr === 0x7fffff18n);
    const nextRow = rows.find((row) => row.addr === 0x7fffff20n);
    expect(retRow?.changed).toBe(true);
    expect(retRow?.cells[0]?.changed).toBe(true);
    expect(nextRow?.changed).toBe(false);
  });

  it('对齐偏移：startAddr 原样使用（调用方负责对齐）', () => {
    const rows = startRows({ startAddr: 0x7fffff04n, rowCount: 1 });
    expect(rows[0]?.addr).toBe(0x7fffff04n);
    expect(rows[0]?.cells.length).toBe(8);
  });

  it('行宽可改：32 位题按 4 字节一行', () => {
    const projection = makeProjection({
      registers: { ESP: '0x7fffff00', EBP: '0x7fffff04', EIP: '0x400000' },
      vmas: [
        makeVma({
          id: 'stack',
          kind: 'stack',
          start: '0x7fffe000',
          size: '0x2000',
          hex: hexOf(0x2000, { 0: '44434241' }),
        }),
      ],
    });
    const rows = buildStackRows({
      projection,
      archBits: 32,
      roles: { sp: 'ESP', bp: 'EBP', ip: 'EIP' },
      rowCount: 5,
    });
    const spRow = rows.find((row) => row.addr === 0x7fffff00n);
    expect(spRow?.cells.length).toBe(4);
    expect(spRow?.anchors).toEqual([{ role: 'sp', name: 'ESP' }]);
    expect(rows.every((row) => row.cells.length === 4)).toBe(true);
  });

  it('findRowIndex / refollowBase 用于自动跟随 sp', () => {
    const rows = startRows();
    expect(findRowIndex(rows, 0x7fffff00n)).toBe(4);
    expect(findRowIndex(rows, 0x80000018n)).toBe(DEFAULT_STACK_ROWS - 1);
    expect(findRowIndex(rows, 0x80000020n)).toBeUndefined();
    expect(refollowBase(rows, 0x7fffff00n, 8)).toBeUndefined();
    expect(refollowBase(rows, 0x80000020n, 8)).toBe(0x80000000n);
  });
});

it.each([32, 64])('sp 在 VMA 起点时，%i 位对齐偏移仍保留 sp 锚点', (archBits) => {
  const projection = makeProjection({ registers: { RSP: '0x1000' }, vmas: [
    makeVma({ id: 'stack', start: '0x1000', size: '0x8', hex: '0000000000000000' }),
  ] });
  const rows = buildStackRows({ projection, archBits, roles: projection.roles, alignOffset: 3 });
  expect(rows.some((row) => row.anchors.some((anchor) => anchor.role === 'sp'))).toBe(true);
  expect(rows[0]?.addr).toBe(0x1000n - BigInt(archBits / 8) + 3n);
});
