// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';

/**
 * 画布面板的选择、键盘命令与侧栏（拖动与接线在 `canvas-panel-interaction.test.ts`）。
 *
 * 同样的坐标口径：jsdom 里矩形全为 0，所以客户端坐标 = 画布坐标。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };

function documentOf(options: {
  readonly nodes: readonly canvas.CanvasNode[];
  readonly main?: readonly string[];
  readonly layout: Readonly<Record<string, canvas.CanvasNodeLayout>>;
}): canvas.CanvasDocument {
  return {
    ...canvas.emptyCanvasDocument(),
    nodes: options.nodes,
    layout: options.layout,
    main: options.main ?? ['start'],
  };
}

function valueNode(id: string, value: canvas.EncodedScalarValue): canvas.ValueNode {
  return { id, kind: 'value', value };
}

function groupNode(id: string, rows: readonly (readonly string[])[]): canvas.GroupNode {
  return { id, kind: 'group', mode: 'list', rows };
}

async function mount(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const element = document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = CHALLENGE;
  element.document = doc;
  document.body.append(element);
  panels.push(element);
  await element.updateComplete;
  return element;
}

async function settle(panel: CanvasPanelElement): Promise<void> {
  await panel.updateComplete;
  await Promise.resolve();
  await panel.updateComplete;
}

function rootOf(panel: CanvasPanelElement): ShadowRoot {
  const root = panel.shadowRoot;
  if (root === null) throw new Error('面板没有影子根');
  return root;
}

function requireElement(panel: CanvasPanelElement, selector: string): HTMLElement {
  const found = rootOf(panel).querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`找不到 ${selector}`);
  return found;
}

interface Option {
  readonly shiftKey?: boolean;
}

function fire(target: EventTarget, type: string, x: number, y: number, option: Option = {}): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: option.shiftKey ?? false,
    }),
  );
}

function clickNode(panel: CanvasPanelElement, nodeId: string, option: Option = {}): void {
  const element = requireElement(panel, `.node-box[data-node="${nodeId}"]`);
  fire(element, 'pointerdown', 0, 0, option);
  fire(window, 'pointerup', 0, 0, option);
}

function keyDown(panel: CanvasPanelElement, key: string, option: Option & { readonly ctrlKey?: boolean } = {}): void {
  panel.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: option.ctrlKey ?? false,
      shiftKey: option.shiftKey ?? false,
    }),
  );
}

function positionOf(panel: CanvasPanelElement, nodeId: string): { x: number; y: number } {
  const position = panel.document?.layout[nodeId];
  if (position === undefined) throw new Error(`节点 ${nodeId} 没有位置`);
  return position;
}

function nodeOf(panel: CanvasPanelElement, nodeId: string): canvas.CanvasNode {
  const node = panel.document?.nodes.find((item) => item.id === nodeId);
  if (node === undefined) throw new Error(`没有节点 ${nodeId}`);
  return node;
}

function selectedCount(panel: CanvasPanelElement): number {
  return rootOf(panel).querySelectorAll('.node-box.selected, .relation-box.selected').length;
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 选择、删除、撤销与键盘
// ---------------------------------------------------------------------------

describe('画布面板：选择与键盘', () => {
  const twoValues = (): canvas.CanvasDocument =>
    documentOf({
      nodes: [START, valueNode('v1', { kind: 'int', value: '1' }), valueNode('v2', { kind: 'int', value: '2' })],
      layout: { start: { x: 600, y: 600 }, v1: { x: 40, y: 40 }, v2: { x: 40, y: 220 } },
    });

  it('点空白清空选择', async () => {
    const panel = await mount(twoValues());
    clickNode(panel, 'v1');
    await settle(panel);
    expect(selectedCount(panel)).toBe(1);
    fire(requireElement(panel, '.stage'), 'pointerdown', 900, 700);
    fire(window, 'pointerup', 900, 700);
    await settle(panel);
    expect(selectedCount(panel)).toBe(0);
  });

  it('Shift 点选加选，Delete 一次删掉两个', async () => {
    const panel = await mount(twoValues());
    clickNode(panel, 'v1');
    clickNode(panel, 'v2', { shiftKey: true });
    await settle(panel);
    expect(selectedCount(panel)).toBe(2);
    keyDown(panel, 'Delete');
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it('Ctrl+Z 撤销、Ctrl+Shift+Z 重做', async () => {
    const panel = await mount(twoValues());
    keyDown(panel, 'Delete');
    clickNode(panel, 'v1');
    keyDown(panel, 'Delete');
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start', 'v2']);
    keyDown(panel, 'z', { ctrlKey: true });
    await settle(panel);
    expect(panel.document?.nodes).toHaveLength(3);
    keyDown(panel, 'z', { ctrlKey: true, shiftKey: true });
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start', 'v2']);
  });

  it('方向键移动 8px，按住 Shift 移动 32px', async () => {
    const panel = await mount(twoValues());
    clickNode(panel, 'v1');
    keyDown(panel, 'ArrowDown');
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 40, y: 48 });
    keyDown(panel, 'ArrowRight', { shiftKey: true });
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 72, y: 48 });
  });
});

// ---------------------------------------------------------------------------
// 侧栏
// ---------------------------------------------------------------------------

describe('画布面板：侧栏', () => {
  it('选中组合后能改组合模式', async () => {
    const panel = await mount(
      documentOf({
        nodes: [
          START,
          valueNode('v1', { kind: 'int', value: '1' }),
          valueNode('v2', { kind: 'int', value: '2' }),
          groupNode('g1', [['v1', 'v2']]),
        ],
        layout: { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } },
      }),
    );
    const title = requireElement(panel, '.group-title[data-group-title="g1"]');
    fire(title, 'pointerdown', 40, 30);
    fire(window, 'pointerup', 40, 30);
    await settle(panel);
    const select = rootOf(panel).querySelector('.field-mode');
    if (!(select instanceof HTMLSelectElement)) throw new Error('侧栏没有组合模式');
    select.value = 'merge';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'g1')).toMatchObject({ mode: 'merge' });
  });

  it('选中转换节点后能改宽度参数', async () => {
    const panel = await mount(
      documentOf({
        nodes: [
          START,
          { id: 'c1', kind: 'convert', spec: { kind: 'int-to-bytes', width: 1, endian: 'little', signed: false }, input: '' },
        ],
        layout: { c1: { x: 40, y: 40 } },
      }),
    );
    requireElement(panel, '.relation-box[data-node="c1"]').click();
    await settle(panel);
    const select = rootOf(panel).querySelector('.field-param-width');
    if (!(select instanceof HTMLSelectElement)) throw new Error('侧栏没有宽度参数');
    select.value = '4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'c1')).toMatchObject({ spec: { width: 4 } });
  });

  it('选中变量后能改名', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, { id: 'd1', kind: 'var-decl', name: 'x', type: 'int', binding: { mode: 'none' } }],
        layout: { d1: { x: 40, y: 40 } },
      }),
    );
    clickNode(panel, 'd1');
    await settle(panel);
    const input = rootOf(panel).querySelector('.field-name');
    if (!(input instanceof HTMLInputElement)) throw new Error('侧栏没有名称输入');
    input.value = 'counter';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'd1')).toMatchObject({ name: 'counter' });
  });
});
