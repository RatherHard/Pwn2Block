import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { detachChainMember, snapData } from '../src/canvas/editor-chain';
import { dissolveEnvelope } from '../src/canvas/editor-envelope';
import { selectionRoots, structureIds } from '../src/canvas/structure';
import { layoutCanvas } from '../src/canvas/view-model';
import { cycleOperator } from '../src/components/canvas-panel-commands';
import { CanvasHistory } from '../src/components/canvas-panel-history';

function value(id: string, literal: canvas.EncodedScalarValue = { kind: 'int', value: '1' }): canvas.ValueNode {
  return { id, kind: 'value', value: literal };
}
function documentOf(nodes: readonly canvas.CanvasNode[]): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes, layout: Object.fromEntries(nodes.map((node, i) => [node.id, { x: 40 + i * 300, y: 80 }])) };
}
function assertReferences(document: canvas.CanvasDocument): void {
  expect(canvas.validateCanvasDocument(document).issues.filter((issue) => ['unknown_node', 'ownership_conflict', 'input_cycle'].includes(issue.code))).toEqual([]);
}

describe('数据吸附与链中脱离', () => {
  it('A+B+C 抽走 B 后得到 A+C，消费者保留，空位收拢且一步撤销', () => {
    const document = documentOf([value('a'), value('b'), value('c'),
      { id: 'ab', kind: 'relation', op: 'int.add', left: 'a', right: 'b' },
      { id: 'abc', kind: 'relation', op: 'int.add', left: 'ab', right: 'c' },
      { id: 'consumer', kind: 'unary', op: 'length', operand: 'abc' },
    ]);
    const history = new CanvasHistory();
    history.push(document);
    const detached = detachChainMember(document, 'b');
    expect(detached.issues).toEqual([]);
    expect(detached.document.nodes.find((node) => node.id === 'ab')).toBeUndefined();
    expect(detached.document.nodes.find((node) => node.id === 'abc')).toMatchObject({ left: 'a', right: 'c' });
    expect(detached.document.nodes.find((node) => node.id === 'consumer')).toMatchObject({ operand: 'abc' });
    expect(detached.document.layout.c.x).toBeLessThan(document.layout.c.x);
    expect(detached.document.layout.b).toEqual(document.layout.b);
    assertReferences(detached.document);
    expect(history.undo(detached.document)).toBe(document);
    expect(history.redos(document)).toBe(detached.document);
  });

  it.each([
    { kind: 'string', value: 'ab' } as const,
    { kind: 'byte', hex: '4142' } as const,
  ])('$kind 吸附得到连接串，第三项吸附扩展同一个包络', (literal) => {
    const document = documentOf([value('a', literal), value('b', literal), value('c', literal)]);
    const first = snapData(document, 'a', 'b');
    const group = first.document.nodes.find((node) => node.kind === 'group');
    expect(group).toMatchObject({ mode: 'merge', rows: [['a', 'b']] });
    const appended = snapData(first.document, 'b', 'c');
    expect(appended.issues).toEqual([]);
    expect(appended.document.nodes.filter((node) => node.kind === 'group')).toEqual([{ ...group, rows: [['a', 'b', 'c']] }]);
    assertReferences(appended.document);
  });

  it('扩展已经被读取的数值后，下游读取完整表达式', () => {
    const document = documentOf([value('a'), value('b'), { id: 'consumer', kind: 'unary', op: 'length', operand: 'a' }]);
    const snapped = snapData(document, 'a', 'b');
    const relation = snapped.document.nodes.find((node) => node.kind === 'relation');
    expect(relation).toMatchObject({ left: 'a', right: 'b', op: 'int.add' });
    expect(snapped.document.nodes.find((node) => node.id === 'consumer')).toMatchObject({ operand: relation?.id });
    assertReferences(snapped.document);
  });

  it('异类数据组成列表；单成员脱离不会留下空组合', () => {
    const mixed = snapData(documentOf([value('a'), value('b', { kind: 'string', value: 'b' })]), 'a', 'b');
    expect(mixed.document.nodes.find((node) => node.kind === 'group')).toMatchObject({ mode: 'list' });
    const document = documentOf([value('a'), { id: 'g', kind: 'group', mode: 'list', rows: [['a']] }, { id: 'consumer', kind: 'unary', op: 'length', operand: 'g' }]);
    const detached = detachChainMember(document, 'a').document;
    expect(detached.nodes.some((node) => node.kind === 'group')).toBe(false);
    expect(detached.nodes.find((node) => node.id === 'consumer')).toMatchObject({ operand: 'a' });
    assertReferences(detached);
  });
});

