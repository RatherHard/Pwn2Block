/**
 * 非示例角色名的消费者守卫（08 §9.2 第 1 行「D 使用公开角色」）。
 *
 * 用例一律用 32 位题目的 `ESP` / `EBP` / `EIP`——它们不在任何样例里，
 * 只有「角色从投影 `roles` 取」这一条路径能让下面三条渲染正确：
 *
 * 1. 寄存器视图的角色标注（`viewmodel/registers`）；
 * 2. 栈视图的 `sp` 锚点与窗口锚定（`viewmodel/stack` + `viewmodel/roles` 取的值）；
 * 3. 指令视图的当前行高亮（`viewmodel/disasm` + `viewmodel/roles` 取的值）。
 *
 * 组件里没有第二套逻辑：`stack-view.spValue()` / `disasm-view.ipValue()` 调 `roleValue`，
 * `registers-view` 调 `buildRegisterRows`，而它们拿到的角色映射来自 `createViewContext`，
 * 后者把 `roles` 钉死成 `projection.roles`（页面壳没有入口塞进另一套名字）。
 */
import type { Projection, Roles } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';
import { SAMPLE_PUBLIC_CHALLENGE } from '../src/fixtures/sample';
import { createViewContext } from '../src/viewmodel/context';
import { EMPTY_DIFF } from '../src/viewmodel/diff';
import { buildDisasmRows } from '../src/viewmodel/disasm';
import { alignDown } from '../src/viewmodel/format';
import { buildRegisterRows } from '../src/viewmodel/registers';
import { REGISTER_ROLES, roleRegisterName, roleValue } from '../src/viewmodel/roles';
import { buildStackRows, findRowIndex, refollowBase } from '../src/viewmodel/stack';
import { hexOf, makeProjection, makeVma } from './helpers';

const BASE32 = 32;
const ROW_BYTES = BASE32 / 8;
/** 32 位题目的角色：与样例的 RSP / RBP / RIP 完全不同的名字。 */
const ROLES32: Roles = { sp: 'ESP', bp: 'EBP', ip: 'EIP' };
/** 同一批地址，但角色名换成 64 位的写法：用来证明没有任何地方按名字特判。 */
const ROLES64_NAMES: Roles = { sp: 'RSP', bp: 'RBP', ip: 'RIP' };

const ESP = 0x7fffff00n;
const EBP = 0x7fffff04n;
const EIP = 0x400002n;
const STACK_OFFSET_ESP = 0x1f00;
const STACK_OFFSET_EBP = 0x1f04;

const DISASM = [
  { addr: '0x400000', bytes: 'c9', text: 'leave' },
  { addr: '0x400001', bytes: 'c3', text: 'ret' },
  { addr: '0x400002', bytes: '0f', text: 'syscall win' },
  { addr: '0x400003', bytes: '0e', text: 'syscall exit' },
] as const;

