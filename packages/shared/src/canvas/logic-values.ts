import { applyBinary } from './ops';
import { repeatOf } from './collection';
import { applyConversion } from './convert';
import { BINARY_OPERATORS, type BinaryOperator } from './operators';
import { decodeScalarValue } from './value-codec';
import { boolValue, byteValue, checkValue, stringValue, type Value } from './value';
import type { LogicLiteral, LogicNode, LogicOperator } from './logic-model';
import type { CanvasResult } from './result';

export class LogicFault extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireLogic<T>(result: CanvasResult<T>, id: string): T {
  if (!result.ok) throw new LogicFault(id, result.message);
  return result.value;
}
export function logicLiteral(value: LogicLiteral, id: string): Value {
  const text = value.text;
  switch (value.type) {
    case 'int': {
      if (!/^-?(?:[0-9]+|0x[0-9a-f]+)$/i.test(text) || text.length > 512)
        throw new LogicFault(id, 'int 需要整数（十进制或 0x 十六进制）');
      const negative = text.startsWith('-');
      const number = BigInt(negative ? text.slice(1) : text) * (negative ? -1n : 1n);
      return requireLogic(decodeScalarValue({ kind: 'int', value: number.toString() }), id);
    }
    case 'double':
      if (text.trim() === '' || !Number.isFinite(Number(text))) throw new LogicFault(id, 'double 需要有限数字');
      return requireLogic(decodeScalarValue({ kind: 'double', value: Number(text) }), id);
    case 'string':
      return checked(stringValue(text), id);
    case 'bool':
      if (text !== 'true' && text !== 'false') throw new LogicFault(id, 'bool 只能为 true 或 false');
      return boolValue(text === 'true');
    case 'bytes':
      return requireLogic(decodeScalarValue({ kind: 'byte', hex: text.replace(/\s/g, '') }), id);
  }
}
const operators: Readonly<Record<string, string>> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
  '&': 'and',
  '|': 'or',
  '^': 'xor',
  '<<': 'shl',
  '>>': 'shr',
  and: 'and',
  or: 'or',
};
export function logicBinary(op: LogicOperator, left: Value, right: Value, id: string): Value {
  if (op === '*' && (left.kind === 'string' || left.kind === 'byte'))
    return requireLogic(repeatOf(left, right), id);
  if ((op === '+' || op === 'concat') && left.kind === right.kind) {
    if (left.kind === 'string' && right.kind === 'string') return checked(stringValue(left.value + right.value), id);
    if (left.kind === 'byte' && right.kind === 'byte') {
      if (left.bytes.length + right.bytes.length > 65536) throw new LogicFault(id, '拼接字节数超过上限');
      return checked(byteValue(new Uint8Array([...left.bytes, ...right.bytes])), id);
    }
  }
  if ((op === '==' || op === '!=') && left.kind === right.kind && (left.kind === 'bool' || left.kind === 'string')) {
    const same = 'value' in right && left.value === right.value;
    return boolValue(op === '==' ? same : !same);
  }
  const name = `${left.kind}.${operators[op]}`;
  if (!(BINARY_OPERATORS as readonly string[]).includes(name)) throw new LogicFault(id, `${left.kind} 不支持 ${op}`);
  return requireLogic(applyBinary(name as BinaryOperator, left, right), id);
}
export function logicConvert(input: Value, node: Extract<LogicNode, { kind: 'convert' }>): Value {
  const target = node.target === 'bytes' ? 'byte' : node.target;
  if (input.kind === target) return input;
  if (target === 'bool') {
    if (input.kind === 'string' && (input.value === 'true' || input.value === 'false'))
      return boolValue(input.value === 'true');
    if (input.kind === 'int' && (input.value === 0n || input.value === 1n)) return boolValue(input.value === 1n);
    throw new LogicFault(node.id, '转换为 bool 只接受 true/false 或整数 0/1');
  }
  if (input.kind === 'bool')
    return logicLiteral(
      { type: node.target, text: target === 'string' ? String(input.value) : input.value ? '1' : '0' },
      node.id,
    );
  const key = `${input.kind}:${target}`;
  const options = { width: Number(node.width) as 1 | 2 | 4 | 8, endian: node.endian, signed: node.signed };
  switch (key) {
    case 'string:byte':
      return requireLogic(applyConversion(input, { kind: 'text-to-bytes', encoding: 'utf-8' }), node.id);
    case 'byte:string':
      return requireLogic(applyConversion(input, { kind: 'bytes-to-text', encoding: 'utf-8' }), node.id);
    case 'int:byte':
      return requireLogic(applyConversion(input, { kind: 'int-to-bytes', ...options }), node.id);
    case 'byte:int':
      return requireLogic(applyConversion(input, { kind: 'bytes-to-int', ...options }), node.id);
    case 'int:double':
      return requireLogic(applyConversion(input, { kind: 'int-to-double' }), node.id);
    case 'double:int':
      return requireLogic(applyConversion(input, { kind: 'double-to-int', rounding: 'trunc' }), node.id);
    case 'int:string':
      return requireLogic(applyConversion(input, { kind: 'int-to-text', base: 10 }), node.id);
    case 'string:int':
      return requireLogic(applyConversion(input, { kind: 'text-to-int', base: 10 }), node.id);
    case 'double:string':
      return requireLogic(applyConversion(input, { kind: 'double-to-text' }), node.id);
    case 'string:double':
      return requireLogic(applyConversion(input, { kind: 'text-to-double' }), node.id);
    default:
      throw new LogicFault(node.id, `不能从 ${input.kind} 转为 ${node.target}`);
  }
}

function checked(value: Value, id: string): Value {
  const error = checkValue(value);
  if (error) throw new LogicFault(id, error);
  return value;
}
