import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_FLOW_DEPTH, CANVAS_MAX_FLOW_NODES } from '../limits';
import {
  CANVAS_FORMAT,
  CANVAS_VERSION,
  type AssignNode,
  type CanvasDocument,
  type CanvasNode,
  type IfNode,
  type LoopIndexNode,
  type LoopNode,
  type MethodNode,
  type StartNode,
  type ValueNode,
} from './document';
import { analyzeFlow, flowNodeIdsOf, isInsideLoop, type FlowRegionRef } from './flow';
import type { CanvasMethodDecl } from './methods';

/**
 * 流程结构与作用域分析的契约测试（需求 §5、§11 AT-08 / AT-09）。
 *
 * 断言精确到「问题代码 + 定位节点」与关键中文文案：区域归属、深度与作用域同时被生成器和界面
 * 读取，模糊断言会让语义改动悄悄溜过去。构造一律走 `docOf(nodes, main)`，不经过 Schema。
 */

function docOf(nodes: readonly CanvasNode[], main: readonly string[] = []): CanvasDocument {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main };
}

function startNode(id: string): StartNode {
  return { id, kind: 'start' };
}
function intNode(id: string, value: number): ValueNode {
  return { id, kind: 'value', value: { kind: 'int', value: String(value) } };
}
function textNode(id: string, text: string): ValueNode {
  return { id, kind: 'value', value: { kind: 'string', value: text } };
}
function byteNode(id: string, hex: string): ValueNode {
  return { id, kind: 'value', value: { kind: 'byte', hex } };
}
function boolNode(id: string): ValueNode {
  return { id, kind: 'value', value: { kind: 'bool', value: true } };
}
function loopNode(id: string, count: string, body: readonly string[]): LoopNode {
  return { id, kind: 'loop', count, body };
}
function assignNode(id: string, target: string, value: string): AssignNode {
  return { id, kind: 'assign', target, value };
}
function loopIndexNode(id: string, loop: string): LoopIndexNode {
  return { id, kind: 'loop-index', loop };
}
function ifNode(id: string, cond: string, then: readonly string[], otherwise: readonly string[]): IfNode {
  return { id, kind: 'if', cond, then, else: otherwise };
}
function methodNode(id: string, block: string, args: Readonly<Record<string, string>>): MethodNode {
  return { id, kind: 'method', block, args };
}

const MAIN: FlowRegionRef = { ownerId: '', kind: 'main' };

/** 问题清单压成 `代码@节点`：测试按代码与定位精确断言，不比较文案就足以定位。 */
function issueKeysOf(document: CanvasDocument, methods?: readonly CanvasMethodDecl[]): readonly string[] {
  return analyzeFlow(document, { methods }).issues.map((issue) => `${issue.code}@${issue.nodeId}`);
}

function messagesOf(document: CanvasDocument, methods?: readonly CanvasMethodDecl[]): readonly string[] {
  return analyzeFlow(document, { methods }).issues.map((issue) => issue.message);
}

/** 合法流程：开始 → 赋值 → 分支（两区域各一条）→ 循环（体内两条，其中一条用循环索引）。 */
function legalFlow(): CanvasDocument {
  return docOf(
    [
      startNode('start'), intNode('v_one', 1), intNode('v_three', 3), boolNode('v_true'),
      assignNode('set_x', 'var_x', 'v_one'),
      ifNode('guard', 'v_true', ['set_then'], ['set_else']),
      assignNode('set_then', 'var_x', 'v_one'), assignNode('set_else', 'var_x', 'v_one'),
      loopNode('loop', 'v_three', ['set_idx', 'set_y']),
      loopIndexNode('idx', 'loop'),
      assignNode('set_idx', 'var_x', 'idx'), assignNode('set_y', 'var_y', 'v_one'),
    ],
    ['start', 'set_x', 'guard', 'loop'],
  );
}

/** 方法节点的公共脚手架：字节串、整数、文本各一个字面值，方法节点接在开始之后。 */
function methodFlow(block: string, args: Readonly<Record<string, string>>): CanvasDocument {
  return docOf(
    [byteNode('v_bytes', '41'), intNode('v_one', 1), textNode('v_text', 'x'), startNode('s'), methodNode('m', block, args)],
    ['s', 'm'],
  );
}

const METHODS: readonly CanvasMethodDecl[] = [
  {
    id: 'write_mem',
    label: '写内存',
    params: [
      { name: 'hex', type: 'bytes' },
      { name: 'n', type: 'int' },
    ],
    actionCount: 2,
  },
];

