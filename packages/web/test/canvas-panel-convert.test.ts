// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';

/**
 * 侧栏的「转换包络」入口（验收表 AT-14「包络为转换 / 解除转换」）。
 *
 * 与 `canvas-panel-wrap.test.ts` 同一套挂载方式，断言落在两处：`document.nodes`（真正写进存档的
 * 形状）与影子根里的按钮（可见入口与禁用原因）。这里只测「按钮 → 命令层 → 文档」这一条链，
 * 命令本身的规则在 `canvas-editor-convert.test.ts` 里逐条钉住。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };

function valueNode(id: string): canvas.CanvasNode {
  return { id, kind: 'value', value: { kind: 'int', value: '1' } };
}

function methodNode(id: string): canvas.CanvasNode {
  return { id, kind: 'method', block: 'emit', args: {} };
}

function groupNode(id: string, rows: readonly (readonly string[])[]): canvas.CanvasNode {
  return { id, kind: 'group', mode: 'list', rows };
}

function convertNode(id: string, input: string): canvas.CanvasNode {
  return { id, kind: 'convert', spec: { kind: 'int-to-bytes', width: 4, endian: 'little', signed: false }, input };
}

function documentOf(options: {
  readonly nodes: readonly canvas.CanvasNode[];
  readonly main?: readonly string[];
}): canvas.CanvasDocument {
  const layout: Record<string, canvas.CanvasNodeLayout> = {};
  options.nodes.forEach((node, index) => {
    layout[node.id] = { x: 40 + index * 220, y: 40 };
  });
  return { ...canvas.emptyCanvasDocument(), nodes: options.nodes, layout, main: options.main ?? ['start'] };
}

/** 两个并排的值节点：多选包络的起点。 */
function pairDocument(): canvas.CanvasDocument {
  return documentOf({ nodes: [START, valueNode('v1'), valueNode('v2')] });
}

/** 一个已经包好的转换：组合 g1 被 c1 包住。 */
function wrappedDocument(): canvas.CanvasDocument {
  return documentOf({ nodes: [START, valueNode('v1'), valueNode('v2'), groupNode('g1', [['v1', 'v2']]), convertNode('c1', 'g1')] });
}

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

function requireButton(panel: CanvasPanelElement, selector: string): HTMLButtonElement {
  const found = rootOf(panel).querySelector(selector);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`找不到按钮 ${selector}`);
  return found;
}

/**
 * 点一个节点的盒子。转换节点只出「关系方框」（`view-model-rows.ts` 的 `RELATION_BOX_KINDS`），
 * 而关系方框的选中发生在 `click` 里（`pointerdown` 对它是「不拖动」），所以三个事件都要发。
 */
function clickNode(panel: CanvasPanelElement, nodeId: string, shiftKey = false): void {
  const element =
    rootOf(panel).querySelector(`.node-box[data-node="${nodeId}"]`) ??
    rootOf(panel).querySelector(`.relation-box[data-node="${nodeId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`找不到节点 ${nodeId}`);
  const init = { clientX: 0, clientY: 0, bubbles: true, cancelable: true, button: 0, shiftKey };
  element.dispatchEvent(new MouseEvent('pointerdown', init));
  window.dispatchEvent(new MouseEvent('pointerup', init));
  element.dispatchEvent(new MouseEvent('click', init));
}

function nodeOf(panel: CanvasPanelElement, nodeId: string): canvas.CanvasNode | undefined {
  return panel.document?.nodes.find((node) => node.id === nodeId);
}

function convertOf(panel: CanvasPanelElement): canvas.ConvertNode {
  const converts = (panel.document?.nodes ?? []).filter((node) => node.kind === 'convert');
  const only = converts[0];
  if (only === undefined || only.kind !== 'convert') throw new Error('文档里没有转换节点');
  return only;
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

describe('画布面板：包络为转换', () => {
  it('选中两个数据节点点「包络为转换」：出现转换与组合，选区切到转换', async () => {
    const panel = await mount(pairDocument());
    clickNode(panel, 'v1');
    clickNode(panel, 'v2', true);
    await settle(panel);
    requireButton(panel, '.btn-wrap-convert').click();
    await settle(panel);

    const convert = convertOf(panel);
    // 组合按选区顺序成行，转换读的就是这个组合。
    expect(nodeOf(panel, convert.input)).toMatchObject({ kind: 'group', rows: [['v1', 'v2']] });
    expect(panel.document?.nodes).toHaveLength(5);
    // 选区切到新转换节点，于是「解除转换」立刻可用。
    expect(rootOf(panel).querySelector('.btn-unwrap-convert')).not.toBeNull();
  });

  it('选中转换节点点「解除转换」：转换消失，组合与成员还在', async () => {
    const panel = await mount(wrappedDocument());
    clickNode(panel, 'c1');
    await settle(panel);
    requireButton(panel, '.btn-unwrap-convert').click();
    await settle(panel);

    expect(panel.document?.nodes.some((node) => node.kind === 'convert')).toBe(false);
    expect(nodeOf(panel, 'g1')).toMatchObject({ kind: 'group', rows: [['v1', 'v2']] });
    expect(nodeOf(panel, 'v1')).toMatchObject({ kind: 'value' });
    expect(nodeOf(panel, 'v2')).toMatchObject({ kind: 'value' });
  });

  it('选中流程语句时「包络为转换」禁用，title 说明原因', async () => {
    const panel = await mount(
      documentOf({ nodes: [START, valueNode('v1'), methodNode('m1')], main: ['start', 'm1'] }),
    );
    clickNode(panel, 'v1');
    clickNode(panel, 'm1', true);
    await settle(panel);

    const button = requireButton(panel, '.btn-wrap-convert');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('没有数据结果，不能包成转换');
  });

  it('外部还引用着内部中间结果时，点按钮把原因报到消息栏，文档不变', async () => {
    const relation: canvas.CanvasNode = { id: 'r1', kind: 'relation', op: 'int.add', left: 'v1', right: 'v2' };
    const panel = await mount(documentOf({ nodes: [START, valueNode('v1'), valueNode('v2'), relation] }));
    clickNode(panel, 'v1');
    clickNode(panel, 'v2', true);
    await settle(panel);
    const before = panel.document;

    requireButton(panel, '.btn-wrap-convert').click();
    await settle(panel);

    expect(panel.document).toBe(before);
    expect(requireElement(panel, '.message').textContent).toContain('还引用着内部的');
  });
});
