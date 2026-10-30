import { describe, it, expect } from 'vitest';
import { generateLogicActions, previewLogicGraph, validateLogicGraph } from './logic-runtime';
import {
  LogicGraphSchema,
  newLogicDocument,
  type LogicGraph,
  type LogicNode,
  type LogicEdge,
  type LogicType,
} from './logic-model';
import { parseCanvasDocument } from './schema';
import { generateCanvasActions } from './actions';

const start: LogicNode = { id: 'start', kind: 'start', x: 20, y: 20 };
function value(id: string, text: string, type: LogicType = 'int'): LogicNode {
  return { id, kind: 'constant', value: { type, text }, x: 100, y: 100 };
}
function variable(id: string, name = id): LogicNode {
  return { id, kind: 'variable', name, x: 300, y: 100 };
}
function envelope(id: string, members: string[], category: 'data' | 'flow' = 'data'): LogicNode {
  return { id, kind: 'envelope', title: id, members, category, x: 50, y: 50 };
}
function data(from: string, to: string, op: Extract<LogicEdge, { kind: 'data' }>['op'] = 'assign'): LogicEdge {
  return { id: `${from}-${to}`, kind: 'data', from, to, op };
}
function flow(from: string, to: string, outlet: 'next' | 'then' | 'else' = 'next'): LogicEdge {
  return { id: `${from}-${to}`, kind: 'flow', from, to, outlet };
}
function ref(from: string, to: string, port: string): LogicEdge {
  return { id: `${from}-${to}`, kind: 'reference', from, to, port };
}
function graph(nodes: LogicNode[], edges: LogicEdge[] = []): LogicGraph {
  return { version: 1, nodes: [start, ...nodes], edges };
}
function method(id: string): LogicNode {
  return { id, kind: 'method', method: 'emit', x: 500, y: 100 };
}
const methods = [{ id: 'emit', label: '记录', params: [{ name: 'n', type: 'int' as const }], actionCount: 1 }];
function actions(g: LogicGraph) {
  return generateLogicActions(g, { methods });
}
function failure(g: LogicGraph, pattern: RegExp): void {
  const result = actions(g);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.map((i) => i.message).join('\n')).toMatch(pattern);
}

