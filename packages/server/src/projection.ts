import {
  ProjectionSchema,
  ReplayFrameSchema,
  ReplaySchema,
  bytesToHex,
  describeError,
  formatHex,
  parseHex,
} from '@pwn2block/shared';
import type {
  ActionResult as EngineActionResult,
  ActionResultView,
  DisasmEntry,
  EngineRuntime,
  ErrorCode,
  ErrorInfoView,
  LastStopView,
  Projection,
  RegisterView,
  ReplayFrame,
  ReplayFrameView,
  ReplayView,
  Roles,
  StdinView,
  StdoutView,
  SubmitOutcome,
  VmError,
  VmState,
  VmaLayout,
  VmaView,
} from '@pwn2block/shared';

/**
 * 公开投影生成器（04 §4）。
 *
 * 这是服务端安全边界的最后一公里，所以**逐字段白名单构造**，绝不 `...spread` 整个 `VmState`：
 * 1. 隐藏 VMA 只给布局（地址、大小、权限、hidden），内容只在 `reveal` 之后出现（01 §6 第 2 条）。
 * 2. `win` / `fail` / `flag` / 虚拟文件内容 / `VmError.detail` 永不进入返回对象。
 * 3. 题目未声明的 fd 不出现：`stdin` / `stdout` 都按题目包的 fd 表裁剪。
 * 4. `roles` 只有 `sp` / `bp` / `ip` 三个寄存器**名字**，逐个字段拷贝：它是「固定的已知信息」
 *    （04 §4、01 §6 第 2 条），不是私有内容的通道，所以绝不把私有包整个带出去。
 *
 * 返回值一律过一遍 `ProjectionSchema`：契约由 shared 定义，这里不自己造形状。
 */

export interface ProjectionContext {
  readonly runtime: EngineRuntime;
  /** 题目是否声明了 stdin / stdout fd（04 §4）。 */
  readonly hasStdin: boolean;
  readonly hasStdout: boolean;
  /** 出题人给错误码写的补充说明，作为投影错误的 `note`。 */
  readonly errorNotes: Readonly<Record<string, string>>;
  /**
   * 角色寄存器名，随投影下发（04 §4、09 §4）。
   *
   * 来源是私有包的 `roles`，但它是**固定的已知信息**（布局与命名公开、内容隐藏，01 §6 第 2 条）：
   * 不下发的话前端只能硬编码 `RSP` / `RBP` / `RIP`，32 位题目与自定义命名就标不出栈 / 帧 / 指令指针。
   * 它**不进 `public.json`**：出题人已在私有包声明一次，公开包再声明一次只会漂移。
   *
   * 预取一次即可：题目加载后它就固定，且这里的对象是**新构造**的（逐字段白名单），
   * 不与私有包共享引用，避免调用方无意中改到私有包。
   */
  readonly roles: Roles;
}

interface Range {
  readonly start: bigint;
  readonly end: bigint;
}

/** 构造投影上下文：fd 声明与 errorNotes 在题目加载后就固定，可以从 runtime 派生一次。 */
export function createProjectionContext(runtime: EngineRuntime): ProjectionContext {
  const fds = runtime.publicPkg.fds ?? [];
  return {
    runtime,
    hasStdin: fds.some((fd) => fd.kind === 'stdin'),
    hasStdout: fds.some((fd) => fd.kind === 'stdout'),
    errorNotes: runtime.publicPkg.errorNotes ?? {},
    // 逐字段白名单：只取三个寄存器名，私有包的 `flag` / `win` / `fail` / `files` 一概不进来。
    roles: {
      sp: runtime.privatePkg.roles.sp,
      bp: runtime.privatePkg.roles.bp,
      ip: runtime.privatePkg.roles.ip,
    },
  };
}

const CONTEXT_CACHE = new WeakMap<EngineRuntime, ProjectionContext>();

/** 同一 runtime 只构造一次上下文；runtime 被丢弃后缓存自动回收。 */
export function projectionContextOf(runtime: EngineRuntime): ProjectionContext {
  const cached = CONTEXT_CACHE.get(runtime);
  if (cached !== undefined) return cached;
  const created = createProjectionContext(runtime);
  CONTEXT_CACHE.set(runtime, created);
  return created;
}

function noteFor(ctx: ProjectionContext, code: ErrorCode, fallback?: string): string | undefined {
  return ctx.errorNotes[code] ?? fallback;
}

