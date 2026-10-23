import { describe, expect, it } from 'vitest';
import {
  CANVAS_FORMAT,
  CANVAS_VERSION,
  inputIdsOf,
  inputRefsOf,
  type CanvasDocument,
  type CanvasNode,
  type VariableBinding,
} from '../src/canvas/document';
import { generateCanvasActions } from '../src/canvas/actions';
import { evaluateCanvasDocument } from '../src/canvas/evaluate';
import { parseCanvasDocument } from '../src/canvas/schema';
import { SubmitRequestSchema } from '../src/api';
import { canvasMethodsOf, type CanvasMethodDecl } from '../src/canvas/methods';
import { pendingValueNodes, previewCanvasDocument } from '../src/canvas/preview';
import { validateCanvasDocument } from '../src/canvas/validate';
import { decodeScalarValue } from '../src/canvas/value-codec';
import type { EncodedScalarValue } from '../src/canvas/value-codec';
import type { Value } from '../src/canvas/value';

/**
 * 阶段二的端到端行为：变量、流程、方法 → 动作序列，以及编辑期预览。
 *
 * 对应验收表（需求 §11）：
 * - AT-05 派生变量跟随源值、初始值只在本轮开头算一次；
 * - AT-06 派生只读、解绑后读取报未初始化、自引用与循环依赖；
 * - AT-07 方法参数在生成时快照，之后改变量不追溯；
 * - AT-08 循环次数只读一次、索引 0/1/2、嵌套可取外层索引；
 * - AT-09 零次跳过、负数与非整数报错、次数超上限；
 * - AT-10 嵌套表达式、不隐式混用、短路跳过的未初始化读取不报错；
 * - AT-17 多引用同一身份、重命名同步、重复声明被拦；
 * - AT-18 待执行预览、生成失败不发布部分动作。
 */

const EMIT: CanvasMethodDecl = {
  id: 'emit',
  label: 'emit(v)',
  params: [{ name: 'v', type: 'int' }],
  actionCount: 1,
};

function docOf(nodes: readonly CanvasNode[], main: readonly string[] = []): CanvasDocument {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main };
}

function intLit(id: string, value: number | bigint): CanvasNode {
  return { kind: 'value', id, value: { kind: 'int', value: String(value) } };
}

function boolLit(id: string, value: boolean): CanvasNode {
  return { kind: 'value', id, value: { kind: 'bool', value } };
}

function textLit(id: string, value: string): CanvasNode {
  return { kind: 'value', id, value: { kind: 'string', value } };
}

function relation(id: string, op: string, left: string, right: string): CanvasNode {
  return { kind: 'relation', id, op: op as never, left, right };
}

function decl(id: string, name: string, type: string, binding: VariableBinding): CanvasNode {
  return { kind: 'var-decl', id, name, type: type as never, binding };
}

function ref(id: string, declId: string): CanvasNode {
  return { kind: 'var-ref', id, decl: declId };
}

function start(id = 'start'): CanvasNode {
  return { kind: 'start', id };
}

function assign(id: string, target: string, value: string): CanvasNode {
  return { kind: 'assign', id, target, value };
}

function loop(id: string, count: string, body: readonly string[]): CanvasNode {
  return { kind: 'loop', id, count, body };
}

function branch(id: string, cond: string, then: readonly string[], otherwise: readonly string[]): CanvasNode {
  return { kind: 'if', id, cond, then, else: otherwise };
}

function call(id: string, args: Readonly<Record<string, string>>): CanvasNode {
  return { kind: 'method', id, block: 'emit', args };
}

function index(id: string, loopId: string): CanvasNode {
  return { kind: 'loop-index', id, loop: loopId };
}

function intOf(value: EncodedScalarValue): bigint {
  const decoded = decodeScalarValue(value);
  if (!decoded.ok || decoded.value.kind !== 'int') throw new Error('不是整数');
  return (decoded.value as Value & { kind: 'int' }).value;
}