describe('节点功能逻辑基准：数据、赋值与包络', () => {
  it('新文档只有唯一开始，存档往返保留独立连接模型', () => {
    const document = newLogicDocument();
    expect(document.logic?.nodes.map((n) => n.kind)).toEqual(['start']);
    expect(parseCanvasDocument(JSON.parse(JSON.stringify(document)))).toMatchObject({ ok: true, document });
    expect(generateCanvasActions(document)).toMatchObject({ ok: true, sequence: { actions: [] } });
  });
  it('仅接受五种标量类型；变量没有类型字段', () => {
    expect(LogicGraphSchema.safeParse(graph([value('v', '', 'string')])).success).toBe(true);
    expect(
      LogicGraphSchema.safeParse({ version: 1, nodes: [{ ...variable('x'), type: 'int' }], edges: [] }).success,
    ).toBe(false);
    expect(
      LogicGraphSchema.safeParse({
        version: 1,
        nodes: [{ id: 'list', kind: 'constant', x: 0, y: 0, value: { type: 'list', text: '[]' } }],
        edges: [],
      }).success,
    ).toBe(false);
  });
  it('运算按连接组合，包络充当括号并提供整体结果', () => {
    const g = graph(
      [value('a', '2'), value('b', '3'), value('c', '4'), envelope('g', ['a', 'b'])],
      [data('a', 'b', '+'), data('g', 'c', '*')],
    );
    expect(previewLogicGraph(g).get('c')).toEqual({ kind: 'int', value: 20n });
  });
  it('连接表达式按 C/Python 运算优先级计算，而不是简单左结合', () => {
    const g = graph(
      [value('a', '2'), value('b', '3'), value('c', '4')],
      [data('a', 'b', '+'), data('b', 'c', '*')],
    );
    expect(previewLogicGraph(g).get('c')).toEqual({ kind: 'int', value: 14n });
  });
  it.each([
    ['left associative subtraction', ['8', '3', '2'], ['-', '-'], 3n],
    ['multiplication before addition', ['2', '3', '4'], ['*', '+'], 10n],
    ['shift has lower precedence than addition', ['2', '1', '1'], ['<<', '+'], 8n],
  ] as const)('%s', (_name, values, operators, expected) => {
    const nodes = values.map((text, index) => value(String.fromCharCode(97 + index), text));
    const edges = operators.map((op, index) => data(String.fromCharCode(97 + index), String.fromCharCode(98 + index), op));
    expect(previewLogicGraph(graph(nodes, edges)).get('c')).toEqual({ kind: 'int', value: expected });
  });
  it('supports relational results in equality expressions', () => {
    const g = graph(
      [value('a', '1'), value('b', '2'), value('c', 'true', 'bool')],
      [data('a', 'b', '<'), data('b', 'c', '==')],
    );
    expect(previewLogicGraph(g).get('c')).toEqual({ kind: 'bool', value: true });
  });
  it.each([
    ['string', 'ab', 'cd', { kind: 'string', value: 'abcd' }],
    ['bytes', '4142', '4344', { kind: 'byte', bytes: new Uint8Array([65, 66, 67, 68]) }],
  ] as const)('%s 的加法就是拼接', (type, a, b, expected) => {
    expect(
      previewLogicGraph(graph([value('a', a, type), value('b', b, type)], [data('a', 'b', '+')])).get('b'),
    ).toEqual(expected);
  });
  it('全局定义先于开始执行，首次赋值推断 int', () => {
    const result = actions(
      graph(
        [value('one', '7'), variable('x'), method('m')],
        [data('one', 'x'), ref('x', 'm', 'n'), flow('start', 'm')],
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      sequence: { actions: [{ type: 'block', id: 'emit', args: { n: '0x7' } }] },
    });
  });
  it('首次赋值可发生在流程中；同名变量节点读取同一状态', () => {
    const g = graph(
      [
        value('one', '9'),
        variable('write', 'x'),
        envelope('set', ['one', 'write']),
        variable('read', 'x'),
        method('m'),
      ],
      [data('one', 'write'), flow('start', 'set'), flow('set', 'm'), ref('read', 'm', 'n')],
    );
    expect(actions(g)).toMatchObject({ ok: true, sequence: { actions: [{ args: { n: '0x9' } }] } });
  });
  it('全局派生变量跟随多次流程赋值重算，且无显式类型或派生模式开关', () => {
    const g = graph(
      [
        value('initial', '1'),
        variable('x'),
        variable('xr', 'x'),
        value('two', '2'),
        variable('y'),
        value('next', '4'),
        variable('xw', 'x'),
        envelope('set', ['next', 'xw']),
        method('before'),
        method('after'),
      ],
      [
        data('initial', 'x'),
        data('xr', 'two', '*'),
        data('two', 'y'),
        data('next', 'xw'),
        flow('start', 'before'),
        flow('before', 'set'),
        flow('set', 'after'),
        ref('y', 'before', 'n'),
        ref('y', 'after', 'n'),
      ],
    );
    const result = actions(g);
    expect(result).toMatchObject({ ok: true, sequence: { actions: [{ args: { n: '0x2' } }, { args: { n: '0x8' } }] } });
  });
  it('派生变量不可在未执行的分支里写入', () => {
    const g = graph(
      [
        value('one', '1'),
        variable('x'),
        variable('xr', 'x'),
        variable('y'),
        value('next', '3'),
        variable('yw', 'y'),
        envelope('set', ['next', 'yw']),
        { id: 'if', kind: 'branch', x: 0, y: 0 },
        value('false', 'false', 'bool'),
      ],
      [
        data('one', 'x'),
        data('xr', 'y'),
        data('next', 'yw'),
        flow('start', 'if'),
        flow('if', 'set', 'then'),
        ref('false', 'if', 'condition'),
      ],
    );
    failure(g, /派生变量.*只读/);
  });
  it('全局变量依赖即使没有被流程读取也不允许成环', () => {
    failure(
      graph(
        [variable('x'), variable('y'), variable('xr', 'x'), variable('yr', 'y')],
        [data('xr', 'y'), data('yr', 'x')],
      ),
      /成环/,
    );
  });
  it('首次赋值后不能改变类型，失败不发布部分动作', () => {
    const g = graph(
      [
        value('one', '1'),
        variable('x'),
        value('str', 'oops', 'string'),
        variable('write', 'x'),
        envelope('set', ['str', 'write']),
        method('m'),
      ],
      [data('one', 'x'), data('str', 'write'), flow('start', 'm'), ref('x', 'm', 'n'), flow('m', 'set')],
    );
    const result = actions(g);
    expect(result).not.toHaveProperty('sequence');
    failure(g, /首次赋值/);
  });
  it('包络不能混类或循环嵌套，跨包络引用合法', () => {
    expect(validateLogicGraph(graph([value('a', '1'), method('m'), envelope('g', ['a', 'm'])])).length).toBeGreaterThan(
      0,
    );
    expect(
      validateLogicGraph(graph([envelope('a', ['b']), envelope('b', ['a'])])).some((i) => i.message.includes('循环')),
    ).toBe(true);
    expect(
      actions(graph([value('a', '1'), envelope('g', ['a']), method('m')], [ref('a', 'm', 'n'), flow('start', 'm')])).ok,
    ).toBe(true);
  });
});

