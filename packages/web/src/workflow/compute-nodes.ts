import {
  alphabetOf,
  bytesToHex,
  cyclicFind,
  cyclicSequence,
  hexToBytes,
  nodeInputs,
  nodeOutput,
  NODE,
  PYTHON_MAX_EVALS_PER_COMPILE,
} from '@pwn2block/shared';
import type { EncodedValue, GraphNode, NodeKindSpec, PortType } from '@pwn2block/shared';
import { addr, concat, int, padding, string, wordBytes, ByteBuildError } from '../compiler/bytes';
import { paramsOf } from './document';
import { report, type EvalContext, type ValueResult } from './context';
import { MAX_INT_BITS } from './params';
import type { PreviewSegment, PythonEvalResult, WorkflowValue } from './types';

/**
 * 各数据节点的计算（06 §4.1）。
 *
 * 这里只做纯计算：不查缓存、不记预览、不递归——需要上游值的地方统一走注入的
 * `EvalHelpers.resolve`，于是求值递归留在 `evaluate.ts` 一处，模块之间没有循环依赖。
 * 出错一律调 `report` 记一条带节点 id 的问题，不抛异常。
 */

/** 求值器提供给节点计算的回调（避免与本模块的递归依赖）。 */
export interface EvalHelpers {
  readonly resolve: (
    node: GraphNode,
    spec: NodeKindSpec,
    port: string,
    path: readonly string[],
  ) => Promise<ValueResult>;
  /** 内部值 → 传输编码（Python 节点的输入）。 */
  readonly encode: (value: WorkflowValue) => EncodedValue;
}

function bytesOf(value: Uint8Array): ValueResult {
  return { ok: true, value: { kind: 'bytes', bytes: value } };
}

function intOf(value: bigint): ValueResult {
  return { ok: true, value: { kind: 'int', value } };
}

function guard<T>(ctx: EvalContext, node: GraphNode, run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    if (error instanceof ByteBuildError) {
      report(ctx, 'eval_failed', node.id, error.message);
      return undefined;
    }
    throw error;
  }
}

function expectType<T extends WorkflowValue['kind']>(
  ctx: EvalContext,
  node: GraphNode,
  port: string,
  result: ValueResult,
  kind: T,
  label: string,
): Extract<WorkflowValue, { kind: T }> | undefined {
  if (!result.ok) return undefined;
  if (result.value.kind !== kind) {
    report(ctx, 'eval_failed', node.id, `输入 ${port} 需要${label}，收到${result.value.kind}`);
    return undefined;
  }
  return result.value as Extract<WorkflowValue, { kind: T }>;
}

