import { describe, expect, it } from 'vitest';
import { NODE, WORKFLOW_MAX_MODULES } from '@pwn2block/shared';
import type { GraphModule } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import type { WorkflowContext } from '../src/workflow/types';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 模块（06 §7；07 §P5）。
 *
 * 断言的是调用语义：输入绑定、结果类型、状态隔离、版本固定、递归/深度/端口错误。
 * 提取 UI 与面包屑不在这些用例里（尚未实现，见 docs/07）。
 */

const CTX: WorkflowContext = WORKFLOW_CONTEXT;

function mod(overrides: Partial<GraphModule> & Pick<GraphModule, 'id' | 'kind'>): GraphModule {
  return {
    name: overrides.id,
    summary: '',
    version: 1,
    inputs: [],
    nodes: [],
    connections: [],
    main: [],
    layout: {},
    ...overrides,
  };
}

function dataModule(): GraphModule {
  return mod({
    id: 'inc',
    kind: 'data',
    inputs: [{ name: 'a', type: 'int' }],
    output: { name: 'out', type: 'int' },
    nodes: [
      wfNode('get', NODE.varGet, { name: 'a', type: 'int' }),
      wfNode('inc', NODE.arith, { op: 'ADD', b: 1 }),
      wfNode('ret', NODE.moduleReturn, { valueType: 'int' }),
    ],
    connections: [wfEdge('get', 'inc', 'a'), wfEdge('inc', 'ret', 'value')],
    main: ['ret'],
  });
}

function pushModule(): GraphModule {
  return mod({
    id: 'emit',
    kind: 'flow',
    inputs: [{ name: 'a', type: 'int' }],
    nodes: [wfNode('get', NODE.varGet, { name: 'a', type: 'int' }), wfNode('push', NODE.push)],
    connections: [wfEdge('get', 'push', 'value')],
    main: ['push'],
  });
}

function callNode(id: string, moduleId: string, extra: Record<string, unknown> = {}) {
  return wfNode(id, NODE.moduleData, {
    moduleId,
    moduleVersion: 1,
    outputType: 'int',
    inputs: ['a:int'],
    ...extra,
  });
}

async function codes(spec: Parameters<typeof workflow>[0]): Promise<readonly string[]> {
  const outcome = await compileGraph({ document: workflow(spec), context: CTX, documentRevision: 1 });
  return outcome.ok ? [] : outcome.issues.map((issue) => issue.code);
}

async function actions(spec: Parameters<typeof workflow>[0]) {
  const outcome = await compileGraph({ document: workflow(spec), context: CTX, documentRevision: 1 });
  if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('; '));
  return outcome.artifact.actions;
}

function intOf(id: string, value: number) {
  return wfNode(id, NODE.arith, { op: 'ADD', a: 0, b: value });
}

describe('数据模块', () => {
  it('绑定输入并把结果交给下游动作', async () => {
    const result = await actions({
      modules: [dataModule()],
      nodes: [intOf('n', 41), callNode('call', 'inc'), wfNode('push', NODE.push)],
      edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
      main: ['call', 'push'],
    });
    expect(result).toEqual([{ type: 'push', value: '0x2a' }]);
  });

  it('没选版本时明确报 module_missing', async () => {
    expect(
      await codes({
        modules: [dataModule()],
        nodes: [intOf('n', 1), callNode('call', 'inc', { moduleVersion: 2 }), wfNode('push', NODE.push)],
        edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
        main: ['call', 'push'],
      }),
    ).toContain('module_missing');
  });

  it('端口声明与定义不一致就拒绝编译', async () => {
    expect(
      await codes({
        modules: [dataModule()],
        nodes: [intOf('n', 1), callNode('call', 'inc', { inputs: ['a:bytes'] }), wfNode('push', NODE.push)],
        edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
        main: ['call', 'push'],
      }),
    ).toContain('module_ports_mismatch');
  });

  it('数据模块里出现动作就报 module_has_action', async () => {
    const withAction = {
      ...dataModule(),
      nodes: [...dataModule().nodes, wfNode('push', NODE.push)],
    };
    expect(
      await codes({
        modules: [withAction],
        nodes: [intOf('n', 1), callNode('call', 'inc'), wfNode('push', NODE.push)],
        edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
        main: ['call', 'push'],
      }),
    ).toContain('module_has_action');
  });
});

