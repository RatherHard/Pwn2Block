import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import { validateGraph } from '../src/workflow/validate';
import type { WorkflowContext } from '../src/workflow/types';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 分支、循环与变量（06 §5；07 §P4 验证项）。
 *
 * 这些断言不需要界面：分支只生成选中路径的动作、零次循环仍有结果、循环每轮重算变量、
 * break/continue 只影响最近一层循环。全部按动作与字节精确比较。
 */

/** 整数常量：data.int 产出字节，这里用「0 + n」得到 int（不接线的参数走内填值）。 */
function intOf(id: string, value: number) {
  return wfNode(id, NODE.arith, { op: 'ADD', a: 0, b: value });
}

async function compile(document: ReturnType<typeof workflow>, context: WorkflowContext = WORKFLOW_CONTEXT) {
  return compileGraph({ document, context, documentRevision: 1 });
}

function actionsOf(outcome: Awaited<ReturnType<typeof compileGraph>>) {
  if (!outcome.ok) throw new Error(`编译失败：${outcome.issues.map((issue) => issue.message).join('; ')}`);
  return outcome.artifact.actions;
}

function codesOf(document: ReturnType<typeof workflow>, context: WorkflowContext = WORKFLOW_CONTEXT) {
  return validateGraph(document, context).errors.map((issue) => issue.code);
}

describe('条件分支', () => {
  it('只生成选中分支的动作', async () => {
    const document = workflow({
      nodes: [
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        wfNode('stepA', NODE.step, { count: 1 }),
        wfNode('stepB', NODE.step, { count: 2 }),
        wfNode('if', NODE.if, {}, { then: ['stepA'], else: ['stepB'] }),
      ],
      edges: [wfEdge('cmp', 'if', 'cond')],
      main: ['if'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'step', count: 1 }]);
  });

  it('条件为假时走「否则」，并且两条分支的结果类型一致', async () => {
    const document = workflow({
      nodes: [
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 2 }),
        intOf('one', 11),
        intOf('two', 22),
        wfNode('r1', NODE.result, { type: 'int' }),
        wfNode('r2', NODE.result, { type: 'int' }),
        wfNode('if', NODE.if, { resultType: 'int' }, { then: ['r1'], else: ['r2'] }),
        wfNode('push', NODE.push),
      ],
      edges: [
        wfEdge('cmp', 'if', 'cond'),
        wfEdge('one', 'r1', 'value'),
        wfEdge('two', 'r2', 'value'),
        wfEdge('if', 'push', 'value'),
      ],
      main: ['if', 'push'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'push', value: '0x16' }]);
  });

  it('声明了结果却没有「结果」节点时拒绝编译', () => {
    const document = workflow({
      nodes: [
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        intOf('one', 1),
        wfNode('r1', NODE.result, { type: 'int' }),
        wfNode('if', NODE.if, { resultType: 'int' }, { then: ['r1'], else: [] }),
      ],
      edges: [wfEdge('cmp', 'if', 'cond'), wfEdge('one', 'r1', 'value')],
      main: ['if'],
    });
    expect(codesOf(document)).toContain('missing_region_result');
  });

  it('否则如果：按顺序判断，命中哪个区域就走哪个', async () => {
    const document = workflow({
      nodes: [
        wfNode('c0', NODE.compare, { op: 'EQ', a: 1, b: 2 }),
        wfNode('c1', NODE.compare, { op: 'EQ', a: 3, b: 3 }),
        wfNode('stepA', NODE.step, { count: 1 }),
        wfNode('stepB', NODE.step, { count: 2 }),
        wfNode('stepC', NODE.step, { count: 3 }),
        wfNode(
          'if',
          NODE.if,
          { branches: 1 },
          { then: ['stepA'], branch1: ['stepB'], else: ['stepC'] },
        ),
      ],
      edges: [wfEdge('c0', 'if', 'cond'), wfEdge('c1', 'if', 'cond1')],
      main: ['if'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'step', count: 2 }]);
  });

  it('否则如果都不成立时落到「否则」', async () => {
    const document = workflow({
      nodes: [
        wfNode('c0', NODE.compare, { op: 'EQ', a: 1, b: 2 }),
        wfNode('c1', NODE.compare, { op: 'EQ', a: 3, b: 4 }),
        wfNode('stepB', NODE.step, { count: 2 }),
        wfNode('stepC', NODE.step, { count: 3 }),
        wfNode('if', NODE.if, { branches: 1 }, { then: [], branch1: ['stepB'], else: ['stepC'] }),
      ],
      edges: [wfEdge('c0', 'if', 'cond'), wfEdge('c1', 'if', 'cond1')],
      main: ['if'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'step', count: 3 }]);
  });
});

