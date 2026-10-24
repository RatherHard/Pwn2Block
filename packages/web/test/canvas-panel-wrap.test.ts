// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { wrapTargetCaptionOf, wrapTargetOf } from '../src/components/canvas-panel-wrap-target';

/**
 * 多选包络（验收表 AT-15「同一区域连续流程包络为循环再解除」）。
 *
 * 选中集是一组 id，不是有序区间，所以「连续」只能靠把 id 映射回序列下标再判断——这里既测那条
 * 判定（纯函数），也测界面真的按整段选区包、包完选区切到新容器、以及只能撤销一次。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };

function methodNode(id: string): canvas.MethodNode {
  return { id, kind: 'method', block: 'emit', args: {} };
}

function documentOf(options: {
  readonly nodes: readonly canvas.CanvasNode[];
  readonly main: readonly string[];
}): canvas.CanvasDocument {
  const layout: Record<string, canvas.CanvasNodeLayout> = {};
  options.nodes.forEach((node, index) => {
    layout[node.id] = { x: 40 + index * 20, y: 40 + index * 20 };
  });
  return { ...canvas.emptyCanvasDocument(), nodes: options.nodes, layout, main: options.main };
}

/** 顶层序列：start → s1 → s2 → s3 → tail。 */
function fourStatements(): canvas.CanvasDocument {
  return documentOf({
    nodes: [START, methodNode('s1'), methodNode('s2'), methodNode('s3'), methodNode('tail')],
    main: ['start', 's1', 's2', 's3', 'tail'],
  });
}

/** 一条循环里放两句，顶层还留一句：用来测跨序列与「按区域下标」。 */
function loopAndTopLevel(): canvas.CanvasDocument {
  return documentOf({
    nodes: [
      START,
      { id: 'loop1', kind: 'loop', count: '', body: ['b1', 'b2'] },
      methodNode('b1'),
      methodNode('b2'),
      methodNode('after'),
    ],
    main: ['start', 'loop1', 'after'],
  });
}

describe('包络定位：选中集 → 连续区间', () => {
  it('空选区给出原因', () => {
    expect(wrapTargetOf(fourStatements(), [])).toEqual({ reason: '先选中要包起来的流程语句' });
  });

  it('单条语句就是 from = to', () => {
    expect(wrapTargetOf(fourStatements(), ['s2'])).toEqual({ ownerId: '', from: 2, to: 2 });
  });

  it('连续三条给出整段区间', () => {
    expect(wrapTargetOf(fourStatements(), ['s1', 's2', 's3'])).toEqual({ ownerId: '', from: 1, to: 3 });
  });

  it('选区顺序不影响结果：乱序仍按序列下标', () => {
    expect(wrapTargetOf(fourStatements(), ['s3', 's1', 's2'])).toEqual({ ownerId: '', from: 1, to: 3 });
  });

  it('不相邻的选区被拒绝，原因说明是「不相邻」', () => {
    expect(wrapTargetOf(fourStatements(), ['s1', 's3'])).toEqual({ reason: '选中的语句在序列里不相邻：一次只包连续的一段' });
  });

  it('跨序列的选区被拒绝，原因说明是「不在同一条序列」', () => {
    expect(wrapTargetOf(loopAndTopLevel(), ['b1', 'after'])).toEqual({
      reason: '选中的语句不在同一条序列里：一次只包同一区域的连续语句',
    });
  });

  it('循环体里的连续区间带上区域类型', () => {
    expect(wrapTargetOf(loopAndTopLevel(), ['b1', 'b2'])).toEqual({ ownerId: 'loop1', kind: 'body', from: 0, to: 1 });
  });

  it('含数据节点时被拒绝，并说明它是数据节点', () => {
    const document = {
      ...fourStatements(),
      nodes: [...fourStatements().nodes, { id: 'v1', kind: 'value', value: { kind: 'int', value: '1' } } as const],
    };
    expect(wrapTargetOf(document, ['s1', 'v1'])).toEqual({ reason: '「v1」是数据节点，只有流程语句能包进循环或条件分支' });
  });

  it('未排进序列的语句被拒绝', () => {
    const document = documentOf({ nodes: [START, methodNode('orphan')], main: ['start'] });
    expect(wrapTargetOf(document, ['orphan'])).toEqual({ reason: '「orphan」还没排进任何流程序列，先把它放进流程再包' });
  });

  it('开始节点不能包进区域', () => {
    const target = wrapTargetOf(fourStatements(), ['start']);
    expect(target).toEqual({ reason: '「start」是开始节点，必须留在顶层序列第一位，不能包进区域' });
  });

  it('重复 id 只算一次，不会因此判成「不相邻」', () => {
    expect(wrapTargetOf(fourStatements(), ['s1', 's1', 's2'])).toEqual({ ownerId: '', from: 1, to: 2 });
  });

  it('不存在的 id 先说不在文档里', () => {
    expect(wrapTargetOf(fourStatements(), ['ghost'])).toEqual({ reason: '选中的「ghost」不在文档里' });
  });

  it('整条序列都能包：从第一项到最后一项', () => {
    expect(wrapTargetOf(fourStatements(), ['s1', 's2', 's3', 'tail'])).toEqual({ ownerId: '', from: 1, to: 4 });
  });

  it('说明文字按 1 起数，单条不说成「第 3–3 项」', () => {
    const document = fourStatements();
    expect(wrapTargetCaptionOf(document, { ownerId: '', from: 2, to: 2 })).toContain('第 3 项');
    expect(wrapTargetCaptionOf(document, { ownerId: '', from: 1, to: 3 })).toContain('第 2–4 项');
    expect(wrapTargetCaptionOf(document, { ownerId: '', from: 1, to: 3 })).toContain('共 5 项');
  });
});

