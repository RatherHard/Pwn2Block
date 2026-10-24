import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import {
  applyRowEdit,
  binaryCycleOf,
  cycleOperator,
  editableTextOf,
} from '../src/components/canvas-panel-commands';

/**
 * 画布上的两类直接动作：就地编辑（含方法参数）与点关系方框切换运算。
 *
 * 断言都落在文档上：界面只是把文本交给这些函数，文档长什么样才是用户真正得到的结果。
 */

const UN = canvas.UNCONNECTED;
const START: canvas.StartNode = { id: 'start', kind: 'start' };
const METHODS: readonly canvas.CanvasMethodDecl[] = [
  { id: 'send', label: '发送', params: [{ name: 'data', type: 'bytes' }, { name: 'n', type: 'int' }], actionCount: 1 },
];

function doc(nodes: readonly canvas.CanvasNode[], layout: canvas.CanvasDocument['layout'] = {}): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes: [START, ...nodes], layout, main: ['start'] };
}

function nodeIn(document: canvas.CanvasDocument, id: string): canvas.CanvasNode | undefined {
  return document.nodes.find((node) => node.id === id);
}

/** 方法节点 `m` 上某个参数接到了谁。 */
function argOf(document: canvas.CanvasDocument, name: string): string {
  const node = nodeIn(document, 'm');
  return node?.kind === 'method' ? (node.args[name] ?? '') : '';
}

const method = (args: Record<string, string>): canvas.CanvasNode => ({ id: 'm', kind: 'method', block: 'send', args });
const int = (id: string, value: string): canvas.CanvasNode => ({ id, kind: 'value', value: { kind: 'int', value } });

describe('就地编辑字面值', () => {
  it('整数接受 0x 前缀，存成十进制', () => {
    const edit = applyRowEdit(doc([int('v', '0')]), 'v', '值', '0x401136');
    expect(edit?.issues).toEqual([]);
    expect(nodeIn(edit!.document, 'v')).toMatchObject({ value: { kind: 'int', value: '4198710' } });
  });

  it('负的十六进制同样换算', () => {
    const edit = applyRowEdit(doc([int('v', '0')]), 'v', '值', '-0x10');
    expect(nodeIn(edit!.document, 'v')).toMatchObject({ value: { kind: 'int', value: '-16' } });
  });

  it('字节串忽略中间空格', () => {
    const bytes: canvas.CanvasNode = { id: 'b', kind: 'value', value: { kind: 'byte', hex: '' } };
    const edit = applyRowEdit(doc([bytes]), 'b', '值', '41 41 0A');
    expect(nodeIn(edit!.document, 'b')).toMatchObject({ value: { kind: 'byte', hex: '41410a' } });
  });

  it('非法整数仍由命令层拒绝，文档不变', () => {
    const before = doc([int('v', '7')]);
    const edit = applyRowEdit(before, 'v', '值', '0xZZ');
    expect(edit?.issues.length).toBeGreaterThan(0);
    expect(nodeIn(edit!.document, 'v')).toMatchObject({ value: { kind: 'int', value: '7' } });
  });
});

