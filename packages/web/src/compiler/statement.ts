import type { PrimitiveActionType } from '@pwn2block/shared';
import { MAX_RUN_MAX_STEPS, MAX_STEP_COUNT, bytesToHex, formatHex } from '@pwn2block/shared';
import type { CompileContext, Env, Eval } from './context';
import {
  actionAllowed,
  fail,
  ok,
  pushAction,
  reportError,
  unknownBlockError,
  visitStatement,
} from './context';
import {
  BYTES_EXPRESSION_TYPES,
  VALUE_EXPRESSION_TYPES,
  asCount,
  asNonNegative,
  evalValue,
  optionalValueInput,
  requireBytesInput,
  requireValueInput,
} from './expr';
import { inputBlock, readStringField } from './fields';
import type { CompiledAction, NormalizedBlock } from './types';
import {
  AUTHOR_BLOCK_PREFIX,
  BLOCK_TYPES,
  FIELDS,
  INPUTS,
  LOOP_MODES,
  MESSAGE_UNDECLARED_AUTHOR_BLOCK,
} from './types';

/**
 * 语句编译：把一条语句链（`开始` 往下、`next` 相连）编译成原子动作序列。
 *
 * - 语句会改变编译期变量环境，所以链上的编译是"穿线"的：`compileChain` 把环境传下去，
 *   循环展开时把上一轮的环境交给下一轮。环境本身不可变（每次修改都返回新 Map）。
 * - 出错时把错误记进上下文（带 blockId），并尽量继续编译兄弟语句，一次报出多处问题。
 * - 动作进入 `ctx.actions` 的顺序就是提交顺序，`feed` 必须排在触发 `read` 的 `step`/`run`
 *   之前：这不是编译期能自动纠正的事（学习者可能故意分开写），所以只在工具箱 tooltip
 *   里提示（见 `blocks/catalog.ts` 的 `FEED_ORDER_TIP`）。
 */

interface IfBranch {
  readonly condition: string;
  readonly body: string;
}

/** `controls_if` 的分支：IF0/DO0、IF1/DO1、IF2/DO2（与 Blockly 默认块一致）。 */
const IF_BRANCHES: readonly IfBranch[] = [
  { condition: INPUTS.if0, body: INPUTS.do0 },
  { condition: INPUTS.if1, body: INPUTS.do1 },
  { condition: INPUTS.if2, body: INPUTS.do2 },
];

/** 动作积木 → 动作名（`allowedActions` 过滤、错误文案用的就是它）。 */
const SIMPLE_ACTIONS: Readonly<Record<string, PrimitiveActionType>> = {
  [BLOCK_TYPES.actionPop]: 'pop',
  [BLOCK_TYPES.actionRet]: 'ret',
};

/** 编译一条语句链，返回链尾的变量环境。 */
export function compileChain(
  ctx: CompileContext,
  first: NormalizedBlock | undefined,
  env: Env,
): Env {
  let current = first;
  let scope = env;
  while (current !== undefined && !ctx.overflowed) {
    const next = current.next;
    const result = compileStatement(ctx, current, scope);
    if (result.ok) scope = result.value;
    current = next;
  }
  return scope;
}

function compileStatement(
  ctx: CompileContext,
  block: NormalizedBlock,
  env: Env,
): Eval<Env> {
  if (!visitStatement(ctx, block.id)) return fail();
  switch (block.type) {
    case BLOCK_TYPES.varsSet:
      return compileVarsSet(ctx, block, env);
    case BLOCK_TYPES.controlsIf:
      return compileIf(ctx, block, env);
    case BLOCK_TYPES.controlsRepeat:
      return compileRepeat(ctx, block, env);
    case BLOCK_TYPES.controlsWhileUntil:
      return compileWhile(ctx, block, env);
    case BLOCK_TYPES.actionWriteBytes:
      return emit(ctx, block, env, buildWriteBytes(ctx, block, env));
    case BLOCK_TYPES.actionPush:
      return emit(ctx, block, env, buildPush(ctx, block, env));
    case BLOCK_TYPES.actionPop:
      return emit(ctx, block, env, buildSimple(ctx, block));
    case BLOCK_TYPES.actionCall:
      return emit(ctx, block, env, buildCall(ctx, block, env));
    case BLOCK_TYPES.actionRet:
      return emit(ctx, block, env, buildSimple(ctx, block));
    case BLOCK_TYPES.actionFeed:
      return emit(ctx, block, env, buildFeed(ctx, block, env));
    case BLOCK_TYPES.actionStep:
      return emit(ctx, block, env, buildStep(ctx, block, env));
    case BLOCK_TYPES.actionRun:
      return emit(ctx, block, env, buildRun(ctx, block, env));
    default:
      return compileFallback(ctx, block, env);
  }
}

