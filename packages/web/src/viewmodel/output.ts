/**
 * 输出区（05 §3、§4、§5、§6）：编译错误、逐步动作结果、错误解释与状态引导。
 *
 * 三条来自文档的硬要求，都在这里落成可测的纯函数：
 * - 编译错误逐条列出，并带上出错积木的 id，界面据此高亮（05 §4）；
 * - 动作结果区分「成功 / 拒绝 / 异常」，错误解释取投影的 `error.message` 与 `error.note`（05 §5）；
 * - 调试模式进入 `satisfied` 只说「当前状态已满足成功条件」并引导去提交，
 *   **不发 flag、不显示判胜依据**（05 §6）——所以这里的文案里没有 flag，也没有成功条件本身。
 */
import { isVmErrorCode, type ActionResultView, type Projection } from '@pwn2block/shared';
import type { PayloadArtifact } from '../compiler/artifact';
import type { CompileError } from '../compiler/types';
import { MESSAGE_STALE } from './program';
import type { StatusTone } from './session';

export interface OutputEntry {
  /** lit 的 `repeat` 用的稳定 key。 */
  readonly key: string;
  readonly tone: StatusTone;
  /** 文字标签：「编译错误」「成功」「拒绝」「异常」…（颜色不是唯一信息载体，05 §7）。 */
  readonly label: string;
  readonly text: string;
  readonly detail?: string;
  /** 出错积木：点这条输出可跳回画布高亮它。 */
  readonly blockId?: string;
}

export interface OutputInput {
  readonly artifact: PayloadArtifact | undefined;
  readonly errors: readonly CompileError[];
  readonly stale: boolean;
  /** 最近一次请求的动作结果（04 §5 的 `results`）。 */
  readonly results: readonly ActionResultView[];
  readonly projection?: Projection;
}

export const TEXT_SATISFIED = '当前状态已满足成功条件：确认 payload 自足后点「提交判题」。';
const DETAIL_SATISFIED = '调试实例是草稿纸，这里的“满足”不代表通过；通过与否只由提交后的判题实例决定。';

function compileEntries(errors: readonly CompileError[]): readonly OutputEntry[] {
  if (errors.length === 0) return [];
  const head: OutputEntry = {
    key: 'compile-head',
    tone: 'error',
    label: '编译错误',
    text: `编译失败：共 ${errors.length} 条错误。程序区没有可用产物，点下面任意一条可高亮对应积木。`,
  };
  return [
    head,
    ...errors.map((error, index) => ({
      key: `compile-${index}`,
      tone: 'error' as StatusTone,
      label: `第 ${index + 1} 条`,
      text: error.message,
      ...(error.blockId === '' ? {} : { blockId: error.blockId }),
    })),
  ];
}

function errorText(error: { readonly message: string; readonly note?: string; readonly code: string }): string {
  const note = error.note === undefined ? '' : `（${error.note}）`;
  return `${error.message}${note} · 错误码 ${error.code}`;
}

function resultEntry(result: ActionResultView, index: number): OutputEntry {
  const position = `第 ${index + 1} 个动作 ${result.action}`;
  if (result.ok) {
    return { key: `result-${index}`, tone: 'ok', label: '成功', text: `${position} 执行成功` };
  }
  const error = result.error;
  // 运行期异常（指令出错）与动作被拒绝是两回事（04 §2）：界面要说清是哪一种。
  const exception = error !== undefined && isVmErrorCode(error.code);
  return {
    key: `result-${index}`,
    tone: 'error',
    label: exception ? '异常' : '拒绝',
    text: exception ? `${position} 触发运行期异常` : `${position} 被拒绝，状态未改变`,
    ...(error === undefined ? {} : { detail: errorText(error) }),
  };
}

function projectionEntries(projection: Projection): readonly OutputEntry[] {
  switch (projection.status) {
    case 'satisfied':
      return [
        {
          key: 'status-satisfied',
          tone: 'ok',
          label: '满足条件',
          text: TEXT_SATISFIED,
          detail: DETAIL_SATISFIED,
        },
      ];
    case 'failed': {
      const error = projection.error;
      return [
        {
          key: 'status-failed',
          tone: 'error',
          label: '运行失败',
          text: error === undefined ? '运行失败' : `运行失败：${error.message}`,
          detail:
            error === undefined
              ? '可用「后退一步」倒回出事前，或「撤销」「重置」重来。'
              : `${error.note === undefined ? '' : `${error.note} · `}错误码 ${error.code}。可用「后退一步」倒回出事前，或「撤销」「重置」重来。`,
        },
      ];
    }
    case 'exited':
      return [
        {
          key: 'status-exited',
          tone: 'warn',
          label: '程序结束',
          text: '程序已结束，但没有满足成功条件。可用「撤销」或「重置」重来。',
        },
      ];
    case 'ready':
    default:
      return [];
  }
}

export function outputEntries(input: OutputInput): readonly OutputEntry[] {
  const entries: OutputEntry[] = [...compileEntries(input.errors)];

  if (input.stale && input.errors.length === 0) {
    entries.push({
      key: 'stale',
      tone: 'warn',
      label: '已过期',
      text: `${MESSAGE_STALE}：程序区显示的还是上一次的产物，重新编译前不能试运行或提交。`,
    });
  }

  entries.push(...input.results.map((result, index) => resultEntry(result, index)));

  const projection = input.projection;
  if (projection !== undefined) entries.push(...projectionEntries(projection));

  if (entries.length === 0) {
    entries.push({
      key: 'idle',
      tone: 'info',
      label: '提示',
      text:
        projection === undefined
          ? '会话还没开始：选一道题后这里显示动作结果与错误解释。'
          : '还没有结果：点「编译」，再用「试运行」或「单步」把动作提交到调试实例。',
    });
  }
  return entries;
}