describe('次数循环', () => {
  it('下标从 0 开始，每轮生成一条动作并记录轮次', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 3 }, { body: ['push', 'idx'] }),
        wfNode('push', NODE.push),
        wfNode('idx', NODE.index),
      ],
      edges: [wfEdge('idx', 'push', 'value')],
      main: ['rep'],
    });
    const outcome = await compile(document);
    expect(actionsOf(outcome)).toEqual([
      { type: 'push', value: '0x0' },
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x2' },
    ]);
    if (!outcome.ok) return;
    expect(outcome.artifact.origins.map((origin) => origin.rounds)).toEqual([
      { rep: 0 },
      { rep: 1 },
      { rep: 2 },
    ]);
  });

  it('零次循环仍给出初始值', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 0, resultType: 'int', initial: '7' }, { body: ['r'] }),
        intOf('nine', 9),
        wfNode('r', NODE.result, { type: 'int' }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('nine', 'r', 'value'), wfEdge('rep', 'push', 'value')],
      main: ['rep', 'push'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'push', value: '0x7' }]);
  });

  it('累计值：每轮结果成为下一轮的累计值', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 3, resultType: 'int', initial: '0' }, { body: ['acc', 'r'] }),
        wfNode('acc', NODE.accumulator, { type: 'int' }),
        intOf('one', 1),
        wfNode('add', NODE.arith, { op: 'ADD' }),
        wfNode('r', NODE.result, { type: 'int' }),
        wfNode('push', NODE.push),
      ],
      edges: [
        wfEdge('acc', 'add', 'a'),
        wfEdge('one', 'add', 'b'),
        wfEdge('add', 'r', 'value'),
        wfEdge('rep', 'push', 'value'),
      ],
      main: ['rep', 'push'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'push', value: '0x3' }]);
  });
});

describe('条件循环', () => {
  it('每轮重新判断条件，变量更新后下一轮重新求值', async () => {
    const document = workflow({
      nodes: [
        wfNode('decl', NODE.varDeclare, { name: 'i', type: 'int', initial: '0' }),
        wfNode('loop', NODE.while, { mode: 'while' }, { body: ['push', 'inc'] }),
        wfNode('get', NODE.varGet, { name: 'i', type: 'int' }),
        intOf('three', 3),
        wfNode('cmp', NODE.compare, { op: 'LT' }),
        intOf('one', 1),
        wfNode('add', NODE.arith, { op: 'ADD' }),
        wfNode('inc', NODE.varSet, { name: 'i', type: 'int' }),
        wfNode('push', NODE.push),
      ],
      edges: [
        wfEdge('get', 'cmp', 'a'),
        wfEdge('three', 'cmp', 'b'),
        wfEdge('cmp', 'loop', 'cond'),
        wfEdge('get', 'add', 'a'),
        wfEdge('one', 'add', 'b'),
        wfEdge('add', 'inc', 'value'),
        wfEdge('get', 'push', 'value'),
      ],
      main: ['decl', 'loop'],
    });
    expect(actionsOf(await compile(document))).toEqual([
      { type: 'push', value: '0x0' },
      { type: 'push', value: '0x1' },
      { type: 'push', value: '0x2' },
    ]);
  });
});

