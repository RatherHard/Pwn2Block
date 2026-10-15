/**
 * 测试辅助：按契约构造投影。
 *
 * 全部走 `ProjectionSchema.parse`，所以测试里的样例和真实响应受同一套校验约束；
 * 只依赖 node（不需要 DOM、不需要 lit）。
 */
import {
  ProjectionSchema,
  bytesToHex,
  hexToBytes,
  type Projection,
  type RegisterView,
  type VmaView,
} from '@pwn2block/shared';
import { createProjectionReader, type ProjectionReader } from '../src/viewmodel/reader';

/** 生成 `size` 字节的全零内容，按偏移打补丁；补丁偏移相对 VMA 起点。 */
export function hexOf(size: number, patches: Readonly<Record<number, string>> = {}): string {
  const bytes = new Uint8Array(size);
  for (const [offset, hex] of Object.entries(patches)) {
    bytes.set(hexToBytes(hex), Number(offset));
  }
  return bytesToHex(bytes);
}

/** 小端定宽 8 字节：`p64(0x400002)` → `0200400000000000`。 */
export function p64(value: bigint): string {
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytesToHex(out);
}

export interface MakeVmaOptions {
  readonly id: string;
  readonly start: string;
  readonly size?: string;
  readonly perm?: string;
  readonly hidden?: boolean;
  readonly hex?: string;
  readonly kind?: string;
  readonly label?: string;
}

export function makeVma(options: MakeVmaOptions): Record<string, unknown> {
  const vma: Record<string, unknown> = {
    id: options.id,
    kind: options.kind ?? 'custom',
    start: options.start,
    size: options.size ?? '0x1000',
    perm: options.perm ?? 'rw',
    hidden: options.hidden ?? false,
  };
  if (options.label !== undefined) vma['label'] = options.label;
  if (options.hex !== undefined) vma['hex'] = options.hex;
  return vma;
}

export interface MakeProjectionOptions {
  readonly registers?: Readonly<Record<string, string>>;
  readonly flags?: { readonly ZF: boolean; readonly CF: boolean; readonly SF: boolean };
  readonly vmas?: readonly Record<string, unknown>[];
  readonly disasm?: readonly Record<string, unknown>[];
  readonly stdin?: { readonly hex: string; readonly pos: number };
  readonly stdout?: { readonly hex: string };
  readonly status?: string;
  readonly steps?: number;
  readonly failures?: number;
  readonly lastStop?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
}

const DEFAULT_REGISTERS: Readonly<Record<string, string>> = {
  RSP: '0x7fffff00',
  RBP: '0x7fffff10',
  RIP: '0x400000',
  RAX: '0x0',
};

const DEFAULT_VMAS: readonly Record<string, unknown>[] = [
  makeVma({ id: 'text', kind: 'code', start: '0x400000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c9c30f0e' }) }),
  makeVma({ id: 'stack', kind: 'stack', start: '0x7fffe000', size: '0x2000', perm: 'rw', hex: hexOf(0x2000) }),
];

const DEFAULT_DISASM: readonly Record<string, unknown>[] = [
  { addr: '0x400000', bytes: 'c9', text: 'leave' },
  { addr: '0x400001', bytes: 'c3', text: 'ret' },
  { addr: '0x400002', bytes: '0f', text: 'syscall win' },
  { addr: '0x400003', bytes: '0e', text: 'syscall exit' },
];

function registerList(values: Readonly<Record<string, string>>): readonly RegisterView[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

export function makeProjection(options: MakeProjectionOptions = {}): Projection {
  return ProjectionSchema.parse({
    status: options.status ?? 'ready',
    steps: options.steps ?? 0,
    failures: options.failures ?? 0,
    registers: registerList(options.registers ?? DEFAULT_REGISTERS),
    flags: options.flags ?? { ZF: false, CF: false, SF: false },
    vmas: options.vmas ?? DEFAULT_VMAS,
    disasm: options.disasm ?? DEFAULT_DISASM,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.lastStop === undefined ? {} : { lastStop: options.lastStop }),
    ...(options.error === undefined ? {} : { error: options.error }),
  });
}

export function makeReader(projection: Projection, archBits = 64): ProjectionReader {
  return createProjectionReader(projection, archBits);
}

/** 常用：一块可控内存（`0x100000`，`rw`）加一块代码区（`0x400000`，`rx`）。 */
export function memoryProjection(
  dataHex: string,
  options: { readonly dataSize?: number; readonly extraVmas?: readonly Record<string, unknown>[] } = {},
): Projection {
  return makeProjection({
    vmas: [
      ...DEFAULT_VMAS,
      makeVma({
        id: 'data',
        start: '0x100000',
        size: `0x${(options.dataSize ?? 0x1000).toString(16)}`,
        kind: 'global',
        hex: dataHex,
      }),
      ...(options.extraVmas ?? []),
    ],
  });
}

export type { VmaView };
