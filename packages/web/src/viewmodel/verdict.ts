/**
 * 判题结果模式（05 §6）：四种 `verdict` 的中文结论与「失败那一帧」定位。纯函数。
 *
 * 这张表是产品要求的原样落地，逐条对应 05 §6：
 * - `won`：通过横幅 + flag + 提示去 CTF 平台提交；
 * - `incomplete`：强调「payload 跑完了，但没有达成目标——不是写错了，是还差东西」；
 * - `failed`：显示命中的异常或失败条件；
 * - `rejected`：显示哪个动作被拒绝、为什么，并给出要回画布高亮的积木。
 *
 * 判胜依据（`win` 谓词）永远不在投影与录像里，所以这里的文案也拿不到它——这正是设计要求。
 */
import type { ActionResultView, ReplayView, SubmitResponse, Verdict } from '@pwn2block/shared';
import type { ActionOrigin } from '../compiler/types';
import { ACTION_ORIGIN_VERSION } from '../compiler/types';
import { blockIdForAction } from '../compiler/locate';
import { actionInstructionsAt, actionPositions, defaultPosition, failurePosition, frameAt, positionLabel } from './replay';
import { STATUS_NAMES, statusMarker, type StatusTone } from './session';

export interface FailureInfo {
  readonly message: string;
  readonly note?: string;
  readonly code?: string;
  /** 出事时正在执行的动作（0-based）与该帧标签；定位不出来时为 `undefined`（09 §3.4）。 */
  readonly actionIndex?: number;
  readonly frameLabel?: string;
}

export interface RejectedInfo extends FailureInfo {
  /** 被拒绝动作在提交序列里的下标（0-based）。 */
  readonly actionIndex: number;
  readonly action: string;
  /** 录像里对应那一帧的位置；映射不出来时为 `undefined`（不做猜测式定位，09 §3.4）。 */
  readonly position?: number;
  readonly blockId?: string;
}

export interface VerdictModel {
  readonly verdict: Verdict;
  readonly tone: StatusTone;
  /** 颜色不是唯一信息载体（05 §7）：横幅同时带符号与文字结论。 */
  readonly marker: string;
  readonly title: string;
  readonly detail: string;
  /** 仅 `won` 时服务端下发（04 §5.1）。 */
  readonly flag?: string;
  readonly rejected?: RejectedInfo;
  readonly failure?: FailureInfo;
  /** `incomplete` 的强调段：不是写错了，是还差东西。 */
  readonly emphasizeIncomplete: boolean;
  /** 默认选中的录像帧位置（05 §6：失败那一帧）。 */
  readonly defaultPosition: number;
  /** 提交的动作数（尝试过的）与实际生效的动作数（04 §5 的两种口径）。 */
  readonly attempted: number;
  readonly executed: number;
}

export interface VerdictInput {
  readonly response: SubmitResponse;
  /** 提交时那份产物的来源表：判题动作 → 积木（09 §3.4，只活在前端内存里）。 */
  readonly origins?: readonly ActionOrigin[];
  /**
   * 来源表版本（09 §3.4）：与当前版本不符时按「来源未知」处理，文案也就不再声称已高亮积木。
   * 省略时按当前版本算——控制器一定会传真实版本，省略只出现在直接构造的测试里。
   */
  readonly originsVersion?: number;
}

const DETAILS: Readonly<Record<Verdict, { readonly title: string; readonly tone: StatusTone }>> = {
  won: { title: '通过', tone: 'ok' },
  incomplete: { title: 'payload 跑完了，但没有达成目标', tone: 'warn' },
  failed: { title: '运行失败', tone: 'error' },
  rejected: { title: '动作被拒绝', tone: 'error' },
};

function noteText(note: string | undefined): string {
  return note === undefined ? '' : `（${note}）`;
}

function failureOf(result: ActionResultView): FailureInfo {
  const error = result.error;
  return error === undefined
    ? { message: '动作被拒绝，但没有给出原因' }
    : { message: error.message, code: error.code, ...(error.note === undefined ? {} : { note: error.note }) };
}

function rejectedAt(
  results: readonly ActionResultView[],
  replay: ReplayView,
  origins: readonly ActionOrigin[] | undefined,
  originsVersion: number,
): RejectedInfo | undefined {
  const actionIndex = results.findIndex((result) => !result.ok);
  if (actionIndex < 0) return undefined;
  const result = results[actionIndex];
  if (result === undefined) return undefined;
  // 第 k 个提交动作对应第 k 个 `action` 帧（09 §3.4：中间指令帧属于后一个动作，不影响这条对应）。
  const position = actionPositions(replay)[actionIndex];
  // 定位判据与画布高亮同源（`compiler/locate.ts`）：版本不符 / 下标错位一律按「来源未知」处理。
  const blockId = blockIdForAction(
    origins === undefined ? undefined : { origins, originsVersion },
    actionIndex,
  );
  return {
    actionIndex,
    action: result.action,
    ...failureOf(result),
    ...(position === undefined ? {} : { position }),
    ...(blockId === undefined ? {} : { blockId }),
  };
}

