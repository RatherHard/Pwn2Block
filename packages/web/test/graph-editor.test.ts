import { describe, expect, it } from 'vitest';
import { NODE, emptyGraphDocument } from '@pwn2block/shared';
import {
  addNode,
  connect,
  copySelection,
  createEditor,
  disconnect,
  moveInto,
  moveNodes,
  moveOut,
  setCollapsed,
  paste,
  pruneConnections,
  redo,
  removeNodes,
  reorder,
  select,
  setParam,
  undo,
} from '../src/graph/editor';
import type { EditResult, GraphEditorState } from '../src/graph/editor';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 编辑器命令（06 §3；07 §P2）：加节点、接线规则、删除、撤销/重做、复制粘贴与顺序调整。
 *
 * 全部断言文档内容：这些命令是画布的唯一写入口，错一步就会写出编译不通过的图。
 */

function seeded(): GraphEditorState {
  return createEditor(
    workflow({
      nodes: [wfNode('fill', NODE.fill, { byte: 0x41, count: 4 }), wfNode('feed', NODE.feed)],
      edges: [],
      main: ['feed'],
    }),
  );
}

function expectOk(result: EditResult): Extract<EditResult, { ok: true }> {
  if (!result.ok) throw new Error(`命令失败：${result.message}`);
  return result;
}

describe('编辑器：加节点与摆放', () => {
  it('语句节点追加到执行序列末尾，数据节点不占执行位', () => {
    const base = createEditor(emptyGraphDocument());
    const withFill = expectOk(addNode(base, { kind: NODE.fill })).state;
    expect(withFill.document.main).toEqual([]);
    expect(withFill.document.nodes.map((node) => node.id)).toContain('fill');
    expect(withFill.selection).toEqual(['fill']);

    const withFeed = expectOk(addNode(withFill, { kind: NODE.feed })).state;
    expect(withFeed.document.main).toEqual(['feed']);
    expect(withFeed.semanticRevision).toBe(2);
  });

  it('id 冲突时自动加序号，不会覆盖已有节点', () => {
    let state = createEditor(emptyGraphDocument());
    state = expectOk(addNode(state, { kind: NODE.fill })).state;
    state = expectOk(addNode(state, { kind: NODE.fill })).state;
    const ids = state.document.nodes.map((node) => node.id);
    expect(ids).toContain('fill');
    expect(ids).toContain('fill2');
  });

  it('新节点不会压在已有节点上', () => {
    let state = createEditor(emptyGraphDocument());
    state = expectOk(addNode(state, { kind: NODE.fill })).state;
    state = expectOk(addNode(state, { kind: NODE.fill })).state;
    const [first, second] = state.document.nodes.filter((node) => node.kind === NODE.fill);
    const left = state.document.layout[first?.id ?? ''];
    const right = state.document.layout[second?.id ?? ''];
    expect(left?.x).not.toBe(right?.x);
  });
});

