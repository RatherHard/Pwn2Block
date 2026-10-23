import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_VARIABLES, CANVAS_MAX_VAR_NAME_CHARS } from '../limits';
import {
  CANVAS_FORMAT,
  CANVAS_VERSION,
  type AssignNode,
  type CanvasDocument,
  type CanvasNode,
  type RelationNode,
  type ValueNode,
  type VarDeclNode,
  type VarRefNode,
  type VariableBinding,
} from './document';
import type { CanvasIssue } from './issues';
import type { ValueKind } from './value';
import {
  assignedVariables,
  checkAssignTargets,
  checkVariableDeclarations,
  declarationDependencies,
  declaredTypeOf,
  initializationOrder,
  resolveVariable,
  variableNameOf,
  variableTableOf,
  type VariableTable,
} from './variables';

/**
 * 全局变量表、初始化顺序与赋值目标的契约测试（需求 §3.1–3.2、§11 AT-05 / AT-06）。
 * 断言到具体节点 id、具体顺序和具体文案：顺序错了不会报错、只会悄悄算错。
 */

function docOf(nodes: readonly CanvasNode[]): CanvasDocument {
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main: [] };
}

function tableOf(nodes: readonly CanvasNode[]): VariableTable {
  return variableTableOf(docOf(nodes));
}

function orderOf(nodes: readonly CanvasNode[]): ReturnType<typeof initializationOrder> {
  const document = docOf(nodes);
  return initializationOrder(document, variableTableOf(document));
}

function declIssuesOf(nodes: readonly CanvasNode[]): readonly CanvasIssue[] {
  return checkVariableDeclarations(tableOf(nodes));
}

function assignIssuesOf(nodes: readonly CanvasNode[]): readonly CanvasIssue[] {
  const document = docOf(nodes);
  return checkAssignTargets(document, variableTableOf(document));
}

function assignedOf(nodes: readonly CanvasNode[]): readonly string[] {
  const document = docOf(nodes);
  return [...assignedVariables(document, variableTableOf(document))];
}

function intNode(id: string, value: number): ValueNode {
  return { id, kind: 'value', value: { kind: 'int', value: String(value) } };
}

function declOf(id: string, name: string, type: ValueKind, binding: VariableBinding = { mode: 'none' }): VarDeclNode {
  return { id, kind: 'var-decl', name, type, binding };
}

function refOf(id: string, decl: string): VarRefNode {
  return { id, kind: 'var-ref', decl };
}

function sumOf(id: string, left: string, right: string): RelationNode {
  return { id, kind: 'relation', op: 'int.add', left, right };
}

function assignOf(id: string, target: string, value: string): AssignNode {
  return { id, kind: 'assign', target, value };
}

const initial = (input: string): VariableBinding => ({ mode: 'initial', input });
const derived = (input: string): VariableBinding => ({ mode: 'derived', input });

function namesOf(order: readonly VarDeclNode[]): readonly string[] {
  return order.map((decl) => decl.name);
}

function messagesOf(issues: readonly CanvasIssue[]): readonly string[] {
  return issues.map((issue) => issue.message);
}

function nodeIdsOf(issues: readonly CanvasIssue[]): readonly string[] {
  return issues.map((issue) => issue.nodeId);
}

/** 一批互不相干的声明，用来压上限。 */
function manyDecls(count: number): readonly VarDeclNode[] {
  return Array.from({ length: count }, (_unused, index) => declOf(`d${index}`, `v${index}`, 'int'));
}

/** `a` 初值 1、`b := a + 1`、`c` 初值引用 `b`：AT-05 的骨架。 */
function at05Nodes(): readonly CanvasNode[] {
  return [
    declOf('d_a', 'a', 'int', initial('v1')),
    intNode('v1', 1),
    declOf('d_b', 'b', 'int', derived('rel_b')),
    sumOf('rel_b', 'view_a', 'v1b'),
    intNode('v1b', 1),
    refOf('view_a', 'd_a'),
    declOf('d_c', 'c', 'int', initial('view_b')),
    refOf('view_b', 'd_b'),
  ];
}

