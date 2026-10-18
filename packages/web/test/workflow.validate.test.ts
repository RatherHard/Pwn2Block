import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { validateGraph } from '../src/workflow/validate';
import type { GraphValidation } from '../src/workflow/validate';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 全图校验（07 §P1 的清单）：入口唯一、未知节点、端口与类型、数据环、跨区域、题目动作权限。
 *
 * 断言按 `code` 而不是中文文案：文案可以改，判定语义不能悄悄改。
 */

function codes(validation: GraphValidation): string[] {
  return validation.issues.map((issue) => issue.code);
}

function basicGraph(): ReturnType<typeof workflow> {
  return workflow({
    nodes: [
      wfNode('fill', NODE.fill, { byte: 0x41, count: 4 }),
      wfNode('addr', NODE.address, { value: 0x400000 }),
      wfNode('cat', NODE.concat, { count: 2 }),
      wfNode('write', NODE.write, { addr: 0x400100 }),
      wfNode('run', NODE.run, { maxSteps: 100 }),
    ],
    edges: [
      wfEdge('fill', 'cat', 'item0'),
      wfEdge('addr', 'cat', 'item1'),
      wfEdge('cat', 'write', 'data'),
    ],
    main: ['fill', 'addr', 'cat', 'write', 'run'],
  });
}

describe('校验：基础题图', () => {
  it('合法的填充 + 地址 + 拼接 + 写入 + 运行没有错误', () => {
    const validation = validateGraph(basicGraph(), WORKFLOW_CONTEXT);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.executionOrder.map((step) => step.nodeId)).toEqual(['fill', 'addr', 'cat', 'write', 'run']);
  });

  it('未使用的数据节点只是警告，不阻止编译', () => {
    const document = basicGraph();
    const withExtra = {
      ...document,
      nodes: [...document.nodes, wfNode('spare', NODE.fill, { byte: 0x42, count: 1 })],
    };
    const validation = validateGraph(withExtra, WORKFLOW_CONTEXT);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((issue) => issue.nodeId)).toContain('spare');
  });
});

describe('校验：入口', () => {
  it('没有开始节点时报 missing_start', () => {
    const document = basicGraph();
    const validation = validateGraph(
      { ...document, nodes: document.nodes.filter((node) => node.kind !== 'start') },
      WORKFLOW_CONTEXT,
    );
    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain('missing_start');
  });

  it('两个开始节点都报 multiple_start', () => {
    const document = basicGraph();
    const validation = validateGraph(
      { ...document, nodes: [...document.nodes, wfNode('start2', 'start')] },
      WORKFLOW_CONTEXT,
    );
    expect(codes(validation).filter((code) => code === 'multiple_start')).toHaveLength(2);
  });

  it('开始节点被放进执行序列时报 start_has_input', () => {
    const document = basicGraph();
    const validation = validateGraph({ ...document, main: ['start', 'run'] }, WORKFLOW_CONTEXT);
    expect(codes(validation)).toContain('start_has_input');
  });
});

describe('校验：节点与参数', () => {
  it('未知节点类型不会静默忽略', () => {
    const document = basicGraph();
    const validation = validateGraph(
      { ...document, nodes: [...document.nodes, wfNode('mystery', 'data.teleport')] },
      WORKFLOW_CONTEXT,
    );
    expect(codes(validation)).toContain('unknown_kind');
  });

  it('没有声明的出题人积木被拒绝', () => {
    const document = workflow({
      nodes: [wfNode('author', NODE.author, { id: 'gets' })],
      main: ['author'],
    });
    expect(codes(validateGraph(document, WORKFLOW_CONTEXT))).toContain('undeclared_author_block');
  });

  it('题目不允许的动作在编译前就被拒绝', () => {
    const document = workflow({
      nodes: [wfNode('hex', NODE.hex, { hex: '41' }), wfNode('feed', NODE.feed)],
      edges: [wfEdge('hex', 'feed', 'data')],
      main: ['hex', 'feed'],
    });
    const context = { ...WORKFLOW_CONTEXT, allowedActions: ['write_bytes'] };
    expect(codes(validateGraph(document, context))).toContain('action_not_allowed');
  });

  it('参数越界（填充字节 300）报 invalid_param', () => {
    const document = workflow({
      nodes: [wfNode('fill', NODE.fill, { byte: 300, count: 4 })],
      main: [],
    });
    const validation = validateGraph(document, WORKFLOW_CONTEXT);
    expect(codes(validation)).toContain('invalid_param');
    expect(validation.issues.find((issue) => issue.code === 'invalid_param')?.nodeId).toBe('fill');
  });
});