describe('结构包络、赋值与解除', () => {
  it('一元与二元表达式整体框选提升到根，内部节点随整体移动', () => {
    const document = documentOf([value('a'), value('b'),
      { id: 'ab', kind: 'relation', op: 'int.add', left: 'a', right: 'b' },
      { id: 'negative', kind: 'unary', op: 'length', operand: 'ab' }]);
    expect(selectionRoots(document, ['a', 'b'])).toEqual(['negative']);
    expect(new Set(structureIds(document, 'negative'))).toEqual(new Set(['a', 'b', 'ab', 'negative']));
  });

  it('变量吸附显示独立的赋值关系，可切换初值与派生绑定', () => {
    const document = documentOf([value('a'), { id: 'variable', kind: 'var-decl', name: 'x', type: 'int', binding: { mode: 'none' } }]);
    const bound = snapData(document, 'variable', 'a');
    expect(bound.issues).toEqual([]);
    const view = layoutCanvas({ document: bound.document });
    expect(view.boxes.find((box) => box.id === 'binding:variable')).toMatchObject({ kind: 'relation', title: '=' });
    const switched = cycleOperator(bound.document, 'variable')!;
    expect(switched.document.nodes.find((node) => node.id === 'variable')).toMatchObject({ binding: { mode: 'derived', input: 'a' } });
    expect(layoutCanvas({ document: switched.document }).boxes.find((box) => box.id === 'binding:variable')?.title).toBe(':=');
  });

  it('解除内层包络也删除附着转换，保留内容并断开整体消费者', () => {
    const document = documentOf([value('a'), value('b'),
      { id: 'g', kind: 'group', mode: 'list', rows: [['a', 'b']] },
      { id: 'convert', kind: 'convert', spec: { kind: 'list-to-bytes' }, input: 'g' },
      { id: 'consumer', kind: 'unary', op: 'length', operand: 'convert' }]);
    const dissolved = dissolveEnvelope(document, 'g');
    expect(dissolved.document.nodes.map((node) => node.id)).toEqual(['a', 'b', 'consumer']);
    expect(dissolved.document.nodes.find((node) => node.id === 'consumer')).toMatchObject({ operand: canvas.UNCONNECTED });
    expect(dissolved.document.layout.g).toBeUndefined();
    expect(dissolved.document.layout.convert).toBeUndefined();
    assertReferences(dissolved.document);
  });
});


describe('嵌套结构边界', () => {
  it.each(['a', 'variable'])('拖走 %s 后解除赋值绑定并保留两端', (id) => {
    const document = documentOf([value('a'), { id: 'variable', kind: 'var-decl', name: 'x', type: 'int', binding: { mode: 'initial', input: 'a' } }]);
    const detached = detachChainMember(document, id).document;
    expect(detached.nodes).toHaveLength(2);
    expect(detached.nodes.find((node) => node.id === 'variable')).toMatchObject({ binding: { mode: 'none' } });
    assertReferences(detached);
  });

  it('外层包络包含内层包络右侧的附着转换', () => {
    const document = documentOf([value('a'), value('b'),
      { id: 'inner', kind: 'group', mode: 'list', rows: [['a', 'b']] },
      { id: 'convert', kind: 'convert', spec: { kind: 'list-to-bytes' }, input: 'inner' },
      { id: 'outer', kind: 'group', mode: 'list', rows: [['convert']] }]);
    const view = layoutCanvas({ document });
    const outer = view.boxes.find((box) => box.nodeId === 'outer' && box.kind === 'group')!;
    const conversion = view.boxes.find((box) => box.nodeId === 'convert' && box.kind === 'relation')!;
    expect(outer).toBeDefined();
    expect(conversion).toBeDefined();
    expect(outer.x + outer.width).toBeGreaterThan(conversion.x + conversion.width);
    expect(outer.y + outer.height).toBeGreaterThan(conversion.y + conversion.height);
    expect(outer.y).toBeLessThan(conversion.y);
  });
});