/** 引擎的结构化错误 → 投影错误：文案来自模板，note 来自题目 `errorNotes`（04 §4）。 */
export function describeVmError(ctx: ProjectionContext, error: VmError): ErrorInfoView {
  const note = noteFor(ctx, error.code);
  return {
    code: error.code,
    message: describeError(error.code, error.addr),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * 动作结果映射（04 §5）。
 *
 * 分工（08 §2 规则 2、09 §3.3）：**动作筛选、`block` 展开与整块回滚、停止条件都在引擎**——
 * `DebugInstance.applyRequest` 与 `EngineRuntime.replaySubmit` 已经按**提交动作**逐个返回结果
 * （积木展开出的原子动作不单独回报），`errorNotes` 由题目包提供，文案由 shared 的模板生成。
 *
 * 所以服务端在这里只做一件事：把 `VmError` 换成投影里的 `ErrorInfoView`。
 * 这里**不自己判定 `allowedActions`，也不自己展开积木**：引擎的 `screenAction` 调用的就是
 * shared 的 `isAllowedByChallenge`（`block` 与回退类始终允许）。服务端再展开一次会把原子动作
 * 交给引擎，反而绕过积木的允许集豁免——真实引擎上，ret2win 的参考解法会因此被判
 * `action_not_allowed`，所以这条路径必须只有一份实现。
 */
export function mapActionResults(
  ctx: ProjectionContext,
  engineResults: readonly EngineActionResult[],
): ActionResultView[] {
  return engineResults.map((result) => ({
    ok: result.ok,
    action: result.action,
    ...(result.error === undefined ? {} : { error: describeVmError(ctx, result.error) }),
  }));
}

/** 隐藏且未 reveal 的 VMA 不可见；`reveal` 之后按非隐藏处理（04 §4）。 */
function isVmaVisible(state: VmState, vma: VmaLayout): boolean {
  return !vma.hidden || state.revealed.includes(vma.id);
}

function vmaView(ctx: ProjectionContext, state: VmState, vma: VmaLayout): VmaView {
  const visible = isVmaVisible(state, vma);
  const bytes = visible ? ctx.runtime.readVmaVisible(state, vma.id) : undefined;
  return {
    id: vma.id,
    kind: vma.kind,
    ...(vma.label === undefined ? {} : { label: vma.label }),
    start: formatHex(parseHex(vma.start)),
    size: formatHex(BigInt(vma.size)),
    perm: vma.perm,
    hidden: !visible,
    // 读不到内容时宁可不出 `hex`，也不编一份出来。
    ...(bytes === undefined ? {} : { hex: bytesToHex(bytes) }),
  };
}

function vmaViews(ctx: ProjectionContext, state: VmState): VmaView[] {
  return ctx.runtime.layout.map((vma) => vmaView(ctx, state, vma));
}

function sameVmaView(previous: VmaView | undefined, current: VmaView): boolean {
  return (
    previous !== undefined &&
    previous.id === current.id &&
    previous.kind === current.kind &&
    previous.label === current.label &&
    previous.start === current.start &&
    previous.size === current.size &&
    previous.perm === current.perm &&
    previous.hidden === current.hidden &&
    previous.hex === current.hex
  );
}

/** 可见且可执行的区域：反汇编只允许覆盖这些地址（02 §4）。 */
function visibleExecRanges(ctx: ProjectionContext, state: VmState): Range[] {
  return ctx.runtime.layout
    .filter((vma) => vma.perm.includes('x') && isVmaVisible(state, vma))
    .map((vma) => {
      const start = parseHex(vma.start);
      return { start, end: start + BigInt(vma.size) };
    });
}

function disasmView(ctx: ProjectionContext, state: VmState): DisasmEntry[] {
  const ranges = visibleExecRanges(ctx, state);
  if (ranges.length === 0) return [];

  const kept: DisasmEntry[] = [];
  for (const entry of ctx.runtime.disassemble(state)) {
    const addr = parseHex(entry.addr);
    if (!ranges.some((range) => addr >= range.start && addr < range.end)) continue;
    kept.push({
      addr: formatHex(addr),
      bytes: entry.bytes.toLowerCase(),
      text: entry.text,
      ...(entry.target === undefined ? {} : { target: formatHex(parseHex(entry.target)) }),
    });
  }
  return kept;
}

function registersOf(ctx: ProjectionContext, state: VmState): RegisterView[] {
  return ctx.runtime.privatePkg.registers.map((name) => {
    const value = state.registers[name];
    if (value === undefined) {
      // 引擎契约违规：宁可整体 500，也不静默补一个 0 让前端看到假状态。
      throw new Error(`VM 状态缺少题目声明的寄存器：${name}`);
    }
    return { name, value: formatHex(value) };
  });
}

/** stdio 视图按题目声明的 fd 裁剪，未声明就整个字段不出现（04 §4）。 */
function stdioOf(
  ctx: ProjectionContext,
  state: VmState,
): { readonly stdin?: StdinView; readonly stdout?: StdoutView } {
  return {
    ...(ctx.hasStdin ? { stdin: { hex: bytesToHex(state.stdin.bytes), pos: state.stdin.pos } } : {}),
    ...(ctx.hasStdout ? { stdout: { hex: bytesToHex(state.stdout) } } : {}),
  };
}

function lastStopOf(state: VmState): LastStopView | undefined {
  const lastStop = state.lastStop;
  if (lastStop === undefined) return undefined;
  return lastStop.addr === undefined
    ? { reason: lastStop.reason }
    : { reason: lastStop.reason, addr: formatHex(lastStop.addr) };
}

function failureCount(failures: number): number {
  return Number.isFinite(failures) ? Math.max(0, Math.trunc(failures)) : 0;
}

/** `VmState` + 实例层计数 → 完整公开投影（04 §4）。 */
export function projectState(ctx: ProjectionContext, state: VmState, failures: number): Projection {
  const lastStop = lastStopOf(state);
  return ProjectionSchema.parse({
    status: state.status,
    steps: state.steps,
    failures: failureCount(failures),
    registers: registersOf(ctx, state),
    // 每次返回新对象：投影之间、投影与上下文之间都不共享引用。
    roles: { sp: ctx.roles.sp, bp: ctx.roles.bp, ip: ctx.roles.ip },
    flags: { ZF: state.flags.ZF, CF: state.flags.CF, SF: state.flags.SF },
    vmas: vmaViews(ctx, state),
    ...stdioOf(ctx, state),
    disasm: disasmView(ctx, state),
    ...(lastStop === undefined ? {} : { lastStop }),
    ...(state.error === undefined ? {} : { error: describeVmError(ctx, state.error) }),
  });
}

function projectFrame(
  ctx: ProjectionContext,
  frame: ReplayFrame,
  index: number,
  failures: number,
  changedVmas: readonly VmaView[],
): ReplayFrameView {
  const state = frame.state;
  const lastStop = lastStopOf(state);
  // 帧自己的 `error` 优先：被拒绝的动作（`action_not_allowed` / `unknown_action`）只拒绝动作、
  // 不写 `state.error`，丢掉它前端就看不出这一帧为什么停下（08 §9.2）。运行期异常的帧两者一致。
  const error = frame.error ?? state.error;
  return ReplayFrameSchema.parse({
    index,
    label: frame.label,
    kind: frame.kind,
    status: state.status,
    steps: state.steps,
    failures,
    registers: registersOf(ctx, state),
    flags: { ZF: state.flags.ZF, CF: state.flags.CF, SF: state.flags.SF },
    changedVmas: [...changedVmas],
    ...stdioOf(ctx, state),
    ...(lastStop === undefined ? {} : { lastStop }),
    ...(error === undefined ? {} : { error: describeVmError(ctx, error) }),
  });
}

/**
 * 回放录像：首份完整投影 + 逐动作 diff（04 §5.1）。
 *
 * 帧里的 `failures` 用「到这一帧为止出现过错误的帧数」近似——提交回放不返回实例层计数，
 * 而录像只服务前端展示，不参与判定（判定用 `verdict`）。
 */
export function projectReplay(ctx: ProjectionContext, outcome: SubmitOutcome): ReplayView {
  const frames = [...outcome.frames];
  const initIndex = frames.findIndex((frame) => frame.kind === 'init');
  const initFrame = initIndex >= 0 ? frames[initIndex] : undefined;
  if (initIndex >= 0) frames.splice(initIndex, 1);

  const initState = initFrame?.state ?? outcome.finalState;
  let previous = vmaViews(ctx, initState);
  let failures = 0;
  const views: ReplayFrameView[] = [];

  frames.forEach((frame, index) => {
    if (frame.error !== undefined) failures += 1;
    const current = vmaViews(ctx, frame.state);
    const changed = current.filter((view, position) => !sameVmaView(previous[position], view));
    previous = current;
    views.push(projectFrame(ctx, frame, index, failures, changed));
  });

  return ReplaySchema.parse({ initial: projectState(ctx, initState, 0), frames: views });
}