describe('变量表', () => {
  it('声明按文档顺序，名字按去空白形式索引；引用视图跟随声明名字，其他节点回退 id', () => {
    const a = declOf('d1', 'a', 'int', initial('v1'));
    const b = declOf('d2', ' a ', 'byte');
    const view = refOf('r1', 'd1');
    const chained = refOf('r2', 'r1');
    const table = tableOf([a, intNode('v1', 1), b, view, chained]);
    expect(table.declarations.map((decl) => decl.id)).toEqual(['d1', 'd2']);
    expect(table.byId.get('d1')).toBe(a);
    expect(table.byName.size).toBe(1);
    expect(table.byName.get('a')).toBe(a);
    expect([...table.refs.keys()]).toEqual(['r1', 'r2']);
    expect(table.refs.get('r1')).toBe(view);
    expect(variableNameOf(table, 'd1')).toBe('a');
    expect(variableNameOf(table, 'r1')).toBe('a');
    expect(variableNameOf(table, 'v1')).toBe('v1');
    expect(variableNameOf(table, '缺少的节点')).toBe('缺少的节点');
    expect(resolveVariable(table, 'd1')).toBe(a);
    expect(resolveVariable(table, 'r1')).toBe(a);
    expect(resolveVariable(table, 'r2')).toBeUndefined();
    expect(resolveVariable(table, 'v1')).toBeUndefined();
  });
});

describe('声明层校验', () => {
  it('合法声明与合法引用视图全部通过，名字长度到上限也通过', () => {
    const atLimit = declOf('d_limit', 'n'.repeat(CANVAS_MAX_VAR_NAME_CHARS), 'int');
    const nodes: readonly CanvasNode[] = [
      declOf('d_a', 'a', 'int', initial('v1')),
      declOf('d_b', 'b', 'byte'),
      atLimit,
      intNode('v1', 1),
      refOf('view_a', 'd_a'),
      refOf('view_limit', 'd_limit'),
    ];
    expect(declIssuesOf(nodes)).toEqual([]);
  });

  it('重名时两条都报，文案含名字；两侧空白不算新名字', () => {
    const issues = declIssuesOf([declOf('d1', 'dup', 'int'), declOf('d2', ' dup ', 'string'), declOf('d3', 'x', 'int')]);
    expect(nodeIdsOf(issues)).toEqual(['d1', 'd2']);
    expect(issues.every((issue) => issue.code === 'variable_error')).toBe(true);
    expect(issues[0].message).toContain('「dup」');
    expect(issues[0].message).toContain('重复');
    expect(issues[1].message).toBe(issues[0].message);
  });

  it('空名与超长各自报错', () => {
    const blank = declIssuesOf([declOf('d1', '   ', 'int'), declOf('d2', '  ', 'int')]);
    expect(nodeIdsOf(blank)).toEqual(['d1', 'd2']);
    expect(blank.every((issue) => issue.message === '变量名不能为空')).toBe(true);
    const long = declIssuesOf([declOf('d3', 'm'.repeat(CANVAS_MAX_VAR_NAME_CHARS + 1), 'int')]);
    expect(long).toHaveLength(1);
    expect(long[0].nodeId).toBe('d3');
    expect(long[0].message).toContain(String(CANVAS_MAX_VAR_NAME_CHARS + 1));
    expect(long[0].message).toContain(String(CANVAS_MAX_VAR_NAME_CHARS));
  });

  it('声明数超上限报一条、定位到第一条超限声明；恰好上限通过', () => {
    expect(declIssuesOf(manyDecls(CANVAS_MAX_VARIABLES))).toEqual([]);
    const issues = declIssuesOf(manyDecls(CANVAS_MAX_VARIABLES + 1));
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe(`d${CANVAS_MAX_VARIABLES}`);
    expect(issues[0].message).toContain(String(CANVAS_MAX_VARIABLES + 1));
    expect(issues[0].message).toContain(String(CANVAS_MAX_VARIABLES));
  });

  it('引用视图指向 var-ref、数据节点或不存在的节点都报错', () => {
    const cases: readonly { readonly nodes: readonly CanvasNode[]; readonly nodeId: string; readonly target: string }[] = [
      { nodes: [declOf('d1', 'a', 'int'), refOf('r1', 'd1'), refOf('r2', 'r1')], nodeId: 'r2', target: 'r1' },
      { nodes: [intNode('v1', 1), refOf('r1', 'v1')], nodeId: 'r1', target: 'v1' },
      { nodes: [refOf('r1', 'ghost')], nodeId: 'r1', target: 'ghost' },
    ];
    for (const item of cases) {
      const issues = declIssuesOf(item.nodes);
      expect(issues).toHaveLength(1);
      expect(issues[0].nodeId).toBe(item.nodeId);
      expect(issues[0].message).toContain('不是变量声明');
      expect(issues[0].message).toContain(item.target);
    }
  });

  it('引用视图不能指向自己', () => {
    expect(messagesOf(declIssuesOf([refOf('r1', 'r1')]))).toEqual(['变量引用「r1」指向自己；引用必须指向变量声明']);
  });
});

