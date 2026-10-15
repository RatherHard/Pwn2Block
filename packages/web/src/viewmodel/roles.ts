/**
 * 角色寄存器取值（08 §9.2 第 1 行「D 使用公开角色」）。
 *
 * 角色（`sp` / `bp` / `ip`）**只从投影的 `roles` 字段读**（`ProjectionSchema.roles` 是必填），
 * 不猜 `RSP` / `RBP` / `RIP`：32 位题目（`ESP` / `EBP` / `EIP`）和自定义命名的题目都走这一条路径。
 *
 * 组件需要“角色对应的当前值”时（栈视图跟随 `sp`、指令视图高亮当前行）调用这里，
 * 不要在组件里按名字 `find`——那是第二份真相。
 */
import { parseHex, type Projection, type Roles } from '@pwn2block/shared';

export type RegisterRole = 'sp' | 'bp' | 'ip';

export const REGISTER_ROLES: readonly RegisterRole[] = ['sp', 'bp', 'ip'];

/** `sp` / `bp` / `ip` 三个角色在投影里对应的寄存器名。 */
export function roleRegisterName(roles: Roles, role: RegisterRole): string {
  return roles[role];
}

/**
 * 该角色寄存器在当前投影里的值。
 *
 * 题目声明的角色寄存器没有出现在投影 `registers` 里时返回 `undefined`：
 * 视图据此不标锚点、不自动跟随，而不是退回到猜一个名字。
 */
export function roleValue(projection: Projection, roles: Roles, role: RegisterRole): bigint | undefined {
  const name = roles[role];
  const found = projection.registers.find((item) => item.name === name);
  return found === undefined ? undefined : parseHex(found.value);
}
