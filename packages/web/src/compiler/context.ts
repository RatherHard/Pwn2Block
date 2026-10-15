import type { AuthorBlock, PrimitiveActionType } from '@pwn2block/shared';
import { wordBytes } from './bytes';
import type {
  ActionOrigin,
  CompiledAction,
  CompileError,
  CompilerChallenge,
  CompilerLimits,
  NormalizedBlock,
} from './types';
import {
  DEFAULT_COMPILER_LIMITS,
  FORBIDDEN_STATE_BLOCK_TYPES,
  MESSAGE_ACTION_NOT_ALLOWED,
  MESSAGE_READS_STATE,
  MESSAGE_UNKNOWN_BLOCK,
} from './types';

/**
 * 编译期上下文（**内部实现**，不写进冻结契约）。
 *
 * 对外 `compileProgram` 是纯函数：同样的输入得到同样的输出。内部用一个小可变上下文收集
 * 动作、错误与计数器，避免每个函数都返回"值 + 错误 + 剩余预算"的元组。
 */

/** 编译期变量环境：变量在编译期就是常量（见 `types.ts` 的"编译期常量模型"）。 */
export type Env = ReadonlyMap<string, bigint>;

/** 可能失败的计算：失败原因已经记进上下文（带 blockId），所以这里只需要一个标记。 */
export type Eval<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export function ok<T>(value: T): Eval<T> {
  return { ok: true, value };
}

export function fail<T>(): Eval<T> {
  return { ok: false };
}

export interface CompileContext {
  readonly limits: CompilerLimits;
  /** 字长（字节）：`int` / `addr` 的默认宽度 W。 */
  readonly wordBytes: number;
  /** 本题允许的原子动作名（`allowedActions`）。 */
  readonly allowed: ReadonlySet<string>;
  /** 本题声明的出题人积木，按 id 索引。 */
  readonly authorBlocks: ReadonlyMap<string, AuthorBlock>;
  /** 输出缓冲。 */
  readonly actions: CompiledAction[];
  /** 动作 → 积木来源表（08 §9.2）；与 `actions` 等长同序。 */
  readonly origins: ActionOrigin[];
  /**
   * 当前正在展开的循环积木 id（栈；内层循环在栈顶）。
   * 循环体里编译出的动作归到**循环积木**上，而不是循环体里那一块（08 §9.2 第 2 条）。
   */
  readonly loopFrames: string[];
  /** 错误缓冲。 */
  readonly errors: CompileError[];
  /** 已用掉的表达式求值步数。 */
  evalSteps: number;
  /** 已访问的语句积木次数（防退化输入的护栏，与求值预算分开计数）。 */
  statements: number;
  /** 错误条数已达上限：停止继续编译，避免刷屏与无谓开销。 */
  overflowed: boolean;
  evalLimitHit: boolean;
  actionLimitHit: boolean;
}

export function createContext(
  challenge: CompilerChallenge,
  limits?: Partial<CompilerLimits>,
): CompileContext {
  return {
    limits: { ...DEFAULT_COMPILER_LIMITS, ...limits },
    wordBytes: wordBytes(challenge.archBits),
    allowed: new Set(challenge.allowedActions),
    authorBlocks: new Map((challenge.authorBlocks ?? []).map((block) => [block.id, block])),
    actions: [],
    origins: [],
    loopFrames: [],
    errors: [],
    evalSteps: 0,
    statements: 0,
    overflowed: false,
    evalLimitHit: false,
    actionLimitHit: false,
  };
}

/** 记录一条编译错误并返回失败：调用方直接 `return reportError(...)` 即可。 */
export function reportError(
  ctx: CompileContext,
  blockId: string,
  message: string,
): Eval<never> {
  if (ctx.errors.length < ctx.limits.errors) {
    ctx.errors.push({ blockId, message });
    if (ctx.errors.length >= ctx.limits.errors) ctx.overflowed = true;
  } else {
    ctx.overflowed = true;
  }
  return fail();
}

/** 未知 / 被保留的积木类型：读状态类给专门文案（05 §4），其余是未知类型。 */
export function unknownBlockError(ctx: CompileContext, block: NormalizedBlock): Eval<never> {
  if (FORBIDDEN_STATE_BLOCK_TYPES.includes(block.type)) {
    return reportError(ctx, block.id, MESSAGE_READS_STATE);
  }
  return reportError(ctx, block.id, MESSAGE_UNKNOWN_BLOCK(block.type));
}

/** `allowedActions` 过滤：不允许就报错，而不是悄悄丢掉这块积木。 */
export function actionAllowed(
  ctx: CompileContext,
  block: NormalizedBlock,
  name: PrimitiveActionType,
): boolean {
  if (ctx.allowed.has(name)) return true;
  reportError(ctx, block.id, MESSAGE_ACTION_NOT_ALLOWED(name));
  return false;
}

/** 动作入缓冲；超过 `limits.actions` 时只报一次错（04 §6 的 submit 上限）。
 *  入缓冲的同时登记来源表（08 §9.2）：`origins[i].index === i` 由这里保证。 */
export function pushAction(
  ctx: CompileContext,
  blockId: string,
  action: CompiledAction,
): boolean {
  if (ctx.actions.length >= ctx.limits.actions) {
    if (!ctx.actionLimitHit) {
      ctx.actionLimitHit = true;
      reportError(
        ctx,
        blockId,
        `编译出的动作数超过上限 ${ctx.limits.actions}，一次 submit 发不出去（04 §6）`,
      );
    }
    return false;
  }
  const index = ctx.actions.length;
  ctx.actions.push(action);
  // 循环体外：来源就是产生动作的那块积木；循环体里：归到最内层循环积木（08 §9.2 第 2 条）。
  const loop = ctx.loopFrames[ctx.loopFrames.length - 1];
  ctx.origins.push({ index, blockId: loop ?? blockId });
  return true;
}

/**
 * 进入一个循环体的展开：体里编译出的动作都归到这块循环积木上。
 * 必须与 `endLoop` 成对调用，调用方用 try/finally 保证栈不错位。
 */
export function beginLoop(ctx: CompileContext, loopBlockId: string): void {
  ctx.loopFrames.push(loopBlockId);
}

/** 退出循环体展开。 */
export function endLoop(ctx: CompileContext): void {
  ctx.loopFrames.pop();
}

/** 表达式求值预算（05 §4）：每个表达式积木访问一次算一步，整次编译累计。
 *  循环展开会在编译期重复求值，所以展开次数多、表达式复杂的程序会先撞到这个上限。 */
export function consumeEvalStep(ctx: CompileContext, blockId: string): boolean {
  if (ctx.evalLimitHit) return false;
  ctx.evalSteps += 1;
  if (ctx.evalSteps > ctx.limits.exprEvalSteps) {
    ctx.evalLimitHit = true;
    reportError(
      ctx,
      blockId,
      `表达式求值超过上限 ${ctx.limits.exprEvalSteps} 步（05 §4），把表达式或循环拆小一些`,
    );
    return false;
  }
  return true;
}

/** 语句访问兜底：正常程序远达不到上限，这里只防调用方传进环状 `next` 造成死循环。 */
export function visitStatement(ctx: CompileContext, blockId: string): boolean {
  ctx.statements += 1;
  if (ctx.statements > ctx.limits.statementVisits) {
    reportError(ctx, blockId, '积木链疑似成环（语句访问次数异常），请检查积木连接');
    ctx.overflowed = true;
    return false;
  }
  return true;
}
