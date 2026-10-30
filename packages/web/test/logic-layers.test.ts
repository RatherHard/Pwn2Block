import { describe, expect, it } from 'vitest';
import type { canvas } from '@pwn2block/shared';
import { logicLayers, moveLogicLayer, normalizeLogicLayerOrder } from '../src/canvas/logic-layers';

const node = (id: string, kind: canvas.LogicNode['kind'] = 'constant', x = 0): canvas.LogicNode => {
  if (kind === 'constant') return { id, kind, value: { type: 'int', text: '1' }, x, y: 0 };
  if (kind === 'start') return { id, kind, x, y: 0 };
  if (kind === 'loop') return { id, kind, count: '1', x, y: 0 };
  if (kind === 'convert') return { id, kind, value: { type: 'int', text: '1' }, target: 'int', x, y: 0, width: '8', endian: 'little', signed: false };
  if (kind === 'envelope') return { id, kind, category: 'data', members: [], title: id, x, y: 0 };
  if (kind === 'method') return { id, kind, method: '', x, y: 0 };
  throw new Error(`unsupported node kind ${kind}`);
};
const graph = (nodes: readonly canvas.LogicNode[], edges: readonly canvas.LogicEdge[] = []): canvas.LogicGraph => ({ version: 1, nodes: [...nodes], edges: [...edges] });

describe('logic layers', () => {
  it('groups data edges, recursive envelopes, and attachments but not flow/reference edges', () => {
    const outer = node('outer', 'envelope');
    const inner = node('inner', 'envelope');
    const a = node('a');
    const b = node('b');
    const loop = { ...node('loop', 'loop'), body: 'b' } as canvas.LogicNode;
    const start = node('start', 'start');
    const method = node('method', 'method');
    const g = graph(
      [{ ...outer, members: ['inner'] } as canvas.LogicNode, { ...inner, members: ['a'] } as canvas.LogicNode, a, b, loop, start, method],
      [
        { id: 'data', kind: 'data', from: 'b', to: 'method', op: '+' },
        { id: 'flow', kind: 'flow', from: 'start', to: 'method', outlet: 'next' },
        { id: 'ref', kind: 'reference', from: 'a', to: 'method', port: 'arg' },
      ],
    );
    const layers = logicLayers(g, ['start', 'outer', 'inner', 'a', 'b', 'loop', 'method']);
    expect(layers.map((layer) => layer.members)).toEqual([
      ['start'],
      ['outer', 'inner', 'a'],
      ['b', 'loop', 'method'],
    ]);
  });

  it('repairs invalid order, keeps members contiguous, and puts new structures on top', () => {
    const g = graph([node('a'), node('b'), node('c')], [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }]);
    expect(normalizeLogicLayerOrder(g, ['missing', 'b', 'b'])).toEqual(['b', 'a', 'c']);
    expect(normalizeLogicLayerOrder(g, ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
  });

  it('moves a whole structure without changing graph data', () => {
    const g = graph([node('a'), node('b'), node('c')], [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }]);
    expect(moveLogicLayer(g, ['a', 'b', 'c'], ['a'], 'top')).toEqual(['c', 'a', 'b']);
    expect(moveLogicLayer(g, ['a', 'b', 'c'], ['b'], 'bottom')).toEqual(['a', 'b', 'c']);
  });

  it('moves multiple selected structures together while preserving their order', () => {
    const g = graph([node('a'), node('b'), node('c'), node('d')]);
    expect(moveLogicLayer(g, ['a', 'b', 'c', 'd'], ['a', 'c'], 'up')).toEqual(['a', 'c', 'b', 'd']);
    expect(moveLogicLayer(g, ['a', 'b', 'c', 'd'], ['a', 'c'], 'down')).toEqual(['b', 'a', 'd', 'c']);
    expect(moveLogicLayer(g, ['a', 'b', 'c', 'd'], ['a', 'c'], 'top')).toEqual(['b', 'd', 'a', 'c']);
    expect(moveLogicLayer(g, ['a', 'b', 'c', 'd'], ['a', 'c'], 'bottom')).toEqual(['a', 'c', 'b', 'd']);
  });
});
