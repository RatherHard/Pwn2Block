/**
 * 页面状态与状态栏文案（05 §1、§6）。纯函数。
 *
 * 页面只持有“最新投影 + 上一份投影 + 视图管理器状态 + 模式”：
 * 高亮由两份投影差分得到（04 §4），两种模式共用同一套视图，只是数据源不同。
 */
import type { InstanceStatus, Projection } from '@pwn2block/shared';
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

function debugText(projection: Projection): StatusText {
  const failureNote = projection.failures > 0 ? `（已失败 ${projection.failures} 次）` : '';
  switch (projection.status) {
    case 'satisfied':
      // 退出与满足可以同时成立（04 §1.1）：这时执行类动作已被服务端拒绝，
      // 状态栏只说「已满足」会让用户不明白按钮为什么点不动。
      return isExitedProjection(projection)
        ? {
            tone: 'ok',
            text: '当前状态已满足成功条件，且程序已经退出：执行类动作会被拒绝，可继续「提交判题」，或用回退类动作重来。',
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

/** 状态栏前缀：`调试模式 · 可继续执行`（05 §7：屏幕阅读器能分辨当前模式）。 */
export function statusLine(projection: Projection, mode: PageMode): string {
  const status = STATUS_NAMES[projection.status];
  return `${MODE_NAMES[mode]} · ${status}`;
}