describe('流程模块', () => {
  it('两次调用状态互不污染', async () => {
    const result = await actions({
      modules: [pushModule()],
      nodes: [
        intOf('a', 5),
        intOf('b', 7),
        wfNode('first', NODE.moduleCall, { moduleId: 'emit', moduleVersion: 1, hasOutput: 'no', inputs: ['a:int'] }),
        wfNode('second', NODE.moduleCall, { moduleId: 'emit', moduleVersion: 1, hasOutput: 'no', inputs: ['a:int'] }),
      ],
      edges: [wfEdge('a', 'first', 'a'), wfEdge('b', 'second', 'a')],
      main: ['first', 'second'],
    });
    expect(result).toEqual([
      { type: 'push', value: '0x5' },
      { type: 'push', value: '0x7' },
    ]);
  });

  it('来源记录模块调用实例', async () => {
    const outcome = await compileGraph({
      document: workflow({
        modules: [pushModule()],
        nodes: [
          intOf('n', 9),
          wfNode('call', NODE.moduleCall, { moduleId: 'emit', moduleVersion: 1, hasOutput: 'no', inputs: ['a:int'] }),
        ],
        edges: [wfEdge('n', 'call', 'a')],
        main: ['call'],
      }),
      context: CTX,
      documentRevision: 1,
    });
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('; '));
    expect(outcome.artifact.origins[0]?.modules).toEqual(['emit@1']);
  });

  it('模块结果可以作为数据输出', async () => {
    const flowModule = mod({
      id: 'double',
      kind: 'flow',
      inputs: [{ name: 'a', type: 'int' }],
      output: { name: 'out', type: 'int' },
      nodes: [
        wfNode('get', NODE.varGet, { name: 'a', type: 'int' }),
        wfNode('twice', NODE.arith, { op: 'MULTIPLY', b: 2 }),
        wfNode('ret', NODE.moduleReturn, { valueType: 'int' }),
      ],
      connections: [wfEdge('get', 'twice', 'a'), wfEdge('twice', 'ret', 'value')],
      main: ['ret'],
    });
    const result = await actions({
      modules: [flowModule],
      nodes: [
        intOf('n', 21),
        wfNode('call', NODE.moduleCall, {
          moduleId: 'double',
          moduleVersion: 1,
          hasOutput: 'yes',
          outputType: 'int',
          inputs: ['a:int'],
        }),
        wfNode('push', NODE.push),
      ],
      edges: [wfEdge('n', 'call', 'a'), wfEdge('call', 'push', 'value')],
      main: ['call', 'push'],
    });
    expect(result).toEqual([{ type: 'push', value: '0x2a' }]);
  });

  it('模块调用自己报 module_recursion', async () => {
    const recursive = mod({
      id: 'loop',
      kind: 'flow',
      nodes: [
        wfNode('self', NODE.moduleCall, { moduleId: 'loop', moduleVersion: 1, hasOutput: 'no' }),
      ],
      main: ['self'],
    });
    expect(
      await codes({
        modules: [recursive],
        nodes: [wfNode('top', NODE.moduleCall, { moduleId: 'loop', moduleVersion: 1, hasOutput: 'no' })],
        main: ['top'],
      }),
    ).toContain('module_recursion');
  });

  it('嵌套超过深度上限报 module_depth', async () => {
    const chain: GraphModule[] = [];
    for (let level = 0; level < 6; level += 1) {
      const next = level + 1 < 6 ? level + 1 : undefined;
      chain.push(
        mod({
          id: `m${level}`,
          kind: 'flow',
          nodes:
            next === undefined
              ? []
              : [wfNode('next', NODE.moduleCall, { moduleId: `m${next}`, moduleVersion: 1, hasOutput: 'no' })],
          main: next === undefined ? [] : ['next'],
        }),
      );
    }
    expect(
      await codes({
        modules: chain,
        nodes: [wfNode('top', NODE.moduleCall, { moduleId: 'm0', moduleVersion: 1, hasOutput: 'no' })],
        main: ['top'],
      }),
    ).toContain('module_depth');
  });

  it('模块声明只到上限内时通过', async () => {
    expect(WORKFLOW_MAX_MODULES).toBeGreaterThan(0);
    expect(
      await codes({
        modules: [pushModule()],
        nodes: [
          intOf('n', 3),
          wfNode('call', NODE.moduleCall, { moduleId: 'emit', moduleVersion: 1, hasOutput: 'no', inputs: ['a:int'] }),
        ],
        edges: [wfEdge('n', 'call', 'a')],
        main: ['call'],
      }),
    ).toEqual([]);
  });
});