describe('变量：派生与初始化（AT-05、AT-06）', () => {
  const nodes = [
    start(),
    decl('a', 'a', 'int', { mode: 'initial', input: 'two' }),
    intLit('two', 2),
    intLit('one', 1),
    decl('b', 'b', 'int', { mode: 'derived', input: 'b-expr' }),
    relation('b-expr', 'int.add', 'a-ref', 'one'),
    ref('a-ref', 'a'),
    decl('c', 'c', 'int', { mode: 'initial', input: 'c-expr' }),
    relation('c-expr', 'int.add', 'a-read', 'one'),
    ref('a-read', 'a'),
    ref('b-read', 'b'),
    ref('c-read', 'c'),
    assign('set-a', 'a', 'four'),
    intLit('four', 4),
    call('emit-b', { v: 'b-read' }),
    call('emit-c', { v: 'c-read' }),
  ];
  const main = ['start', 'set-a', 'emit-b', 'emit-c'];

  it('派生变量跟随源值，初始值只在本轮开头算一次', () => {
    const result = generateCanvasActions(docOf(nodes, main), { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const args = result.sequence.actions.map((action) =>
      action.type === 'block' ? action.args.v : undefined,
    );
    // b := a+1 读到时 a 已被赋成 4，所以是 5；c 的初始值在开头算过，保持 3。
    expect(args).toEqual(['0x5', '0x3']);
    expect(result.sequence.steps).toHaveLength(3);
    expect(result.sequence.steps[1]?.inputs[0]?.value.kind).toBe('int');
  });

  it('从同一份文档重新生成，结果完全一致（没有跨执行残留）', () => {
    const first = generateCanvasActions(docOf(nodes, main), { methods: [EMIT] });
    const second = generateCanvasActions(docOf(nodes, main), { methods: [EMIT] });
    expect(second).toEqual(first);
  });

  it('派生变量只读：流程赋值写它会被拦', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'a', 'int', { mode: 'initial', input: 'one' }),
        intLit('one', 1),
        decl('b', 'b', 'int', { mode: 'derived', input: 'a-read' }),
        ref('a-read', 'a'),
        assign('set-b', 'b', 'one'),
      ],
      ['start', 'set-b'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('派生变量'))).toBe(true);
  });

  it('解绑后不保留旧值：读取未初始化变量报错（AT-05 后半）', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'a', 'int', { mode: 'none' }),
        ref('a-read', 'a'),
        call('emit-a', { v: 'a-read' }),
      ],
      ['start', 'emit-a'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('还没初始化'))).toBe(true);
  });

  it('自引用的声明被拦', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'a', 'int', { mode: 'initial', input: 'a-expr' }),
        relation('a-expr', 'int.add', 'a-read', 'one'),
        ref('a-read', 'a'),
        intLit('one', 1),
      ],
      ['start'],
    );
    const result = validateCanvasDocument(document);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('自己'))).toBe(true);
  });

  it('两个声明互相依赖被拦，且不会死循环', () => {
    const document = docOf(
      [
        start(),
        decl('x', 'x', 'int', { mode: 'initial', input: 'y-read' }),
        ref('y-read', 'y'),
        decl('y', 'y', 'int', { mode: 'initial', input: 'x-read' }),
        ref('x-read', 'x'),
      ],
      ['start'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.code === 'variable_error')).toBe(true);
  });
});

describe('方法：参数快照（AT-07）', () => {
  it('生成时固定参数值，之后改变量不追溯修改已生成动作', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'a', 'int', { mode: 'initial', input: 'two' }),
        intLit('two', 2),
        ref('a-read', 'a'),
        call('emit-a', { v: 'a-read' }),
        assign('set-a', 'a', 'nine'),
        intLit('nine', 9),
        call('emit-again', { v: 'a-read' }),
      ],
      ['start', 'emit-a', 'set-a', 'emit-again'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.sequence.actions.map((action) =>
      action.type === 'block' ? action.args.v : undefined,
    );
    expect(args).toEqual(['0x2', '0x9']);
    expect(result.sequence.steps[0]?.inputs[0]?.value.kind).toBe('int');
  });

  it('字节参数编码成无前缀 hex，地址参数编码成 0x（需求 §5.4）', () => {
    const bytesParam: CanvasMethodDecl = {
      id: 'raw',
      label: 'raw(data)',
      params: [{ name: 'data', type: 'bytes' }],
      actionCount: 1,
    };
    const document = docOf(
      [
        start(),
        textLit('text', 'hi'),
        { kind: 'convert', id: 'bytes', spec: { kind: 'text-to-bytes', encoding: 'utf-8' }, input: 'text' },
        { kind: 'method', id: 'send', block: 'raw', args: { data: 'bytes' } },
      ],
      ['start', 'send'],
    );
    const result = generateCanvasActions(document, { methods: [bytesParam] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'raw', args: { data: '6869' } }]);
  });

  it('地址超出 64 位范围报错', () => {
    const addrParam: CanvasMethodDecl = {
      id: 'jump',
      label: 'jump(addr)',
      params: [{ name: 'addr', type: 'addr' }],
      actionCount: 1,
    };
    const document = docOf(
      [
        start(),
        { kind: 'value', id: 'huge', value: { kind: 'int', value: '340282366920938463463374607431768211456' } },
        { kind: 'method', id: 'go', block: 'jump', args: { addr: 'huge' } },
      ],
      ['start', 'go'],
    );
    const result = generateCanvasActions(document, { methods: [addrParam] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('64 位'))).toBe(true);
  });
});