/** 非动作、非控制流的积木：出题人积木、表达式错位、未知类型。 */
function compileFallback(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Env> {
  if (block.type.startsWith(AUTHOR_BLOCK_PREFIX)) return compileAuthorBlock(ctx, block, env);
  if (VALUE_EXPRESSION_TYPES.includes(block.type) || BYTES_EXPRESSION_TYPES.includes(block.type)) {
    return reportError(
      ctx,
      block.id,
      `表达式积木不能单独放在语句位置：${block.type}（它要连在输入槽上）`,
    );
  }
  return unknownBlockError(ctx, block);
}

// ---------------------------------------------------------------------------
// 变量与控制流（编译期展开）
// ---------------------------------------------------------------------------

function compileVarsSet(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Env> {
  const name = readStringField(block, FIELDS.variable);
  if (name === undefined || name === '') {
    return reportError(ctx, block.id, `变量积木需要 ${FIELDS.variable} 字段（变量名）`);
  }
  const value = requireValueInput(ctx, block, INPUTS.value, env, '变量的值');
  if (!value.ok) return fail();
  return ok(new Map(env).set(name, value.value));
}

function compileIf(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Env> {
  for (const branch of IF_BRANCHES) {
    const condition = inputBlock(block, branch.condition);
    if (!condition) continue;
    const value = evalCondition(ctx, condition, env);
    if (!value.ok) return fail();
    if (value.value) return ok(compileChain(ctx, inputBlock(block, branch.body), env));
  }
  const elseBody = inputBlock(block, INPUTS.else);
  if (!elseBody) return ok(env);
  return ok(compileChain(ctx, elseBody, env));
}

function compileRepeat(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Env> {
  const timesValue = requireValueInput(ctx, block, INPUTS.times, env, '循环次数');
  if (!timesValue.ok) return fail();
  const times = asCount(ctx, block, timesValue.value, '循环次数');
  if (!times.ok) return fail();
  const body = inputBlock(block, INPUTS.body);
  if (body === undefined || times.value === 0) return ok(env);
  if (times.value > ctx.limits.loopUnroll) {
    return reportError(
      ctx,
      block.id,
      `循环展开 ${times.value} 次超过上限 ${ctx.limits.loopUnroll}（05 §4）`,
    );
  }
  let scope = env;
  for (let i = 0; i < times.value && !ctx.overflowed; i += 1) {
    scope = compileChain(ctx, body, scope);
  }
  return ok(scope);
}

function compileWhile(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<Env> {
  const mode = readStringField(block, FIELDS.mode);
  if (mode === undefined || !(LOOP_MODES as readonly string[]).includes(mode)) {
    return reportError(
      ctx,
      block.id,
      `循环积木的 ${FIELDS.mode} 只能是 ${LOOP_MODES.join(' / ')}，收到 ${String(mode)}`,
    );
  }
  const condition = inputBlock(block, INPUTS.bool);
  if (!condition) return reportError(ctx, block.id, `循环缺少条件输入（${INPUTS.bool}）`);
  const body = inputBlock(block, INPUTS.body);
  if (!body) return ok(env); // 空循环体：什么也不做

  let scope = env;
  let iterations = 0;
  for (;;) {
    const value = evalCondition(ctx, condition, scope);
    if (!value.ok) return fail();
    const keepGoing = mode === 'WHILE' ? value.value : !value.value;
    if (!keepGoing) return ok(scope);
    if (iterations >= ctx.limits.loopUnroll) {
      return reportError(
        ctx,
        block.id,
        `循环展开超过上限 ${ctx.limits.loopUnroll} 次仍未结束（05 §4），检查循环条件`,
      );
    }
    scope = compileChain(ctx, body, scope);
    iterations += 1;
    if (ctx.overflowed) return ok(scope);
  }
}

/** 条件求值：编译期常量，非 0 为真。 */
function evalCondition(
  ctx: CompileContext,
  condition: NormalizedBlock,
  env: Env,
): Eval<boolean> {
  const value = evalValue(ctx, condition, env);
  if (!value.ok) return fail();
  return ok(value.value !== 0n);
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 把构造好的动作推进缓冲，并返回（未改变的）环境。 */
function emit(
  ctx: CompileContext,
  block: NormalizedBlock,
  env: Env,
  action: Eval<CompiledAction>,
): Eval<Env> {
  if (!action.ok) return fail();
  if (!pushAction(ctx, block.id, action.value)) return fail();
  return ok(env);
}

/** 无参数动作：`pop` / `ret`。 */
function buildSimple(ctx: CompileContext, block: NormalizedBlock): Eval<CompiledAction> {
  const name = SIMPLE_ACTIONS[block.type];
  if (name === undefined) return unknownBlockError(ctx, block);
  if (!actionAllowed(ctx, block, name)) return fail();
  return ok(name === 'pop' ? { type: 'pop' } : { type: 'ret' });
}

/** 取一个值输入并要求非负（地址、push 的值都用它）。 */
function nonNegativeInput(
  ctx: CompileContext,
  block: NormalizedBlock,
  input: string,
  env: Env,
  label: string,
): Eval<bigint> {
  const value = requireValueInput(ctx, block, input, env, label);
  if (!value.ok) return fail();
  const unsigned = asNonNegative(ctx, block, value.value, label);
  if (!unsigned.ok) return fail();
  return ok(unsigned.value);
}

/** 取一个字节输入并转成动作要的 hex 字符串。 */
function bytesHexInput(
  ctx: CompileContext,
  block: NormalizedBlock,
  input: string,
  env: Env,
  label: string,
): Eval<string> {
  const bytes = requireBytesInput(ctx, block, input, env, label);
  if (!bytes.ok) return fail();
  return ok(bytesToHex(bytes.value));
}

function buildWriteBytes(
  ctx: CompileContext,
  block: NormalizedBlock,
  env: Env,
): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'write_bytes')) return fail();
  const address = nonNegativeInput(ctx, block, INPUTS.addr, env, '目标地址');
  if (!address.ok) return fail();
  const hex = bytesHexInput(ctx, block, INPUTS.bytes, env, '写入的字节');
  if (!hex.ok) return fail();
  return ok({ type: 'write_bytes', addr: formatHex(address.value), hex: hex.value });
}

function buildPush(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'push')) return fail();
  const value = nonNegativeInput(ctx, block, INPUTS.value, env, '压栈的值');
  if (!value.ok) return fail();
  return ok({ type: 'push', value: formatHex(value.value) });
}

function buildCall(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'call')) return fail();
  const address = nonNegativeInput(ctx, block, INPUTS.addr, env, '调用地址');
  if (!address.ok) return fail();
  return ok({ type: 'call', addr: formatHex(address.value) });
}