/** 嵌套 `levels` 层分支：`if_{levels-1}` 在 main 上，`if_0` 最深。 */
function nestedFlow(levels: number): CanvasDocument {
  const nodes: CanvasNode[] = [intNode('v_cond', 1), startNode('s')];
  const ids: string[] = [];
  for (let level = 0; level < levels; level += 1) {
    nodes.push(ifNode(`if_${level}`, 'v_cond', level === 0 ? [] : [ids[level - 1]], []));
    ids.push(`if_${level}`);
  }
  return docOf(nodes, ['s', ids[levels - 1]]);
}

/** 一条 main 上挂 `count` 条赋值：用来撞流程节点总数上限。 */
function wideFlow(count: number): CanvasDocument {
  const assigns = Array.from({ length: count }, (_, index) => assignNode(`set_${index}`, 'var_x', 'v_one'));
  return docOf([intNode('v_one', 1), startNode('s'), ...assigns], ['s', ...assigns.map((node) => node.id)]);
}

describe('合法流程', () => {
  it('记录开始节点、每条序列的归属与嵌套深度，且没有问题', () => {
    const layout = analyzeFlow(legalFlow());
    expect(layout.issues).toEqual([]);
    expect(layout.start).toEqual(startNode('start'));
    expect(layout.main).toEqual(['start', 'set_x', 'guard', 'loop']);
    expect(layout.regionOf).toEqual(
      new Map<string, FlowRegionRef>([
        ['start', MAIN], ['set_x', MAIN], ['guard', MAIN], ['loop', MAIN],
        ['set_then', { ownerId: 'guard', kind: 'then' }],
        ['set_else', { ownerId: 'guard', kind: 'else' }],
        ['set_idx', { ownerId: 'loop', kind: 'body' }],
        ['set_y', { ownerId: 'loop', kind: 'body' }],
      ]),
    );
    expect(layout.depthOf).toEqual(
      new Map([
        ['start', 0], ['set_x', 0], ['guard', 0], ['loop', 0],
        ['set_then', 1], ['set_else', 1], ['set_idx', 1], ['set_y', 1],
      ]),
    );
  });

  it('isInsideLoop 沿容器链向上判断，循环自己不在自己的循环体里', () => {
    const layout = analyzeFlow(legalFlow());
    expect(isInsideLoop(layout, 'set_idx', 'loop')).toBe(true);
    expect(isInsideLoop(layout, 'set_y', 'loop')).toBe(true);
    expect(isInsideLoop(layout, 'set_x', 'loop')).toBe(false);
    expect(isInsideLoop(layout, 'set_then', 'loop')).toBe(false);
    expect(isInsideLoop(layout, 'loop', 'loop')).toBe(false);
  });
});

