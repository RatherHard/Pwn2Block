/**
 * 运行菜单 / payload 工具栏的按钮模型（05 §1、§3、§6）。纯函数，两处菜单共用同一份判定。
 *
 * 顶部「运行」菜单与 payload 工具栏等价（05 §1），所以按钮的可用性与禁用原因只能有**一处**
 * 事实来源，否则两处的禁用状态会漂移。组件只负责把这里的模型渲染成按钮并把
 * `RunCommand` 派发出去。
 *
 * 终止态口径（04 §1.1）：**`failed`（判负）** 与 **已退出** 都是终止态，两者都禁用执行类动作
 * （试运行 / 单步 / 运行 N 步），**回退类（后退一步 / 撤销 / 重置）与「提交判题」不受影响**。
 * 判定只看 `RunMenuInput.terminal` 这一个字段，由调用方用 `viewmodel/session.ts` 的
 * `terminalReasonOf()` 从**调试实例投影**派生，不允许各处自己拼 `status`。
 */
import { MAX_STEP_COUNT, type HistoryDepthView } from '@pwn2block/shared';
import type { PayloadArtifact } from '../compiler/artifact';
import {
  MESSAGE_COMPILE_FAILED,
  MESSAGE_EMPTY_PROGRAM,
  MESSAGE_NEED_COMPILE,
  MESSAGE_STALE,
} from './program';
import type { PageMode, TerminalReason } from './session';

/** 工具栏能做的事。「编译」是本地操作，不是 API 请求，所以单独一类。 */
export type RunCommand =
  | { readonly kind: 'trial-run' }
  | { readonly kind: 'step' }
  | { readonly kind: 'run-n'; readonly count: number }
  | { readonly kind: 'step-back' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'submit' };

export type RunButtonId = RunCommand['kind'] | 'compile';

export interface RunButtonModel {
  readonly id: RunButtonId;
  readonly label: string;
  readonly hint: string;
  readonly enabled: boolean;
  /** 禁用原因（05 §6）：必须写出来，不能只靠置灰。 */
  readonly disabledReason?: string;
}

export interface RunMenuInput {
  readonly mode: PageMode;
  readonly hasSession: boolean;
  readonly sessionExpired: boolean;
  readonly artifact: PayloadArtifact | undefined;
  readonly stale: boolean;
  /** 最近一次编译的错误条数：用来区分「没编译过」与「编译失败」。 */
  readonly compileErrorCount: number;
  readonly history: HistoryDepthView;
  readonly cursor: number;
  readonly allowedActions: readonly string[];
  /**
   * 终止态（04 §1.1）：`failed` 判负或 `exited` 已结束，`undefined` 表示还能继续执行。
   * 调用方用 `viewmodel/session.ts` 的 `terminalReasonOf()` 从调试实例投影派生。
   *
   * 这里刻意带**原因**而不是一个布尔：两条来路的禁用文案不同（判负 ≠ 已退出），
   * 但仍然只有一个字段、一处判据，不存在两个并列布尔互相漂移的可能。
   */
  readonly terminal?: TerminalReason;
}

interface Gate {
  readonly enabled: boolean;
  readonly reason?: string;
}

function gate(reason: string | undefined): Gate {
  return reason === undefined ? { enabled: true, reason: undefined } : { enabled: false, reason };
}

/** 会话层面的禁用（05 §6）：没有会话、会话失效、或在判题结果模式里。 */
function sessionBlocked(input: RunMenuInput): string | undefined {
  if (!input.hasSession) return '会话还没准备好：先在上面选一道题';
  if (input.sessionExpired) return '会话已失效：点「重新开始」再继续';
  return undefined;
}

/** 产物层面的禁用（05 §3、09 §3.2）：未编译 / 编译失败 / 改动后过期。 */
function artifactBlocked(input: RunMenuInput): string | undefined {
  if (input.stale) return MESSAGE_STALE;
  if (input.artifact === undefined) {
    return input.compileErrorCount > 0 ? MESSAGE_COMPILE_FAILED : MESSAGE_NEED_COMPILE;
  }
  return undefined;
}

/** 判题结果模式下前七个按钮不作用于录像，禁用并说明；「提交判题」不受影响（提交不限次数）。 */
function debugBlocked(input: RunMenuInput): string | undefined {
  if (input.mode === 'verdict') return '判题结果模式看的是录像：先点「回到调试」再继续调试';
  return undefined;
}

/**
 * 已退出 = 程序执行到结束（04 §1.1）：执行类动作会被服务端拒绝，回退类与「提交判题」不受影响。
 * 判胜那一刻程序也可能已经结束，此时 `status` 是 `satisfied`，只有 `lastStop.reason` 能说明。
 */
export const MESSAGE_EXITED =
  '程序已退出：执行类动作会被服务端拒绝，请用「后退一步」「撤销」「重置」重来，或直接「提交判题」';

/**
 * 判负 = `failed`：运行时异常或命中失败条件（03 §2.1）。
 * 与「已退出」分开写：判负未必是 `exit` 造成的，说成「已退出」会让学习者找错方向。
 */
export const MESSAGE_FAILED =
  '程序已被判负（运行出错或命中失败条件）：执行类动作会被服务端拒绝，请用「后退一步」「撤销」「重置」重来，或直接「提交判题」';