/**
 * `failed` 没有「被拒绝的动作」：失败条件命中时 `lastStop.reason = 'exception'` 且不带 error（09 §7）。
 * 出事那一帧按 09 §3.4 的归属规则找：优先带 `error` 的 `action` 帧。
 */
function failureOfRun(replay: ReplayView): FailureInfo {
  const position = failurePosition(replay);
  if (position === undefined) return { message: '回放没有正常结束，但没有给出原因' };
  const frame = frameAt(replay, position);
  if (frame === undefined) return { message: '回放没有正常结束，但没有给出原因' };
  const owner = actionInstructionsAt(replay, position)?.action;
  const context = {
    ...(owner === undefined ? {} : { actionIndex: owner }),
    frameLabel: frame.label,
  };
  if (frame.error !== undefined) {
    return {
      message: frame.error.message,
      code: frame.error.code,
      ...(frame.error.note === undefined ? {} : { note: frame.error.note }),
      ...context,
    };
  }
  const where =
    owner === undefined ? `回放的第 ${position} 帧` : `第 ${owner + 1} 个动作执行期间（回放第 ${position} 帧）`;
  return { message: `${where}进入「${STATUS_NAMES.failed}」：命中了题目的失败条件`, ...context };
}

function wonDetail(response: SubmitResponse): string {
  if (response.flag === undefined) {
    return '判定为通过，但服务端没有下发 flag（通常是服务端缺少 flag 环境变量）。请把这一情况报告给管理员。';
  }
  return '这份 payload 从初始状态出发达成了目标。把下面的 flag 提交到 CTF 平台。';
}

function buildDetail(
  response: SubmitResponse,
  rejected: RejectedInfo | undefined,
  failure: FailureInfo | undefined,
): string {
  switch (response.verdict) {
    case 'won':
      return wonDetail(response);
    case 'incomplete':
      return '不是写错了，是还差东西：回放完整跑完，成功条件仍未满足。回「调试模式」把 payload 补全，再提交一次。';
    case 'failed': {
      const where =
        failure?.actionIndex === undefined
          ? ''
          : `第 ${failure.actionIndex + 1} 个动作「${failure.frameLabel ?? '未命名'}」执行期间 —— `;
      return `命中的失败条件：${where}${failure?.message ?? '未知'}${noteText(failure?.note)}${
        failure?.code === undefined ? '' : ` · 错误码 ${failure.code}`
      }。录像已定位到出事的那一帧，用它看清是哪一步把状态带偏了。`;
    }
    case 'rejected':
      if (rejected === undefined) {
        return '提交的动作里有被拒绝的，但服务端没有指出是哪一条：请对照输出区的动作结果排查。';
      }
      return `第 ${rejected.actionIndex + 1} 个动作 ${rejected.action} 被拒绝：${rejected.message}${noteText(
        rejected.note,
      )}${rejected.code === undefined ? '' : ` · 错误码 ${rejected.code}`}。${
        rejected.blockId === undefined
          ? '（来源表里没有对应积木，无法自动定位：请按动作顺序自己找。）'
          : '画布上已高亮产生它的积木。'
      }`;
  }
}

export function verdictModel(input: VerdictInput): VerdictModel {
  const { response } = input;
  const replay = response.replay;
  const meta = DETAILS[response.verdict];
  const rejected =
    response.verdict === 'rejected'
      ? rejectedAt(response.results, replay, input.origins, input.originsVersion ?? ACTION_ORIGIN_VERSION)
      : undefined;
  // `rejected` 也要算失败帧：服务端没在结果里标出哪一条被拒时，这是唯一的兜底说明。
  const failure =
    response.verdict === 'failed' || response.verdict === 'rejected' ? failureOfRun(replay) : undefined;

  return {
    verdict: response.verdict,
    tone: meta.tone,
    marker: statusMarker(meta.tone),
    title: meta.title,
    detail: buildDetail(response, rejected, failure),
    ...(response.flag === undefined ? {} : { flag: response.flag }),
    ...(rejected === undefined ? {} : { rejected }),
    ...(failure === undefined ? {} : { failure }),
    emphasizeIncomplete: response.verdict === 'incomplete',
    defaultPosition: defaultPosition(replay),
    attempted: response.results.length,
    executed: response.executed,
  };
}

/**
 * 时间线当前位置的简短描述：`第 3 帧「write_bytes」· 已执行 5 条指令，状态可继续执行`。
 * 中间指令帧带上它属于哪个动作（09 §3.4 的归属规则）。
 */
export function positionSummary(replay: ReplayView, position: number): string {
  const frame = frameAt(replay, position);
  const status = frame?.status ?? replay.initial.status;
  const steps = frame?.steps ?? replay.initial.steps;
  const owner = frame?.kind === 'instruction' ? actionInstructionsAt(replay, position) : undefined;
  const suffix =
    owner === undefined ? '' : `（第 ${owner.action + 1} 个动作执行途中，第 ${owner.positions.indexOf(position) + 1} 条）`;
  return `第 ${position} 帧「${positionLabel(replay, position)}」${suffix}· 已执行 ${steps} 条指令，状态${
    STATUS_NAMES[status]
  }`;
}