describe('依赖收集', () => {
  it('绑定表达式直接读的变量就是依赖', () => {
    const document = docOf(at05Nodes());
    const table = variableTableOf(document);
    expect(declarationDependencies(document, table, 'd_b')).toEqual(['d_a']);
    expect(declarationDependencies(document, table, 'd_c')).toEqual(['d_b']);
  });

  it('沿表达式内部做传递闭包，同一变量出现两次只算一条', () => {
    const document = docOf([
      declOf('d_x', 'x', 'int', derived('rel_outer')),
      declOf('d_a', 'a', 'int'),
      declOf('d_b', 'b', 'int'),
      sumOf('rel_outer', 'view_a', 'rel_inner'),
      sumOf('rel_inner', 'view_b', 'view_a2'),
      refOf('view_a', 'd_a'),
      refOf('view_a2', 'd_a'),
      refOf('view_b', 'd_b'),
    ]);
    expect(declarationDependencies(document, variableTableOf(document), 'd_x')).toEqual(['d_a', 'd_b']);
  });

  it('自引用被剔除；没有绑定、指向不存在的节点或未知声明都返回空', () => {
    const document = docOf([
      declOf('d_self', 's', 'int', initial('view_s')),
      refOf('view_s', 'd_self'),
      declOf('d_none', 'n', 'int'),
      declOf('d_bad', 'b', 'int', initial('ghost')),
    ]);
    const table = variableTableOf(document);
    expect(declarationDependencies(document, table, 'd_self')).toEqual([]);
    expect(declarationDependencies(document, table, 'd_none')).toEqual([]);
    expect(declarationDependencies(document, table, 'd_bad')).toEqual([]);
    expect(declarationDependencies(document, table, '缺少的声明')).toEqual([]);
  });

  it('数据引用成环时只停下、不死循环', () => {
    const document = docOf([
      declOf('d_x', 'x', 'int', derived('rel_1')),
      declOf('d_a', 'a', 'int'),
      sumOf('rel_1', 'rel_2', 'v1'),
      sumOf('rel_2', 'rel_1', 'view_a'),
      refOf('view_a', 'd_a'),
      intNode('v1', 1),
    ]);
    expect(declarationDependencies(document, variableTableOf(document), 'd_x')).toEqual(['d_a']);
  });
});

