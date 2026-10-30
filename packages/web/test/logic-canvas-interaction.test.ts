// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { LogicCanvasElement } from '../src/components/logic-canvas';

const mounted: LogicCanvasElement[] = [];
afterEach(() => mounted.splice(0).forEach((ui) => ui.remove()));
const constant = (id: string, x: number, text = '2'): canvas.LogicNode =>
  ({ id, kind: 'constant', x, y: 220, value: { type: 'int', text } });
async function mount(nodes: canvas.LogicNode[], edges: canvas.LogicEdge[] = []) {
  const ui = new LogicCanvasElement();
  ui.graph = { version: 1, nodes: [{ id: 'start', kind: 'start', x: 0, y: 0 }, ...nodes], edges };
  ui.addEventListener('logic-edit', (event) => { ui.graph = (event as CustomEvent<canvas.LogicGraph>).detail; });
  document.body.append(ui);
  mounted.push(ui);
  await ui.updateComplete;
  return ui;
}
async function press(ui: LogicCanvasElement, selector: string) {
  const target = ui.shadowRoot!.querySelector(selector);
  expect(target).not.toBeNull();
  target!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 10 }));
  await ui.updateComplete;
}

describe('canvas connection and expression interaction', () => {
  it('anchors the initial viewport on the start node', async () => {
    const ui = new LogicCanvasElement();
    ui.graph = { version: 1, nodes: [{ id: 'start', kind: 'start', x: 1000, y: 800 }], edges: [] };
    document.body.append(ui);
    mounted.push(ui);
    await ui.updateComplete;
    await ui.updateComplete;
    const transform = (ui.shadowRoot!.querySelector('.surface') as HTMLElement).style.transform;
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(0);
    expect(Number(match![2])).toBeLessThan(0);
  });
  it('shows one plus choice, including legacy concatenation edges', async () => {
    const ui = await mount([constant('a', 0), constant('b', 268)],
      [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: 'concat' }]);
    await press(ui, '.relation');
    const select = ui.shadowRoot!.querySelector<HTMLSelectElement>('select[aria-label="关系"]')!;
    expect([...select.options].filter((option) => option.value === 'concat')).toHaveLength(0);
    expect(select.value).toBe('+');
    expect(ui.shadowRoot!.querySelector('.relation')!.textContent!.trim()).toBe('+');
  });
  it('starts at an input, finishes only at an output, and permits multiple incoming edges', async () => {
    const ui = await mount([{ id: 'branch', kind: 'branch', x: 200, y: 0 },
      { id: 'sink', kind: 'method', method: 'gets', x: 500, y: 0 }]);
    await press(ui, '[data-node="branch"] .port-in');
    await press(ui, '[data-node="start"] .port-out');
    expect(ui.graph.edges).toEqual([expect.objectContaining({ from: 'start', to: 'branch', outlet: 'next' })]);
    await press(ui, '[data-node="sink"] .port-in');
    await press(ui, '[data-node="branch"] .port-then');
    await press(ui, '[data-node="sink"] .port-in');
    await press(ui, '[data-node="branch"] .port-else');
    expect(ui.graph.edges.filter((edge) => edge.to === 'sink')).toHaveLength(2);
    expect(canvas.validateLogicGraph(ui.graph)).toEqual([]);
    await press(ui, '[data-node="sink"] .port-in');
    await press(ui, '[data-node="start"] .port-out');
    expect(ui.graph.edges).toHaveLength(3);
  });
  it('does not connect via the node body or by starting at the output', async () => {
    const ui = await mount([{ id: 'b', kind: 'branch', x: 300, y: 0 }]);
    await press(ui, '[data-node="start"] .port-out');
    await press(ui, '[data-node="b"] .node-title');
    expect(ui.graph.edges).toHaveLength(0);
    await press(ui, '[data-node="b"] .port-in');
    await press(ui, '[data-node="start"] .node-title');
    expect(ui.graph.edges).toHaveLength(0);
  });
  it('moves an assignment target with its nested expression, preserving all connections', async () => {
    const ui = await mount([
      { id: 'v', kind: 'variable', name: 'payload', x: 0, y: 220 },
      constant('a', 300), constant('b', 568),
      { id: 'inner', kind: 'envelope', category: 'data', members: ['a', 'b'], title: 'inner', x: 280, y: 180 },
      { id: 'outer', kind: 'envelope', category: 'data', members: ['inner'], title: 'outer', x: 260, y: 140 },
      { id: 'method', kind: 'method', method: 'gets', x: 900, y: 0 },
    ], [{ id: 'sum', kind: 'data', from: 'a', to: 'b', op: '+' },
      { id: 'assign', kind: 'data', from: 'outer', to: 'v', op: 'assign' },
      { id: 'ref', kind: 'reference', from: 'outer', to: 'method', port: 'data' }]);
    const original = ui.graph;
    ui.shadowRoot!.querySelector('[data-node="v"]')!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 230 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 330 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 90, clientY: 330 }));
    await ui.updateComplete;
    expect(ui.graph.edges).toEqual(original.edges);
    for (const id of ['v', 'a', 'b', 'inner', 'outer']) {
      const before = original.nodes.find((node) => node.id === id)!;
      expect(ui.graph.nodes.find((node) => node.id === id)).toMatchObject({ x: before.x + 80, y: before.y + 100 });
    }
    expect(ui.graph.nodes.find((node) => node.id === 'method')).toEqual(original.nodes.find((node) => node.id === 'method'));
  });
  it('shows an envelope expression result and updates it with its data', async () => {
    const ui = await mount([constant('a', 0), constant('b', 268),
      { id: 'group', kind: 'envelope', category: 'data', title: 'sum', members: ['a', 'b'], x: 0, y: 180 }],
    [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }]);
    expect(ui.shadowRoot!.querySelector('[data-node="group"] .envelope-summary')?.textContent).toContain('int 4');
    ui.graph = { ...ui.graph, nodes: ui.graph.nodes.map((node) => node.id === 'b' ? constant('b', 268, '3') : node) };
    await ui.updateComplete;
    expect(ui.shadowRoot!.querySelector('[data-node="group"] .envelope-summary')?.textContent).toContain('int 5');
  });
});
