/**
 * 页面状态与状态栏文案（05 §1、§6）。纯函数。
 *
 * 页面只持有“最新投影 + 上一份投影 + 视图管理器状态 + 模式”：
 * 高亮由两份投影差分得到（04 §4），两种模式共用同一套视图，只是数据源不同。
 */
import type { InstanceStatus, Projection } from '@pwn2block/shared';
import { formatAddrShort } from './format';
import { createViewManagerState, type ViewManagerState } from './views';

export type PageMode = 'debug' | 'verdict';

export const MODE_NAMES: Readonly<Record<PageMode, string>> = {
  debug: '调试模式',
  verdict: '判题结果',
};

export const STATUS_NAMES: Readonly<Record<InstanceStatus, string>> = {
  ready: '可继续执行',
  satisfied: '已满足成功条件',
  failed: '运行失败',
  exited: '程序已结束',
};

export interface PageState {
  readonly mode: PageMode;
  readonly projection: Projection;
  /** 上一份投影，用于差分高亮。 */
  readonly previous?: Projection;
  readonly views: ViewManagerState;
}

export function createPageState(projection: Projection, views?: ViewManagerState): PageState {
  return { mode: 'debug', projection, views: views ?? createViewManagerState() };
}

/** 收到新投影：旧的变成 `previous`，视图状态与模式保持不变。 */
export function applyProjection(state: PageState, next: Projection): PageState {
  if (next === state.projection) return state;
  return { ...state, previous: state.projection, projection: next };
}

export function setMode(state: PageState, mode: PageMode): PageState {
  return mode === state.mode ? state : { ...state, mode };
}

/**
 * 「程序已退出」的唯一派生口径（04 §1.1、09 §8 第 10 条）。
 *
 * 与引擎的 `isExited()`（`packages/engine/src/state.ts`）同一判据：`status === 'exited'`，
 * 或**退出那一刻同时满足成功条件**——后者的 `status` 是 `satisfied`，只有
 * `lastStop.reason === 'exit'` 能说明程序已经结束。只看 `status` 会有两处盲区：
 * 工具栏放行了注定被拒的执行类动作，512 分片在退出落在片边界时多发一片（都会白记 failures）。
 */
export function isExitedProjection(projection: Projection): boolean {
  return projection.status === 'exited' || projection.lastStop?.reason === 'exit';
}

/**
 * 终止态的原因（04 §1.1）：`failed` 是判负（异常或命中失败条件），`exited` 是程序已经结束。
 * 两者都拒绝执行类动作，但原因不同，界面文案必须分开——判负未必是 `exit` 造成的。
 */
export type TerminalReason = 'failed' | 'exited';

/**
 * 终止态的**唯一**派生口径，与引擎的 `isTerminal()`（`packages/engine/src/state.ts`）同源：
 * `status === 'failed' || isExitedProjection(projection)`。
 *
 * 判负优先于已退出：`failed` 的实例也可能带着 `lastStop.reason === 'exit'`（例如退出那一刻命中
 * 失败条件），此刻学习者最需要看到的是「判负」，而不是退出细节，所以 `failed` 先行。
 */
export function terminalReasonOf(projection: Projection): TerminalReason | undefined {
  if (projection.status === 'failed') return 'failed';
  return isExitedProjection(projection) ? 'exited' : undefined;
}

export type StatusTone = 'ok' | 'warn' | 'error' | 'info';

export interface StatusText {
  readonly text: string;
  readonly tone: StatusTone;
}

const TONE_MARKERS: Readonly<Record<StatusTone, string>> = {
  ok: '●',
  warn: '▲',
  error: '■',
  info: '·',
};

/** 颜色不是唯一信息载体（05 §7）：状态栏同时显示符号。 */
export function statusMarker(tone: StatusTone): string {
  return TONE_MARKERS[tone];
}

/** 满足条件且已退出：两处反馈使用同一份具体操作引导（05 §6）。 */
export const SATISFIED_EXIT_GUIDANCE =
  '程序已经退出，执行类动作会被拒绝。可直接「提交判题」，或用「后退一步」「撤销」「重置」继续调试。';