describe('开始节点', () => {
  it('没有任何开始节点、main 里放了流程时报缺开始节点', () => {
    const document = docOf([intNode('v_one', 1), assignNode('set_x', 'var_x', 'v_one')], ['set_x']);
    expect(issueKeysOf(document)).toEqual(['flow_error@']);
    expect(messagesOf(document)).toEqual(['工作流缺少开始节点']);
  });

  it('两个开始节点时每个多余的都报错', () => {
    const document = docOf([startNode('s1'), startNode('s2')], ['s1', 's2']);
    expect(issueKeysOf(document)).toEqual(['flow_error@s2']);
    expect(messagesOf(document)).toEqual(['工作流只能有一个开始节点，「s2」是多余的']);
  });

  it('开始节点不是 main 第一步时报错', () => {
    const document = docOf(
      [startNode('s'), intNode('v_one', 1), assignNode('set_x', 'var_x', 'v_one')],
      ['set_x', 's'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@s']);
    expect(messagesOf(document)).toEqual(['开始节点必须是流程的第一步']);
  });

  it('纯数据文档（main 为空、没有流程节点）不报缺开始节点', () => {
    const document = docOf([intNode('v_one', 1), textNode('v_text', 'x')], []);
    expect(issueKeysOf(document)).toEqual([]);
  });

  it('main 为空时把孤立开始节点报成「没有接进流程」', () => {
    const document = docOf([startNode('s')], []);
    expect(issueKeysOf(document)).toEqual(['flow_error@s']);
    expect(messagesOf(document)).toEqual(['流程节点 s 没有接进流程']);
  });
});

describe('序列成员', () => {
  it('数据节点塞进 main 时定位到第一个坏成员', () => {
    const document = docOf([startNode('s'), textNode('v_text', 'hi')], ['s', 'v_text']);
    expect(issueKeysOf(document)).toEqual(['flow_error@v_text']);
    expect(messagesOf(document)).toEqual(['「v_text」是数据节点，不能放进流程序列']);
  });

  it('引用不存在的节点', () => {
    const document = docOf([startNode('s')], ['s', 'ghost']);
    expect(issueKeysOf(document)).toEqual(['flow_error@ghost']);
    expect(messagesOf(document)).toEqual(['流程序列引用了不存在的节点 ghost']);
  });

  it('同一节点出现在两条序列里', () => {
    const document = docOf(
      [
        startNode('s'), boolNode('v_true'), ifNode('br', 'v_true', ['a'], ['a']),
        intNode('v_one', 1), assignNode('a', 'var_x', 'v_one'),
      ],
      ['s', 'br'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@a']);
    expect(messagesOf(document)).toEqual([
      '流程节点「a」已经在「br」的成立分支里，一个流程节点只能出现在一条序列里',
    ]);
  });

  it('同一序列内出现两次也算重复', () => {
    const document = docOf(
      [startNode('s'), intNode('v_one', 1), assignNode('a', 'var_x', 'v_one')],
      ['s', 'a', 'a'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@a']);
    expect(messagesOf(document)).toEqual([
      '流程节点「a」已经在顶层序列里，一个流程节点只能出现在一条序列里',
    ]);
  });

  it('孤儿流程节点报错', () => {
    const document = docOf(
      [startNode('s'), intNode('v_one', 1), assignNode('lost', 'var_x', 'v_one')],
      ['s'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@lost']);
    expect(messagesOf(document)).toEqual(['流程节点 lost 没有接进流程']);
  });
});

describe('循环索引', () => {
  it('指向不存在的循环时只报索引节点', () => {
    const document = docOf(
      [startNode('s'), loopIndexNode('idx', 'ghost'), assignNode('use', 'var_x', 'idx')],
      ['s', 'use'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@idx']);
    expect(messagesOf(document)).toEqual(['循环索引必须指向一个次数循环']);
  });

  it('使用点全在循环体外时，索引节点与使用点各自报错', () => {
    const document = docOf(
      [
        startNode('s'), intNode('v_one', 1), loopNode('lp', 'v_one', []),
        loopIndexNode('idx', 'lp'), assignNode('use', 'var_x', 'idx'),
      ],
      ['s', 'lp', 'use'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@use', 'flow_error@idx']);
    expect(messagesOf(document)).toEqual([
      '循环索引只在所属循环体内可用，这条语句在循环外',
      '循环索引只在所属循环体内可用',
    ]);
  });

  it('同一索引还有一个循环体内的使用点时，只报越界的那条语句', () => {
    const document = docOf(
      [
        startNode('s'), intNode('v_one', 1), loopNode('lp', 'v_one', ['set_in']),
        loopIndexNode('idx', 'lp'),
        assignNode('set_in', 'var_x', 'idx'), assignNode('set_out', 'var_x', 'idx'),
      ],
      ['s', 'lp', 'set_out'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@set_out']);
    expect(messagesOf(document)).toEqual(['循环索引只在所属循环体内可用，这条语句在循环外']);
  });

  it('嵌套循环里的内层语句可以合法引用外层索引', () => {
    const document = docOf(
      [
        startNode('s'), intNode('v_three', 3),
        loopNode('outer', 'v_three', ['inner']), loopNode('inner', 'v_three', ['set_inner']),
        loopIndexNode('idx_outer', 'outer'), assignNode('set_inner', 'var_x', 'idx_outer'),
      ],
      ['s', 'outer'],
    );
    const layout = analyzeFlow(document);
    expect(layout.issues).toEqual([]);
    expect(layout.depthOf.get('set_inner')).toBe(2);
    expect(isInsideLoop(layout, 'set_inner', 'outer')).toBe(true);
    expect(isInsideLoop(layout, 'set_inner', 'inner')).toBe(true);
    expect(isInsideLoop(layout, 'inner', 'inner')).toBe(false);
  });

  it('没有任何使用点的索引节点不下结论', () => {
    const document = docOf(
      [startNode('s'), intNode('v_one', 1), loopNode('lp', 'v_one', []), loopIndexNode('idx', 'lp')],
      ['s', 'lp'],
    );
    expect(issueKeysOf(document)).toEqual([]);
  });
});

describe('方法节点', () => {
  it('未声明的方法报 method_mismatch；不传 methods 时不校验方法', () => {
    const document = methodFlow('feed', { hex: 'v_bytes', n: 'v_one' });
    expect(issueKeysOf(document, METHODS)).toEqual(['method_mismatch@m']);
    expect(messagesOf(document, METHODS)).toEqual(['题目没有声明方法 feed']);
    expect(issueKeysOf(document)).toEqual([]);
  });

  it('缺参、多参时各自列出参数名', () => {
    const missing = methodFlow('write_mem', { hex: 'v_bytes' });
    expect(issueKeysOf(missing, METHODS)).toEqual(['method_mismatch@m']);
    expect(messagesOf(missing, METHODS)).toEqual(['方法 write_mem 缺少参数：n']);

    const extra = methodFlow('write_mem', { hex: 'v_bytes', n: 'v_one', junk: 'v_one' });
    expect(issueKeysOf(extra, METHODS)).toEqual(['method_mismatch@m']);
    expect(messagesOf(extra, METHODS)).toEqual(['方法 write_mem 多出参数：junk']);
  });

  it('bytes 参数接文本时报类型不匹配', () => {
    const document = methodFlow('write_mem', { hex: 'v_text', n: 'v_one' });
    expect(issueKeysOf(document, METHODS)).toEqual(['type_mismatch@m']);
    expect(messagesOf(document, METHODS)).toEqual(['方法 write_mem 的参数 hex 需要字节串，收到文本']);
  });

  it('参数引用不存在的节点时报 flow_error', () => {
    const document = methodFlow('write_mem', { hex: 'ghost', n: 'v_one' });
    expect(issueKeysOf(document, METHODS)).toEqual(['flow_error@m']);
    expect(messagesOf(document, METHODS)).toEqual([
      '方法 write_mem 的参数 hex 引用了不存在的节点 ghost',
    ]);
  });

  it('参数类型正确时没有问题', () => {
    expect(issueKeysOf(methodFlow('write_mem', { hex: 'v_bytes', n: 'v_one' }), METHODS)).toEqual([]);
  });
});

describe('上限', () => {
  it('流程节点总数超限报 limit_exceeded', () => {
    const document = wideFlow(CANVAS_MAX_FLOW_NODES);
    expect(issueKeysOf(document)).toEqual(['limit_exceeded@']);
    expect(messagesOf(document)).toEqual([
      `流程节点数 ${CANVAS_MAX_FLOW_NODES + 1} 超过上限 ${CANVAS_MAX_FLOW_NODES}`,
    ]);
  });

  it('嵌套深度超限时定位到越界的容器', () => {
    const layout = analyzeFlow(nestedFlow(CANVAS_MAX_FLOW_DEPTH + 2));
    expect(layout.depthOf.get('if_0')).toBe(CANVAS_MAX_FLOW_DEPTH + 1);
    expect(layout.issues.map((issue) => `${issue.code}@${issue.nodeId}`)).toEqual([
      'limit_exceeded@if_0',
    ]);
    expect(layout.issues.map((issue) => issue.message)).toEqual([
      `流程嵌套深度 ${CANVAS_MAX_FLOW_DEPTH + 1} 超过上限 ${CANVAS_MAX_FLOW_DEPTH}`,
    ]);
  });
});

describe('重复出现的防御', () => {
  it('分支出现在自己的 then 里时返回问题而不是挂住', () => {
    const document = docOf(
      [startNode('s'), boolNode('v_true'), ifNode('br', 'v_true', ['br'], [])],
      ['s', 'br'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@br']);
  });

  it('两个分支互相包含时返回问题而不是挂住', () => {
    const document = docOf(
      [startNode('s'), boolNode('v_true'), ifNode('a', 'v_true', ['b'], []), ifNode('b', 'v_true', ['a'], [])],
      ['s', 'a'],
    );
    expect(issueKeysOf(document)).toEqual(['flow_error@a']);
  });
});

describe('flowNodeIdsOf', () => {
  it('只列流程节点，不看是否已经接进序列', () => {
    const document = docOf(
      [
        intNode('v_one', 1), startNode('s'), ifNode('br', 'v_one', [], []),
        assignNode('a', 'var_x', 'v_one'), assignNode('lost', 'var_x', 'v_one'),
      ],
      ['s', 'br', 'a'],
    );
    expect(flowNodeIdsOf(document)).toEqual(['s', 'br', 'a', 'lost']);
  });
});
