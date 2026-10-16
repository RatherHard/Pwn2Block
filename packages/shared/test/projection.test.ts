import { describe, expect, it } from 'vitest';
import { LastStopViewSchema, ProjectionSchema, ReplayFrameSchema, RolesSchema, StopReasonSchema } from '../src/index';

/**
 * `Projection.roles` 的契约单测（A 的自测，规则 6）。
 *
 * 依据：D1 定下的决策——在投影里增加 `roles`（08 §8 阻塞 1、§9.2 第 1 行），
 * 同步进 `docs/04` §4 的字段表与 `docs/09` §4。
 *
 * 它为什么在投影里而不是 `public.json` 里：角色寄存器名是「固定的东西」（01 §6 第 2 条）——
 * 布局与命名公开、内容隐藏。不下发的话前端只能自己猜 `RSP` / `RBP` / `RIP`，
 * 32 位题目（`ESP` / `EBP` / `EIP`）与自定义命名的题目就标不出三个指针。
 * 放进 `public.json` 则会让出题人在两个文件里声明同一件事，把漂移风险留给校验。
 *
 * 这份测试只守**契约形状**；「服务端有没有真的填、填的是不是私有包里的那份」由
 * `packages/server/test/**` 与 `tests/acceptance/**` 在真实响应上验收。
 */

/** 一份最小的合法投影（除 `roles` 外字段齐全）。 */
function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    steps: 0,
    failures: 0,
    registers: [{ name: 'RSP', value: '0x7fffff00' }],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    flags: { ZF: false, CF: false, SF: false },
    vmas: [],
    disasm: [],
    ...overrides,
  };
}

describe('Projection.roles 契约', () => {
  it('缺 roles 一律解析失败：投影必须带角色，前端不许自己猜寄存器名', () => {
    const withoutRoles = projection();
    delete withoutRoles.roles;
    const result = ProjectionSchema.safeParse(withoutRoles);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('roles');
  });

  it('三个角色原样透传，不改名、不丢字段', () => {
    const parsed = ProjectionSchema.parse(projection({ roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' } }));

    expect(parsed.roles).toEqual({ sp: 'RSP', bp: 'RBP', ip: 'RIP' });
    expect(Object.keys(parsed.roles).sort()).toEqual(['bp', 'ip', 'sp']);
  });

  it('非示例命名的题目同样成立：32 位的 ESP / EBP / EIP 不被硬编码假设挡住', () => {
    const parsed = ProjectionSchema.parse(projection({ roles: { sp: 'ESP', bp: 'EBP', ip: 'EIP' } }));

    expect(parsed.roles).toEqual({ sp: 'ESP', bp: 'EBP', ip: 'EIP' });
  });

  it('roles 的值必须是合法寄存器名，不是任意字符串', () => {
    expect(ProjectionSchema.safeParse(projection({ roles: { sp: 'rsp', bp: 'RBP', ip: 'RIP' } })).success).toBe(
      false,
    );
  });

  it('roles 只声明 sp / bp / ip 三个角色键', () => {
    expect(Object.keys(RolesSchema.shape).sort()).toEqual(['bp', 'ip', 'sp']);
  });
});


describe('?????????', () => {
  it.each(['exit', 'exception'])('?????????? %s', (reason) => {
    const lastStop = { reason, addr: '0x1000' };
    expect(ProjectionSchema.parse(projection({ lastStop })).lastStop).toEqual(lastStop);
    expect(ReplayFrameSchema.shape.lastStop.parse(lastStop)).toEqual(lastStop);
  });

  it.each(['step', 'limit'])('?????? %s ??????????', (reason) => {
    const lastStop = { reason, addr: '0x1000' };
    expect(StopReasonSchema.safeParse(reason).success).toBe(true);
    expect(LastStopViewSchema.safeParse(lastStop).success).toBe(false);
    expect(ProjectionSchema.safeParse(projection({ lastStop })).success).toBe(false);
    expect(ReplayFrameSchema.shape.lastStop.safeParse(lastStop).success).toBe(false);
  });
});