describe('编辑器：接线规则', () => {
  it('类型一致才接得上，并替换同一输入口上的旧线', () => {
    const base = seeded();
    const ok = expectOk(
      connect(base, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'feed', port: 'data' }),
    ).state;
    expect(ok.document.connections).toEqual([
      { from: { node: 'fill', port: 'out' }, to: { node: 'feed', port: 'data' } },
    ]);

    const replaced = expectOk(
      connect(
        { ...base, document: { ...base.document, nodes: [...base.document.nodes, wfNode('hex', NODE.hex, { hex: '41' })] } },
        WORKFLOW_CONTEXT,
        { node: 'hex', port: 'out' },
        { node: 'feed', port: 'data' },
      ),
    ).state;
    expect(replaced.document.connections).toHaveLength(1);
    expect(replaced.document.connections[0]?.from.node).toBe('hex');
  });

  it('类型不符时给出谁要什么的原文，不静默丢弃', () => {
    const base = seeded();
    const result = connect(
      base,
      WORKFLOW_CONTEXT,
      { node: 'fill', port: 'out' },
      { node: 'feed', port: 'missing' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('没有输入端口');
  });

  it('数据依赖成环时拒绝接线', () => {
    const document = workflow({
      nodes: [wfNode('a', NODE.concat, { count: 2 }), wfNode('b', NODE.concat, { count: 2 })],
      edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'item0' } }],
      main: [],
    });
    const state = createEditor(document);
    const result = connect(
      state,
      WORKFLOW_CONTEXT,
      { node: 'b', port: 'out' },
      { node: 'a', port: 'item1' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('成环');
  });

  it('自连与重复连线都被拒绝', () => {
    const base = seeded();
    expect(
      connect(base, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'fill', port: 'byte' }).ok,
    ).toBe(false);
    const connected = expectOk(
      connect(base, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'feed', port: 'data' }),
    ).state;
    expect(
      connect(connected, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'feed', port: 'data' }).ok,
    ).toBe(false);
  });

  it('断开连线只影响那一条边', () => {
    const base = seeded();
    const connected = expectOk(
      connect(base, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'feed', port: 'data' }),
    ).state;
    const edge = connected.document.connections[0];
    if (edge === undefined) throw new Error('没有连线可断');
    expect(disconnect(connected, edge).document.connections).toEqual([]);
  });

  it('改参数后失效的端口连线被清掉', () => {
    const document = workflow({
      nodes: [wfNode('a', NODE.fill, { byte: 1, count: 1 }), wfNode('b', NODE.fill, { byte: 2, count: 1 }), wfNode('cat', NODE.concat, { count: 2 })],
      edges: [
        { from: { node: 'a', port: 'out' }, to: { node: 'cat', port: 'item0' } },
        { from: { node: 'b', port: 'out' }, to: { node: 'cat', port: 'item1' } },
      ],
      main: [],
    });
    const state = createEditor(document);
    const shrunk = setParam(state, 'cat', 'count', 1, WORKFLOW_CONTEXT);
    expect(shrunk.document.connections).toHaveLength(1);
    expect(shrunk.document.connections[0]?.to.port).toBe('item0');
    expect(pruneConnections(shrunk.document, WORKFLOW_CONTEXT)).toBe(shrunk.document);
  });
});

describe('编辑器：删除、撤销与复制', () => {
  it('删除节点会连带清掉它的连线、布局与执行位', () => {
    const base = seeded();
    const state = expectOk(
      connect(base, WORKFLOW_CONTEXT, { node: 'fill', port: 'out' }, { node: 'feed', port: 'data' }),
    ).state;
    const removed = removeNodes(state, ['fill']);
    expect(removed.document.connections).toEqual([]);
    expect(removed.document.layout.fill).toBeUndefined();
    expect(removed.document.main).toEqual(['feed']);
  });

  it('开始节点删不掉', () => {
    const state = removeNodes(seedEditorWithStart(), ['start']);
    expect(state.document.nodes.some((node) => node.id === 'start')).toBe(true);
  });

  it('撤销恢复文档与选择，重做再前进一次', () => {
    const base = seeded();
    const added = expectOk(addNode(base, { kind: NODE.run })).state;
    const undone = undo(added);
    expect(undone.document.main).toEqual(['feed']);
    const redone = redo(undone);
    expect(redone.document.main).toEqual(['feed', 'run']);
  });

  it('只拖位置不涨语义修订号，也不进撤销栈的语义位置', () => {
    const base = seeded();
    const moved = moveNodes(base, { fill: { x: 300, y: 120 } });
    expect(moved.semanticRevision).toBe(0);
    expect(moved.layoutRevision).toBe(1);
    expect(moved.document.layout.fill).toEqual({ x: 300, y: 120 });
    expect(moved.past).toHaveLength(1);
  });

  it('复制粘贴：节点重新编号、内部连线一起复制、语句节点插在原节点之后', () => {
    const document = workflow({
      nodes: [wfNode('fill', NODE.fill, { byte: 0x41, count: 1 }), wfNode('write', NODE.write)],
      edges: [{ from: { node: 'fill', port: 'out' }, to: { node: 'write', port: 'data' } }],
      main: ['write'],
    });
    let state = createEditor(document);
    state = select(state, ['fill', 'write']);
    state = copySelection(state);
    const pasted = expectOk(paste(state, WORKFLOW_CONTEXT)).state;
    // start + fill + write + 两份复制 = 5 个节点。
    expect(pasted.document.nodes).toHaveLength(5);
    expect(pasted.document.connections).toHaveLength(2);
    expect(pasted.document.main).toEqual(['write', 'write2']);
    expect(pasted.selection).toEqual(['fill2', 'write2']);
  });

  it('剪贴板为空时粘贴给出原因', () => {
    const result = paste(seeded(), WORKFLOW_CONTEXT);
    expect(result.ok).toBe(false);
  });
});

