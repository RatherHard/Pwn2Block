// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { layoutCanvas } from '../src/canvas/view-model';

/**
 * 画布面板的交互：拖动、吸附、接线、就地编辑、多选、撤销与键盘。
 *
 * 全部用坐标驱动（`PointerEvent` 在 jsdom 里不保证存在，改发 `MouseEvent`），而 jsdom 里
 * `getBoundingClientRect()` 全为 0、`scrollLeft/Top` 也是 0，所以**客户端坐标 = 画布坐标**，
 * 用例可以直接写视图模型算出来的点位。
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

function createPanel(): CanvasPanelElement {
  const element = document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  return element;
}

async function mount(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const panel = createPanel();
  panel.challenge = CHALLENGE;
  panel.document = doc;
  document.body.append(panel);
  panels.push(panel);
  await panel.updateComplete;
  return panel;
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

function nodeEl(panel: CanvasPanelElement, nodeId: string): HTMLElement {
  return requireElement(panel, `.node-box[data-node="${nodeId}"]`);
}

function portEl(panel: CanvasPanelElement, nodeId: string, name: string): HTMLElement {
  return requireElement(panel, `.port[data-node="${nodeId}"][data-port="${name}"]`);
}

function rowEl(panel: CanvasPanelElement, nodeId: string, label: string): HTMLElement {
  const rows = [...rootOf(panel).querySelectorAll(`.row[data-node="${nodeId}"]`)];
  const found = rows.find((row) => row.querySelector('.row-label')?.textContent?.trim() === label);
  if (!(found instanceof HTMLElement)) throw new Error(`找不到 ${nodeId} 的「${label}」行`);
  return found;
}

/** 端口中心的画布坐标：与面板用同一份视图模型算，避免用例里手抄几何。 */
function portPoint(doc: canvas.CanvasDocument, nodeId: string, name: string): { x: number; y: number } {
  const view = layoutCanvas({ document: doc, methods: [] });
  const port = view.ports.find((item) => item.nodeId === nodeId && item.name === name);
  if (port === undefined) throw new Error(`没有端口 ${nodeId}.${name}`);
  return { x: port.x, y: port.y };
}