/** 一份 32 位投影，寄存器名与角色名由调用方给：地址布局恒定。 */
function projectionWith(roles: Roles, sp: string, bp: string, ip: string): Projection {
  return makeProjection({
    roles,
    registers: { RAX: '0x0', [sp]: '0x7fffff00', [bp]: '0x7fffff04', [ip]: '0x400002' },
    vmas: [
      makeVma({ id: 'code', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c9c30f0e' }) }),
      makeVma({
        id: 'stack',
        kind: 'stack',
        start: '0x7fffe000',
        size: '0x2000',
        hex: hexOf(0x2000, { [STACK_OFFSET_ESP]: '41424344', [STACK_OFFSET_EBP]: '05000000' }),
      }),
    ],
    disasm: DISASM,
  });
}

function projection32(): Projection {
  return projectionWith(ROLES32, 'ESP', 'EBP', 'EIP');
}

function contextOf(projection: Projection) {
  return createViewContext({
    projection,
    archBits: BASE32,
    challenge: SAMPLE_PUBLIC_CHALLENGE,
    diff: EMPTY_DIFF,
  });
}

describe('非示例角色（ESP / EBP / EIP）', () => {
  it('上下文里的角色就是投影里的角色，页面壳没有第二个入口', () => {
    const projection = projection32();
    const context = contextOf(projection);
    expect(context.roles).toEqual(ROLES32);
    expect(context.roles).toBe(projection.roles);
    expect(context.labels).toEqual(SAMPLE_PUBLIC_CHALLENGE.labels);
    expect(context.archBits).toBe(BASE32);
  });

  it('寄存器视图：ESP / EBP / EIP 分别标成 sp / bp / ip，RAX 不标', () => {
    const projection = projection32();
    const rows = buildRegisterRows({ projection, archBits: BASE32, roles: projection.roles });
    expect(rows.registers.map((row) => row.name)).toEqual(['RAX', 'ESP', 'EBP', 'EIP']);
    expect(rows.registers.map((row) => row.role)).toEqual([undefined, 'sp', 'bp', 'ip']);
    // 32 位定宽：8 个十六进制位，而不是 16 位。
    expect(rows.registers.find((row) => row.name === 'ESP')?.hex).toBe('0x7fffff00');
    expect(rows.registers.find((row) => row.name === 'EIP')?.hex).toBe('0x00400002');
  });

  it('栈视图：sp 锚点落在 ESP 那一行，窗口自动锚定到 ESP 的值，行宽按 32 位', () => {
    const projection = projection32();
    const rowsBeforeSp = 4;
    const rows = buildStackRows({ projection, archBits: BASE32, roles: projection.roles, rowCount: 6 });
    expect(rows.every((row) => row.cells.length === ROW_BYTES)).toBe(true);
    // 自动锚定：起点 = alignDown(ESP, 4) - 4 行。
    expect(rows[0]?.addr).toBe(alignDown(ESP, ROW_BYTES) - BigInt(rowsBeforeSp * ROW_BYTES));
    const spRow = rows.find((row) => row.addr === ESP);
    const bpRow = rows.find((row) => row.addr === EBP);
    expect(spRow?.anchors).toEqual([{ role: 'sp', name: 'ESP' }]);
    expect(bpRow?.anchors).toEqual([{ role: 'bp', name: 'EBP' }]);
    // 角色名对但地址不在窗口里的寄存器不会跑到锚点列（这里只有 ESP / EBP 在栈上）。
    expect(rows.flatMap((row) => row.anchors).map((anchor) => anchor.name)).toEqual(['ESP', 'EBP']);
    expect(findRowIndex(rows, ESP)).toBe(rowsBeforeSp);
    expect(refollowBase(rows, ESP, ROW_BYTES)).toBeUndefined();
  });

  it('指令视图：当前行是 EIP 指向的那一条，且只有这一条', () => {
    const projection = projection32();
    // 组件 `disasm-view.ipValue()` 走的就是这一行。
    const ip = roleValue(projection, projection.roles, 'ip');
    expect(ip).toBe(EIP);
    const rows = buildDisasmRows({ projection, archBits: BASE32, ip });
    expect(rows.filter((row) => row.isIp).map((row) => row.text)).toEqual(['syscall win']);
    expect(rows.find((row) => row.addr === EIP)?.isIp).toBe(true);
    expect(rows.find((row) => row.addr === 0x400000n)?.isIp).toBe(false);
  });

  it('角色寄存器不在投影里时取不到值：视图不猜名字、不标锚点、不高亮', () => {
    const projection = makeProjection({
      roles: ROLES32,
      registers: { RAX: '0x0', ESP: '0x7fffff00', EBP: '0x7fffff04' },
    });
    const ip = roleValue(projection, projection.roles, 'ip');
    expect(ip).toBeUndefined();
    const rows = buildDisasmRows({ projection, archBits: BASE32, ip });
    expect(rows.every((row) => !row.isIp)).toBe(true);
  });

  it('只换角色名、地址不变时，三条视图的落点完全一致（没有任何地方写死 RSP / RBP / RIP）', () => {
    const named = projectionWith(ROLES32, 'ESP', 'EBP', 'EIP');
    const classic = projectionWith(ROLES64_NAMES, 'RSP', 'RBP', 'RIP');

    const rolesOf = (projection: Projection) =>
      buildRegisterRows({ projection, archBits: BASE32, roles: projection.roles }).registers.map((row) => row.role);
    expect(rolesOf(named)).toEqual(rolesOf(classic));
    expect(rolesOf(named)).toEqual([undefined, 'sp', 'bp', 'ip']);

    const anchorsOf = (projection: Projection) =>
      buildStackRows({ projection, archBits: BASE32, roles: projection.roles, rowCount: 6 }).map((row) =>
        row.anchors.map((anchor) => `${anchor.role ?? '-'}@${row.addr.toString(16)}`),
      );
    expect(anchorsOf(named)).toEqual(anchorsOf(classic));

    const ipRowOf = (projection: Projection) =>
      buildDisasmRows({
        projection,
        archBits: BASE32,
        ip: roleValue(projection, projection.roles, 'ip'),
      }).findIndex((row) => row.isIp);
    expect(ipRowOf(named)).toBe(2);
    expect(ipRowOf(classic)).toBe(2);
  });

  it('角色名一律从投影读，函数本身不带任何寄存器名常量', () => {
    const projection = projection32();
    expect(REGISTER_ROLES).toEqual(['sp', 'bp', 'ip']);
    expect(REGISTER_ROLES.map((role) => roleRegisterName(projection.roles, role))).toEqual(['ESP', 'EBP', 'EIP']);
    expect(REGISTER_ROLES.map((role) => roleValue(projection, projection.roles, role))).toEqual([ESP, EBP, EIP]);
  });
});
