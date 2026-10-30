import { describe, expect, it } from 'vitest';
import type { canvas } from '@pwn2block/shared';
import { createLogicEdge, nearestLogicSnap } from '../src/canvas/logic-editor';

const value = (id: string, x: number, y: number): canvas.LogicNode => ({
  id, kind: 'constant', value: { type: 'int', text: '2' }, x, y,
});
const base: canvas.LogicGraph = { version: 1, nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 },
  value('old', 100, 400), value('moving', 300, 200), value('new', 510, 200),
], edges: [] };
const attached: canvas.LogicGraph = { version: 1, edges: [], nodes: [
  { id: 'start', kind: 'start', x: 0, y: 0 }, value('member', 200, 200), value('moving', 300, 100),
  { id: 'z-env', kind: 'envelope', category: 'data', members: ['member'], title: 'data', x: 200, y: 200 },
  { id: 'a-convert', kind: 'convert', input: 'z-env', value: { type: 'int', text: '0' }, target: 'int',
    width: '8', endian: 'little', signed: false, x: 900, y: 900 },
] };
describe('connected and attached nodes must not snap as new independent objects', () => {
  it.each(['incoming', 'outgoing'] as const)('does not auto-connect a node with an %s edge', (direction) => {
    const graph: canvas.LogicGraph = { ...base, edges: [{ id: 'existing', kind: 'data', op: '+',
      from: direction === 'incoming' ? 'old' : 'moving', to: direction === 'incoming' ? 'moving' : 'old' }] };
    expect(nearestLogicSnap(graph, 'moving', [])).toBeUndefined();
  });
  it('still allows a fresh node to snap to a connected target', () => {
    const graph: canvas.LogicGraph = { ...base, edges: [{ id: 'existing', kind: 'data', op: '+', from: 'old', to: 'moving' }] };
    expect(nearestLogicSnap(graph, 'new', [])?.target).toBe('moving');
  });
  it('offers the envelope once, without its invisible attachment as a competing target', () => {
    expect(nearestLogicSnap(attached, 'moving', [])?.target).toBe('z-env');
    expect(nearestLogicSnap(attached, 'a-convert', [])).toBeUndefined();
  });
  it('does not create manual connections using an invisible attachment endpoint', () => {
    const hidden = attached.nodes.find((n) => n.id === 'a-convert')!;
    const moving = attached.nodes.find((n) => n.id === 'moving')!;
    expect(createLogicEdge(attached, hidden, moving, [])).toBeUndefined();
    expect(createLogicEdge(attached, moving, hidden, [])).toBeUndefined();
  });
  it('does not resnap an envelope connected through its hidden attachment', () => {
    const graph: canvas.LogicGraph = { ...attached, edges: [{ id: 'old', kind: 'data', op: '+', from: 'a-convert', to: 'moving' }] };
    expect(nearestLogicSnap(graph, 'z-env', [])).toBeUndefined();
  });
});