describe('校验：连线', () => {
  it('类型不匹配会被拦下：字节接到需要整数的端口', () => {
    const document = workflow({
      nodes: [
        wfNode('addr', NODE.address, { value: 1 }),
        wfNode('cmp', NODE.compare, { op: 'EQ' }),
        wfNode('run', NODE.run, { maxSteps: 1 }),
      ],
      edges: [wfEdge('addr', 'cmp', 'a')],
      main: ['addr', 'cmp', 'run'],
    });
    const issue = validateGraph(document, WORKFLOW_CONTEXT).issues.find(
      (candidate) => candidate.code === 'type_mismatch',
    );
    expect(issue?.nodeId).toBe('cmp');
    expect(issue?.port).toBe('a');
  });

  it('同一个输入接两条线时只报一次（重复边）', () => {
    const document = workflow({
      nodes: [
        wfNode('a', NODE.fill, { byte: 0x41, count: 1 }),
        wfNode('b', NODE.fill, { byte: 0x42, count: 1 }),
        wfNode('cat', NODE.concat, { count: 2 }),
        wfNode('write', NODE.write),
      ],
      edges: [wfEdge('a', 'cat', 'item0'), wfEdge('a', 'cat', 'item0'), wfEdge('cat', 'write', 'data')],
      main: ['a', 'b', 'cat', 'write'],
    });
    expect(codes(validateGraph(document, WORKFLOW_CONTEXT))).toContain('duplicate_edge');
  });

  it('必填输入没接线时报 missing_input', () => {
    const document = workflow({
      nodes: [wfNode('cat', NODE.concat, { count: 2 }), wfNode('write', NODE.write)],
      edges: [wfEdge('cat', 'write', 'data')],
      main: ['cat', 'write'],
    });
    const issues = validateGraph(document, WORKFLOW_CONTEXT).issues.filter(
      (issue) => issue.code === 'missing_input',
    );
    expect(issues.map((issue) => issue.port)).toEqual(['item0', 'item1']);
  });

  it('数据依赖成环时报 data_cycle', () => {
    const document = workflow({
      nodes: [
        wfNode('a', NODE.concat, { count: 2 }),
        wfNode('b', NODE.concat, { count: 2 }),
        wfNode('write', NODE.write),
      ],
      edges: [
        wfEdge('b', 'a', 'item0'),
        wfEdge('a', 'b', 'item1'),
        wfEdge('a', 'write', 'data'),
      ],
      main: ['a', 'b', 'write'],
    });
    expect(codes(validateGraph(document, WORKFLOW_CONTEXT))).toContain('data_cycle');
  });

  it('数据节点按依赖求值，不必摆进执行序列；语句节点必须被摆放', () => {
    const dataOnly = workflow({
      nodes: [wfNode('hex', NODE.hex, { hex: '41' }), wfNode('feed', NODE.feed)],
      edges: [wfEdge('hex', 'feed', 'data')],
      main: ['feed'],
    });
    expect(codes(validateGraph(dataOnly, WORKFLOW_CONTEXT))).not.toContain('unplaced_node');
    expect(validateGraph(dataOnly, WORKFLOW_CONTEXT).ok).toBe(true);

    const orphan = workflow({
      nodes: [wfNode('feed', NODE.feed), wfNode('run', NODE.run, { maxSteps: 1 })],
      edges: [],
      main: ['feed'],
    });
    const issues = validateGraph(orphan, WORKFLOW_CONTEXT).issues.filter(
      (issue) => issue.code === 'unplaced_node',
    );
    expect(issues.map((issue) => issue.nodeId)).toEqual(['run']);
  });

  it('同一个节点放进两个区域时报 duplicate_placement', () => {
    const document = workflow({
      nodes: [wfNode('run', NODE.run, { maxSteps: 1 })],
      main: ['run', 'run'],
    });
    expect(codes(validateGraph(document, WORKFLOW_CONTEXT))).toContain('duplicate_placement');
  });

  it('连线引用不存在的节点时报 unknown_node', () => {
    const document = workflow({
      nodes: [wfNode('feed', NODE.feed)],
      edges: [wfEdge('ghost', 'feed', 'data')],
      main: ['feed'],
    });
    expect(codes(validateGraph(document, WORKFLOW_CONTEXT))).toContain('unknown_node');
  });
});