// ---------------------------------------------------------------------------
// 界面：按整段选区包、选区切到新容器、单次撤销
// ---------------------------------------------------------------------------

async function mount(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const element = window.document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = CHALLENGE;
  element.document = doc;
  window.document.body.append(element);
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

function clickNode(panel: CanvasPanelElement, nodeId: string, shiftKey = false): void {
  const element = requireElement(panel, `.node-box[data-node="${nodeId}"]`);
  const event = (type: string): void => {
    element.dispatchEvent(
      new MouseEvent(type, { clientX: 0, clientY: 0, bubbles: true, cancelable: true, button: 0, shiftKey }),
    );
  };
  event('pointerdown');
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: 0, clientY: 0, bubbles: true, cancelable: true, button: 0, shiftKey }),
  );
}

function keyDown(panel: CanvasPanelElement, key: string, ctrlKey = false, shiftKey = false): void {
  panel.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey, shiftKey }),
  );
}

function selectThree(panel: CanvasPanelElement): void {
  clickNode(panel, 's1');
  clickNode(panel, 's2', true);
  clickNode(panel, 's3', true);
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

describe('画布面板：多选包络', () => {
  it('框选三条后「包进循环」：三条进循环体，原位置留循环，选区切到新循环', async () => {
    const panel = await mount(fourStatements());
    selectThree(panel);
    await settle(panel);
    requireElement(panel, '.btn-wrap-loop').click();
    await settle(panel);

    const main = panel.document?.main ?? [];
    expect(main).toHaveLength(3);
    const loopId = main[1];
    expect(nodeOf(panel, loopId ?? '')).toMatchObject({ kind: 'loop', body: ['s1', 's2', 's3'] });
    expect(main).toEqual(['start', loopId, 'tail']);
    // 选区切到新容器，所以「解除」立刻可用。
    expect(rootOf(panel).querySelector('.btn-unwrap-loop')).not.toBeNull();
  });

  it('包络只占一步撤销：Ctrl+Z 直接回到包络之前', async () => {
    const panel = await mount(fourStatements());
    const before = panel.document;
    selectThree(panel);
    await settle(panel);
    requireElement(panel, '.btn-wrap-loop').click();
    await settle(panel);
    keyDown(panel, 'z', true);
    await settle(panel);
    expect(panel.document?.main).toEqual(['start', 's1', 's2', 's3', 'tail']);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(before?.nodes.map((node) => node.id));
  });

  it('包进条件：选区进 then，else 为空', async () => {
    const panel = await mount(fourStatements());
    selectThree(panel);
    await settle(panel);
    requireElement(panel, '.btn-wrap-branch').click();
    await settle(panel);

    const main = panel.document?.main ?? [];
    const ifId = main[1] ?? '';
    expect(nodeOf(panel, ifId)).toMatchObject({ kind: 'if', then: ['s1', 's2', 's3'], else: [] });
  });

  it('不相邻的选区：按钮禁用，title 说明原因', async () => {
    const panel = await mount(fourStatements());
    clickNode(panel, 's1');
    clickNode(panel, 's3', true);
    await settle(panel);

    const button = requireElement(panel, '.btn-wrap-loop');
    expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('不相邻');
  });

  it('含数据节点的选区：两个按钮都禁用', async () => {
    const document = {
      ...fourStatements(),
      nodes: [...fourStatements().nodes, { id: 'v1', kind: 'value', value: { kind: 'int', value: '1' } } as const],
    };
    const panel = await mount(document);
    clickNode(panel, 's1');
    clickNode(panel, 'v1', true);
    await settle(panel);

    for (const selector of ['.btn-wrap-loop', '.btn-wrap-branch']) {
      const button = requireElement(panel, selector);
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    }
  });

  it('Ctrl+G 包进循环、Ctrl+Shift+G 包进条件', async () => {
    const panel = await mount(fourStatements());
    selectThree(panel);
    await settle(panel);
    keyDown(panel, 'g', true);
    await settle(panel);
    expect(nodeOf(panel, panel.document?.main[1] ?? '')).toMatchObject({ kind: 'loop' });

    const branchPanel = await mount(fourStatements());
    selectThree(branchPanel);
    await settle(branchPanel);
    keyDown(branchPanel, 'g', true, true);
    await settle(branchPanel);
    expect(nodeOf(branchPanel, branchPanel.document?.main[1] ?? '')).toMatchObject({ kind: 'if' });
  });

  it('包完再解除：三条按原顺序回到 main', async () => {
    const panel = await mount(fourStatements());
    selectThree(panel);
    await settle(panel);
    requireElement(panel, '.btn-wrap-loop').click();
    await settle(panel);
    requireElement(panel, '.btn-unwrap-loop').click();
    await settle(panel);

    expect(panel.document?.main).toEqual(['start', 's1', 's2', 's3', 'tail']);
    expect(panel.document?.nodes.some((node) => node.kind === 'loop')).toBe(false);
  });

  it('循环体里的两条也能包进内层循环', async () => {
    const panel = await mount(loopAndTopLevel());
    clickNode(panel, 'b1');
    clickNode(panel, 'b2', true);
    await settle(panel);
    requireElement(panel, '.btn-wrap-loop').click();
    await settle(panel);

    const outer = nodeOf(panel, 'loop1');
    expect(outer.kind).toBe('loop');
    if (outer.kind !== 'loop') throw new Error('外层不是循环');
    expect(outer.body).toHaveLength(1);
    expect(nodeOf(panel, outer.body[0] ?? '')).toMatchObject({ kind: 'loop', body: ['b1', 'b2'] });
  });
});

function nodeOf(panel: CanvasPanelElement, nodeId: string): canvas.CanvasNode {
  const node = panel.document?.nodes.find((item) => item.id === nodeId);
  if (node === undefined) throw new Error(`没有节点 ${nodeId}`);
  return node;
}