/** 终止态原因 → 禁用文案：两条来路都要给出出路，且都必须逐字可读（05 §6）。 */
const MESSAGE_TERMINAL: Readonly<Record<TerminalReason, string>> = {
  failed: MESSAGE_FAILED,
  exited: MESSAGE_EXITED,
};

/** 终止态（failed / 已退出）一律禁执行类动作（04 §1.1）。 */
function terminalBlocked(input: RunMenuInput): string | undefined {
  return input.terminal === undefined ? undefined : MESSAGE_TERMINAL[input.terminal];
}

function firstReason(...reasons: readonly (string | undefined)[]): string | undefined {
  return reasons.find((reason) => reason !== undefined);
}

function remainingActions(input: RunMenuInput): number {
  const total = input.artifact?.actions.length ?? 0;
  const cursor = Math.min(Math.max(0, input.cursor), total);
  return total - cursor;
}

/**
 * 「试运行 / 单步」在程序区动作用完时退化成 `run` / `step`（05 §3），
 * 所以退化路径要检查 `allowedActions`。
 */
function fallbackBlocked(input: RunMenuInput, name: 'run' | 'step'): string | undefined {
  if (remainingActions(input) > 0) return undefined;
  if (input.allowedActions.includes(name)) return undefined;
  return `没有剩余动作，会退化成 ${name}，但本题不允许 ${name} 动作`;
}

function backDepth(input: RunMenuInput): { readonly stepBack: string | undefined; readonly undo: string | undefined } {
  const empty = input.history.undo === 0 && input.history.stepBack === 0;
  return {
    stepBack:
      input.history.stepBack > 0
        ? undefined
        : empty
          ? '历史为空，没有可回退的指令'
          : '已退到 64 条指令窗口之外，只能用「撤销」或「重置」',
    undo: input.history.undo > 0 ? undefined : '历史为空，没有可撤销的提交',
  };
}

interface Spec {
  readonly id: RunButtonId;
  readonly label: string;
  readonly hint: string;
  /** 返回禁用原因；`undefined` 表示可用。 */
  readonly blocked: (input: RunMenuInput) => string | undefined;
}

const SPECS: readonly Spec[] = [
  {
    id: 'compile',
    label: '编译',
    hint: '把积木编译成原子动作序列，不提交',
    blocked: (input) => firstReason(sessionBlocked(input)),
  },
  {
    id: 'trial-run',
    label: '试运行',
    hint: '把剩余动作提交到调试实例；序列用完时提交 run',
    blocked: (input) =>
      firstReason(
        sessionBlocked(input),
        debugBlocked(input),
        terminalBlocked(input),
        artifactBlocked(input),
        fallbackBlocked(input, 'run'),
      ),
  },
  {
    id: 'step',
    label: '单步',
    hint: '提交下一个动作；序列用完时提交 step',
    blocked: (input) =>
      firstReason(
        sessionBlocked(input),
        debugBlocked(input),
        terminalBlocked(input),
        artifactBlocked(input),
        fallbackBlocked(input, 'step'),
      ),
  },
  {
    id: 'run-n',
    label: '运行 N 步',
    hint: `提交 step 带 count（1–${MAX_STEP_COUNT}），断点的替代品`,
    blocked: (input) =>
      firstReason(
        sessionBlocked(input),
        debugBlocked(input),
        terminalBlocked(input),
        input.allowedActions.includes('step') ? undefined : '本题不允许 step 动作',
      ),
  },
  {
    id: 'step-back',
    label: '后退一步',
    hint: '提交 step_back，倒回一条指令（最近 64 条内有效）',
    blocked: (input) => firstReason(sessionBlocked(input), debugBlocked(input), backDepth(input).stepBack),
  },
  {
    id: 'undo',
    label: '撤销',
    hint: '提交 undo，回退上一次提交（回退类动作始终可用）',
    blocked: (input) => firstReason(sessionBlocked(input), debugBlocked(input), backDepth(input).undo),
  },
  {
    id: 'reset',
    label: '重置',
    hint: '提交 reset，回到题目初始状态',
    blocked: (input) => firstReason(sessionBlocked(input), debugBlocked(input)),
  },
  {
    id: 'submit',
    label: '提交判题',
    hint: '把完整动作序列发到 /submit，切到判题结果模式（不限次数）',
    blocked: (input) =>
      firstReason(
        sessionBlocked(input),
        artifactBlocked(input),
        (input.artifact?.actions.length ?? 0) === 0 ? MESSAGE_EMPTY_PROGRAM : undefined,
      ),
  },
];

export function runMenuModel(input: RunMenuInput): readonly RunButtonModel[] {
  return SPECS.map((spec) => {
    const verdict = gate(spec.blocked(input));
    return {
      id: spec.id,
      label: spec.label,
      hint: spec.hint,
      enabled: verdict.enabled,
      ...(verdict.reason === undefined ? {} : { disabledReason: verdict.reason }),
    };
  });
}

/** 禁用原因的纯文本清单：颜色不是唯一信息载体（05 §7）。 */
export function disabledReasons(model: readonly RunButtonModel[]): readonly string[] {
  return model
    .filter((button) => !button.enabled && button.disabledReason !== undefined)
    .map((button) => `${button.label}：${button.disabledReason ?? ''}`);
}

export function buttonModel(
  model: readonly RunButtonModel[],
  id: RunButtonId,
): RunButtonModel | undefined {
  return model.find((button) => button.id === id);
}