describe('编辑器：执行顺序', () => {
  it('前移后移只改顺序，不改节点与连线', () => {
    const document = workflow({
      nodes: [wfNode('feed', NODE.feed), wfNode('run', NODE.run, { maxSteps: 1 })],
      edges: [],
      main: ['feed', 'run'],
    });
    const state = createEditor(document);
    const moved = reorder(state, 'run', -1);
    expect(moved.document.main).toEqual(['run', 'feed']);
    expect(moved.document.nodes).toEqual(document.nodes);
  });

  it('到边界时什么都不做，不产生撤销点', () => {
    const document = workflow({
      nodes: [wfNode('feed', NODE.feed)],
      edges: [],
      main: ['feed'],
    });
    const state = createEditor(document);
    expect(reorder(state, 'feed', 1)).toBe(state);
  });
});

function seedEditorWithStart(): GraphEditorState {
  return createEditor(emptyGraphDocument());
}

describe('编辑器：容器', () => {
  function withBranch(): GraphEditorState {
    return createEditor(
      workflow({
        nodes: [
          wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
          wfNode('if', NODE.if, {}, { then: [], else: [] }),
          wfNode('step', NODE.step, { count: 1 }),
        ],
        edges: [wfEdge('cmp', 'if', 'cond')],
        main: ['if', 'step'],
      }),
    );
  }

  it('把语句移进分支区域，且可撤销', () => {
    const result = moveInto(withBranch(), ['step'], 'if', 'then');
    if (!result.ok) throw new Error(result.message);
    expect(result.state.document.main).toEqual(['if']);
    expect(result.state.document.nodes.find((node) => node.id === 'if')?.regions?.then).toEqual(['step']);
    const back = undo(result.state);
    expect(back.document.main).toEqual(['if', 'step']);
  });

  it('拒绝把容器放进自己的子区域', () => {
    const result = moveInto(withBranch(), ['if'], 'if', 'then');
    expect(result.ok).toBe(false);
  });

  it('移出容器后紧跟在容器之后', () => {
    const inside = moveInto(withBranch(), ['step'], 'if', 'then');
    if (!inside.ok) throw new Error(inside.message);
    const outside = moveOut(inside.state, ['step']);
    expect(outside.document.main).toEqual(['if', 'step']);
    expect(outside.document.nodes.find((node) => node.id === 'if')?.regions?.then).toEqual([]);
  });

  it('新容器自带空区域', () => {
    const result = addNode(seedEditorWithStart(), { kind: NODE.repeat });
    if (!result.ok) throw new Error(result.message);
    const node = result.state.document.nodes.find((candidate) => candidate.kind === NODE.repeat);
    expect(node?.regions?.body).toEqual([]);
  });
});

describe('容器折叠（只改布局）', () => {
  function withIf() {
    return createEditor(
      workflow({
        nodes: [wfNode('if', NODE.if, {}, { then: [], else: [] }), wfNode('run', NODE.run)],
        main: ['if', 'run'],
      }),
    );
  }

  it('折叠只涨 layoutRevision，不涨语义版本', () => {
    const state = withIf();
    const folded = setCollapsed(state, 'if', true);
    expect(folded.semanticRevision).toBe(state.semanticRevision);
    expect(folded.layoutRevision).toBe(state.layoutRevision + 1);
    expect(folded.document.layout.if?.collapsed).toBe(true);
    expect(undo(folded).document.layout.if?.collapsed).toBeUndefined();
  });

  it('非容器与重复折叠不改状态', () => {
    const state = withIf();
    expect(setCollapsed(state, 'run', true)).toBe(state);
    const folded = setCollapsed(state, 'if', true);
    expect(setCollapsed(folded, 'if', true)).toBe(folded);
  });
});