describe('跳出与继续', () => {
  it('break 结束最近一层循环', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 5 }, { body: ['branch', 'idx'] }),
        wfNode('idx', NODE.index),
        intOf('two', 2),
        wfNode('cmp', NODE.compare, { op: 'LT' }),
        wfNode('br', NODE.break),
        wfNode('push', NODE.push),
        wfNode('branch', NODE.if, {}, { then: ['push'], else: ['br'] }),
      ],
      edges: [
        wfEdge('idx', 'cmp', 'a'),
        wfEdge('two', 'cmp', 'b'),
        wfEdge('cmp', 'branch', 'cond'),
        wfEdge('idx', 'push', 'value'),
      ],
      main: ['rep'],
    });
    expect(actionsOf(await compile(document))).toEqual([
      { type: 'push', value: '0x0' },
      { type: 'push', value: '0x1' },
    ]);
  });

  it('continue 跳过本轮剩余语句', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 4 }, { body: ['branch', 'idx'] }),
        wfNode('idx', NODE.index),
        intOf('one', 1),
        wfNode('cmp', NODE.compare, { op: 'EQ' }),
        wfNode('cont', NODE.continue),
        wfNode('push', NODE.push),
        wfNode('branch', NODE.if, {}, { then: ['cont'], else: ['push'] }),
      ],
      edges: [
        wfEdge('idx', 'cmp', 'a'),
        wfEdge('one', 'cmp', 'b'),
        wfEdge('cmp', 'branch', 'cond'),
        wfEdge('idx', 'push', 'value'),
      ],
      main: ['rep'],
    });
    expect(actionsOf(await compile(document))).toEqual([
      { type: 'push', value: '0x0' },
      { type: 'push', value: '0x2' },
      { type: 'push', value: '0x3' },
    ]);
  });

  it('外层 if 里的 continue 仍作用于最近的循环', async () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 3 }, { body: ['branch'] }),
        wfNode('congrue', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        wfNode('branch', NODE.if, {}, { then: ['inner'] }),
        wfNode('inner', NODE.if, {}, { then: ['cont'] }),
        wfNode('cont', NODE.continue),
      ],
      edges: [
        wfEdge('congrue', 'branch', 'cond'),
        wfEdge('congrue', 'inner', 'cond'),
      ],
      main: ['rep'],
    });
    // 每轮都在第二层 if 里 continue，于是循环体没有生成任何动作。
    expect(actionsOf(await compile(document))).toEqual([]);
  });

  it('循环外的 break 在校验期就被拒绝', () => {
    const document = workflow({ nodes: [wfNode('br', NODE.break)], main: ['br'] });
    expect(codesOf(document)).toContain('break_outside_loop');
  });
});

describe('变量的作用域与类型', () => {
  it('循环体里声明的变量不会泄漏到外层', () => {
    const document = workflow({
      nodes: [
        wfNode('rep', NODE.repeat, { count: 1 }, { body: ['decl'] }),
        wfNode('decl', NODE.varDeclare, { name: 'x', type: 'int', initial: '1' }),
        wfNode('get', NODE.varGet, { name: 'x', type: 'int' }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('get', 'push', 'value')],
      main: ['rep', 'push'],
    });
    expect(codesOf(document)).toContain('undeclared_variable');
  });

  it('重复声明与类型不一致都会被报出来', () => {
    const document = workflow({
      nodes: [
        wfNode('d1', NODE.varDeclare, { name: 'x', type: 'int', initial: '0' }),
        wfNode('d2', NODE.varDeclare, { name: 'x', type: 'int', initial: '0' }),
        wfNode('get', NODE.varGet, { name: 'x', type: 'text' }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('get', 'push', 'value')],
      main: ['d1', 'd2', 'push'],
    });
    const codes = codesOf(document);
    expect(codes).toContain('duplicate_variable');
    expect(codes).toContain('variable_type_mismatch');
  });

  it('分支内可以使用外层声明的变量', async () => {
    const document = workflow({
      nodes: [
        wfNode('decl', NODE.varDeclare, { name: 'x', type: 'int', initial: '5' }),
        wfNode('get', NODE.varGet, { name: 'x', type: 'int' }),
        wfNode('push', NODE.push),
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        wfNode('branch', NODE.if, {}, { then: ['push'], else: [] }),
      ],
      edges: [wfEdge('get', 'push', 'value'), wfEdge('cmp', 'branch', 'cond')],
      main: ['decl', 'branch'],
    });
    expect(actionsOf(await compile(document))).toEqual([{ type: 'push', value: '0x5' }]);
  });
});
