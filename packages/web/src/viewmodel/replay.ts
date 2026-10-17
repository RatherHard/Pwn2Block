/**
 * 回放录像（04 §5.1、09 §3.4）。
 *
 * 录像的形状是「首份完整投影 `initial` + 逐帧 diff」，不是几十份完整投影。所以「看第 k 帧」
 * 要把 `frames[0..k-1].changedVmas` 依次叠到初态上——**这是判题结果模式唯一的投影来源**，
 * 调试模式仍然读调试实例的投影（05 §1：两种模式共用同一套视图，只是数据源不同）。
 *
 * 时间线的位置约定：`0` 是初态，位置 `i + 1` 对应 `frames[i]`。这是界面自己的编号，
 * 与 `frames[i].index`（帧序号）、动作下标都不是一回事（09 §3.4）。
 *
 * **帧与动作的归属（09 §3.4，A 已收口更正）**：引擎在**动作执行期间**就 push `instruction` 帧，
 * 动作自己的 `action` 帧要等它执行完才 push，所以夹在两个 `action` 帧之间的 `instruction` 帧
 * 属于**后一个**动作；`initial` 之后、第一个 `action` 帧之前的 `instruction` 帧属于第 1 个动作。
 * 于是「第 k 个动作」= 第 k 个 `action` 帧（`actionPositions[k - 1]`），
 * 而它的中间状态 = 前一个 `action` 帧之后、它之前的那段 `instruction` 帧。
 */
import type { Projection, ReplayFrameView, ReplayView, VmaView } from '@pwn2block/shared';
import { STATUS_NAMES, type PageState } from './session';

/** 09 §3.4：录像期间代码段被改写时，指令视图必须显示这句而不是过期反汇编。 */
export const MESSAGE_REPLAY_DISASM_STALE = '录像中代码已变化，指令视图不可用';

export interface DisasmAvailability {
  readonly available: boolean;
  readonly notice?: string;
}

export interface FrameProjection {
  readonly projection: Projection;
  /** 上一帧，用于差分高亮。 */
  readonly previous?: Projection;
  /** 指令视图不可用时的说明；未设置表示可用（09 §3.4）。 */
  readonly disasmNotice?: string;
}

export function timelineLength(replay: ReplayView): number {
  return replay.frames.length + 1;
}

export function clampPosition(replay: ReplayView, position: number): number {
  const last = timelineLength(replay) - 1;
  if (!Number.isFinite(position)) return 0;
  return Math.min(Math.max(0, Math.floor(position)), last);
}

export function frameAt(replay: ReplayView, position: number): ReplayFrameView | undefined {
  if (position <= 0) return undefined;
  return replay.frames[position - 1];
}

/** 时间线上的文字标签：位置 0 是初态，其余用帧自己的 `label`。 */
export function positionLabel(replay: ReplayView, position: number): string {
  return frameAt(replay, clampPosition(replay, position))?.label ?? '初态';
}

/** 读屏用的位置描述（05 §7）：标签 + 已执行指令数 + 实例状态 + 它属于哪个动作。 */
export function positionDescription(replay: ReplayView, position: number): string {
  const clamped = clampPosition(replay, position);
  const frame = frameAt(replay, clamped);
  const status = frame?.status ?? replay.initial.status;
  const steps = frame?.steps ?? replay.initial.steps;
  return `${positionLabel(replay, clamped)}：已执行 ${steps} 条指令，状态${STATUS_NAMES[status]}${ownerNote(
    replay,
    clamped,
  )}`;
}

/** 中间指令帧的归属说明：它属于哪个动作（09 §3.4）。 */
function ownerNote(replay: ReplayView, position: number): string {
  if (frameAt(replay, position)?.kind !== 'instruction') return '';
  const action = actionOfPosition(replay, position);
  return action === undefined ? '' : `（第 ${action + 1} 个动作执行途中）`;
}

/**
 * 隐藏 VMA 只留布局：内容一旦不再下发，就绝不能沿用上一帧的字节（01 §6 第 2 条）。
 */