describe('节点功能逻辑基准：流程、循环、转换', () => {
  it('bool 引用选择 true/false 流程并在合流后只执行一次', () => {
    const g = graph(
      [
        { id: 'if', kind: 'branch', x: 0, y: 0 },
        value('cond', 'false', 'bool'),
        value('a', '1'),
        method('yes'),
        method('no'),
        method('end'),
      ],
      [
        flow('start', 'if'),
        ref('cond', 'if', 'condition'),
        flow('if', 'yes', 'then'),
        flow('if', 'no', 'else'),
        flow('yes', 'end'),
        flow('no', 'end'),
        ref('a', 'yes', 'n'),
        ref('a', 'no', 'n'),
        ref('a', 'end', 'n'),
      ],
    );
    const result = actions(g);
    expect(result.ok && result.sequence.steps.map((s) => s.nodeId)).toEqual(['no', 'end']);
    failure({ ...g, nodes: g.nodes.map((n) => (n.id === 'cond' ? value('cond', '1') : n)) }, /bool/);
  });
  it('次数循环附着流程包络，次数可为 int 引用，0 次不执行', () => {
    const g = graph(
      [
        value('n', '3'),
        value('a', '7'),
        method('m'),
        envelope('body', ['m'], 'flow'),
        { id: 'loop', kind: 'loop', count: '1', body: 'body', x: 0, y: 0 },
      ],
      [flow('start', 'body'), ref('a', 'm', 'n'), ref('n', 'loop', 'count')],
    );
    const result = actions(g);
    expect(result.ok && result.sequence.actions.length).toBe(3);
    expect(result.ok && result.sequence.steps.map((s) => s.rounds.loop)).toEqual([0, 1, 2]);
    const zero = { ...g, nodes: g.nodes.map((n) => (n.id === 'n' ? value('n', '0') : n)) };
    expect(actions(zero)).toMatchObject({ ok: true, sequence: { actions: [] } });
  });
  it('循环也可附着带赋值的数据包络，每轮读取当前变量', () => {
    const g = graph(
      [
        value('initial', '0'),
        variable('x'),
        variable('read', 'x'),
        value('one', '1'),
        variable('write', 'x'),
        envelope('inc', ['read', 'one', 'write']),
        { id: 'loop', kind: 'loop', body: 'inc', count: '3', x: 0, y: 0 },
        method('m'),
      ],
      [
        data('initial', 'x'),
        data('read', 'one', '+'),
        data('one', 'write'),
        flow('start', 'inc'),
        flow('inc', 'm'),
        ref('x', 'm', 'n'),
      ],
    );
    expect(actions(g)).toMatchObject({ ok: true, sequence: { actions: [{ args: { n: '0x3' } }] } });
  });
  it('循环次数类型、总预算、动作预算均受限', () => {
    const g = graph(
      [
        value('a', '1'),
        method('m'),
        envelope('body', ['m'], 'flow'),
        { id: 'loop', kind: 'loop', body: 'body', count: '3', x: 0, y: 0 },
      ],
      [flow('start', 'body'), ref('a', 'm', 'n')],
    );
    expect(generateLogicActions(g, { methods, maxActions: 2 }).ok).toBe(false);
    failure({ ...g, nodes: g.nodes.map((n) => (n.kind === 'loop' ? { ...n, count: '257' } : n)) }, /循环次数/);
  });
  it('转换可以直接填写，也可附着包络作为整体类型转换', () => {
    const convert: LogicNode = {
      id: 'convert',
      kind: 'convert',
      target: 'bytes',
      value: { type: 'int', text: '258' },
      width: '2',
      endian: 'little',
      signed: false,
      x: 0,
      y: 0,
    };
    expect(previewLogicGraph(graph([convert])).get('convert')).toEqual({ kind: 'byte', bytes: new Uint8Array([2, 1]) });
    const attached = graph(
      [value('a', '1'), value('b', '2'), envelope('sum', ['a', 'b']), { ...convert, input: 'sum' }],
      [data('a', 'b', '+')],
    );
    expect(previewLogicGraph(attached).get('sum')).toEqual({ kind: 'byte', bytes: new Uint8Array([3, 0]) });
  });
  it('拒绝流程回边、重复出口和多个开始节点', () => {
    failure(graph([method('m')], [flow('start', 'm'), flow('m', 'start')]), /开始节点|成环/);
    failure(graph([method('m'), method('n')], [flow('start', 'm'), flow('start', 'n')]), /只能有一条/);
    failure(graph([{ ...start, id: 'start2' }]), /恰好有一个/);
  });
});