function debugText(projection: Projection): StatusText {
  const failureNote = projection.failures > 0 ? `（已失败 ${projection.failures} 次）` : '';
  switch (projection.status) {
    case 'satisfied':
      // 退出与满足可以同时成立（04 §1.1）：这时执行类动作已被服务端拒绝，
      // 状态栏只说「已满足」会让用户不明白按钮为什么点不动。
      return isExitedProjection(projection)
        ? {
            tone: 'ok',
            text: `当前状态已满足成功条件。${SATISFIED_EXIT_GUIDANCE}`,
          }
        : {
            tone: 'ok',
            text: '当前状态已满足成功条件。调试模式不发 flag：确认 payload 自足后再点「提交判题」。',
          };
    case 'failed': {
      const note = projection.error?.note === undefined ? '' : `（${projection.error.note}）`;
      const message = projection.error?.message ?? '运行时异常';
      return { tone: 'error', text: `运行失败：${message}${note}。可用 step_back 倒回，或 undo / reset 重来。` };
    }
    case 'exited':
      return { tone: 'warn', text: '程序已结束，但没有满足成功条件。可用 undo / reset 重来。' };
    case 'ready':
    default:
      return {
        tone: 'info',
        text: `可继续执行：已执行 ${projection.steps} 条指令${failureNote}`,
      };
  }
}

export function statusTextOf(projection: Projection, mode: PageMode): StatusText {
  if (mode === 'verdict') {
    return {
      tone: 'info',
      text: '判题结果模式：右边是判定结论与回放录像，左侧视图读的是录像里的某一帧；调试实例没有被提交改动，随时可以「回到调试」。',
    };
  }
  return debugText(projection);
}

/** 状态栏左侧的模式标签（09 §2）：`DEBUG │ … │ ip=… │ 动作 n/m` 的第一段。 */
export const STATUS_MODE_TAGS: Readonly<Record<PageMode, string>> = {
  debug: 'DEBUG',
  verdict: 'VERDICT',
};

export interface StatusBarInput {
  readonly mode: PageMode;
  readonly projection: Projection;
  readonly ip?: bigint;
  readonly cursor: number;
  readonly total: number;
  /** 上一轮「运行」被终止时执行到的位置（Task 5 的 `ControllerState.aborted`）。 */
  readonly aborted?: { readonly executed: number; readonly total: number };
}

/**
 * 四段拼接的公共逻辑：`<标签> │ <文案> │ ip=… │ 动作 n/m`。`statusBar` 与
 * `preSessionStatusBar` 共用，分隔符和标签只在这一处写。
 */
function joinStatusBar(mode: PageMode, text: string, ip: bigint | undefined, cursor: number, total: number): string {
  const tag = STATUS_MODE_TAGS[mode];
  const ipText = ip === undefined ? '—' : formatAddrShort(ip);
  return `${tag} │ ${text} │ ip=${ipText} │ 动作 ${cursor}/${total}`;
}

/**
 * 底部状态栏文案（09 §2）：`DEBUG │ <状态文案> │ ip=0x… │ 动作 n/m`。
 *
 * `aborted` 置位时文案段换成「已终止：执行到动作 n/m」——终止落在最后一个分片
 * （`executed === total`）也算终止，不会被误判成「正常跑完」；游标段始终读
 * `cursor/total`，与是否终止无关（终止态同样可以继续单步、撤销）。
 */
export function statusBar(input: StatusBarInput): string {
  const text =
    input.aborted === undefined
      ? statusTextOf(input.projection, input.mode).text
      : `已终止：执行到动作 ${input.aborted.executed}/${input.aborted.total}`;
  return joinStatusBar(input.mode, text, input.ip, input.cursor, input.total);
}

/**
 * 第一相位（题面已拿到、还没有投影，05 §3.1）的状态栏文案：这一相位没有 `Projection`，
 * `ip` 和「动作 n/m」都没有意义，但播报区本身必须常驻（09 §2），否则屏幕阅读器在
 * 这一相位结束、第一份投影到达时听不到任何播报——因为它没有订阅一个本来不存在的节点。
 */
export function preSessionStatusBar(mode: PageMode, text: string): string {
  return joinStatusBar(mode, text, undefined, 0, 0);
}