function hiddenLayout(vma: VmaView): VmaView {
  return {
    id: vma.id,
    kind: vma.kind,
    start: vma.start,
    size: vma.size,
    perm: vma.perm,
    hidden: true,
    ...(vma.label === undefined ? {} : { label: vma.label }),
  };
}

function mergeVma(previous: VmaView, changed: VmaView): VmaView {
  if (changed.hidden) return hiddenLayout(changed);
  if (changed.hex !== undefined) return changed;
  // 非隐藏但没带内容：保留上一份已公开的内容，绝不凭空造字节。
  return { ...previous, ...changed };
}

/** 把一帧的 `changedVmas` 叠到当前布局上；新出现的 VMA 直接追加（正常不会发生）。 */
function mergeVmas(current: readonly VmaView[], changed: readonly VmaView[]): readonly VmaView[] {
  if (changed.length === 0) return current;
  const byId = new Map(changed.map((vma) => [vma.id, vma]));
  const merged = current.map((vma) => {
    const next = byId.get(vma.id);
    return next === undefined ? vma : mergeVma(vma, next);
  });
  const known = new Set(current.map((vma) => vma.id));
  for (const vma of changed) if (!known.has(vma.id)) merged.push(vma);
  return merged;
}

/**
 * 位置 `position` 处的完整投影：初态 + 前 `position` 帧的累计 diff。
 *
 * 累积而不是只取一帧，是因为 `changedVmas` 是**逐帧增量**，而寄存器/标志位在帧里是绝对值。
 */
export function projectionAtPosition(replay: ReplayView, position: number): Projection {
  const clamped = clampPosition(replay, position);
  const initial = replay.initial;
  let vmas: readonly VmaView[] = initial.vmas;
  let stdin = initial.stdin;
  let stdout = initial.stdout;
  let lastStop = initial.lastStop;

  for (let index = 0; index < clamped; index += 1) {
    const frame = replay.frames[index];
    if (frame === undefined) break;
    vmas = mergeVmas(vmas, frame.changedVmas);
    stdin = frame.stdin ?? stdin;
    stdout = frame.stdout ?? stdout;
    lastStop = frame.lastStop ?? lastStop;
  }

  const frame = frameAt(replay, clamped);
  return {
    status: frame?.status ?? initial.status,
    steps: frame?.steps ?? initial.steps,
    failures: frame?.failures ?? initial.failures,
    registers: frame?.registers ?? initial.registers,
    roles: initial.roles,
    flags: frame?.flags ?? initial.flags,
    // `Projection.vmas` 是可写数组（zod 推断），这里交一份拷贝而不是继续共享只读视图。
    vmas: [...vmas],
    ...(stdin === undefined ? {} : { stdin }),
    ...(stdout === undefined ? {} : { stdout }),
    disasm: initial.disasm,
    ...(lastStop === undefined ? {} : { lastStop }),
    // error 不跨帧继承：它描述的是「这一帧出了事」。
    ...(frame?.error === undefined ? {} : { error: frame.error }),
  };
}

/**
 * 指令视图可用性（09 §3.4）：`ReplayFrame` 不带 `disasm`，所以整个回放只能共用初态那一份，
 * **仅当**没有任何一帧改动了可执行（`perm` 含 `x`）区域时才可用；否则显示不可用提示，
 * 绝不显示过期反汇编。前端不解码（03 §4）。
 */
export function disasmAvailability(replay: ReplayView): DisasmAvailability {
  for (const frame of replay.frames) {
    for (const vma of frame.changedVmas) {
      if (vma.perm.includes('x')) return { available: false, notice: MESSAGE_REPLAY_DISASM_STALE };
    }
  }
  return { available: true };
}

/** 视图数据源（05 §1）：判题模式下视图读录像帧，返回投影 + 上一帧 + 指令视图提示。 */
export function frameProjection(replay: ReplayView, position: number): FrameProjection {
  const clamped = clampPosition(replay, position);
  const availability = disasmAvailability(replay);
  const projection = projectionAtPosition(replay, clamped);
  const previous = clamped === 0 ? undefined : projectionAtPosition(replay, clamped - 1);
  return {
    projection: availability.available ? projection : { ...projection, disasm: [] },
    ...(previous === undefined ? {} : { previous }),
    ...(availability.notice === undefined ? {} : { disasmNotice: availability.notice }),
  };
}

