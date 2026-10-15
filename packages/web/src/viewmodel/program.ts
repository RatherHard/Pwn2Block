/**
 * 程序区（05 §3）：把编译产物摊成「一行一个动作」，并标出当前执行位置。
 *
 * 数据来源只有一个：H 的 `ArtifactTracker.state`（09 §3.2 冻结）。这里不再维护第二份
 * 产物或过期状态，只做展示层投影——所以「点了哪一行 → 高亮哪块积木」「第几个动作 →
 * 哪块积木」都读同一份 `origins` 来源表。
 */
import { runMaxSteps, stepCount, type Action } from '@pwn2block/shared';
import type { ActionOrigin, CompiledAction } from '../compiler/types';
import type { PayloadArtifact } from '../compiler/artifact';
import { formatHexSpaced } from './format';

/** 05 §3：改了积木必须重新编译，过期产物不许试运行也不许提交。 */
export const MESSAGE_STALE = '积木已改动，请重新编译';
/** 从未编译过（或编译失败清空了产物）时的提示。 */
export const MESSAGE_NEED_COMPILE = '程序区还没有编译产物：先在画布上拼程序，再点「编译」';
/** 编译失败后按钮被禁用的原因（错误逐条列在输出区）。 */
export const MESSAGE_COMPILE_FAILED = '编译失败：先按输出区的错误修正积木，再点「编译」';
/** 空程序是合法的编译结果，但提交会被服务端拒绝（请求体至少一个动作）。 */
export const MESSAGE_EMPTY_PROGRAM = '程序区没有动作：未连到「开始」积木的积木不参与编译（05 §3.1）';

export interface ProgramRow {
  readonly index: number;
  /** 动作类型名，程序区左列显示，便于对照 04 §2 的动作表。 */
  readonly type: string;
  /** 中文说明（含参数）。 */
  readonly label: string;
  /** 产生这个动作的积木；来源未知时为 `undefined`（不做猜测式定位，09 §3.4）。 */
  readonly blockId?: string;
  /** 当前执行位置（下一次要提交的动作）。 */
  readonly current: boolean;
  /** 已经提交过的动作。 */
  readonly done: boolean;
}

function argsText(args: Readonly<Record<string, string | number>>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '无参数';
  return entries.map(([name, value]) => `${name}=${String(value)}`).join(' ');
}

function byteCount(hex: string): number {
  return Math.floor(hex.length / 2);
}

/** 一个编译出的动作 → 中文单行说明。参数文案与 04 §2 的动作表对齐。 */
export function describeAction(action: CompiledAction): string {
  switch (action.type) {
    case 'write_bytes':
      return `写入 ${action.addr} ← ${formatHexSpaced(action.hex)}（${byteCount(action.hex)} 字节）`;
    case 'push':
      return `压栈 ${action.value}`;
    case 'pop':
      return '弹栈：校验后丢弃值，只把 sp 前移一个字';
    case 'call':
      return `调用 ${action.addr}：压入当前 ip，不执行指令`;
    case 'ret':
      return '返回：弹出栈顶到 ip';
    case 'feed':
      return `喂入 stdin ${formatHexSpaced(action.hex)}（${byteCount(action.hex)} 字节）`;
    case 'step':
      return `执行 ${stepCount(action)} 条指令`;
    case 'run':
      return `连续执行：直到退出、异常或 ${runMaxSteps(action)} 条上限`;
    case 'block':
      return `出题人积木 ${action.id}（${argsText(action.args)}）`;
  }
}

export function programRows(
  artifact: PayloadArtifact | undefined,
  cursor: number,
): readonly ProgramRow[] {
  if (artifact === undefined) return [];
  return artifact.actions.map((action, index) => ({
    index,
    type: action.type,
    label: describeAction(action),
    blockId: artifact.origins[index]?.blockId,
    current: index === cursor,
    done: index < cursor,
  }));
}

/** 第 `index` 个动作来自哪块积木；来源表版本不符或越界时按「来源未知」处理（09 §3.4）。 */
export function blockIdOfAction(
  artifact: PayloadArtifact | undefined,
  origins: readonly ActionOrigin[] | undefined,
  index: number,
): string | undefined {
  const table = artifact?.origins ?? origins;
  const origin = table?.[index];
  if (origin === undefined || origin.index !== index) return undefined;
  return origin.blockId;
}

/**
 * 提交给调试实例 / 判题的动作：`step` 带 `count`，`run` 不带参数时取默认上限。
 * 工具栏按钮构造的动作都经过这里，保证请求体形状只有一处。
 */
export function stepAction(count?: number): Action {
  return count === undefined ? { type: 'step' } : { type: 'step', count };
}

export function runAction(): Action {
  return { type: 'run' };
}

/** 05 §3：「运行 N 步」的输入框只接受正整数；越界返回 `undefined` 由调用方提示。 */
export function parseStepCount(text: string, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return undefined;
  return value;
}