/** 盒子矩形（含宽高）：用例要按真实尺寸选落点，不能假设行高。 */
function boxOf(doc: canvas.CanvasDocument, nodeId: string): { x: number; y: number; width: number; height: number } {
  const box = layoutCanvas({ document: doc, methods: [] }).boxes.find((item) => item.nodeId === nodeId);
  if (box === undefined) throw new Error(`没有盒子 ${nodeId}`);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
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

function drag(target: EventTarget, from: { x: number; y: number }, to: { x: number; y: number }, option: Option = {}): void {
  fire(target, 'pointerdown', from.x, from.y, option);
  fire(window, 'pointermove', Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2), option);
  fire(window, 'pointermove', to.x, to.y, option);
  fire(window, 'pointerup', to.x, to.y, option);
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

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

describe('画布面板：端口与连线', () => {
  const wireDoc = (): canvas.CanvasDocument =>
    documentOf({
      nodes: [START, valueNode('v1', { kind: 'int', value: '2' }), { id: 'r1', kind: 'relation', op: 'int.add', left: '', right: '' }],
      layout: { v1: { x: 40, y: 40 }, r1: { x: 500, y: 300 } },
    });

  it('从端口拖到另一个节点就接上，并出现一条数据边', async () => {
    const doc = wireDoc();
    const panel = await mount(doc);
    const from = portPoint(doc, 'r1', 'left');
    drag(portEl(panel, 'r1', 'left'), from, { x: 80, y: 60 });
    await settle(panel);
    expect(nodeOf(panel, 'r1')).toMatchObject({ left: 'v1' });
    expect(rootOf(panel).querySelectorAll('.edge-data')).toHaveLength(1);
    expect(portEl(panel, 'r1', 'left').classList.contains('connected')).toBe(true);
  });

  it('从端口拖到空白就断开，端口回到空心', async () => {
    const base = wireDoc();
    const doc = documentOf({
      nodes: base.nodes.map((node) => (node.id === 'r1' && node.kind === 'relation' ? { ...node, left: 'v1' } : node)),
      layout: base.layout,
    });
    const panel = await mount(doc);
    expect(portEl(panel, 'r1', 'left').classList.contains('connected')).toBe(true);
    const from = portPoint(doc, 'r1', 'left');
    drag(portEl(panel, 'r1', 'left'), from, { x: 900, y: 700 });
    await settle(panel);
    expect(nodeOf(panel, 'r1')).toMatchObject({ left: '' });
    expect(rootOf(panel).querySelectorAll('.edge-data')).toHaveLength(0);
    expect(portEl(panel, 'r1', 'left').classList.contains('hollow')).toBe(true);
  });

  it('从端口拖到另一个端口也接得上', async () => {
    const doc = documentOf({
      nodes: [
        START,
        { id: 'r2', kind: 'relation', op: 'int.add', left: '', right: '' },
        { id: 'r1', kind: 'relation', op: 'int.sub', left: '', right: '' },
      ],
      layout: { r2: { x: 40, y: 40 }, r1: { x: 600, y: 400 } },
    });
    const panel = await mount(doc);
    const from = portPoint(doc, 'r1', 'left');
    const to = portPoint(doc, 'r2', 'left');
    drag(portEl(panel, 'r1', 'left'), from, to);
    await settle(panel);
    expect(nodeOf(panel, 'r1')).toMatchObject({ left: 'r2' });
    expect(rootOf(panel).querySelectorAll('.edge-data')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 就地编辑
// ---------------------------------------------------------------------------

describe('画布面板：就地编辑', () => {
  const editDoc = (): canvas.CanvasDocument =>
    documentOf({
      nodes: [START, valueNode('v1', { kind: 'int', value: '0' })],
      layout: { v1: { x: 40, y: 40 } },
    });

  it('双击可编辑的行出现输入框，回车提交', async () => {
    const panel = await mount(editDoc());
    const row = rowEl(panel, 'v1', '值');
    fire(row, 'dblclick', 0, 0);
    await settle(panel);
    const input = rootOf(panel).querySelector('.row-input');
    if (!(input instanceof HTMLInputElement)) throw new Error('没有出现输入框');
    input.value = '42';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'v1')).toMatchObject({ value: { kind: 'int', value: '42' } });
    expect(rootOf(panel).querySelector('.row-input')).toBeNull();
  });

  it('Esc 取消就地编辑，文档不动', async () => {
    const panel = await mount(editDoc());
    const row = rowEl(panel, 'v1', '值');
    fire(row, 'dblclick', 0, 0);
    await settle(panel);
    const input = rootOf(panel).querySelector('.row-input');
    if (!(input instanceof HTMLInputElement)) throw new Error('没有出现输入框');
    input.value = '99';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(panel);
    expect(nodeOf(panel, 'v1')).toMatchObject({ value: { kind: 'int', value: '0' } });
    expect(rootOf(panel).querySelector('.row-input')).toBeNull();
  });

  it('双击不可就地编辑的行改为打开侧栏', async () => {
    const doc = documentOf({
      nodes: [START, { id: 'm1', kind: 'method', block: 'gets', args: { data: '' } }],
      layout: { m1: { x: 40, y: 40 } },
    });
    const panel = await mount(doc);
    fire(rowEl(panel, 'm1', '方法'), 'dblclick', 0, 0);
    await settle(panel);
    expect(rootOf(panel).querySelector('.row-input')).toBeNull();
    expect(rootOf(panel).querySelectorAll('.node-box.selected')).toHaveLength(1);
    expect(rootOf(panel).querySelector('.inspector-id')?.textContent?.trim()).toBe('m1');
  });
});

// ---------------------------------------------------------------------------
// 拖动与吸附
// ---------------------------------------------------------------------------

describe('画布面板：拖动与吸附', () => {
  it('拖动节点按 8px 网格吸附', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' })],
        layout: { start: { x: 600, y: 600 }, v1: { x: 40, y: 40 } },
      }),
    );
    drag(nodeEl(panel, 'v1'), { x: 50, y: 50 }, { x: 200, y: 300 });
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 192, y: 288 });
  });

  it('按住 Shift 拖动不吸附', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' })],
        layout: { start: { x: 600, y: 600 }, v1: { x: 40, y: 40 } },
      }),
    );
    drag(nodeEl(panel, 'v1'), { x: 50, y: 50 }, { x: 200, y: 300 }, { shiftKey: true });
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 190, y: 290 });
  });

  it('拖动中按 Esc 放弃，文档一个像素都不变', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' })],
        layout: { start: { x: 600, y: 600 }, v1: { x: 40, y: 40 } },
      }),
    );
    fire(nodeEl(panel, 'v1'), 'pointerdown', 50, 50);
    fire(window, 'pointermove', 200, 300);
    await settle(panel);
    keyDown(panel, 'Escape');
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 40, y: 40 });
  });

  it('拖组合标题整组一起移动', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' }), valueNode('v2', { kind: 'int', value: '2' }), groupNode('g1', [['v1'], ['v2']])],
        layout: { v1: { x: 40, y: 40 }, v2: { x: 40, y: 180 } },
      }),
    );
    const title = requireElement(panel, '.group-title[data-group-title="g1"]');
    drag(title, { x: 40, y: 30 }, { x: 136, y: 78 });
    await settle(panel);
    expect(positionOf(panel, 'v1')).toEqual({ x: 136, y: 88 });
    expect(positionOf(panel, 'v2')).toEqual({ x: 136, y: 228 });
  });

  it('拖到组合的某一行上就能插进那一行', async () => {
    const doc = documentOf({
      nodes: [START, valueNode('v1', { kind: 'int', value: '1' }), valueNode('v2', { kind: 'int', value: '2' }), groupNode('g1', [['v1'], ['v2']])],
      layout: { v1: { x: 40, y: 40 }, v2: { x: 40, y: 180 } },
    });
    const panel = await mount(doc);
    const v2 = boxOf(doc, 'v2');
    const drop = { x: v2.x + 20, y: Math.round(v2.y + v2.height / 2) };
    fire(nodeEl(panel, 'v1'), 'pointerdown', 50, 50);
    fire(window, 'pointermove', drop.x, drop.y);
    await settle(panel);
    expect(rootOf(panel).querySelector('.snap-hint')?.textContent?.trim()).toBe('插入当前行');
    fire(window, 'pointerup', drop.x, drop.y);
    await settle(panel);
    expect(nodeOf(panel, 'g1')).toMatchObject({ rows: [['v2'], ['v1']] });
  });

  it('拖到组合下缘新增一行', async () => {
    const doc = documentOf({
      nodes: [
        START,
        valueNode('v1', { kind: 'int', value: '1' }),
        valueNode('v2', { kind: 'int', value: '2' }),
        valueNode('v3', { kind: 'int', value: '3' }),
        valueNode('v4', { kind: 'int', value: '4' }),
        groupNode('g1', [['v1', 'v2'], ['v3', 'v4']]),
      ],
      layout: { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 }, v3: { x: 40, y: 160 }, v4: { x: 240, y: 160 } },
    });
    const panel = await mount(doc);
    const lastBottom = Math.max(...['v3', 'v4'].map((id) => boxOf(doc, id).y + boxOf(doc, id).height));
    const drop = { x: 60, y: lastBottom + 12 };
    fire(nodeEl(panel, 'v1'), 'pointerdown', 50, 50);
    fire(window, 'pointermove', drop.x, drop.y);
    await settle(panel);
    expect(rootOf(panel).querySelector('.snap-hint')?.textContent?.trim()).toBe('新增一行');
    fire(window, 'pointerup', drop.x, drop.y);
    await settle(panel);
    expect(nodeOf(panel, 'g1')).toMatchObject({ rows: [['v2'], ['v3', 'v4'], ['v1']] });
  });

  it('把成员拖出组合到空白处就解除包络', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' }), valueNode('v2', { kind: 'int', value: '2' }), groupNode('g1', [['v1', 'v2']])],
        layout: { v1: { x: 40, y: 40 }, v2: { x: 240, y: 40 } },
      }),
    );
    drag(nodeEl(panel, 'v1'), { x: 60, y: 60 }, { x: 700, y: 700 });
    await settle(panel);
    expect(panel.document?.nodes.some((node) => node.kind === 'group')).toBe(false);
    expect(positionOf(panel, 'v1')).toEqual({ x: 680, y: 680 });
  });

  it('把节点拖到另一个节点上就拼成组合', async () => {
    const panel = await mount(
      documentOf({
        nodes: [START, valueNode('v1', { kind: 'int', value: '1' }), valueNode('v2', { kind: 'int', value: '2' })],
        layout: { v1: { x: 40, y: 40 }, v2: { x: 440, y: 40 } },
      }),
    );
    drag(nodeEl(panel, 'v1'), { x: 60, y: 60 }, { x: 470, y: 70 });
    await settle(panel);
    const group = panel.document?.nodes.find((node) => node.kind === 'group');
    expect(group?.kind).toBe('group');
    if (group?.kind !== 'group') throw new Error('没有建出组合');
    expect([...canvas.groupMembers(group)].sort()).toEqual(['v1', 'v2']);
  });
});

