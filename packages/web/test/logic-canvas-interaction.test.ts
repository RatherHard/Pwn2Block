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
  ui.shadowRoot!.querySelector('.stage')!.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 2000);
  return ui;
}
async function press(ui: LogicCanvasElement, selector: string) {
  const target = ui.shadowRoot!.querySelector(selector);
  expect(target).not.toBeNull();
  target!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 10 }));
  await ui.updateComplete;
}
function pointer(ui: LogicCanvasElement, type: string, x: number, y: number, selector?: string, altKey = false) {
  const transform = ui.shadowRoot!.querySelector<HTMLElement>('.surface')!.style.transform;
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform)!;
  const event = new MouseEvent(type, { bubbles: true, button: 0, altKey,
    clientX: Number(match[1]) + x * Number(match[3]), clientY: Number(match[2]) + y * Number(match[3]) });
  (selector ? ui.shadowRoot!.querySelector(selector)! : window).dispatchEvent(event);
}

describe('canvas connection and expression interaction', () => {
  it.each(['a', 'loop'])('属性栏从 %s 建立附着循环次数引用，流程连接仍走包络', async (selected) => {
    const ui = await mount([constant('a', 800),
      { id: 'member', kind: 'method', method: 'emit', x: 200, y: 400 },
      { id: 'next', kind: 'method', method: 'emit', x: 900, y: 400 },
      { id: 'env', kind: 'envelope', category: 'flow', members: ['member'], title: 'env', x: 0, y: 0 },
      { id: 'loop', kind: 'loop', body: 'env', count: '2', x: 0, y: 0 }]);
    const connect = async (target: string) => {
      const select = ui.shadowRoot!.querySelector<HTMLSelectElement>('select[aria-label="连接到"]')!;
      expect([...select.options].map((option) => option.value)).toContain(target);
      select.value = target;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await ui.updateComplete;
      [...ui.shadowRoot!.querySelectorAll('button')].find((button) => button.textContent?.trim() === '建立连接')!.click();
      await ui.updateComplete;
    };
    await press(ui, selected === 'a' ? '[data-node="a"]' : '[data-attachment="loop"]');
    await connect(selected === 'a' ? 'loop' : 'a');
    expect(ui.graph.edges).toEqual([expect.objectContaining({ kind: 'reference', from: 'a', to: 'loop', port: 'count' })]);
    await press(ui, '[data-attachment="loop"]');
    await connect('next');
    expect(ui.graph.edges).toContainEqual(expect.objectContaining({ kind: 'flow', from: 'env', to: 'next' }));
    expect(canvas.validateLogicGraph(ui.graph)).toEqual([]);
  });
  it.each(['convert', 'loop'] as const)('拖出附着标签解除附着，点击不解除，取消恢复：%s', async (kind) => {
    const modifier: canvas.LogicNode = kind === 'convert'
      ? { id: 'attachment', kind, input: 'env', target: 'bytes', value: { type: 'int', text: '0' }, width: '8', endian: 'little', signed: false, x: 900, y: 600 }
      : { id: 'attachment', kind, body: 'env', count: '2', x: 900, y: 600 };
    const ui = await mount([kind === 'convert' ? constant('a', 100) : { id: 'a', kind: 'method', method: 'emit', x: 100, y: 220 },
      { id: 'env', kind: 'envelope', category: kind === 'convert' ? 'data' : 'flow', members: ['a'], title: 'env', x: 0, y: 0 }, modifier]);
    const original = ui.graph;
    await press(ui, '[data-attachment="attachment"]');
    expect(ui.graph).toEqual(original);
    pointer(ui, 'pointerdown', 150, 190, '[data-attachment="attachment"]');
    pointer(ui, 'pointermove', 600, 450);
    await ui.updateComplete;
    expect(ui.shadowRoot!.querySelector('[data-node="attachment"]')).not.toBeNull();
    expect(ui.shadowRoot!.querySelector('[data-attachment="attachment"]')).toBeNull();
    expect(ui.graph).toEqual(original);
    ui.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ui.updateComplete;
    expect(ui.shadowRoot!.querySelector('[data-attachment="attachment"]')).not.toBeNull();
    pointer(ui, 'pointerdown', 150, 190, '[data-attachment="attachment"]');
    pointer(ui, 'pointermove', 600, 450);
    pointer(ui, 'pointerup', 600, 450);
    await ui.updateComplete;
    const detached = ui.graph.nodes.find((node) => node.id === 'attachment')!;
    expect(detached).not.toHaveProperty(kind === 'convert' ? 'input' : 'body');
    expect(detached).toMatchObject({ x: 510, y: 412 });
    expect(ui.graph.nodes.find((node) => node.id === 'a')).toEqual(original.nodes.find((node) => node.id === 'a'));
    expect(canvas.validateLogicGraph(ui.graph)).toEqual([]);
  });
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

  it('previews the final inserted row without publishing it, then publishes exactly once on release', async () => {
    const ui = await mount([constant('a', 100), constant('b', 368),
      { ...constant('x', 100), y: 450 }, { ...constant('y', 368), y: 450 }], [
      { id: 'ab', kind: 'data', from: 'a', to: 'b', op: '*' },
      { id: 'xy', kind: 'data', from: 'x', to: 'y', op: '+' },
    ]);
    const original = ui.graph;
    let edits = 0;
    ui.addEventListener('logic-edit', () => edits++);
    pointer(ui, 'pointerdown', 110, 460, '[data-node="x"]');
    pointer(ui, 'pointermove', 324, 258);
    await ui.updateComplete;
    expect(ui.graph).toBe(original);
    expect(edits).toBe(0);
    expect(ui.shadowRoot!.querySelectorAll('.relation.ghost')).toHaveLength(2);
    expect(ui.shadowRoot!.querySelector('.snap-feedback')?.textContent).toContain('插入');
    const positions = ['a', 'x', 'y', 'b'].map((id) => ui.shadowRoot!.querySelector<HTMLElement>(`[data-node="${id}"]`)!.style.left);
    expect(positions).toEqual(['100px', '368px', '636px', '904px']);
    pointer(ui, 'pointerup', 324, 258);
    await ui.updateComplete;
    expect(edits).toBe(1);
    expect(ui.shadowRoot!.querySelectorAll('.relation.ghost')).toHaveLength(0);
    expect(['a', 'x', 'y', 'b'].map((id) => ui.shadowRoot!.querySelector<HTMLElement>(`[data-node="${id}"]`)!.style.left)).toEqual(positions);
  });

  it('cancels tail extraction with Esc, while a relation never initiates dragging', async () => {
    const ui = await mount([constant('a', 100), constant('b', 368), constant('c', 636)], [
      { id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }, { id: 'bc', kind: 'data', from: 'b', to: 'c', op: '*' },
    ]);
    const original = ui.graph;
    pointer(ui, 'pointerdown', 380, 230, '[data-node="b"]');
    pointer(ui, 'pointermove', 380, 430);
    await ui.updateComplete;
    expect(ui.shadowRoot!.querySelectorAll('.relation')).toHaveLength(1);
    ui.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ui.updateComplete;
    expect(ui.graph).toBe(original);
    expect(ui.shadowRoot!.querySelectorAll('.relation')).toHaveLength(2);
    pointer(ui, 'pointerdown', 324, 258, '[data-edge="ab"]');
    pointer(ui, 'pointermove', 324, 500);
    pointer(ui, 'pointerup', 324, 500);
    await ui.updateComplete;
    expect(ui.graph).toBe(original);
    expect(ui.shadowRoot!.querySelector('.marquee')).toBeNull();
  });
});
