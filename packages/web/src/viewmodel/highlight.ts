/**
 * 「该高亮哪块积木」的唯一派生点（05 §4、§6，09 §3.4）。纯函数，可在 node 里单测。
 *
 * 界面上的两处定位读同一个结果，不允许各算一套：
 * - **画布高亮**：`app-shell` 把它作为 `highlightBlockId` 交给 payload 面板 → Blockly 桥；
 * - **输出区 / 判题横幅**：错误条目与被拒绝动作的「定位积木」按钮。
 *
 * 所有位置判定都经 H 的 `compiler/locate.ts`：空串 `blockId` 翻成「没有位置」，
 * 来源表版本不符、下标错位、动作类型对不上一律按「来源未知」处理——宁可不说，
 * 也不去指一块可能已经被删掉的积木（09 §3.4）。
 */
import type { ActionResultView } from '@pwn2block/shared';
import type { PayloadArtifact } from '../compiler/artifact';
import { blockIdForAction, highlightTargetForErrors } from '../compiler/locate';
import type { ActionOrigin, CompileError } from '../compiler/types';
import type { PageMode } from './session';

/** 判题那份产物的来源表与它的版本（判题结果模式定位用；只活在前端内存里）。 */
export interface VerdictHighlight {
  readonly results: readonly ActionResultView[];
  readonly origins: readonly ActionOrigin[];
  readonly originsVersion: number;
}

export interface HighlightInput {
  readonly mode: PageMode;
  readonly verdict?: VerdictHighlight;
  /** 当前的编译产物（09 §3.2 的追踪器快照）。 */
  readonly artifact: PayloadArtifact | undefined;
  readonly errors: readonly CompileError[];
  /** 最近一次请求的动作结果与游标（调试实例）。 */
  readonly results: readonly ActionResultView[];
  readonly cursor: number;
}

/** 结果列表里第一条被拒绝的动作下标；全部成功时 `undefined`。 */
function firstRejected(results: readonly ActionResultView[]): ActionResultView | undefined {
  return results.find((result) => !result.ok);
}

/**
 * 结果的第 `index` 条对应产物里的第几个动作（0-based）。`offset` 是结果的第 0 条对应的
 * 产物下标：调试路径是 `cursor - results.length`，判题路径是 `0`。
 *
 * 越界、或产物里的动作类型与结果里的 `action` 不一致，都返回 `undefined`——错位说明这份结果
 * 不是这份产物产生的，猜一位只会指错积木。
 */
export function actionRowFor(
  artifact: PayloadArtifact | undefined,
  results: readonly ActionResultView[],
  offset: number,
  index: number,
): number | undefined {
  const result = results[index];
  if (result === undefined || artifact === undefined) return undefined;
  const row = offset + index;
  if (!Number.isInteger(row) || row < 0) return undefined;
  if (artifact.actions[row]?.type !== result.action) return undefined;
  return row;
}

/**
 * 结果里第一条被拒绝的动作在产物里的下标（0-based）；没有拒绝或定位不出来时 `undefined`。
 * 画布高亮与输出区的「定位积木」据此找到那块积木（05 §6 的 `rejected` 结论）。
 */
export function rejectedRowFor(
  artifact: PayloadArtifact | undefined,
  results: readonly ActionResultView[],
  offset: number,
): number | undefined {
  const index = results.findIndex((result) => !result.ok);
  if (index < 0) return undefined;
  return actionRowFor(artifact, results, offset, index);
}

/**
 * 调试路径的偏移 `分片起点`：**服务端 `results` 的下标基准是分片起点**（04 §5），
 * 不是整份产物的起点——一次「运行」会按 `MAX_ACTIONS_PER_REQUEST`（512）分片，
 * 每片的 `results[i]` 说的是这一片里第 `i` 个动作。
 *
 * 控制器把游标按 `results.length`（这一片尝试过的动作数）推进，所以
 * `分片起点 = cursor - results.length`，于是「结果第 i 条 → 产物下标 = 分片起点 + i」。
 * 这条加法是**界面自己的状态**，不是 `locate.ts` 的知识（A 的口径：不加 `blockIdForBatchAction`）。
 */
export function debugOffset(results: readonly ActionResultView[], cursor: number): number {
  return cursor - results.length;
}

/**
 * 当前该在画布上高亮的积木 id；`undefined` 表示「清掉高亮」。
 *
 * 优先级：判题结果里的被拒绝动作 → 调试结果里的被拒绝动作 → 第一条可定位的编译错误。
 * 判题那份来源表版本对不上时不猜，但也不因此挡掉编译错误的定位（画布在两种模式下都可见）。
 */
export function highlightBlockId(input: HighlightInput): string | undefined {
  const verdict = input.verdict;
  if (input.mode === 'verdict' && verdict !== undefined) {
    const rejected = firstRejected(verdict.results);
    if (rejected !== undefined) {
      const id = blockIdForAction(
        { origins: verdict.origins, originsVersion: verdict.originsVersion },
        verdict.results.indexOf(rejected),
      );
      if (id !== undefined) return id;
    }
  }

  const debugRow = rejectedRowFor(input.artifact, input.results, debugOffset(input.results, input.cursor));
  if (debugRow !== undefined) {
    const id = blockIdForAction(input.artifact, debugRow);
    if (id !== undefined) return id;
  }

  // 编译失败时产物已被清空（09 §3.2）：第一条**可定位**的错误才是该指的那块积木。
  if (input.artifact !== undefined || input.errors.length === 0) return undefined;
  return highlightTargetForErrors(input.errors);
}