describe('节点逻辑边界回归', () => {
  it('赋值数据包络可作为流程包络成员，每轮先赋值再调用方法', () => {
    const g = graph(
      [
        value('initial', '0'),
        variable('x'),
        variable('read', 'x'),
        value('one', '1'),
        variable('write', 'x'),
        envelope('inc', ['read', 'one', 'write']),
        method('m'),
        envelope('body', ['inc', 'm'], 'flow'),
        { id: 'loop', kind: 'loop', count: '3', body: 'body', x: 0, y: 0 },
      ],
      [
        data('initial', 'x'),
        data('read', 'one', '+'),
        data('one', 'write'),
        flow('start', 'body'),
        flow('inc', 'm'),
        ref('x', 'm', 'n'),
      ],
    );
    expect(actions(g)).toMatchObject({
      ok: true,
      sequence: { actions: [{ args: { n: '0x1' } }, { args: { n: '0x2' } }, { args: { n: '0x3' } }] },
    });
  });
  it('不接流程的纯数据依赖环也会阻止编译', () => {
    failure(
      graph([value('a', '1'), value('b', '2')], [data('a', 'b', '+'), data('b', 'a', '*')]),
      /数据依赖不允许成环/,
    );
  });
});

describe('节点逻辑审查回归：嵌套循环、附着转换与派生缓存', () => {
  it('赋值包络再包一层后仍执行内层附着循环，并保留每轮赋值记录', () => {
    const g = graph(
      [
        value('initial', '0'),
        variable('x'),
        variable('read', 'x'),
        value('one', '1'),
        variable('write', 'x'),
        envelope('inc', ['read', 'one', 'write']),
        { id: 'loop', kind: 'loop', body: 'inc', count: '3', x: 0, y: 0 },
        envelope('outer', ['inc']),
        method('m'),
      ],
      [
        data('initial', 'x'),
        data('read', 'one', '+'),
        data('one', 'write'),
        flow('start', 'outer'),
        flow('outer', 'm'),
        ref('x', 'm', 'n'),
      ],
    );
    expect(validateLogicGraph(g)).toEqual([]);
    const result = actions(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'emit', args: { n: '0x3' } }]);
    expect(result.sequence.steps.filter((step) => step.kind === 'assign')).toMatchObject([
      { nodeId: 'inc', rounds: { loop: 0 }, inputs: [{ name: 'x', value: { kind: 'int', value: 1n } }] },
      { nodeId: 'inc', rounds: { loop: 1 }, inputs: [{ name: 'x', value: { kind: 'int', value: 2n } }] },
      { nodeId: 'inc', rounds: { loop: 2 }, inputs: [{ name: 'x', value: { kind: 'int', value: 3n } }] },
    ]);
    expect(result.sequence.steps.at(-1)?.rounds).toEqual({});
  });

  it('包络有外部运算时，从包络和附着转换节点读取均得到同一转换结果', () => {
    const g = graph(
      [
        value('prefix', 'a', 'string'),
        value('two', '2'),
        envelope('wrapped', ['two']),
        {
          id: 'convert',
          kind: 'convert',
          input: 'wrapped',
          target: 'string',
          value: { type: 'int', text: '0' },
          width: '8',
          endian: 'little',
          signed: false,
          x: 0,
          y: 0,
        },
        variable('fromEnvelope'),
        variable('fromConvert'),
      ],
      [data('prefix', 'wrapped', '+'), data('wrapped', 'fromEnvelope'), data('convert', 'fromConvert')],
    );
    expect(validateLogicGraph(g)).toEqual([]);
    expect(actions(g)).toMatchObject({ ok: true, sequence: { actions: [] } });
    const preview = previewLogicGraph(g);
    for (const id of ['wrapped', 'convert', 'fromEnvelope', 'fromConvert']) {
      expect(preview.get(id)).toEqual({ kind: 'string', value: 'a2' });
    }
  });

  it('十六层共享派生依赖不会耗尽预算，源变量赋值后整条派生链仍更新', () => {
    const nodes: LogicNode[] = [value('initial', '1'), variable('x0')];
    const edges: LogicEdge[] = [data('initial', 'x0')];
    for (let i = 1; i <= 16; i++) {
      nodes.push(variable(`left${i}`, `x${i - 1}`), variable(`right${i}`, `x${i - 1}`), variable(`x${i}`));
      edges.push(data(`left${i}`, `right${i}`, '+'), data(`right${i}`, `x${i}`));
    }
    const globals = graph(nodes, edges);
    expect(globals.nodes).toHaveLength(51);
    expect(validateLogicGraph(globals)).toEqual([]);
    expect(actions(globals)).toMatchObject({ ok: true, sequence: { actions: [] } });
    expect(previewLogicGraph(globals).get('x16')).toEqual({ kind: 'int', value: 65536n });

    const g = graph(
      [
        ...nodes,
        value('next', '2'),
        variable('write', 'x0'),
        envelope('set', ['next', 'write']),
        method('before'),
        method('after'),
      ],
      [
        ...edges,
        data('next', 'write'),
        flow('start', 'before'),
        flow('before', 'set'),
        flow('set', 'after'),
        ref('x16', 'before', 'n'),
        ref('x16', 'after', 'n'),
      ],
    );
    const result = actions(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([
      { type: 'block', id: 'emit', args: { n: '0x10000' } },
      { type: 'block', id: 'emit', args: { n: '0x20000' } },
    ]);
    expect(result.sequence.steps.find((step) => step.kind === 'assign')?.variables).toContainEqual({
      name: 'x16',
      value: { kind: 'int', value: 131072n },
    });
  });
});

