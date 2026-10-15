import type { ActionOrigin, CompileError } from './types';
import { ACTION_ORIGIN_VERSION } from './types';

/**
 * 编译结果 → 画布定位桥（05 §4、08 §9.2、09 §3.4）。**纯函数**，D 直接消费。
 *
 * 编译结果里已经带着两类定位信息，D 需要的是「把它翻成该高亮哪块积木」：
 * - `errors[].blockId`：出错积木（例外是"一个开始积木都没有"那条用空串，没有位置可指）；
 * - `origins[i].blockId`：第 `i` 个提交动作由哪块积木产生（只活在前端内存里）。
 *
 * 为什么把这几行判定单独成一层，而不是让界面各写一遍：
 * - **空串不是积木 id**。`highlight('')` 在 Blockly 里是"清空高亮"，看起来没报错，
 *   实际把「这条错误定位不了」悄悄变成「把高亮清掉了」。这里统一翻成 `undefined`，
 *   让"没有位置"和"位置是空串"在类型上就没有区别（09 §8 第 8 条的失败用例正是这一类）。
 * - **来源表版本要对得上**（09 §3.4 第 4 条）：`originsVersion` 与当前版本不一致时按
 *   「来源未知」处理，不做猜测式定位。版本号漂移只可能来自热更新 / 旧快照，
 *   这时按旧下标去指一块可能已经删掉的积木，比不定位更坏。
 * - **表内下标必须自证**（`origins[i].index === i`）：错位说明产物不是这份表产生的，
 *   一样按未知处理，而不是"差一位也能猜"。
 *
 * 录像定位（09 §3.4）：录像里第 k 个 `kind === 'action'` 帧对应第 k 个提交动作（1-based），
 * 所以 `blockIdForSubmittedAction(artifact, k)` 就是那一帧该高亮的积木。
 */

/** 能提供来源表的对象：`PayloadArtifact` 与编译成功的 `CompileResult` 都结构上满足它。 */
export interface OriginSource {
  /** 与 `actions` 等长同序；`origins[i].index === i`。 */
  readonly origins: readonly ActionOrigin[];
  readonly originsVersion: number;
}

/** 来源表是否可用于定位：没传来源表、或版本与当前不一致，都算「来源未知」。 */
export function originsAreCurrent(
  source: OriginSource | undefined,
  version: number = ACTION_ORIGIN_VERSION,
): boolean {
  return source !== undefined && source.originsVersion === version;
}

/**
 * 第 `actionIndex` 个（**0-based**）提交动作对应的积木 id。
 *
 * 任何一处对不上就返回 `undefined`（版本不符 / 下标越界 / 表内 `index` 与下标不符 /
 * `blockId` 是空串）：界面据此说「来源未知」，而不是猜一块积木去高亮。
 */
export function blockIdForAction(
  source: OriginSource | undefined,
  actionIndex: number,
): string | undefined {
  if (source === undefined || !originsAreCurrent(source)) return undefined;
  if (!Number.isInteger(actionIndex) || actionIndex < 0) return undefined;
  const origin: ActionOrigin | undefined = source.origins[actionIndex];
  if (origin === undefined || origin.index !== actionIndex) return undefined;
  return origin.blockId === '' ? undefined : origin.blockId;
}

/**
 * 第 `ordinal` 个（**1-based**）提交动作对应的积木 id——与录像里第 `ordinal` 个
 * `kind === 'action'` 帧一一对应（09 §3.4）。
 *
 * 单独提供这个 1-based 入口，是因为录像定位的编号规则与数组下标差一：
 * 让调用方在**自己的编号体系里**调用，比让它每处都记得 `- 1` 更不容易错。
 */
export function blockIdForSubmittedAction(
  source: OriginSource | undefined,
  ordinal: number,
): string | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 1) return undefined;
  return blockIdForAction(source, ordinal - 1);
}

/** 这条错误能不能定位到画布上的积木：空串表示「没有具体位置」（05 §4 的唯一例外）。 */
export function isLocatableError(error: CompileError): boolean {
  return error.blockId !== '';
}

/** 第一条能定位到积木的错误：`errors[0]` 定位不了时继续往后找，而不是直接放弃。 */
export function firstLocatableError(errors: readonly CompileError[]): CompileError | undefined {
  return errors.find(isLocatableError);
}

/**
 * 编译失败后该高亮哪块积木：第一条**可定位**错误的积木 id。
 * 返回 `undefined` 表示"清掉高亮"（没有错误、或错误都没有具体位置）。
 */
export function highlightTargetForErrors(
  errors: readonly CompileError[],
): string | undefined {
  return firstLocatableError(errors)?.blockId;
}

/** 全部可定位错误的积木 id，按错误顺序去重：给 D 做「下一处错误」跳转用。 */
export function locatableErrorBlockIds(errors: readonly CompileError[]): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    if (!isLocatableError(error) || seen.has(error.blockId)) continue;
    seen.add(error.blockId);
    ids.push(error.blockId);
  }
  return ids;
}