describe('循环：次数、索引与嵌套（AT-08、AT-09）', () => {
  const counted = docOf(
    [
      start(),
      decl('n', 'n', 'int', { mode: 'initial', input: 'three' }),
      intLit('three', 3),
      ref('n-read', 'n'),
      loop('loop1', 'n-read', ['set-n', 'emit-index']),
      assign('set-n', 'n', 'big'),
      intLit('big', 99),
      index('idx', 'loop1'),
      call('emit-index', { v: 'idx' }),
    ],
    ['start', 'loop1'],
  );

  it('次数只读一次：循环体改变量不影响轮数，索引从 0 开始', () => {
    const result = generateCanvasActions(counted, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.sequence.actions.map((action) =>
      action.type === 'block' ? action.args.v : undefined,
    );
    expect(args).toEqual(['0x0', '0x1', '0x2']);
    expect(result.sequence.steps.map((step) => step.rounds.loop1)).toEqual([0, 0, 1, 1, 2, 2]);
    const last = result.sequence.steps.at(-1);
    expect(last?.variables.map((view) => view.name)).toEqual(['n']);
    expect(intOf({ kind: 'int', value: String(last?.variables[0]?.value.kind === 'int' ? (last.variables[0].value as { value: bigint }).value : 0) })).toBe(99n);
  });

  it('零次跳过循环体（合法）', () => {
    const document = docOf(
      [
        start(),
        intLit('zero', 0),
        loop('loop1', 'zero', ['emit']),
        call('emit', { v: 'zero' }),
      ],
      ['start', 'loop1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([]);
  });

  it('负数次数报错，不悄悄截断', () => {
    const document = docOf(
      [start(), intLit('minus', -1), loop('loop1', 'minus', [])],
      ['start', 'loop1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('不能为负'))).toBe(true);
  });

  it('非整数次数在静态校验期就被拦', () => {
    const document = docOf(
      [start(), textLit('text', '3'), loop('loop1', 'text', [])],
      ['start', 'loop1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.code === 'type_mismatch')).toBe(true);
  });

  it('次数超过单循环上限报错', () => {
    const document = docOf(
      [start(), intLit('many', 300), loop('loop1', 'many', [])],
      ['start', 'loop1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('超过单次上限'))).toBe(true);
  });

  it('步骤快照超过上限整体失败，不静默丢一半', () => {
    const assigns = Array.from({ length: 9 }, (_unused, index) => `set-${index}`);
    const nodes = [
      start(),
      decl('a', 'a', 'int', { mode: 'initial', input: 'one' }),
      intLit('one', 1),
      intLit('many', 256),
      loop('loop1', 'many', assigns),
      ...assigns.map((id) => assign(id, 'a', 'one')),
    ];
    const result = generateCanvasActions(docOf(nodes, ['start', 'loop1']), { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('步骤数超过上限'))).toBe(true);
  });

  it('嵌套循环里可以显式读外层索引', () => {
    const document = docOf(
      [
        start(),
        intLit('two', 2),
        loop('outer', 'two', ['inner']),
        loop('inner', 'two', ['emit-outer', 'emit-inner']),
        index('outer-idx', 'outer'),
        index('inner-idx', 'inner'),
        call('emit-outer', { v: 'outer-idx' }),
        call('emit-inner', { v: 'inner-idx' }),
      ],
      ['start', 'outer'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.sequence.actions.map((action) =>
      action.type === 'block' ? action.args.v : undefined,
    );
    expect(args).toEqual(['0x0', '0x0', '0x0', '0x1', '0x1', '0x0', '0x1', '0x1']);
  });

  it('索引在所属循环体之外使用被拦（结构上无法跨区域接线）', () => {
    const document = docOf(
      [
        start(),
        intLit('two', 2),
        loop('outer', 'two', []),
        index('idx', 'outer'),
        call('emit', { v: 'idx' }),
      ],
      ['start', 'outer', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('循环索引'))).toBe(true);
  });
});

describe('数据表达式与短路（AT-10）', () => {
  it('嵌套表达式按优先级求值', () => {
    const document = docOf(
      [
        start(),
        intLit('two', 2),
        intLit('three', 3),
        intLit('one', 1),
        relation('mul', 'int.mul', 'two', 'three'),
        relation('add', 'int.add', 'mul', 'one'),
        call('emit', { v: 'add' }),
      ],
      ['start', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'emit', args: { v: '0x7' } }]);
  });

  it('整数与浮点不隐式混用', () => {
    const document = docOf(
      [
        start(),
        intLit('one', 1),
        { kind: 'value', id: 'half', value: { kind: 'double', value: 1.5 } },
        relation('add', 'int.add', 'one', 'half'),
        call('emit', { v: 'add' }),
      ],
      ['start', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.code === 'type_mismatch')).toBe(true);
  });

  it('短路跳过的分支里读未初始化变量不报错', () => {
    const document = docOf(
      [
        start(),
        decl('flag', 'flag', 'bool', { mode: 'none' }),
        ref('flag-read', 'flag'),
        boolLit('no', false),
        relation('and', 'bool.and', 'no', 'flag-read'),
        branch('if1', 'and', ['emit-one'], ['emit-two']),
        intLit('one', 1),
        intLit('two', 2),
        call('emit-one', { v: 'one' }),
        call('emit-two', { v: 'two' }),
      ],
      ['start', 'if1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'emit', args: { v: '0x2' } }]);
  });
});

describe('引用视图与预览（AT-17、AT-18）', () => {
  it('多个引用视图指向同一声明，重命名只改声明', () => {
    const nodes = [
      start(),
      decl('a', 'count', 'int', { mode: 'initial', input: 'one' }),
      intLit('one', 1),
      ref('read-1', 'a'),
      ref('read-2', 'a'),
      call('emit-1', { v: 'read-1' }),
      call('emit-2', { v: 'read-2' }),
    ];
    const document = docOf(nodes, ['start', 'emit-1', 'emit-2']);
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toHaveLength(2);
    // 重命名就是把声明上的名字改掉：两个视图读的是同一个声明，名字自动同步。
    const renamed = docOf(
      nodes.map((node) => (node.kind === 'var-decl' ? { ...node, name: 'total' } : node)),
      ['start', 'emit-1', 'emit-2'],
    );
    expect(generateCanvasActions(renamed, { methods: [EMIT] }).ok).toBe(true);
  });

  it('同一声明重复出现会被拦（一个变量只有一份声明）', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'count', 'int', { mode: 'none' }),
        decl('b', 'count', 'int', { mode: 'none' }),
      ],
      ['start'],
    );
    const result = validateCanvasDocument(document);
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'variable_error')).toHaveLength(2);
  });

  it('依赖流程赋值的值显示待执行，纯数据表达式照常算', () => {
    const document = docOf(
      [
        start(),
        decl('a', 'a', 'int', { mode: 'initial', input: 'two' }),
        intLit('two', 2),
        ref('a-read', 'a'),
        decl('b', 'b', 'int', { mode: 'derived', input: 'b-expr' }),
        relation('b-expr', 'int.add', 'a-read', 'one'),
        intLit('one', 1),
        assign('set-a', 'a', 'four'),
        intLit('four', 4),
        relation('pure', 'int.add', 'two', 'one'),
      ],
      ['start', 'set-a'],
    );

    const pending = pendingValueNodes(document);
    expect(pending.has('a-read')).toBe(true);
    expect(pending.has('b-read')).toBe(false);
    expect(pending.has('pure')).toBe(false);

    const preview = previewCanvasDocument(document);
    expect(preview.nodes.get('a-read')?.status).toBe('pending');
    expect(preview.nodes.get('pure')).toEqual({ status: 'value', value: { kind: 'int', value: 3n } });
  });

  it('生成失败时不发布任何动作（AT-18）', () => {
    const document = docOf(
      [
        start(),
        intLit('minus', -1),
        loop('loop1', 'minus', ['emit']),
        call('emit', { v: 'minus' }),
      ],
      ['start', 'loop1'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    expect('sequence' in result).toBe(false);
  });
});

describe('方法目录（需求 §5.4）', () => {
  it('从题目声明转成画布方法目录', () => {
    const methods = canvasMethodsOf({
      authorBlocks: [
        {
          id: 'gets',
          label: 'gets(buf)',
          params: [{ name: 'data', type: 'bytes' }],
          expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
        },
      ],
    });
    expect(methods).toEqual([
      { id: 'gets', label: 'gets(buf)', params: [{ name: 'data', type: 'bytes' }], actionCount: 1 },
    ]);
  });

  it('生成的动作用服务端同一个展开器能展开（提交前口径一致）', () => {
    const document = docOf(
      [
        start(),
        textLit('text', 'A'),
        { kind: 'convert', id: 'bytes', spec: { kind: 'text-to-bytes', encoding: 'utf-8' }, input: 'text' },
        { kind: 'method', id: 'send', block: 'gets', args: { data: 'bytes' } },
      ],
      ['start', 'send'],
    );
    const result = generateCanvasActions(document, {
      challenge: {
        authorBlocks: [
          {
            id: 'gets',
            label: 'gets(buf)',
            params: [{ name: 'data', type: 'bytes' }],
            expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([
      { type: 'block', id: 'gets', args: { data: '41' } },
    ]);
  });

  it('生成的动作能通过提交请求的 Schema 校验', () => {
    const document = docOf(
      [
        start(),
        intLit('one', 1),
        call('emit', { v: 'one' }),
      ],
      ['start', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = SubmitRequestSchema.safeParse({ actions: result.sequence.actions });
    expect(parsed.success).toBe(true);
  });
});

describe('未接线（编辑中的正常状态）', () => {
  it('存档形状接受空串，校验报 unconnected 并点明端口', () => {
    const raw = {
      format: 'pwn2block.canvas',
      version: 2,
      nodes: [
        { kind: 'relation', id: 'add', op: 'int.add', left: '', right: '' },
      ],
      layout: {},
      main: [],
    };
    const parsed = parseCanvasDocument(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = validateCanvasDocument(parsed.document);
    expect(result.ok).toBe(false);
    const messages = result.issues.map((issue) => issue.message);
    expect(result.issues.every((issue) => issue.code === 'unconnected')).toBe(true);
    expect(messages).toContain('「运算」的「左」还没接线');
    expect(messages).toContain('「运算」的「右」还没接线');
  });

  it('求值遇到未接线回「还没接线」，不是「未知节点」', () => {
    const document = docOf([{ kind: 'relation', id: 'add', op: 'int.add', left: '', right: '' }]);
    const result = evaluateCanvasDocument(document);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('unconnected');
    expect(result.issues[0]?.message).toContain('「左」还没接线');
  });

  it('生成动作被未接线挡住，且不产出动作', () => {
    const document = docOf(
      [start(), { kind: 'relation', id: 'add', op: 'int.add', left: '', right: 'one' }, intLit('one', 1), call('emit', { v: 'add' })],
      ['start', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.code === 'unconnected')).toBe(true);
  });

  it('接上线之后同一个节点就合法了', () => {
    const document = docOf(
      [
        start(),
        intLit('one', 1),
        intLit('two', 2),
        { kind: 'relation', id: 'add', op: 'int.add', left: 'one', right: 'two' },
        call('emit', { v: 'add' }),
      ],
      ['start', 'emit'],
    );
    const result = generateCanvasActions(document, { methods: [EMIT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.actions).toEqual([{ type: 'block', id: 'emit', args: { v: '0x3' } }]);
  });

  it('inputIdsOf 跳过未接线，引用计数不把它当作引用', () => {
    const node = { kind: 'relation', id: 'add', op: 'int.add', left: '', right: 'two' } as CanvasNode;
    expect(inputIdsOf(node)).toEqual(['two']);
    expect(inputRefsOf(node).map((ref) => [ref.name, ref.id, ref.required])).toEqual([
      ['left', undefined, true],
      ['right', 'two', true],
    ]);
  });
});