describe('节点逻辑审查回归：附着循环次数依赖', () => {
  it.each([false, true])('循环所在包络再嵌套一层=%s 时，先完成外层次数赋值再执行循环', (nested) => {
    const g = graph(
      [
        value('initial', '0'),
        variable('x'),
        variable('read', 'x'),
        value('one', '1'),
        variable('write', 'x'),
        envelope('inc', ['read', 'one', 'write']),
        { id: 'loop', kind: 'loop', body: 'inc', count: '1', x: 0, y: 0 },
        ...(nested ? [envelope('middle', ['inc'])] : []),
        value('three', '3'),
        variable('count'),
        envelope('outer', [nested ? 'middle' : 'inc', 'three', 'count']),
        method('m'),
      ],
      [
        data('initial', 'x'),
        data('read', 'one', '+'),
        data('one', 'write'),
        data('three', 'count'),
        ref('count', 'loop', 'count'),
        flow('start', 'outer'),
        flow('outer', 'm'),
        ref('x', 'm', 'n'),
      ],
    );
    expect(validateLogicGraph(g)).toEqual([]);
    const result = actions(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'emit', args: { n: '0x3' } }]);
    expect(result.sequence.steps.filter((step) => step.kind === 'assign')).toMatchObject([
      { nodeId: 'outer', rounds: {}, inputs: [{ name: 'count', value: { kind: 'int', value: 3n } }] },
      { nodeId: 'inc', rounds: { loop: 0 }, inputs: [{ name: 'x', value: { kind: 'int', value: 1n } }] },
      { nodeId: 'inc', rounds: { loop: 1 }, inputs: [{ name: 'x', value: { kind: 'int', value: 2n } }] },
      { nodeId: 'inc', rounds: { loop: 2 }, inputs: [{ name: 'x', value: { kind: 'int', value: 3n } }] },
    ]);
    expect(result.sequence.steps.at(-1)?.rounds).toEqual({});
  });
});