async function intInput(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<bigint | undefined> {
  const result = await helpers.resolve(node, spec, port, path);
  return expectType(ctx, node, port, result, 'int', '整数')?.value;
}

async function bytesInput(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<Uint8Array | undefined> {
  const result = await helpers.resolve(node, spec, port, path);
  return expectType(ctx, node, port, result, 'bytes', '字节')?.bytes;
}

async function boolInput(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<boolean | undefined> {
  const result = await helpers.resolve(node, spec, port, path);
  return expectType(ctx, node, port, result, 'bool', '布尔')?.value;
}

async function textInput(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  port: string,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<string | undefined> {
  const result = await helpers.resolve(node, spec, port, path);
  return expectType(ctx, node, port, result, 'text', '文本')?.text;
}

export function computeNode(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  switch (node.kind) {
    case NODE.fill:
      return computeFill(ctx, node, spec, path, helpers);
    case NODE.text:
      return computeText(ctx, node, spec, path, helpers);
    case NODE.hex:
      // 可以直接填 hex，也可以由别的字节节点接线：两种都走同一条输入解析。
      return helpers.resolve(node, spec, 'hex', path);
    case NODE.int:
      return computeInt(ctx, node, spec, path, helpers);
    case NODE.address:
      return computeAddress(ctx, node, spec, path, helpers);
    case NODE.concat:
      return computeConcat(ctx, node, spec, path, helpers);
    case NODE.arith:
      return computeArith(ctx, node, spec, path, helpers);
    case NODE.compare:
      return computeCompare(ctx, node, spec, path, helpers);
    case NODE.logic:
      return computeLogic(ctx, node, spec, path, helpers);
    case NODE.bytesToInt:
      return computeBytesToInt(ctx, node, spec, path, helpers);
    case NODE.slice:
      return computeSlice(ctx, node, spec, path, helpers);
    case NODE.assemble:
      return computeAssemble(ctx, node, spec, path, helpers);
    case NODE.select:
      return computeSelect(ctx, node, spec, path, helpers);
    case NODE.cyclic:
      return computeCyclic(ctx, node, spec, path, helpers);
    case NODE.find:
      return computeFind(ctx, node, spec, path, helpers);
    case NODE.python:
      return computePython(ctx, node, spec, path, helpers);
    default:
      return Promise.resolve(report(ctx, 'eval_failed', node.id, `节点 ${spec.label} 不是数据节点，无法求值`));
  }
}

async function computeFill(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const byte = await intInput(ctx, node, spec, 'byte', path, helpers);
  if (byte === undefined) return { ok: false };
  const count = await intInput(ctx, node, spec, 'count', path, helpers);
  if (count === undefined) return { ok: false };
  if (byte < 0n || byte > 0xffn) {
    return report(ctx, 'invalid_param', node.id, `填充字节必须在 0x00..0xff 之间，收到 ${byte}`);
  }
  if (count < 0n) return report(ctx, 'invalid_param', node.id, `填充次数不能为负，收到 ${count}`);
  const out = guard(ctx, node, () => padding(Number(byte), Number(count)));
  return out === undefined ? { ok: false } : bytesOf(out);
}

const ENCODINGS = ['utf-8', 'latin1', 'ascii'] as const;

/** UTF-8 之外的编码自己实现：`TextEncoder` 只会 UTF-8，而题目常要求逐字节原样。 */
function encodeWith(text: string, encoding: string): Uint8Array {
  if (encoding === 'utf-8') return string(text);
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const limit = encoding === 'ascii' ? 0x80 : 0x100;
    if (code >= limit) {
      throw new ByteBuildError(
        'invalid_value',
        `${encoding} 编码不了字符 ${JSON.stringify(text[index])}（U+${code.toString(16).padStart(4, '0')}）`,
      );
    }
    out[index] = code;
  }
  return out;
}

async function computeText(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const text = await textInput(ctx, node, spec, 'text', path, helpers);
  if (text === undefined) return { ok: false };
  const encoding = typeof node.params.encoding === 'string' ? node.params.encoding : 'utf-8';
  if (!(ENCODINGS as readonly string[]).includes(encoding)) {
    return report(ctx, 'invalid_param', node.id, `未知编码 ${encoding}`);
  }
  const out = guard(ctx, node, () => encodeWith(text, encoding));
  return out === undefined ? { ok: false } : bytesOf(out);
}

async function computeInt(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const value = await intInput(ctx, node, spec, 'value', path, helpers);
  if (value === undefined) return { ok: false };
  const width = await intInput(ctx, node, spec, 'width', path, helpers);
  if (width === undefined) return { ok: false };
  const endian = node.params.endian === 'big' ? 'big' : 'little';
  const out = guard(ctx, node, () => int(value, Number(width), endian));
  return out === undefined ? { ok: false } : bytesOf(out);
}

async function computeAddress(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const value = await intInput(ctx, node, spec, 'value', path, helpers);
  if (value === undefined) return { ok: false };
  const out = guard(ctx, node, () => addr(value, wordBytes(ctx.workflow.archBits)));
  return out === undefined ? { ok: false } : bytesOf(out);
}

async function computeConcat(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const segments: PreviewSegment[] = [];
  const parts: Uint8Array[] = [];
  const count = Number(node.params.count ?? 2);
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const port = `item${index}`;
    const bytes = await bytesInput(ctx, node, spec, port, path, helpers);
    if (bytes === undefined) return { ok: false };
    segments.push({ port, offset, length: bytes.length });
    parts.push(bytes);
    offset += bytes.length;
  }
  const out = guard(ctx, node, () => concat(...parts));
  return out === undefined ? { ok: false } : { ok: true, value: { kind: 'bytes', bytes: out }, segments };
}

const ARITHMETIC: Readonly<Record<string, (a: bigint, b: bigint) => bigint>> = {
  ADD: (a, b) => a + b,
  MINUS: (a, b) => a - b,
  MULTIPLY: (a, b) => a * b,
  DIVIDE: (a, b) => a / b,
  MOD: (a, b) => a % b,
  AND: (a, b) => a & b,
  OR: (a, b) => a | b,
  XOR: (a, b) => a ^ b,
  SHL: (a, b) => a << b,
  SHR: (a, b) => a >> b,
};

function tooBig(value: bigint): boolean {
  return value < 0n ? (-value).toString(2).length > MAX_INT_BITS : value.toString(2).length > MAX_INT_BITS;
}

async function computeArith(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const op = typeof node.params.op === 'string' ? node.params.op : 'ADD';
  const operation = ARITHMETIC[op];
  if (operation === undefined) return report(ctx, 'invalid_param', node.id, `未知运算 ${op}`);
  const a = await intInput(ctx, node, spec, 'a', path, helpers);
  if (a === undefined) return { ok: false };
  const b = await intInput(ctx, node, spec, 'b', path, helpers);
  if (b === undefined) return { ok: false };
  if ((op === 'DIVIDE' || op === 'MOD') && b === 0n) {
    return report(ctx, 'eval_failed', node.id, `${op === 'DIVIDE' ? '整除' : '取余'}的除数是 0`);
  }
  if ((op === 'SHL' || op === 'SHR') && (b < 0n || b > 1024n)) {
    return report(ctx, 'eval_failed', node.id, `移位位数必须在 0..1024 之间，收到 ${b}`);
  }
  const result = operation(a, b);
  if (tooBig(result)) {
    return report(ctx, 'eval_failed', node.id, `运算结果超过 ${MAX_INT_BITS} 位，换一种算法或先拆分`);
  }
  return intOf(result);
}

async function computeCompare(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const op = typeof node.params.op === 'string' ? node.params.op : 'EQ';
  const a = await intInput(ctx, node, spec, 'a', path, helpers);
  if (a === undefined) return { ok: false };
  const b = await intInput(ctx, node, spec, 'b', path, helpers);
  if (b === undefined) return { ok: false };
  const result =
    op === 'EQ'
      ? a === b
      : op === 'NEQ'
        ? a !== b
        : op === 'LT'
          ? a < b
          : op === 'LTE'
            ? a <= b
            : op === 'GT'
              ? a > b
              : op === 'GTE'
                ? a >= b
                : undefined;
  if (result === undefined) return report(ctx, 'invalid_param', node.id, `未知比较 ${op}`);
  return { ok: true, value: { kind: 'bool', value: result } };
}

async function computeLogic(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const op = typeof node.params.op === 'string' ? node.params.op : 'AND';
  const a = await boolInput(ctx, node, spec, 'a', path, helpers);
  if (a === undefined) return { ok: false };
  if (op === 'NOT') return { ok: true, value: { kind: 'bool', value: !a } };
  const b = await boolInput(ctx, node, spec, 'b', path, helpers);
  if (b === undefined) return { ok: false };
  const result = op === 'AND' ? a && b : op === 'OR' ? a || b : op === 'XOR' ? a !== b : undefined;
  if (result === undefined) return report(ctx, 'invalid_param', node.id, `未知逻辑运算 ${op}`);
  return { ok: true, value: { kind: 'bool', value: result } };
}

async function computeBytesToInt(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const bytes = await bytesInput(ctx, node, spec, 'bytes', path, helpers);
  if (bytes === undefined) return { ok: false };
  const width = await intInput(ctx, node, spec, 'width', path, helpers);
  if (width === undefined) return { ok: false };
  const size = Number(width);
  if (!Number.isInteger(size) || size < 1 || size > 8) {
    return report(ctx, 'invalid_param', node.id, `位宽必须是 1..8 字节，收到 ${width}`);
  }
  if (bytes.length !== size) {
    return report(
      ctx,
      'eval_failed',
      node.id,
      `字节长度 ${bytes.length} 与位宽 ${size} 不一致：按位宽解码会读错字节`,
    );
  }
  const big = node.params.endian === 'big';
  let value = 0n;
  for (let index = 0; index < size; index += 1) {
    const byte = bytes[big ? index : size - 1 - index] ?? 0;
    value = (value << 8n) | BigInt(byte);
  }
  return intOf(value);
}

async function computeSlice(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const bytes = await bytesInput(ctx, node, spec, 'bytes', path, helpers);
  if (bytes === undefined) return { ok: false };
  const offset = await intInput(ctx, node, spec, 'offset', path, helpers);
  if (offset === undefined) return { ok: false };
  const length = await intInput(ctx, node, spec, 'length', path, helpers);
  if (length === undefined) return { ok: false };
  if (offset < 0n || length < 0n) {
    return report(ctx, 'eval_failed', node.id, `截取需要非负的偏移与长度，收到 ${offset} / ${length}`);
  }
  const start = Number(offset);
  const size = Number(length);
  if (start + size > bytes.length) {
    return report(
      ctx,
      'eval_failed',
      node.id,
      `截取越界：偏移 ${start} + 长度 ${size} 超过字节长度 ${bytes.length}`,
    );
  }
  return bytesOf(bytes.slice(start, start + size));
}

async function computeAssemble(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const count = Number(node.params.count ?? 2);
  const fillValue = Number(node.params.fill ?? 0x90);
  const placed: { offset: number; bytes: Uint8Array }[] = [];
  const segments: PreviewSegment[] = [];

  for (let index = 0; index < count; index += 1) {
    const offset = await intInput(ctx, node, spec, `offset${index}`, path, helpers);
    if (offset === undefined) return { ok: false };
    if (offset < 0n || offset > 0x100000n) {
      return report(
        ctx,
        'eval_failed',
        node.id,
        `第 ${index + 1} 段偏移必须在 0..0x100000 之间，收到 ${offset}`,
      );
    }
    const bytes = await bytesInput(ctx, node, spec, `item${index}`, path, helpers);
    if (bytes === undefined) return { ok: false };
    placed.push({ offset: Number(offset), bytes });
    segments.push({ port: `item${index}`, offset: Number(offset), length: bytes.length });
  }

  const sorted = [...placed].sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as { offset: number; bytes: Uint8Array };
    const current = sorted[index] as { offset: number; bytes: Uint8Array };
    if (current.offset < previous.offset + previous.bytes.length) {
      return report(
        ctx,
        'eval_failed',
        node.id,
        `第 ${sorted.indexOf(previous) + 1} 段（偏移 ${previous.offset}）与第 ${sorted.indexOf(current) + 1} 段（偏移 ${current.offset}）重叠`,
      );
    }
  }

  const total = sorted.reduce((max, segment) => Math.max(max, segment.offset + segment.bytes.length), 0);
  const out = guard(ctx, node, () => new Uint8Array(total).fill(fillValue & 0xff));
  if (out === undefined) return { ok: false };
  for (const segment of placed) out.set(segment.bytes, segment.offset);
  return { ok: true, value: { kind: 'bytes', bytes: out }, segments };
}

async function computeSelect(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const condition = await boolInput(ctx, node, spec, 'cond', path, helpers);
  if (condition === undefined) return { ok: false };
  // 只求值被选中的候选值：没被选中的分支即使有错（甚至要跑 Python）也不该执行。
  return helpers.resolve(node, spec, condition ? 'a' : 'b', path);
}

async function computeCyclic(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const length = await intInput(ctx, node, spec, 'length', path, helpers);
  if (length === undefined) return { ok: false };
  if (length < 0n) return report(ctx, 'invalid_param', node.id, `长度不能为负，收到 ${length}`);
  const alphabet = alphabetOf(typeof node.params.alphabet === 'string' ? node.params.alphabet : 'lower');
  const out = guard(ctx, node, () => string(cyclicSequence(alphabet, Number(length))));
  return out === undefined ? { ok: false } : bytesOf(out);
}

async function computeFind(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const needle = await bytesInput(ctx, node, spec, 'needle', path, helpers);
  if (needle === undefined) return { ok: false };
  if (needle.length === 0) {
    return report(ctx, 'eval_failed', node.id, '要找的字节是空的：定位序列里空串没有唯一偏移');
  }
  const alphabet = alphabetOf(typeof node.params.alphabet === 'string' ? node.params.alphabet : 'lower');
  const offset = cyclicFind(needle, alphabet);
  if (offset === undefined) {
    return report(
      ctx,
      'eval_failed',
      node.id,
      `在定位序列里找不到 ${bytesToHex(needle)}：检查字母表是否一致，或这段字节不是从序列里取的`,
    );
  }
  return intOf(BigInt(offset));
}

async function computePython(
  ctx: EvalContext,
  node: GraphNode,
  spec: NodeKindSpec,
  path: readonly string[],
  helpers: EvalHelpers,
): Promise<ValueResult> {
  const evaluator = ctx.workflow.python;
  if (evaluator === undefined) {
    return report(ctx, 'python_unavailable', node.id, 'Python 求值不可用：服务端没有启用隔离运行器');
  }
  if (ctx.pythonCalls >= PYTHON_MAX_EVALS_PER_COMPILE) {
    return report(
      ctx,
      'limit_exceeded',
      node.id,
      `一次编译最多发起 ${PYTHON_MAX_EVALS_PER_COMPILE} 次 Python 求值（06 §5.3）`,
    );
  }
  const outputType = nodeOutput(spec, paramsOf(node, spec))?.type;
  if (outputType === undefined) return report(ctx, 'eval_failed', node.id, 'Python 节点没有声明输出类型');
  const code = typeof node.params.code === 'string' ? node.params.code : '';
  if (code.trim() === '') return report(ctx, 'invalid_param', node.id, 'Python 节点的代码是空的');

  const ports = nodeInputs(spec, paramsOf(node, spec), ctx.portContext);
  const inputs: { name: string; type: PortType; value: EncodedValue }[] = [];
  for (const port of ports) {
    const result = await helpers.resolve(node, spec, port.name, path);
    if (!result.ok) return result;
    inputs.push({ name: port.name, type: port.type, value: helpers.encode(result.value) });
  }

  ctx.pythonCalls += 1;
  let result: PythonEvalResult;
  try {
    result = await evaluator.evaluate({ code, outputType, inputs });
  } catch (error) {
    return report(
      ctx,
      'python_failed',
      node.id,
      `Python 求值请求失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!result.ok) {
    const line = result.error.line === undefined ? '' : `（第 ${result.error.line} 行）`;
    return report(ctx, 'python_failed', node.id, `Python ${result.error.code}${line}：${result.error.message}`);
  }
  if (result.value.kind !== outputType) {
    return report(
      ctx,
      'python_failed',
      node.id,
      `Python 输出类型是 ${result.value.kind}，但节点声明的是 ${outputType}`,
    );
  }
  const decoded = decodeEncoded(result.value);
  if (decoded === undefined) return report(ctx, 'python_failed', node.id, 'Python 返回值无法解码');
  return { ok: true, value: decoded };
}

function decodeEncoded(value: EncodedValue): WorkflowValue | undefined {
  switch (value.kind) {
    case 'int': {
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(value.value)) return undefined;
      return { kind: 'int', value: BigInt(value.value) };
    }
    case 'bool':
      return { kind: 'bool', value: value.value };
    case 'bytes':
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(value.hex)) return undefined;
      return { kind: 'bytes', bytes: hexToBytes(value.hex) };
    case 'text':
      return { kind: 'text', text: value.text };
  }
}
