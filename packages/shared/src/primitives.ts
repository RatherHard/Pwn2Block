import { z } from 'zod';
import { HexSchema } from './hex';

/** 位宽由出题人指定（02 §1）。 */
export const ArchBitsSchema = z.union([z.literal(32), z.literal(64)]);
export type ArchBits = z.infer<typeof ArchBitsSchema>;

export const REGISTER_NAME_RE = /^[A-Z][A-Z0-9_]{0,15}$/;

/** 寄存器名：大写字母开头，最多 16 位（02 §2）。 */
export const RegisterNameSchema = z
  .string()
  .regex(REGISTER_NAME_RE, '寄存器名必须大写字母开头、由 A-Z 0-9 _ 组成、不超过 16 位');
export type RegisterName = z.infer<typeof RegisterNameSchema>;

export const VMA_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const VmaIdSchema = z.string().regex(VMA_ID_RE, 'VMA id 必须小写字母开头、不超过 32 位');
export type VmaId = z.infer<typeof VmaIdSchema>;

export const VMA_KINDS = ['code', 'global', 'stack', 'heap', 'key', 'custom'] as const;
export const VmaKindSchema = z.enum(VMA_KINDS);
export type VmaKind = z.infer<typeof VmaKindSchema>;

/** 权限：`r` / `w` / `x` 的任意非空子集，去重后按 rwx 规范化（02 §3）。 */
export const PermSchema = z
  .string()
  .regex(/^[rwx]{1,3}$/, '权限只能是 r / w / x 的组合')
  .transform((v) => {
    const set = new Set(v);
    return ['r', 'w', 'x'].filter((c) => set.has(c)).join('');
  });
export type Perm = z.infer<typeof PermSchema>;

export function hasPerm(perm: Perm, need: 'r' | 'w' | 'x'): boolean {
  return perm.includes(need);
}

/** 可执行 / 可写等检查用的单字符权限。 */
export const PermCharSchema = z.enum(['r', 'w', 'x']);
export type PermChar = z.infer<typeof PermCharSchema>;

/** VMA 布局：内容之外的公开信息（02 §3）；`hex` 只在可见时出现。 */
export interface VmaLayout {
  readonly id: VmaId;
  readonly kind: VmaKind;
  readonly label?: string;
  readonly start: string;
  readonly size: string;
  readonly perm: Perm;
  readonly hidden: boolean;
}

export const LABEL_KINDS = ['func', 'buffer', 'saved_bp', 'ret_addr', 'custom'] as const;
export const LabelKindSchema = z.enum(LABEL_KINDS);
export type LabelKind = z.infer<typeof LabelKindSchema>;

export const LabelSchema = z.object({
  name: z.string().min(1).max(64),
  addr: HexSchema,
  size: z.number().int().positive(),
  kind: LabelKindSchema,
});
export type Label = z.infer<typeof LabelSchema>;

export const FD_KINDS = ['stdin', 'stdout', 'file'] as const;
export const FdKindSchema = z.enum(FD_KINDS);
export type FdKind = z.infer<typeof FdKindSchema>;