describe('string/bytes repetition connections', () => {
  it.each([
    ['string', 'ab🙂', { kind: 'string', value: 'ab🙂ab🙂ab🙂' }],
    ['bytes', '00ff', { kind: 'byte', bytes: new Uint8Array([0, 255, 0, 255, 0, 255]) }],
  ] as const)('repeats a %s fragment through a * edge and an envelope', (type, text, expected) => {
    const g = graph([value('fragment', text, type), value('count', '3'), envelope('result', ['fragment', 'count'])],
      [data('fragment', 'count', '*')]);
    expect(validateLogicGraph(g)).toEqual([]);
    expect(previewLogicGraph(g).get('result')).toEqual(expected);
  });
  it.each(['string', 'bytes'] as const)('accepts zero and huge counts for empty %s fragments', (type) => {
    for (const [text, count] of [['ab', '0'], ['', '1000000000000000000']] as const) {
      const g = graph([value('fragment', text, type), value('count', count)], [data('fragment', 'count', '*')]);
      expect(previewLogicGraph(g).get('count')).toEqual(type === 'string'
        ? { kind: 'string', value: '' } : { kind: 'byte', bytes: new Uint8Array() });
    }
  });
  it.each(['string', 'bytes'] as const)('reports invalid counts and oversized %s results on the connection', (type) => {
    for (const [count, countType, message] of [
      ['-1', 'int', /重复次数不能为负/],
      ['1.5', 'double', /重复次数需要整数/],
      ['3', 'string', /重复次数需要整数/],
      ['1000000000000000000', 'int', /超过上限/],
    ] as const) {
      const g = graph([value('fragment', 'ab', type), value('count', count, countType)], [data('fragment', 'count', '*')]);
      expect(previewLogicGraph(g).get('count')).toMatch(message);
    }
  });
});

it('compiles repeated bytes from a nested envelope into method arguments', () => {
  const g = graph([
    value('fragment', '00ff', 'bytes'), value('count', '3'),
    envelope('inner', ['fragment', 'count']), envelope('outer', ['inner']), method('send'),
  ], [data('fragment', 'count', '*'), ref('outer', 'send', 'payload'), flow('start', 'send')]);
  const options = { methods: [{ id: 'emit', label: 'emit', params: [{ name: 'payload', type: 'bytes' as const }], actionCount: 1 }] };
  expect(generateLogicActions(g, options)).toMatchObject({ ok: true, sequence: {
    actions: [{ type: 'block', id: 'emit', args: { payload: '00ff00ff00ff' } }],
  } });
  const invalid = { ...g, nodes: g.nodes.map((n) => n.id === 'count' ? value('count', '-1') : n) };
  expect(generateLogicActions(invalid, options)).toMatchObject({ ok: false, issues: [
    { nodeId: 'fragment-count', message: expect.stringMatching(/重复次数不能为负/) },
  ] });
});