function buildFeed(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'feed')) return fail();
  const hex = bytesHexInput(ctx, block, INPUTS.bytes, env, '喂给 stdin 的字节');
  if (!hex.ok) return fail();
  return ok({ type: 'feed', hex: hex.value });
}

function buildStep(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'step')) return fail();
  const count = optionalValueInput(ctx, block, INPUTS.count, env);
  if (!count.ok) return fail();
  if (count.value === undefined) return ok({ type: 'step' });
  const steps = asCount(ctx, block, count.value, '步数');
  if (!steps.ok) return fail();
  if (steps.value < 1 || steps.value > MAX_STEP_COUNT) {
    return reportError(
      ctx,
      block.id,
      `步数必须在 1..${MAX_STEP_COUNT} 之间（04 §6），收到 ${steps.value}`,
    );
  }
  return ok({ type: 'step', count: steps.value });
}

function buildRun(ctx: CompileContext, block: NormalizedBlock, env: Env): Eval<CompiledAction> {
  if (!actionAllowed(ctx, block, 'run')) return fail();
  const maxSteps = optionalValueInput(ctx, block, INPUTS.maxSteps, env);
  if (!maxSteps.ok) return fail();
  if (maxSteps.value === undefined) return ok({ type: 'run' });
  const steps = asCount(ctx, block, maxSteps.value, '最大步数');
  if (!steps.ok) return fail();
  if (steps.value < 1 || steps.value > MAX_RUN_MAX_STEPS) {
    return reportError(
      ctx,
      block.id,
      `最大步数必须在 1..${MAX_RUN_MAX_STEPS} 之间（04 §6），收到 ${steps.value}`,
    );
  }
  return ok({ type: 'run', maxSteps: steps.value });
}

// ---------------------------------------------------------------------------
// 出题人积木
// ---------------------------------------------------------------------------

/**
 * 出题人积木编译成 `{ type: 'block', id, args }`：**展开由服务端完成**（03 §3）。
 * 客户端提交展开结果一律不被信任，所以这里只做参数收集与类型检查。
 */
function compileAuthorBlock(
  ctx: CompileContext,
  block: NormalizedBlock,
  env: Env,
): Eval<Env> {
  const id = block.type.slice(AUTHOR_BLOCK_PREFIX.length);
  const author = ctx.authorBlocks.get(id);
  if (!author) return reportError(ctx, block.id, MESSAGE_UNDECLARED_AUTHOR_BLOCK(id));

  const declared = new Set(author.params.map((param) => param.name));
  for (const [name, child] of Object.entries(block.inputs)) {
    if (child !== undefined && !declared.has(name)) {
      return reportError(ctx, block.id, `出题人积木 ${id} 没有声明参数 ${name}`);
    }
  }

  const args: Record<string, string> = {};
  for (const param of author.params) {
    const child = inputBlock(block, param.name);
    if (!child) {
      return reportError(ctx, block.id, `出题人积木 ${id} 缺少参数输入：${param.name}`);
    }
    if (param.type === 'bytes') {
      const bytes = requireBytesInput(ctx, block, param.name, env, `参数 ${param.name}`);
      if (!bytes.ok) return fail();
      args[param.name] = bytesToHex(bytes.value);
      continue;
    }
    const value = requireValueInput(ctx, block, param.name, env, `参数 ${param.name}`);
    if (!value.ok) return fail();
    const unsigned = asNonNegative(ctx, block, value.value, `参数 ${param.name}`);
    if (!unsigned.ok) return fail();
    args[param.name] = formatHex(unsigned.value);
  }

  return emit(ctx, block, env, ok<CompiledAction>({ type: 'block', id, args }));
}