describe('方法参数就地编辑', () => {
  it('没接线时初值为空，提交后新建字面值并接上，类型按题目声明', () => {
    const before = doc([method({ data: UN, n: UN })], { start: { x: 0, y: 600 }, m: { x: 400, y: 100 } });
    expect(editableTextOf(before, 'm', 'n')).toBe('');
    const edit = applyRowEdit(before, 'm', 'n', '0x20', METHODS);
    expect(edit?.issues).toEqual([]);
    const literalId = argOf(edit!.document, 'n');
    expect(literalId).toBe('n1');
    expect(nodeIn(edit!.document, literalId)).toMatchObject({ kind: 'value', value: { kind: 'int', value: '32' } });
    // 新字面值放在方法框左侧，与方法框顶对齐。
    expect(edit!.document.layout[literalId]).toEqual({ x: 160, y: 100 });
  });

  it('左侧空位被占时往下找', () => {
    const before = doc([method({ data: UN, n: UN })], { start: { x: 160, y: 100 }, m: { x: 400, y: 100 } });
    const edit = applyRowEdit(before, 'm', 'n', '1', METHODS);
    expect(edit!.document.layout[argOf(edit!.document, 'n')]).toEqual({ x: 160, y: 196 });
  });

  it('字节参数新建的是字节串', () => {
    const before = doc([method({ data: UN, n: UN })], { m: { x: 400, y: 100 } });
    const edit = applyRowEdit(before, 'm', 'data', '4141', METHODS);
    expect(nodeIn(edit!.document, argOf(edit!.document, 'data'))).toMatchObject({
      value: { kind: 'byte', hex: '4141' },
    });
  });

  it('接的是字面值时直接改那个字面值，接线不动', () => {
    const before = doc([int('k', '1'), method({ data: UN, n: 'k' })]);
    expect(editableTextOf(before, 'm', 'n')).toBe('1');
    const edit = applyRowEdit(before, 'm', 'n', '9', METHODS);
    expect(nodeIn(edit!.document, 'k')).toMatchObject({ value: { kind: 'int', value: '9' } });
    expect(edit!.document.nodes).toHaveLength(before.nodes.length);
  });

  it('接的是表达式时不可编辑，提交被拒绝', () => {
    const relation: canvas.CanvasNode = { id: 'r', kind: 'relation', op: 'int.add', left: UN, right: UN };
    const before = doc([relation, method({ data: UN, n: 'r' })]);
    expect(editableTextOf(before, 'm', 'n')).toBeUndefined();
    const edit = applyRowEdit(before, 'm', 'n', '3', METHODS);
    expect(edit?.document).toBe(before);
    expect(edit?.issues[0]?.message).toContain('去那个节点上改');
  });

  it('题目没声明这个方法时拒绝，不留半截节点', () => {
    const before = doc([method({ data: UN, n: UN })]);
    const edit = applyRowEdit(before, 'm', 'n', '3', []);
    expect(edit?.document).toBe(before);
    expect(edit?.issues[0]?.code).toBe('method_mismatch');
  });

  it('非法文本让整次编辑放弃，文档里不多出节点', () => {
    const before = doc([method({ data: UN, n: UN })]);
    const edit = applyRowEdit(before, 'm', 'n', '不是数', METHODS);
    expect(edit?.document).toBe(before);
    expect(edit?.issues.length).toBeGreaterThan(0);
  });
});

describe('点关系方框切换运算', () => {
  it('二元运算只在左右类型相同的运算里转，并能绕回', () => {
    const cycle = binaryCycleOf('int.add');
    expect(cycle.length).toBeGreaterThan(1);
    for (const op of cycle) {
      expect(canvas.binaryOperatorSpec(op)).toMatchObject({ left: 'int', right: 'int' });
    }
    let document = doc([{ id: 'r', kind: 'relation', op: 'int.add', left: UN, right: UN }]);
    for (let index = 0; index < cycle.length; index += 1) {
      document = cycleOperator(document, 'r')!.document;
    }
    expect(nodeIn(document, 'r')).toMatchObject({ op: 'int.add' });
  });

  it('一元操作没接线时在全部操作里转', () => {
    const unary: canvas.CanvasNode = { id: 'u', kind: 'unary', op: 'bool.not', operand: UN };
    const edit = cycleOperator(doc([unary]), 'u');
    expect(edit?.issues).toEqual([]);
    expect(nodeIn(edit!.document, 'u')).toMatchObject({ op: 'length' });
  });

  it('已接字节串的「长度」没有同类型的替代，原地不动并说明原因', () => {
    const bytes: canvas.CanvasNode = { id: 'b', kind: 'value', value: { kind: 'byte', hex: '41' } };
    const unary: canvas.CanvasNode = { id: 'u', kind: 'unary', op: 'length', operand: 'b' };
    const before = doc([bytes, unary]);
    const edit = cycleOperator(before, 'u');
    expect(edit?.document).toBe(before);
    expect(edit?.issues[0]?.message).toContain('只有这一种操作');
  });
});
