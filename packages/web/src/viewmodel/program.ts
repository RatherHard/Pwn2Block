/**
 * 编译相关文案与「运行 N 步」解析（05 §3）。
 *
 * 程序区已删除（画布高亮是唯一的定位线索，05 §4）：这里只保留跨组件共用的文案常量
 * 与提交动作用到的纯函数，不再维护任何「一行一个动作」的展示层投影。
 */
import type { Action } from '@pwn2block/shared';

/** 05 §3：改了积木必须重新编译，过期产物不许试运行也不许提交。 */
export const MESSAGE_STALE = '积木已改动，正在重新编译';
/** 从未编译过（或编译失败清空了产物）时的提示。 */
export const MESSAGE_NEED_COMPILE = '画布还没有可运行的程序：先拼积木';
/** 编译失败后按钮被禁用的原因（错误逐条列在输出区）。 */
export const MESSAGE_COMPILE_FAILED = '编译失败：先按输出区的错误修正积木';
/** 空程序是合法的编译结果，但提交会被服务端拒绝（请求体至少一个动作）。 */
export const MESSAGE_EMPTY_PROGRAM = '画布上没有动作：未连到「开始」积木的积木不参与编译';

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