describe('初始化顺序', () => {
  it('AT-05：a 初值 1、b := a + 1、c 初值引用 b，顺序是 a、b、c', () => {
    const result = orderOf(at05Nodes());
    expect(namesOf(result.order)).toEqual(['a', 'b', 'c']);
    expect(result.issues).toEqual([]);
  });

  it('无依赖时按文档顺序；有依赖时依赖压过文档顺序', () => {
    const free = orderOf([
      declOf('d_c', 'c', 'int', initial('v1')),
      declOf('d_a', 'a', 'int', initial('v1')),
      declOf('d_b', 'b', 'int', initial('v1')),
      intNode('v1', 1),
    ]);
    expect(namesOf(free.order)).toEqual(['c', 'a', 'b']);
    const dependent = orderOf([
      declOf('d_b', 'b', 'int', derived('rel_b')),
      declOf('d_a', 'a', 'int', initial('v1')),
      sumOf('rel_b', 'view_a', 'one'),
      refOf('view_a', 'd_a'),
      intNode('v1', 1),
      intNode('one', 1),
    ]);
    expect(namesOf(dependent.order)).toEqual(['a', 'b']);
    expect([...free.issues, ...dependent.issues]).toEqual([]);
  });

  it('未初始化的声明不参与排序，按文档顺序排在最后', () => {
    const result = orderOf([
      declOf('d_u', 'u', 'int'),
      declOf('d_b', 'b', 'int', derived('rel_b')),
      declOf('d_v', 'v', 'int'),
      declOf('d_a', 'a', 'int', initial('v1')),
      sumOf('rel_b', 'view_a', 'one'),
      refOf('view_a', 'd_a'),
      intNode('v1', 1),
      intNode('one', 1),
    ]);
    expect(namesOf(result.order)).toEqual(['a', 'b', 'u', 'v']);
    expect(result.issues).toEqual([]);
  });

  it('自引用报错并点明变量名，顺序仍然排得出来', () => {
    const result = orderOf([
      declOf('d_a', 'a', 'int', initial('rel_a')),
      sumOf('rel_a', 'view_a', 'v1'),
      refOf('view_a', 'd_a'),
      intNode('v1', 1),
    ]);
    expect(namesOf(result.order)).toEqual(['a']);
    expect(messagesOf(result.issues)).toEqual(['变量 a 的初始值引用了自己']);
    expect(result.issues[0].nodeId).toBe('d_a');
  });

  it('两节点环报错并点名环上的名字；环外先排好，环上剩余按文档顺序追加', () => {
    const result = orderOf([
      declOf('d_a', 'a', 'int', initial('view_b')),
      declOf('d_b', 'b', 'int', initial('view_a')),
      declOf('d_z', 'z', 'int', derived('view_b')),
      declOf('d_d', 'd', 'int', initial('v1')),
      refOf('view_a', 'd_a'),
      refOf('view_b', 'd_b'),
      intNode('v1', 1),
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('variable_error');
    expect(result.issues[0].nodeId).toBe('d_a');
    expect(result.issues[0].message).toBe('变量 a 与 b 互相依赖，无法确定初始化顺序');
    expect(namesOf(result.order)).toEqual(['d', 'a', 'b', 'z']);
  });

  it('三节点环报错且不死循环，名字按文档顺序都写进文案', () => {
    const result = orderOf([
      declOf('d_a', 'a', 'int', initial('view_c')),
      declOf('d_b', 'b', 'int', initial('view_a')),
      declOf('d_c', 'c', 'int', initial('view_b')),
      refOf('view_a', 'd_a'),
      refOf('view_b', 'd_b'),
      refOf('view_c', 'd_c'),
    ]);
    expect(messagesOf(result.issues)).toEqual(['变量 a 与 b 与 c 互相依赖，无法确定初始化顺序']);
    expect(namesOf(result.order)).toEqual(['a', 'b', 'c']);
  });
});

describe('被赋值集合与赋值目标', () => {
  /** 普通变量 `a`、派生变量 `b`、数据节点 `v1`，以及两个引用视图。 */
  function assignNodes(assigns: readonly AssignNode[]): readonly CanvasNode[] {
    return [
      declOf('d_a', 'a', 'int', initial('v1')),
      declOf('d_b', 'b', 'int', derived('rel_b')),
      sumOf('rel_b', 'view_a', 'one'),
      intNode('v1', 1),
      intNode('one', 1),
      refOf('view_a', 'd_a'),
      refOf('view_b', 'd_b'),
      ...assigns,
    ];
  }

  it('写普通变量与 var-ref 目标通过，集合记声明 id 且只记一次', () => {
    const nodes = assignNodes([assignOf('as_1', 'view_a', 'v1'), assignOf('as_2', 'd_a', 'v1')]);
    expect(assignIssuesOf(nodes)).toEqual([]);
    expect(assignedOf(nodes)).toEqual(['d_a']);
  });

  it('写派生变量报错，直接目标与引用视图目标都点明变量名', () => {
    expect(messagesOf(assignIssuesOf(assignNodes([assignOf('as_1', 'd_b', 'v1')])))).toEqual([
      '派生变量 b 只读，不能由流程赋值覆盖；先解除绑定',
    ]);
    const viaView = assignNodes([assignOf('as_1', 'view_b', 'v1')]);
    expect(messagesOf(assignIssuesOf(viaView))).toEqual(['派生变量 b 只读，不能由流程赋值覆盖；先解除绑定']);
    expect(nodeIdsOf(assignIssuesOf(viaView))).toEqual(['as_1']);
  });

  it('目标指向数据节点或不存在的节点都报错，且不记入被赋值集合', () => {
    const dataTarget = assignNodes([assignOf('as_1', 'v1', 'v1')]);
    expect(messagesOf(assignIssuesOf(dataTarget))).toEqual(['设置变量的目标「v1」不是变量']);
    expect(assignedOf(dataTarget)).toEqual([]);
    const missingTarget = assignNodes([assignOf('as_2', 'ghost', 'v1')]);
    expect(messagesOf(assignIssuesOf(missingTarget))).toEqual(['设置变量的目标「ghost」不是变量']);
    expect(assignedOf(missingTarget)).toEqual([]);
  });
});

describe('声明类型', () => {
  it('int / byte / string 的声明与引用视图都返回声明类型，其他节点是 undefined', () => {
    const table = tableOf([
      declOf('d_i', 'i', 'int'),
      declOf('d_y', 'y', 'byte'),
      declOf('d_s', 's', 'string'),
      refOf('view_i', 'd_i'),
      refOf('view_y', 'd_y'),
      refOf('view_s', 'd_s'),
      intNode('v1', 1),
    ]);
    expect(declaredTypeOf(table, 'd_i')).toBe('int');
    expect(declaredTypeOf(table, 'view_i')).toBe('int');
    expect(declaredTypeOf(table, 'd_y')).toBe('byte');
    expect(declaredTypeOf(table, 'view_y')).toBe('byte');
    expect(declaredTypeOf(table, 'd_s')).toBe('string');
    expect(declaredTypeOf(table, 'view_s')).toBe('string');
    expect(declaredTypeOf(table, 'v1')).toBeUndefined();
  });
});