/**
 * 出事的那一帧（05 §6、09 §3.4）：优先带 `error` 的 **`action` 帧**——被拒绝与异常都挂在
 * 动作自己的帧上，失败条件命中时也在它之后的 `failed` 帧；其次任何带 `error` 的帧，
 * 最后是第一帧进入 `failed` 的帧。没出事返回 `undefined`。
 */
export function failurePosition(replay: ReplayView): number | undefined {
  const frames = replay.frames;
  for (const [index, frame] of frames.entries()) {
    if (frame.kind === 'action' && frame.error !== undefined) return index + 1;
  }
  for (const [index, frame] of frames.entries()) {
    if (frame.error !== undefined) return index + 1;
  }
  for (const [index, frame] of frames.entries()) {
    if (frame.status === 'failed') return index + 1;
  }
  return undefined;
}

/** 默认选中的帧（05 §6）：优先出事的那一帧，没出事就停在最后一帧。 */
export function defaultPosition(replay: ReplayView): number {
  return failurePosition(replay) ?? replay.frames.length;
}

/** `kind === 'action'` 的帧在时间线上的位置，按出现顺序：第 k 个提交动作 → `positions[k - 1]`（09 §3.4）。 */
export function actionPositions(replay: ReplayView): readonly number[] {
  const positions: number[] = [];
  for (const [index, frame] of replay.frames.entries()) {
    if (frame.kind === 'action') positions.push(index + 1);
  }
  return positions;
}

/**
 * 位置 `position` 属于第几个动作（0-based）。归属规则见文件头：第一个 `action` 帧之前
 * （`initial` 之后）的中间帧属于第 1 个动作。初态不属于任何动作。
 */
export function actionOfPosition(replay: ReplayView, position: number): number | undefined {
  const clamped = clampPosition(replay, position);
  if (clamped === 0) return undefined;
  let action = 0;
  for (const [index, frame] of replay.frames.entries()) {
    if (frame.kind !== 'action') continue;
    if (index + 1 >= clamped) return action;
    action += 1;
  }
  return undefined;
}

/** 第 k 个动作（0-based）执行途中经过的 `instruction` 帧位置，按时间顺序（09 §3.4）。 */
export function instructionPositionsFor(replay: ReplayView, actionIndex: number): readonly number[] {
  const actions = actionPositions(replay);
  const end = actions[actionIndex];
  if (end === undefined) return [];
  const start = actions[actionIndex - 1] ?? 0;
  const positions: number[] = [];
  for (let position = start + 1; position < end; position += 1) {
    if (frameAt(replay, position)?.kind === 'instruction') positions.push(position);
  }
  return positions;
}

export interface ActionInstructions {
  /** 0-based 动作下标。 */
  readonly action: number;
  /** 该动作执行途中经过的指令帧位置与标签，按时间顺序。 */
  readonly positions: readonly number[];
  readonly labels: readonly string[];
}

/** 「第 k 个动作执行了哪些指令」：给程序区与判题横幅用（09 §3.4）。 */
export function actionInstructionsAt(replay: ReplayView, position: number): ActionInstructions | undefined {
  const action = actionOfPosition(replay, position);
  if (action === undefined) return undefined;
  const positions = instructionPositionsFor(replay, action);
  return { action, positions, labels: positions.map((each) => positionLabel(replay, each)) };
}

/** `displayedView` 只需要判题状态里的录像与时间线位置。 */
export interface VerdictFrameSource {
  readonly response: { readonly replay: ReplayView };
  readonly position: number;
}

/**
 * 视图当前显示的投影（05 §1）：判题结果模式读录像里选中的那一帧，调试模式读调试实例的投影。
 * 页面渲染与控制器计算可用标签都走这里，保证两边的数据源一致。
 */
export function displayedView(page: PageState, verdict: VerdictFrameSource | undefined): FrameProjection {
  if (page.mode === 'verdict' && verdict !== undefined) {
    return frameProjection(verdict.response.replay, verdict.position);
  }
  return page.previous === undefined
    ? { projection: page.projection }
    : { projection: page.projection, previous: page.previous };
}
